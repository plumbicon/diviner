/**
 * Живой источник данных по нескольким инструментам сразу.
 *
 * Отдельный класс, а не правка {@link TinkoffDataSource}: однобумажный источник
 * прямо сейчас держит однобумажных боевых ботов с реальными деньгами, и его поведение
 * должно остаться байт в байт прежним. Общее у них только клиент.
 *
 * Две вещи, которых нет в однобумажном пути:
 *
 * 1. **Граница минуты.** В бэктесте «последняя свеча минуты» определяется
 *    порядком в файле. В live свечи одной минуты прилетают вразнобой в течение
 *    нескольких секунд, а кросс-секционная стратегия обязана сравнивать скоры,
 *    увидев вселенную целиком. Поэтому свечи копятся по минутам и выдаются
 *    пачкой: либо когда пришли все подписанные бумаги, либо по истечении
 *    льготного окна. Ждать «всех» как единственное условие нельзя — на
 *    неликвидной бумаге минута без сделок штатна, и пачка не собралась бы никогда.
 *
 * 2. **Сторож молчания — общий, а не по бумагам.** Отказ, от которого он
 *    защищает, это смерть всего стрима; персональный сторож на каждую бумагу
 *    давал бы ложные срабатывания на неликвиде постоянно.
 */
import {
    TinkoffMarketDataProvider,
    buildCandleDerivedTradingSchedule,
    DEFAULT_EXCHANGE,
} from "../../core/market-data.js";

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const SCHEDULE_LOOKBACK_DAYS = 21;   // столько истории нужно фичам
const SCHEDULE_AHEAD_DAYS = 14;

export class MultiSymbolTinkoffDataSource {
    /**
     * @param {object} params - Параметры.
     * @param {object} params.client - TinkoffClient.
     * @param {Array<object>} params.instruments - Инструменты вселенной.
     * @param {number} [params.interval] - Интервал свечей, минут.
     * @param {boolean} [params.verbose] - Подробный лог.
     * @param {number} [params.stallTimeoutMin] - Порог молчания стрима, минут.
     * @param {number} [params.batchGraceMs] - Льготное окно сбора минуты, мс.
     */
    constructor({
        client, instruments, interval = 1, verbose = false,
        stallTimeoutMin = 30, batchGraceMs = 8000,
    }) {
        if (!instruments?.length) throw new Error("MultiSymbolTinkoffDataSource requires instruments");
        this.client = client;
        this.instruments = instruments;
        this.interval = interval;
        this.verbose = verbose;
        this.batchGraceMs = batchGraceMs;
        this.intervalMs = (Number(interval) || 1) * 60 * 1000;

        this.byTicker = new Map(instruments.map((i) => [i.ticker, i]));
        this.providers = new Map();
        this._lastTimeByTicker = new Map();

        // Копилка минут: ts минуты → (тикер → свеча). Плюс таймер на каждую.
        this._buckets = new Map();
        this._timers = new Map();

        this._queue = [];
        this._notify = null;
        this._closed = false;
        this._catchUpFrom = null;

        this._stallTimeoutMs = Math.max(0, Number(stallTimeoutMin) || 0) * 60 * 1000;
        this._lastCandleWall = Date.now();
        this._stallTimer = null;
    }

    /** Тикеры вселенной. @returns {Array<string>} Тикеры. */
    getSymbols() {
        return [...this.byTicker.keys()].sort();
    }

    /**
     * Инструмент по тикеру.
     * @param {string} ticker - Тикер.
     * @returns {object|null} Инструмент.
     */
    getInstrument(ticker) {
        return this.byTicker.get(ticker) ?? null;
    }

    /** Провайдер истории по бумаге (создаётся лениво). @private */
    _provider(ticker) {
        let provider = this.providers.get(ticker);
        if (!provider) {
            const instrument = this.byTicker.get(ticker);
            if (!instrument) throw new Error(`Unknown ticker ${ticker}`);
            provider = new TinkoffMarketDataProvider({
                api: this.client.api,
                instrument,
                exchange: instrument.exchange || DEFAULT_EXCHANGE,
            });
            this.providers.set(ticker, provider);
        }
        return provider;
    }

