import { evaluateIntrabarStop, classifyStopExit } from "../../core/stops.js";

/**
 * Исполнитель для мультитикерного бэктеста: одна касса, несколько одновременных
 * позиций по разным бумагам.
 *
 * Движок остаётся однопозиционным по своему контракту — и это намеренно. Он
 * обрабатывает по одной свече за такт, а у свечи есть тикер, поэтому
 * `getPosition()`/`closePosition()`/`checkStops()` отвечают про позицию **той
 * бумаги, чья свеча сейчас в работе**. Так проверки SL/TP и таймаута движка
 * работают над мультипозиционным портфелем без единой правки в `core/engine.js`.
 *
 * Сколько бумаг держать и в какой пропорции делить депозит — **не его дело**.
 * Это решение стратегии: она смотрит на капитал (`getEquity`), свои открытые
 * позиции и неисполненные ордера и передаёт в ордере сумму (`budget`) либо
 * готовый размер (`size`). Исполнитель отвечает за механику: перевести сумму в
 * лоты по цене исполнения, проверить кассу, вести позиции и стопы.
 *
 * Позиции ведутся по бумагам: на счёте по инструменту бывает одна нетто-позиция
 * — это ограничение биржи, поэтому повторный ордер по занятой бумаге отклоняется.
 *
 * Заливка — по open следующей свечи ТОЙ ЖЕ бумаги (`fillOnNextOpen`), как в
 * однобумажном исполнителе. Стопы исполняются внутри свечи по уровню, в обход
 * буфера: биржевой стоп срабатывает при касании, а не на открытии следующего бара.
 */
export class MultiSymbolExecutor {
    /**
     * @param {object} params - Параметры.
     * @param {import("../../core/multi-portfolio.js").MultiPortfolio} params.portfolio - Портфель.
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
        /** Тикер → отложенный ордер { type, budget, size, sl, tp, exitDeadline, reason }. */
        this._pending = new Map();

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
        return this.currentTicker ? this.portfolio.positionOf(this.currentTicker) : null;
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
        const position = this.portfolio.positionOf(candle?.ticker);
        if (!position) return null;
        const reason = evaluateIntrabarStop(position, candle);
        if (!reason) return null;

