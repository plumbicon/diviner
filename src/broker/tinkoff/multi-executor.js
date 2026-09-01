/**
 * Живой исполнитель на несколько одновременных позиций.
 *
 * Отдельный класс, а не правка {@link TinkoffExecutor}: однопозиционный держит
 * однобумажных боевых ботов с реальными деньгами. Здесь повторены все его защиты, но
 * заведены по бумагам: своё состояние, свой файл состояния, свой таймер дедлайна.
 *
 * Распределение депозита исполнитель НЕ решает — стратегия передаёт в ордере
 * сумму (`budget`), а он лишь переводит её в лоты по цене исполнения. Сколько
 * бумаг держать и в какой пропорции делить кассу — вопрос стратегии.
 *
 * Очередь ордеров одна на всех: биржевые заявки должны уходить по очереди, иначе
 * частичное исполнение одной перемешается с откатом другой.
 */
import { join } from "node:path";
import { OrderManager } from "./order-manager.js";
import { PositionStore } from "../common/position-store.js";
import { evaluateIntrabarStop, classifyStopExit } from "../../core/stops.js";
import { buildOrderId, quotationToNumber } from "./broker.js";
import { SIZING_SLIPPAGE_PAD } from "../../core/portfolio.js";

// Через сколько повторить закрытие по дедлайну, если бумага занята заявкой.
const DEADLINE_RETRY_MS = 15_000;

// Отказы, которые повтором не лечатся: инструмент недоступен этому счёту, пока
// пользователь не пройдёт тест в приложении или пока биржа не снимет запрет.
// Сообщения приходят транслитом, поэтому ищем по латинскому написанию тоже.
const PERMANENT_REJECTIONS = [
    /neobxodimo projti/i,           // «необходимо пройти соответствующий тест»
    /необходимо пройти/i,
    /not available for short/i,
    /instrument is not available/i,
    /trading is not available/i,
];

// Отказы из-за нехватки денег: зависят от кассы, снимаются при её росте.
const SOFT_REJECTIONS = [
    /not enough assets/i,
    /insufficient/i,
    /недостаточно/i,
];

// Во сколько раз должна вырасти касса, чтобы снять мягкую блокировку. Отказ
// пришёл на конкретную сумму залога — пробовать снова имеет смысл, когда денег
// стало ощутимо больше, а не после копеечного движения баланса.
const BLOCK_RELEASE_RATIO = 1.25;

