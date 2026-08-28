import { evaluateIntrabarStop } from "../../core/stops.js";

/**
 * Исполнитель для мультитикерного бэктеста: одна касса, k одновременных позиций
 * по разным бумагам.
 *
 * Движок остаётся однопозиционным по своему контракту — и это намеренно. Он
 * обрабатывает по одной свече за такт, а у свечи есть тикер, поэтому
 * `getPosition()`/`closePosition()`/`checkStops()` отвечают про позицию **той
 * бумаги, чья свеча сейчас в работе**. Так проверки SL/TP и таймаута движка
 * работают над мультипозиционным портфелем без единой правки в `core/engine.js`.
 *
 * Слот резервируется в момент постановки ордера, а не заливки: капитал
 * распределяется решением, а не случайностью порядка прихода свечей. Иначе два
 * ордера на последний свободный слот привели бы к тому, что второй молча
 * пропадает.
 *
 * Заливка — по open следующей свечи ТОЙ ЖЕ бумаги (`fillOnNextOpen`), как в
 * однобумажном исполнителе. Стопы исполняются внутри свечи по уровню, в обход
 * буфера: биржевой стоп срабатывает при касании, а не на открытии следующего бара.
 */
export class MultiSymbolExecutor {
    /**
     * @param {object} params - Параметры.
     * @param {import("../../core/slot-portfolio.js").SlotPortfolio} params.portfolio - Портфель.
     * @param {boolean} [params.fillOnNextOpen] - Заливать по open следующей свечи.
     * @param {boolean} [params.intrabarStops] - Внутрисвечные SL/TP.
     * @param {Map<string, object>} [params.instruments] - Тикер → инструмент (лот).
     */
    constructor({ portfolio, fillOnNextOpen = false, intrabarStops = false, instruments = null }) {
        this.portfolio = portfolio;
        this.fillOnNextOpen = fillOnNextOpen;
        this.intrabarStops = intrabarStops;
        this.instruments = instruments instanceof Map ? instruments : new Map();

        this.currentCandle = null;
        this.currentTicker = null;
        /** Последняя виденная цена бумаги — для переоценки и финального закрытия. */
        this.lastCandle = new Map();
        /** Тикер → отложенный ордер { type, slot, sl, tp, exitDeadline, size, reason }. */
        this._pending = new Map();
        /** Слоты, занятые под ещё не залитые ордера. */
        this._reserved = new Set();

        /** Точки капитала и их время — по одной на минуту (конец батча). */
        this.equity = [];
        this.timeline = [];
    }

    // ── контракт движка ─────────────────────────────────────────────────────

    /**
     * Свеча такта. Заливает отложенный ордер этой бумаги по её open.
     * @param {object} candle - Свеча с полем ticker.
     */
    setCurrentCandle(candle) {
        this.currentCandle = candle;
        this.currentTicker = candle?.ticker ?? null;
        if (candle) this.lastCandle.set(this.currentTicker, candle);

        if (!this.fillOnNextOpen || !candle) return;
        const pending = this._pending.get(this.currentTicker);
        if (pending) this._settle(pending, candle.open, candle.datetime);
    }

    /** Позиция бумаги, чья свеча в работе. @returns {object|null} Позиция. */
    getPosition() {
        const found = this.currentTicker ? this.portfolio.positionOf(this.currentTicker) : null;
        return found ? found.position : null;
    }

    /** Свободный кэш. @returns {number} Кэш. */
    getBalance() {
        return this.portfolio.cash;
    }

    /**
     * Внутрисвечный SL/TP по текущей бумаге: закрывает ровно по уровню, в обход
     * буфера отложенных ордеров.
     * @param {object} candle - Текущая свеча.
     * @returns {object|null} Сделка.
     */
    checkStops(candle) {
        const found = this.portfolio.positionOf(candle?.ticker);
        if (!found) return null;
        const reason = evaluateIntrabarStop(found.position, candle);
        if (!reason) return null;

        this._cancelPending(candle.ticker);
        return this.portfolio.close(found.slot, {
            price: reason === "sl" ? found.position.sl : found.position.tp,
            datetime: candle.datetime,
            reason,
        });
    }

    /**
     * Закрыть позицию текущей бумаги (или указанной явно).
     * @param {string} [reason] - Причина выхода.
     * @param {string} [ticker] - Бумага; по умолчанию — текущая.
     * @returns {object|null} Сделка при немедленном закрытии.
     */
    closePosition(reason = "manual", ticker = this.currentTicker) {
        const found = this.portfolio.positionOf(ticker);
        if (!found) return null;

        if (this.fillOnNextOpen) {
            // Один буфер на бумагу: повторный сигнал выхода в том же такте
            // (например, стоп и расписание сразу) не должен ставить второй ордер.
            if (!this._pending.has(ticker)) {
                this._pending.set(ticker, { type: "close", ticker, slot: found.slot, reason });
            }
            return null;
        }
        return this.portfolio.close(found.slot, {
            price: this.lastCandle.get(ticker)?.close, datetime: this.currentCandle?.datetime, reason,
        });
    }