        this._pending.delete(candle.ticker);
        return this.portfolio.close(candle.ticker, {
            price: reason === "sl" ? position.sl : position.tp,
            datetime: candle.datetime,
            // Ярлык тот же, что в live: защитный стоп и трейлинг — разные события.
            reason: reason === "sl" ? classifyStopExit(position) : reason,
        });
    }

    /**
     * Закрыть позицию текущей бумаги (или указанной явно).
     * @param {string} [reason] - Причина выхода.
     * @param {string} [ticker] - Бумага; по умолчанию — текущая.
     * @returns {object|null} Сделка при немедленном закрытии.
     */
    closePosition(reason = "manual", ticker = this.currentTicker) {
        if (!this.portfolio.positionOf(ticker)) return null;

        if (this.fillOnNextOpen) {
            // Один буфер на бумагу: повторный сигнал выхода в том же такте
            // (например, стоп и расписание сразу) не должен ставить второй ордер.
            if (!this._pending.has(ticker)) {
                this._pending.set(ticker, { type: "close", ticker, reason });
            }
            return null;
        }
        return this.portfolio.close(ticker, {
            price: this.lastCandle.get(ticker)?.close, datetime: this.currentCandle?.datetime, reason,
        });
    }

    /**
     * Закрыть позицию немедленно по цене последней сделки бумаги (close её последней свечи),
     * сняв висящий ордер на закрытие. Нужен для выхода «в тот же день», когда следующей свечи
     * бумаги сегодня уже не будет: без него ордер ждал бы open следующей свечи — хоть через ночь,
     * хоть через два месяца простоя торгов.
     * @param {string} [reason] - Причина выхода.
     * @param {string} [ticker] - Бумага; по умолчанию — текущая.
     * @param {Date|null} [datetime] - Время выхода; по умолчанию — время последней свечи бумаги.
     * @returns {object|null} Сделка.
     */
    closeAtLast(reason = "manual", ticker = this.currentTicker, datetime = null) {
        const position = this.portfolio.positionOf(ticker);
        if (!position) return null;
        if (this._pending.get(ticker)?.type === "close") this._pending.delete(ticker);
        const candle = this.lastCandle.get(ticker);
        return this.portfolio.close(ticker, {
            price: candle?.close ?? position.entryPrice,
            datetime: datetime ?? candle?.datetime ?? this.currentCandle?.datetime,
            reason,
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
     * Открыть шорт по бумаге. Сумму (`budget`) или размер (`size`) задаёт
     * стратегия — распределение депозита между бумагами это её решение.
     * @param {object} order - { ticker, budget, size, sl, tp, exitDeadline }.
     * @returns {boolean} Принят ли ордер.
     */
    sell(order = {}) {
        return this._queueOpen("short", order);
    }

    /**
     * Открыть лонг по бумаге.
     * @param {object} order - { ticker, budget, size, sl, tp, exitDeadline }.
     * @returns {boolean} Принят ли ордер.
     */
    buy(order = {}) {
        return this._queueOpen("long", order);
    }

    /** Открытые позиции. @returns {Array<object>} Позиции. */
    getPositions() {
        return [...this.portfolio.positions.values()];
    }

    /**
     * Позиция по бумаге.
     * @param {string} ticker - Тикер.
     * @returns {object|null} Позиция.
     */
    getPositionOf(ticker) {
        return this.portfolio.positionOf(ticker);
    }

    /**
     * Бумаги с неисполненными ордерами. Стратегии это нужно, чтобы считать свою
     * занятость: ордер поставлен, но позиции ещё нет.
     * @returns {Array<string>} Тикеры.
     */
    getPendingTickers() {
        return [...this._pending.keys()];
    }

    /** Есть ли по бумаге позиция или неисполненный ордер. @returns {boolean} Занята ли. */
    isBusy(ticker) {
        return Boolean(this.portfolio.positionOf(ticker)) || this._pending.has(ticker);
    }

    /**
     * Заблокирована ли бумага отказом биржи. В симуляции отказов нет, но метод
     * обязан существовать: стратегия спрашивает его безусловно, и молчаливый
     * `undefined` из-за необязательного вызова снял бы защиту в бою.
     * @returns {boolean} Всегда false.
     */
    isBlocked() {
        return false;
    }

    /** Капитал по последним известным ценам удерживаемых бумаг. @returns {number} Капитал. */
    getEquity() {
        return this.portfolio.equity(
            (ticker) => this.lastCandle.get(ticker)?.close ?? null,
        );
    }

    // ── внутреннее ──────────────────────────────────────────────────────────

    /** @private */
    _queueOpen(side, { ticker = this.currentTicker, size = null, budget = null,
                      sl = null, tp = null, exitDeadline = null } = {}) {
        if (!ticker || this.isBusy(ticker)) return false;

        const order = { type: `open-${side}`, ticker, size, budget, sl, tp, exitDeadline };
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
        if (!Number.isFinite(price)) return;

        if (order.type === "close") {
            this.portfolio.close(order.ticker, { price, datetime, reason: order.reason });
            return;
        }
        this.portfolio.open(order.ticker, {
            side: order.type === "open-long" ? "long" : "short",
            price, datetime,
            lot: Number(this.instruments.get(order.ticker)?.lot) || 1,
            size: order.size,
            budget: order.budget,
            sl: order.sl, tp: order.tp, exitDeadline: order.exitDeadline,
        });
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
        for (const position of this.getPositions()) {
            const candle = this.lastCandle.get(position.ticker);
            this.portfolio.close(position.ticker, {
                price: candle?.close ?? position.entryPrice,
                datetime: candle?.datetime ?? position.entryTime,
                reason: "eod",
            });
        }
        if (this.equity.length > 0) this.equity[this.equity.length - 1] = this.getEquity();
    }
}