export class MultiSymbolTinkoffExecutor {
    /**
     * @param {object} params - Параметры.
     * @param {object} params.client - TinkoffClient.
     * @param {Array<object>} params.instruments - Инструменты вселенной.
     * @param {number} [params.interval] - Интервал свечей, минут.
     * @param {object} [params.options] - Опции брокера.
     */
    constructor({ client, instruments, interval = 1, options = {} }) {
        this.client = client;
        this.options = options;
        this.verbose = Boolean(options.verbose);
        this.dryRun = Boolean(options.dryRun);
        this.orderTag = options.orderTag || "div";
        this.intrabarStops = Boolean(options.intrabarStops);

        this.byTicker = new Map(instruments.map((i) => [i.ticker, i]));
        // Заменяемый снаружи — иначе поведение при отказе биржи не проверить
        // иначе как настоящей заявкой.
        this.orderManager = options.orderManager
            || new OrderManager(client, { verbose: this.verbose, dryRun: this.dryRun });

        const intervalMs = (Number(interval) || 1) * 60 * 1000;
        this.maxEntryAgeMs = Number.isFinite(options.maxEntryAgeMs)
            ? options.maxEntryAgeMs
            : intervalMs * 2 + 30_000;

        this.leverage = Number.isFinite(Number(options.leverage)) && Number(options.leverage) > 0
            ? Number(options.leverage) : 1;
        this.confirmMarginTrade = this.leverage > 1;
        this.commission = Number.isFinite(Number(options.commission)) && Number(options.commission) >= 0
            ? Number(options.commission) : 0.0005;

        const accountId = client?.accountId || "acc";
        const stateDir = options.stateDir || join(process.cwd(), ".diviner-state");
        /** Тикер → { position, store, exitTimer }. */
        this.slots = new Map();
        for (const instrument of instruments) {
            this.slots.set(instrument.ticker, {
                position: null,
                store: new PositionStore(
                    join(stateDir, `${accountId}_${instrument.ticker}.json`),
                    { verbose: this.verbose },
                ),
                exitTimer: null,
            });
        }

        this.accountRubBalance = 0;
        this._balanceAt = 0;
        // Как часто перечитывать остаток вне зависимости от сделок: со счёта
        // деньги уходят и помимо наших заявок — комиссия за операцию, абонентская
        // плата, вывод. Кэш при этом становится завышенным, и заявка уходит на
        // сумму, которой уже нет.
        this.balanceMaxAgeMs = Number.isFinite(options.balanceMaxAgeMs)
            ? options.balanceMaxAgeMs : 60_000;
        this.currentCandle = null;
        this.currentTicker = null;
        this.lastCandle = new Map();
        /** Тикер → true, пока ордер по бумаге в очереди. */
        this._inFlight = new Set();
        /**
         * Тикер → причина отказа биржи, из-за которой бумагу нельзя торговать.
         * Без этого стратегия каждый раз отдаёт свободный слот одному и тому же
         * лучшему кандидату, заявка по нему отклоняется, слот откатывается — и
         * бумага, которую взять можно, шанса не получает вовсе.
         */
        this._blocked = new Map();
        this.orderQueue = Promise.resolve();
        this.sessionTrades = [];
    }

    // ── контракт движка ─────────────────────────────────────────────────────

    /** Стартовая сверка: баланс и реальные позиции по всей вселенной. */
    async init() {
        await this.refreshBalance();
        await this.syncWithAccountPositions();
    }

    setCurrentCandle(candle) {
        this.currentCandle = candle;
        this.currentTicker = candle?.ticker ?? null;
        if (candle?.ticker) this.lastCandle.set(candle.ticker, candle);

        // Конец минуты — момент, когда стратегия считает бюджет. Ставим обновление
        // остатка в очередь заявок: движок ждёт её через drainOrders(), поэтому к
        // следующему решению цифра будет свежей. Синхронно спросить нельзя —
        // стратегия вызывает getEquity() без await.
        if (candle?.isBatchEnd && Date.now() - this._balanceAt > this.balanceMaxAgeMs) {
            this._enqueue("balance", () => this.refreshBalance());
        }
    }

    /** Позиция бумаги текущей свечи (движок спрашивает про неё). */
    getPosition() {
        return this.currentTicker ? (this.slots.get(this.currentTicker)?.position ?? null) : null;
    }

    getBalance() {
        return this.accountRubBalance;
    }

    /**
     * Внутрисвечный SL/TP по бумаге свечи. В live «внутрисвечно» означает по
     * high/low пришедшей закрытой свечи: тика мы не видим, и это единственный
     * доступный признак касания уровня.
     * @param {object} candle - Свеча.
     * @returns {object|null} Закрытая позиция.
     */
    checkStops(candle) {
        const slot = this.slots.get(candle?.ticker);
        if (!slot?.position) return null;
        const reason = evaluateIntrabarStop(slot.position, candle);
        if (!reason) return null;
        // sl покрывает и защитный стоп, и трейлинг — в отчёте это разные события.
        return this.closePosition(reason === "sl" ? classifyStopExit(slot.position) : reason, candle.ticker);
    }

    syncStrategyState(strategy) {
        strategy._position = this.getPosition();
        strategy.cash = this.accountRubBalance;
    }

    /** Дождаться, пока все поставленные заявки отработают. */
    async drainOrders() {
        await this.orderQueue;
    }

    // ── контракт стратегии ──────────────────────────────────────────────────

    /** Открытые позиции. @returns {Array<object>} Позиции. */
    getPositions() {
        const out = [];
        for (const slot of this.slots.values()) if (slot.position) out.push(slot.position);
        return out;
    }