    /**
     * Поток свечей вселенной: по возрастанию времени, пачками по минутам.
     * @returns {AsyncGenerator<object>} Свечи с полями ticker и isBatchEnd.
     */
    async *stream() {
        this._catchUpFrom = new Date();
        await this.client.subscribeCandles(
            this.instruments,
            this.interval,
            (candle) => this._accept(candle),
            { waitingClose: true, onReconnectCatchUp: () => this._catchUpAll() },
        );
        this._startStallWatchdog();
        console.log(
            `[MultiTinkoff] Подписка на ${this.instruments.length} инструментов, `
            + `интервал ${this.interval}м, окно сбора минуты ${this.batchGraceMs} мс.`,
        );

        while (!this._closed) {
            if (this._queue.length === 0) {
                await new Promise((resolve) => { this._notify = resolve; });
                continue;
            }
            yield this._queue.shift();
        }
    }

    /**
     * Принять свечу из стрима: отбросить дубль, положить в копилку минуты.
     * @param {object} candle - Свеча с тикером.
     * @private
     */
    _accept(candle) {
        const ticker = candle?.ticker;
        const time = candle?.datetime instanceof Date ? candle.datetime.getTime() : NaN;
        if (!ticker || !Number.isFinite(time) || !this.byTicker.has(ticker)) return;

        const last = this._lastTimeByTicker.get(ticker);
        if (last != null && time <= last) {
            if (this.verbose) {
                console.log(`[MultiTinkoff] ${ticker}: дубль/устаревшая ${candle.datetime.toISOString()}`);
            }
            return;
        }
        this._lastTimeByTicker.set(ticker, time);
        this._lastCandleWall = Date.now();

        let bucket = this._buckets.get(time);
        if (!bucket) {
            bucket = new Map();
            this._buckets.set(time, bucket);
            this._timers.set(time, setTimeout(() => this._flushUpTo(time), this.batchGraceMs));
        }
        bucket.set(ticker, candle);

        // Вся вселенная отчиталась — ждать нечего.
        if (bucket.size >= this.byTicker.size) this._flushUpTo(time);
    }

    /**
     * Выдать все копилки с временем ≤ ts, в порядке возрастания.
     *
     * Именно «все до», а не только эту: опоздавшая минута иначе ушла бы в поток
     * после более свежей, и движок увидел бы время, идущее назад.
     * @param {number} ts - Граница минуты.
     * @private
     */
    _flushUpTo(ts) {
        const due = [...this._buckets.keys()].filter((t) => t <= ts).sort((a, b) => a - b);
        for (const minute of due) {
            const bucket = this._buckets.get(minute);
            this._buckets.delete(minute);
            const timer = this._timers.get(minute);
            if (timer) { clearTimeout(timer); this._timers.delete(minute); }
            if (!bucket || bucket.size === 0) continue;

            const tickers = [...bucket.keys()].sort();
            tickers.forEach((ticker, index) => {
                const candle = bucket.get(ticker);
                candle.isBatchEnd = index === tickers.length - 1;
                this._queue.push(candle);
            });
            if (this.verbose) {
                console.log(`[MultiTinkoff] минута ${new Date(minute).toISOString()}: ${tickers.length} бумаг`);
            }
        }
        if (this._notify) {
            const notify = this._notify;
            this._notify = null;
            notify();
        }
    }

    /** Сторож молчания всего стрима. @private */
    _startStallWatchdog() {
        if (this._stallTimeoutMs <= 0 || this._stallTimer) return;
        this._stallTimer = setInterval(() => {
            const silent = Date.now() - this._lastCandleWall;
            if (silent < this._stallTimeoutMs) return;
            // Тишина по ВСЕЙ вселенной — это отказ стрима, а не спокойный рынок:
            // хотя бы одна ликвидная бумага обязана торговаться каждую минуту.
            console.warn(
                `[MultiTinkoff] Тишина ${Math.round(silent / 60000)} мин по всем `
                + `${this.instruments.length} инструментам — переподписка.`,
            );
            this._lastCandleWall = Date.now();
            this._forceReconnect().catch((error) => {
                console.error(`[MultiTinkoff] Переподписка не удалась: ${error.message}`);
            });
        }, 60_000);
        this._stallTimer.unref?.();
    }

