/**
 * Live T-Invest data source for a universe of instruments (a single instrument is the
 * special case of a one-ticker universe).
 *
 * Two things shape its design:
 *
 * 1. **The minute boundary.** In a backtest "the last candle of a minute" is defined by
 *    the order in the file. Live, the candles of one minute arrive scattered over several
 *    seconds, while a cross-sectional strategy must compare scores having seen the whole
 *    universe. So candles are collected per minute and released as a batch: either when
 *    every subscribed instrument has arrived or when the grace window expires. Waiting
 *    for "all" as the only condition is impossible — a minute without trades is normal
 *    for an illiquid instrument, and the batch would never complete.
 *
 * 2. **One silence watchdog for the whole stream, not per instrument.** The failure it
 *    guards against is the death of the whole stream; a watchdog per instrument would
 *    fire falsely on illiquid names all the time.
 */
import {
    TinkoffMarketDataProvider,
    buildCandleDerivedTradingSchedule,
    DEFAULT_EXCHANGE,
} from "../../core/market-data.js";

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const SCHEDULE_LOOKBACK_DAYS = 21;   // history depth strategy features need
const SCHEDULE_AHEAD_DAYS = 14;

export class MultiSymbolTinkoffDataSource {
    /**
     * @param {object} params - Parameters.
     * @param {object} params.client - TinkoffClient.
     * @param {Array<object>} params.instruments - Universe instruments.
     * @param {number} [params.interval] - Candle interval, minutes.
     * @param {boolean} [params.verbose] - Verbose log.
     * @param {number} [params.stallTimeoutMin] - Stream silence threshold, minutes.
     * @param {number} [params.batchGraceMs] - Grace window for collecting a minute, ms.
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

        // Minute buckets: minute ts → (ticker → candle), plus a timer per bucket.
        this._buckets = new Map();
        this._timers = new Map();

        this._queue = [];
        this._notify = null;
        // Time of the last released minute. Deduplication is per instrument, while the
        // release order is shared: without this boundary the catch-up after a reconnect
        // (which feeds old candles of instruments that were silent) would create a batch
        // for a minute already sent to the engine, and time in the stream would go back.
        this._lastFlushedTs = 0;
        this._droppedLate = 0;
        this._closed = false;
        this._catchUpFrom = null;

        this._stallTimeoutMs = Math.max(0, Number(stallTimeoutMin) || 0) * 60 * 1000;
        this._lastCandleWall = Date.now();
        this._stallTimer = null;
        // A resubscription for silence has already happened, and no live candle since.
        this._stallReconnected = false;
        // Error the stream ends with, so that the process restarts.
        this._fatal = null;
        // dateKey (Moscow) → session bounds. The schedule is the same for the whole
        // exchange, so asking for one instrument is enough.
        this._sessionCache = new Map();
    }

    /** Universe tickers. @returns {Array<string>} Tickers. */
    getSymbols() {
        return [...this.byTicker.keys()].sort();
    }

    /**
     * Instrument by ticker.
     * @param {string} ticker - Ticker.
     * @returns {object|null} Instrument.
     */
    getInstrument(ticker) {
        return this.byTicker.get(ticker) ?? null;
    }