    /**
     * Позиция по бумаге.
     * @param {string} ticker - Тикер.
     * @returns {object|null} Позиция.
     */
    getPositionOf(ticker) {
        return this.slots.get(ticker)?.position ?? null;
    }

    /** Бумаги с заявкой в полёте. @returns {Array<string>} Тикеры. */
    getPendingTickers() {
        return [...this._inFlight];
    }

    /**
     * Занята ли бумага: есть позиция или заявка в полёте.
     * @param {string} ticker - Тикер.
     * @returns {boolean} Занята.
     */
    isBusy(ticker) {
        return this._inFlight.has(ticker) || Boolean(this.slots.get(ticker)?.position);
    }

    /**
     * Заблокирована ли бумага отказом биржи.
     *
     * Отказы бывают двух родов. «Нужен тест в Профиле» и запрет инструмента —
     * до конца процесса: повтор через минуту ничего не меняет. Нехватка залога
     * зависит от кассы, поэтому снимается, когда свободных денег стало заметно
     * больше, чем в момент отказа, — обычно после закрытия позиции.
     *
     * @param {string} ticker - Тикер.
     * @returns {boolean} Торговать нельзя.
     */
    isBlocked(ticker) {
        const block = this._blocked.get(ticker);
        if (!block) return false;
        if (block.permanent) return true;
        if (this.accountRubBalance > block.balanceAt * BLOCK_RELEASE_RATIO) {
            this._blocked.delete(ticker);
            console.log(
                `[MultiExec] ${ticker}: блокировка снята — касса выросла `
                + `с ${block.balanceAt.toFixed(0)} до ${this.accountRubBalance.toFixed(0)} ₽.`,
            );
            return false;
        }
        return true;
    }

    /** Заблокированные бумаги и причины — для отчёта на выходе. */
    getBlocked() {
        return [...this._blocked].map(([ticker, b]) => ({ ticker, ...b }));
    }

    /**
     * Запомнить отказ биржи по бумаге.
     * @param {string} ticker - Тикер.
     * @param {string} message - Текст ошибки от API.
     * @private
     */
    _blockTicker(ticker, message) {
        if (this._blocked.has(ticker)) return;
        const permanent = PERMANENT_REJECTIONS.some((rx) => rx.test(message));
        const soft = SOFT_REJECTIONS.some((rx) => rx.test(message));
        // Незнакомую ошибку блокируем мягко: она может быть разовой (таймаут,
        // сеть), но крутить её каждую минуту всё равно незачем.
        if (!permanent && !soft) {
            this._blocked.set(ticker, {
                permanent: false, balanceAt: this.accountRubBalance, message,
            });
            console.warn(`[MultiExec] ${ticker}: незнакомый отказ, бумага отложена до роста кассы.`);
            return;
        }
        this._blocked.set(ticker, {
            permanent, balanceAt: this.accountRubBalance, message,
        });
        console.warn(
            permanent
                ? `[MultiExec] ${ticker}: бумага исключена до перезапуска — биржа отказывает постоянно.`
                : `[MultiExec] ${ticker}: не хватает залога, бумага отложена до роста кассы `
                  + `(сейчас ${this.accountRubBalance.toFixed(0)} ₽).`,
        );
    }

    /**
     * Капитал: свободный кэш плюс маржа и нереализованный P&L по позициям.
     * @returns {number} Капитал.
     */
    getEquity() {
        let total = this.accountRubBalance;
        for (const [ticker, slot] of this.slots) {
            const position = slot.position;
            if (!position) continue;
            const price = this.lastCandle.get(ticker)?.close ?? position.entryPrice;
            const shares = position.size * (this.byTicker.get(ticker)?.lot || 1);
            total += (shares * position.entryPrice) / this.leverage
                + shares * (position.entryPrice - price);
        }
        return total;
    }