    /**
     * Состояние в стратегию. Здесь же — отметка капитала на конце минуты:
     * при нескольких открытых позициях она считается по ценам всех удерживаемых
     * бумаг сразу, поэтому одна точка на минуту, а не на свечу.
     * @param {object} strategy - Стратегия.
     */
    syncStrategyState(strategy) {
        strategy._position = this.getPosition();
        strategy.cash = this.portfolio.cash;
        if (this.currentCandle?.isBatchEnd) {
            this.equity.push(this.getEquity());
            this.timeline.push(this.currentCandle.datetime);
        }
    }

    // ── контракт стратегии ──────────────────────────────────────────────────

    /**
     * Открыть шорт по бумаге. Слот резервируется сразу.
     * @param {object} order - { ticker, size, sl, tp, exitDeadline }.
     * @returns {boolean} Принят ли ордер.
     */
    sell(order = {}) {
        return this._queueOpen("short", order);
    }

    /**
     * Открыть лонг по бумаге.
     * @param {object} order - { ticker, size, sl, tp, exitDeadline }.
     * @returns {boolean} Принят ли ордер.
     */
    buy(order = {}) {
        return this._queueOpen("long", order);
    }

    /** Открытые позиции. @returns {Array<{slot: number, position: object}>} Позиции. */
    getPositions() {
        const out = [];
        this.portfolio.positions.forEach((position, slot) => {
            if (position) out.push({ slot, position });
        });
        return out;
    }

    /**
     * Позиция по бумаге.
     * @param {string} ticker - Тикер.
     * @returns {object|null} Позиция.
     */
    getPositionOf(ticker) {
        return this.portfolio.positionOf(ticker)?.position ?? null;
    }

    /** Есть ли по бумаге позиция или неисполненный ордер. @returns {boolean} Занята ли. */
    isBusy(ticker) {
        return Boolean(this.portfolio.positionOf(ticker)) || this._pending.has(ticker);
    }

    /** Сколько слотов свободно с учётом резервов. @returns {number} Свободно. */
    freeSlots() {
        let n = 0;
        this.portfolio.positions.forEach((position, slot) => {
            if (!position && !this._reserved.has(slot)) n += 1;
        });
        return n;
    }

    /** Капитал по последним известным ценам удерживаемых бумаг. @returns {number} Капитал. */
    getEquity() {
        return this.portfolio.equity(
            (_slot, position) => this.lastCandle.get(position.ticker)?.close ?? position.entryPrice,
        );
    }

    // ── внутреннее ──────────────────────────────────────────────────────────

    /** @private */
    _queueOpen(side, { ticker = this.currentTicker, size = null, sl = null, tp = null, exitDeadline = null } = {}) {
        if (!ticker || this.isBusy(ticker)) return false;
        const slot = this.portfolio.positions.findIndex(
            (position, i) => !position && !this._reserved.has(i),
        );
        if (slot < 0) return false;

        const order = { type: `open-${side}`, ticker, slot, size, sl, tp, exitDeadline };
        this._reserved.add(slot);
        if (this.fillOnNextOpen) {
            this._pending.set(ticker, order);
            return true;
        }
        const candle = this.lastCandle.get(ticker);
        this._settle(order, candle?.close, candle?.datetime);
        return true;
    }

    /** @private */
    _settle(order, price, datetime) {
        this._pending.delete(order.ticker);
        this._reserved.delete(order.slot);
        if (!Number.isFinite(price)) return;

        if (order.type === "close") {
            const found = this.portfolio.positionOf(order.ticker);
            if (found) this.portfolio.close(found.slot, { price, datetime, reason: order.reason });
            return;
        }
        if (this.portfolio.positions[order.slot]) return;   // слот успели занять — не удваиваем
        this.portfolio.open(order.slot, {
            side: order.type === "open-long" ? "long" : "short",
            price, datetime, ticker: order.ticker,
            lot: Number(this.instruments.get(order.ticker)?.lot) || 1,
            size: order.size,
            budget: this.portfolio.budgetFor(this.getEquity()),
            sl: order.sl, tp: order.tp, exitDeadline: order.exitDeadline,
        });
    }

    /** @private */
    _cancelPending(ticker) {
        const pending = this._pending.get(ticker);
        if (!pending) return;
        this._pending.delete(ticker);
        this._reserved.delete(pending.slot);
    }

    /**
     * Конец данных: залить всё, что висит, и закрыть остатки по последним ценам.
     * Дальше некуда — следующей свечи не будет.
     */
    flush() {
        for (const order of [...this._pending.values()]) {
            const candle = this.lastCandle.get(order.ticker);
            this._settle(order, candle?.close, candle?.datetime);
        }
        for (const { slot, position } of this.getPositions()) {
            const candle = this.lastCandle.get(position.ticker);
            this.portfolio.close(slot, {
                price: candle?.close ?? position.entryPrice,
                datetime: candle?.datetime ?? position.entryTime,
                reason: "eod",
            });
        }
        if (this.equity.length > 0) this.equity[this.equity.length - 1] = this.getEquity();
    }
}