    /** History provider for an instrument (created lazily). @private */
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
     * Candle stream of the universe: ascending time, in per-minute batches.
     * @returns {AsyncGenerator<object>} Candles with `ticker` and `isBatchEnd`.
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
            if (this._fatal) throw this._fatal;
            if (this._queue.length === 0) {
                await new Promise((resolve) => { this._notify = resolve; });
                continue;
            }
            yield this._queue.shift();
        }
    }

    /**
     * Accept a candle from the stream: drop duplicates, put it into its minute bucket.
     * @param {object} candle - Candle with a ticker.
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
        if (time <= this._lastFlushedTs) {
            this._droppedLate += 1;
            if (this._droppedLate === 1 || this._droppedLate % 100 === 0) {
                console.warn(
                    `[MultiTinkoff] ${ticker}: свеча ${candle.datetime.toISOString()} старше уже`
                    + ` отданной минуты — отброшена (всего ${this._droppedLate}).`,
                );
            }
            return;
        }
        this._lastTimeByTicker.set(ticker, time);
        // Only the live stream matters to the watchdog: the catch-up goes over REST and
        // arrives even when the subscription is dead — otherwise it would mask silence.
        if (!candle.isCatchUp) {
            this._lastCandleWall = Date.now();
            this._stallReconnected = false;
        }

        let bucket = this._buckets.get(time);
        if (!bucket) {
            bucket = new Map();
            this._buckets.set(time, bucket);
            this._timers.set(time, setTimeout(() => this._flushUpTo(time), this.batchGraceMs));
        }
        bucket.set(ticker, candle);

        // The whole universe has reported — nothing to wait for.
        if (bucket.size >= this.byTicker.size) this._flushUpTo(time);
    }

    /**
     * Release every bucket with time ≤ ts, in ascending order.
     *
     * "Everything up to", not just this one: otherwise a late minute would enter the
     * stream after a fresher one, and the engine would see time going backwards.
     * @param {number} ts - Minute boundary.
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
            this._lastFlushedTs = Math.max(this._lastFlushedTs, minute);
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

    /**
     * Whether an exchange session is running now. The schedule comes from the broker and
     * is cached per day; when it is unavailable, a broad Moscow window is used so that a
     * schedule failure does not switch the watchdog off entirely.
     * @param {Date} now - Moment to check.
     * @returns {Promise<boolean>} Inside a session.
     * @private
     */
    async _isWithinTradingSession(now) {
        const dateKey = new Date(now.getTime() + MSK_OFFSET_MS).toISOString().slice(0, 10);
        if (!this._sessionCache.has(dateKey)) {
            try {
                const days = await this.getTradingSchedule({ ticker: this.instruments[0].ticker });
                for (const day of days || []) {
                    const key = day.dateKey || day.date?.slice(0, 10);
                    if (!key) continue;
                    this._sessionCache.set(key, {
                        isTradingDay: Boolean(day.isTradingDay),
                        openTs: day.startTime ? new Date(day.startTime).getTime() : null,
                        closeTs: day.endTime ? new Date(day.endTime).getTime() : null,
                    });
                }
            } catch { /* ниже отработает запасное окно */ }
        }
        const entry = this._sessionCache.get(dateKey);
        if (entry) {
            if (!entry.isTradingDay) return false;
            if (entry.openTs && entry.closeTs) {
                const ts = now.getTime();
                return ts >= entry.openTs && ts <= entry.closeTs;
            }
            return true;
        }
        const msk = new Date(now.getTime() + MSK_OFFSET_MS);
        const minutes = msk.getUTCHours() * 60 + msk.getUTCMinutes();
        return minutes >= 6 * 60 + 50 && minutes <= 23 * 60 + 50;
    }

    /** Silence watchdog of the whole stream. @private */
    _startStallWatchdog() {
        if (this._stallTimeoutMs <= 0 || this._stallTimer) return;
        this._stallTimer = setInterval(() => {
            this._checkStall(new Date()).catch((error) => {
                console.error(`[MultiTinkoff] Сторож молчания упал: ${error.message}`);
            });
        }, 60_000);
        this._stallTimer.unref?.();
    }

    /** @private */
    async _checkStall(now) {
        // Outside a session silence is normal, not a failure. Without this check the
        // watchdog resubscribed every half hour all night, jerking a healthy connection.
        if (!await this._isWithinTradingSession(now)) {
            this._lastCandleWall = now.getTime();
            return;
        }
        const silent = now.getTime() - this._lastCandleWall;
        if (silent < this._stallTimeoutMs) return;
        const minutes = Math.round(silent / 60000);
        if (this._stallReconnected) {
            // A resubscription happened and did not help. This cannot be fixed inside the
            // process: on 2026-10-08 the stream was silent for 7.5 hours and came back
            // only after a restart. The stream ends with an error, the process exits with
            // code 1, systemd starts a new one, and positions are restored from the account.
            this._fail(new Error(
                `Тишина ${minutes} мин после переподписки — стрим не восстановился, нужен перезапуск процесса.`,
            ));
            return;
        }
        // Silence across the WHOLE universe during an open session is a stream failure,
        // not a quiet market: at least one liquid instrument trades every minute.
        console.warn(
            `[MultiTinkoff] Тишина ${minutes} мин по всем `
            + `${this.instruments.length} инструментам при открытой сессии — переподписка.`,
        );
        this._lastCandleWall = now.getTime();
        this._stallReconnected = true;
        await this._forceReconnect();
    }

    /**
     * End the stream with an error: the engine rethrows it and the process exits with code 1.
     * @param {Error} error - Reason.
     * @private
     */
    _fail(error) {
        console.error(`[MultiTinkoff] ${error.message}`);
        this._fatal = error;
        if (this._stallTimer) { clearInterval(this._stallTimer); this._stallTimer = null; }
        if (this._notify) { const notify = this._notify; this._notify = null; notify(); }
    }

    /**
     * Resubscribe without bringing the process down: recreate the stream in a new call,
     * then catch up what was missed. If the subscription fails, the client retries — with
     * back-off and catch-up.
     * @private
     */
    async _forceReconnect() {
        if (this._closed) return;
        // The bounds are taken BEFORE resubscribing: otherwise the first live candle
        // would move "the last known" forward and the missed interval would not be
        // fetched. The catch-up itself runs after: it is dozens of sequential REST
        // requests, and there is no reason to keep the stream down all that time.
        const bounds = new Map(this._lastTimeByTicker);
        try {
            await this.client.restartMarketStream("candle silence");
        } catch (error) {
            console.warn(`[MultiTinkoff] Переподписка не удалась: ${error.message}.`);
            return;
        }
        console.log("[MultiTinkoff] Подписка на свечи восстановлена (процесс жив).");
        try {
            await this._catchUpAll(bounds);
        } catch (error) {
            console.warn(`[MultiTinkoff] Догрузка после переподписки не удалась: ${error.message}`);
        }
    }

    /**
     * Catch up what each instrument missed after a reconnect. Candles older than the last
     * one are marked noTrade: their close is stale, and an order on it would fill far
     * from the modelled price.
     * @private
     */
    async _catchUpAll(bounds = null) {
        const now = new Date();
        for (const ticker of this.getSymbols()) {
            const lower = (bounds ?? this._lastTimeByTicker).get(ticker)
                ?? this._catchUpFrom?.getTime() ?? null;
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
        // Caught-up candles are released immediately: the grace window does not apply.
        const latest = Math.max(...[...this._lastTimeByTicker.values()], 0);
        if (latest > 0) this._flushUpTo(latest);
    }

    /**
     * History of a specific instrument.
     * @param {object} params - { ticker, from, to, interval }.
     * @returns {Promise<Array<object>>} Candles.
     */
    async getHistory({ ticker, until, ...params } = {}) {
        if (!ticker) throw new Error("getHistory requires a ticker on a multi-symbol source");
        return this._provider(ticker).getCandles({ interval: this.interval, ...params });
    }

    /**
     * Trading schedule for an instrument.
     * @param {object} params - { ticker, from, to }.
     * @returns {Promise<Array<object>>} Trading days.
     */
    async getTradingSchedule({ ticker, from, to, ...params } = {}) {
        const instrument = ticker ? this.byTicker.get(ticker) : this.instruments[0];
        // The exchange schedule is live, not derived from data: without a date range the
        // API returns an empty list. Silently returning nothing here would leave the
        // strategy without a single trading day and without a single error in the log.
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

    /** Stop the stream and drop the subscription. */
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