    /**
     * Открыть шорт по бумаге.
     * @param {object} order - { ticker, budget, size, sl, tp, exitDeadline }.
     * @returns {object|null} Оптимистично открытая позиция либо null.
     */
    sell(order = {}) {
        return this._open("short", order);
    }

    /**
     * Открыть лонг по бумаге.
     * @param {object} order - См. {@link sell}.
     * @returns {object|null} Позиция.
     */
    buy(order = {}) {
        return this._open("long", order);
    }

    /** @private */
    _open(side, { ticker = this.currentTicker, size = null, budget = null,
                  sl = null, tp = null, exitDeadline = null } = {}) {
        const slot = this.slots.get(ticker);
        const instrument = this.byTicker.get(ticker);
        if (!slot || !instrument) return null;

        if (slot.position || this._inFlight.has(ticker)) {
            if (this.verbose) console.log(`[MultiExec] ${ticker}: пропуск — бумага уже занята`);
            return null;
        }
        // Страховка на случай, если стратегия блокировку не спросила: иначе
        // отказ повторится и слот снова уйдёт впустую.
        if (this.isBlocked(ticker)) {
            if (this.verbose) console.log(`[MultiExec] ${ticker}: пропуск — бумага заблокирована отказом`);
            return null;
        }
        // Разогревочная свеча из догрузки: состояние обновляет, торговать не должна —
        // её close уже неактуален.
        if (this.currentCandle?.noTrade) return null;

        // Страховка на случай, если разогревочная метка не проставилась: ордер по
        // устаревшей свече исполнится по цене переподключения, а не по той, на
        // которой принято решение.
        const candleTime = this.currentCandle?.datetime instanceof Date
            ? this.currentCandle.datetime.getTime() : null;
        if (candleTime !== null) {
            const ageMs = Date.now() - candleTime;
            if (ageMs > this.maxEntryAgeMs) {
                console.warn(
                    `[MultiExec] ${ticker}: вход отменён — свеча старше `
                    + `${Math.round(ageMs / 1000)}с (порог ${Math.round(this.maxEntryAgeMs / 1000)}с).`,
                );
                return null;
            }
        }

        const price = this.lastCandle.get(ticker)?.close ?? this.currentCandle?.close;
        const lots = size ?? this._lotsFor(ticker, price, budget);
        if (!Number.isFinite(lots) || lots <= 0) {
            if (this.verbose) console.log(`[MultiExec] ${ticker}: пропуск — размер 0 (бюджет ${budget})`);
            return null;
        }

        const position = {
            side, size: lots, ticker,
            entryPrice: price,
            entryTime: this.currentCandle?.datetime ?? new Date(),
            sl, tp, exitDeadline,
        };
        slot.position = position;
        slot.store.save({
            figi: instrument.figi, ticker, side, size: lots,
            entryPrice: price ?? null,
            entryTime: position.entryTime instanceof Date ? position.entryTime.toISOString() : null,
            sl: sl ?? null, tp: tp ?? null, exitDeadline: exitDeadline ?? null,
        });
        this._armExitDeadline(ticker, exitDeadline);
        this._inFlight.add(ticker);
        this._enqueue(ticker, () => this._executeOrder(ticker, side === "long" ? "buy" : "sell", lots));
        return position;
    }

    /**
     * Закрыть позицию по бумаге.
     * @param {string} [reason] - Причина.
     * @param {string} [ticker] - Тикер; по умолчанию — бумага текущей свечи.
     * @returns {object|null} Закрытая позиция.
     */
    closePosition(reason = "manual", ticker = this.currentTicker) {
        const slot = this.slots.get(ticker);
        if (!slot?.position) return null;
        if (this._inFlight.has(ticker)) {
            if (this.verbose) console.log(`[MultiExec] ${ticker}: выход отложен — по бумаге уже есть заявка`);
            return null;
        }
        this._clearExitDeadline(ticker);
        const closed = slot.position;
        slot.position = null;
        slot.store.clear();
        this._inFlight.add(ticker);
        this._enqueue(ticker, () => this._closeRealPosition(ticker, closed, reason));
        return closed;
    }