    /**
     * Переподписаться, не роняя процесс: сначала догрузить пропущенное, потом
     * пересоздать подписку (_startCandleStream сам снимает мёртвую).
     * @private
     */
    async _forceReconnect() {
        if (this._closed) return;
        try {
            await this._catchUpAll();
        } catch (error) {
            console.warn(`[MultiTinkoff] Догрузка перед переподпиской не удалась: ${error.message}`);
        }
        await this.client._startCandleStream();
        console.log("[MultiTinkoff] Подписка на свечи восстановлена (процесс жив).");
    }

    /**
     * Догрузить пропущенное по каждой бумаге после переподключения.
     * Свечи старше последней помечаются noTrade: их close уже неактуален, и
     * ордер по нему исполнился бы далеко от смоделированной цены.
     * @private
     */
    async _catchUpAll() {
        const now = new Date();
        for (const ticker of this.getSymbols()) {
            const lower = this._lastTimeByTicker.get(ticker) ?? this._catchUpFrom?.getTime() ?? null;
            if (lower === null) continue;
            const from = new Date(lower + 1);
            if (from >= now) continue;
            let candles;
            try {
                candles = await this._provider(ticker).getCandles({
                    from, to: now, interval: this.interval, includeWeekend: true,
                });
            } catch (error) {
                console.error(`[MultiTinkoff] ${ticker}: догрузка не удалась — ${error.message}`);
                continue;
            }
            const closed = (candles || [])
                .filter((c) => c.isComplete !== false
                    && c.datetime instanceof Date
                    && c.datetime.getTime() > lower
                    && c.datetime.getTime() + this.intervalMs <= now.getTime())
                .sort((a, b) => a.datetime.getTime() - b.datetime.getTime());
            const lastIdx = closed.length - 1;
            closed.forEach((candle, index) => {
                candle.ticker = ticker;
                candle.isCatchUp = true;
                if (index < lastIdx) candle.noTrade = true;
                this._accept(candle);
            });
        }
        // Догруженное отдаём немедленно: льготное окно тут ни при чём.
        const latest = Math.max(...[...this._lastTimeByTicker.values()], 0);
        if (latest > 0) this._flushUpTo(latest);
    }

    /**
     * История по конкретной бумаге.
     * @param {object} params - { ticker, from, to, interval }.
     * @returns {Promise<Array<object>>} Свечи.
     */
    async getHistory({ ticker, until, ...params } = {}) {
        if (!ticker) throw new Error("getHistory requires a ticker on a multi-symbol source");
        return this._provider(ticker).getCandles({ interval: this.interval, ...params });
    }

    /**
     * Расписание торгов по бумаге.
     * @param {object} params - { ticker, from, to }.
     * @returns {Promise<Array<object>>} Торговые дни.
     */
    async getTradingSchedule({ ticker, from, to, ...params } = {}) {
        const instrument = ticker ? this.byTicker.get(ticker) : this.instruments[0];
        // Биржевое расписание живое, а не выводимое из данных: без диапазона дат
        // API отдаёт пустой список. Молча вернуть пустоту здесь — значит оставить
        // стратегию без единого торгового дня и без единой ошибки в логе.
        const now = Date.now();
        const range = {
            from: from ?? new Date(now - SCHEDULE_LOOKBACK_DAYS * DAY_MS),
            to:   to   ?? new Date(now + SCHEDULE_AHEAD_DAYS * DAY_MS),
        };
        const days = await this._provider(instrument?.ticker ?? this.instruments[0].ticker)
            .getTradingSchedule({ exchange: instrument?.exchange || DEFAULT_EXCHANGE, ...range, ...params });
        if (!days?.length) {
            console.warn(`[MultiTinkoff] ${ticker ?? "?"}: расписание торгов пустое — стратегия сочтёт день неторговым.`);
        }
        return days;
    }

    /** Остановить поток и снять подписку. */
    async requestStop() {
        this._closed = true;
        if (this._stallTimer) { clearInterval(this._stallTimer); this._stallTimer = null; }
        for (const timer of this._timers.values()) clearTimeout(timer);
        this._timers.clear();
        try { await this.client.unsubscribeCandles?.(); } catch { /* уже закрыт */ }
        if (this._notify) { const notify = this._notify; this._notify = null; notify(); }
    }
}

export { MSK_OFFSET_MS, buildCandleDerivedTradingSchedule };