    // ── внутренности ────────────────────────────────────────────────────────

    /**
     * Размер в ЛОТАХ из выделенной суммы. Резервируем известные издержки: при
     * неблагоприятном исполнении (+SIZING_SLIPPAGE_PAD) маржа и комиссия обязаны
     * уложиться в бюджет. Для шорта размер дополнительно ограничен реальной
     * ставкой риска брокера (dshortClient), иначе заявку отклонят.
     * @private
     */
    _lotsFor(ticker, price, budget) {
        const instrument = this.byTicker.get(ticker);
        if (!instrument || !Number.isFinite(price) || price <= 0) return 0;
        const available = Number.isFinite(budget) && budget > 0
            ? Math.min(budget, this.accountRubBalance)
            : this.accountRubBalance;
        if (!(available > 0)) return 0;

        const lot = Number(instrument.lot) || 1;
        const priceFill = price * (1 + SIZING_SLIPPAGE_PAD);
        const perLotCost = priceFill * (1 / this.leverage + this.commission) * lot;
        let lots = Math.floor(available / perLotCost);

        const riskRate = quotationToNumber(instrument.dshortClient) ?? quotationToNumber(instrument.dshort);
        if (riskRate > 0) {
            const perLotMargin = priceFill * (riskRate + this.commission) * lot;
            lots = Math.min(lots, Math.floor(available / perLotMargin));
        }
        return Math.max(0, lots);
    }

    /** @private */
    _armExitDeadline(ticker, exitDeadline) {
        this._clearExitDeadline(ticker);
        if (exitDeadline == null || !Number.isFinite(exitDeadline)) return;
        const slot = this.slots.get(ticker);
        const delay = Math.max(0, exitDeadline - Date.now());
        // Дедлайн — событие часов, а не цены: он обязан сработать даже если под
        // конец сессии по бумаге не пришло ни одной свечи.
        slot.exitTimer = setTimeout(() => {
            slot.exitTimer = null;
            if (!slot.position) return;
            console.log(`[MultiExec] ${ticker}: дедлайн ${new Date(exitDeadline).toISOString()} — закрываем по рынку.`);
            if (this.closePosition("time", ticker)) return;
            // Закрыть не дали (по бумаге висит заявка). Таймер уже израсходован, и
            // без повтора позиция уехала бы за сессию: свечей под её конец может
            // не прийти вовсе, а значит и повтора по свече не будет.
            console.warn(`[MultiExec] ${ticker}: дедлайн отложен — повтор через ${Math.round(DEADLINE_RETRY_MS / 1000)} с.`);
            slot.exitTimer = setTimeout(() => {
                slot.exitTimer = null;
                if (slot.position) this.closePosition("time", ticker);
            }, DEADLINE_RETRY_MS);
            slot.exitTimer.unref?.();
        }, delay);
        slot.exitTimer.unref?.();
    }

    /** @private */
    _clearExitDeadline(ticker) {
        const slot = this.slots.get(ticker);
        if (slot?.exitTimer) { clearTimeout(slot.exitTimer); slot.exitTimer = null; }
    }

    /** @private */
    _enqueue(ticker, operation) {
        this.orderQueue = this.orderQueue
            .then(operation)
            .catch((error) => console.error(`[MultiExec] ${ticker}: очередь заявок упала — ${error.message}`))
            .finally(() => { this._inFlight.delete(ticker); });
        return this.orderQueue;
    }

    /** @private */
    _orderId(ticker, action, direction) {
        const at = this.currentCandle?.datetime instanceof Date ? this.currentCandle.datetime : new Date();
        return buildOrderId({ tag: this.orderTag, ticker, action, direction, at });
    }

    /** @private */
    async _executeOrder(ticker, direction, lots) {
        const instrument = this.byTicker.get(ticker);
        const slot = this.slots.get(ticker);
        try {
            // Во время аукциона открытия и дискретных аукционов биржа замораживает
            // цену и отклоняет рыночные заявки, хотя сессия формально открыта.
            const status = await this.client.getTradingStatus?.(instrument.figi);
            if (status && status.marketOrderAvailableFlag === false) {
                console.warn(`[MultiExec] ${ticker}: рыночные заявки недоступны (аукцион) — вход отменён.`);
                this._abortEntry(ticker);
                return;
            }
            const result = await this.orderManager.postMarketOrder({
                figi: instrument.figi,
                instrumentId: instrument.uid || instrument.figi,
                quantity: lots,
                direction,
                orderId: this._orderId(ticker, "open", direction),
                confirmMarginTrade: this.confirmMarginTrade,
            });
            const summary = this.client.getOrderExecutionSummary(result);
            const executed = summary.lotsExecuted ?? lots;
            this.sessionTrades.push({
                kind: "open", ticker, direction, lots: executed,
                at: new Date(), fillPrice: summary.avgPrice ?? null,
            });
            const fill = summary.avgPrice != null ? ` @ ${summary.avgPrice}` : "";
            console.log(
                `[MultiExec] Open order executed: ${ticker} ${direction} ${executed}/${lots} lots${fill}`
                + ` (${summary.statusName})`,
            );
            if (executed !== lots && slot.position) {
                console.warn(`[MultiExec] ${ticker}: исполнено ${executed} из ${lots} лотов — правим состояние.`);
                slot.position.size = executed;
                if (executed <= 0) this._abortEntry(ticker);
            }
        } catch (error) {
            console.error(`[MultiExec] ${ticker}: заявка не прошла — ${error.message}`);
            this._abortEntry(ticker);
            this._blockTicker(ticker, error.message || "");
        }
        // Вход занял маржу: без перечитывания остаток остался бы доходовым, а
        // getEquity() посчитал бы маржу дважды — и следующий слот запросил бы
        // больше, чем есть на счёте.
        await this.refreshBalance();
    }

    /** Откат оптимистично открытой позиции, если вход не состоялся. @private */
    _abortEntry(ticker) {
        this._clearExitDeadline(ticker);
        const slot = this.slots.get(ticker);
        if (slot) { slot.position = null; slot.store.clear(); }
    }

    /** @private */
    async _closeRealPosition(ticker, position, reason) {
        const instrument = this.byTicker.get(ticker);
        const slot = this.slots.get(ticker);
        try {
            const direction = position.side === "short" ? "buy" : "sell";
            const result = await this.orderManager.closePosition({
                figi: instrument.figi,
                instrumentId: instrument.uid || instrument.figi,
                quantity: position.size,
                currentSide: position.side,
                orderId: this._orderId(ticker, "close", direction),
            });
            const summary = this.client.getOrderExecutionSummary(result);
            const executed = summary.lotsExecuted ?? position.size;
            if (executed <= 0) throw new Error(`ордер не исполнен (${summary.statusName})`);
            if (executed < position.size) {
                // Закрылись не полностью — остаток возвращаем в состояние, иначе
                // он останется на счёте без нашего ведома и без защиты. Файл
                // состояния был очищен при постановке заявки, поэтому пишем заново:
                // иначе после рестарта остаток подняли бы со счёта без уровней.
                const rest = { ...position, size: position.size - executed };
                slot.position = rest;
                slot.store.save({
                    figi: instrument.figi, ticker, side: rest.side, size: rest.size,
                    entryPrice: rest.entryPrice ?? null,
                    entryTime: rest.entryTime instanceof Date ? rest.entryTime.toISOString() : null,
                    sl: rest.sl ?? null, tp: rest.tp ?? null, exitDeadline: rest.exitDeadline ?? null,
                });
                this._armExitDeadline(ticker, rest.exitDeadline);
                console.warn(`[MultiExec] ${ticker}: закрыто ${executed} из ${position.size} лотов, остаток под наблюдением.`);
            }
            this.sessionTrades.push({
                kind: "close", ticker, reason, lots: executed,
                at: new Date(), fillPrice: summary.avgPrice ?? null,
            });
            const fill = summary.avgPrice != null ? ` @ ${summary.avgPrice}` : "";
            console.log(
                `[MultiExec] Close order executed: ${ticker} ${position.side} ${executed}/${position.size} lots`
                + `${fill} [reason=${reason}] (${summary.statusName})`,
            );
        } catch (error) {
            // Позиция снята с учёта ДО отправки заявки (оптимистично). Если заявка
            // не прошла, на счёте она осталась — и оставить состояние пустым нельзя:
            // бумага считалась бы свободной, стратегия вошла бы в неё повторно и
            // удвоила экспозицию, а прежняя позиция осталась бы без стопа и дедлайна.
            slot.position = position;
            slot.store.save({
                figi: instrument.figi, ticker, side: position.side, size: position.size,
                entryPrice: position.entryPrice ?? null,
                entryTime: position.entryTime instanceof Date ? position.entryTime.toISOString() : null,
                sl: position.sl ?? null, tp: position.tp ?? null,
                exitDeadline: position.exitDeadline ?? null,
            });
            this._armExitDeadline(ticker, position.exitDeadline);
            console.error(
                `[MultiExec] ${ticker}: ЗАКРЫТЬ НЕ УДАЛОСЬ (${error.message}). `
                + "Позиция возвращена в состояние под защиту стопа и дедлайна; попробуем на следующей свече.",
            );
        }
        await this.refreshBalance();
    }

    /** Обновить рублёвый остаток счёта. */
    async refreshBalance() {
        if (!this.client?.getRubBalance) return this.accountRubBalance;
        try {
            this.accountRubBalance = await this.client.getRubBalance(this.client.accountId);
            this._balanceAt = Date.now();
        } catch (error) {
            // Не роняем такт: работаем на прошлом значении, но не помечаем его
            // свежим, чтобы попытка повторилась на следующей минуте.
            console.error(`[MultiExec] Остаток счёта не получен — ${error.message}`);
        }
        return this.accountRubBalance;
    }

    /**
     * Сверка с реальными позициями счёта по всей вселенной. SL/TP и дедлайн
     * восстанавливаются из файла состояния бумаги; если файл не совпал с
     * позицией — она остаётся без защиты до тех пор, пока стратегия не выставит
     * уровни заново, и об этом надо сказать вслух.
     */
    async syncWithAccountPositions() {
        if (this.dryRun) return;
        let restored = 0;
        for (const [ticker, instrument] of this.byTicker) {
            const slot = this.slots.get(ticker);
            const lot = Number(instrument.lot) || 1;
            let live = null;
            try {
                live = await this.client.getInstrumentPosition(instrument.figi, lot);
            } catch (error) {
                console.error(`[MultiExec] ${ticker}: позицию счёта не получить — ${error.message}`);
                continue;
            }
            if (!live) {
                slot.position = null;
                slot.store.clear();
                continue;
            }
            const saved = slot.store.load();
            const matched = saved && saved.figi === instrument.figi && saved.side === live.side;
            const exitDeadline = matched ? (saved.exitDeadline ?? null) : null;
            slot.position = {
                side: live.side, size: live.lots, ticker,
                entryPrice: (matched && saved.entryPrice) || live.averagePrice || live.currentPrice || 0,
                entryTime: matched && saved.entryTime && !Number.isNaN(Date.parse(saved.entryTime))
                    ? new Date(saved.entryTime) : new Date(),
                sl: matched ? (saved.sl ?? null) : null,
                tp: matched ? (saved.tp ?? null) : null,
                exitDeadline,
                source: "account",
            };
            this._armExitDeadline(ticker, exitDeadline);
            restored += 1;
            console.warn(
                `[MultiExec] ${ticker}: на счёте ${live.side} ${live.lots} лот(ов) — состояние восстановлено`
                + `${matched ? ` (sl=${saved.sl} tp=${saved.tp})` : ", БЕЗ уровней защиты"}.`,
            );
        }
        console.log(`[MultiExec] Сверка со счётом: ${restored} открытых позиций из ${this.byTicker.size} бумаг.`);
    }
}
