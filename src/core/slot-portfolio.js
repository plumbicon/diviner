import { SIZING_SLIPPAGE_PAD } from "./portfolio.js";

/**
 * Портфель на k слотов с общей кассой.
 *
 * Кросс-секционная стратегия держит несколько бумаг одновременно, но касса у неё
 * одна: слот получает бюджет `капитал / k`, а не собственный счёт. Отсюда два
 * отличия от {@link Portfolio}: размер считается от выделенного бюджета, а не от
 * всего кэша, и лот берётся у инструмента сделки — у бумаг вселенной он разный.
 *
 * Арифметика (округление до лотов, резерв под комиссию и проскальзывание, маржа,
 * P&L) — копия Portfolio. При slots=1 бюджет слота равен всему кэшу, поэтому
 * прогон обязан совпасть с однопозиционным портфелем цифра в цифру; это и
 * проверяется тестом.
 */
export class SlotPortfolio {
    /**
     * @param {object} params - Параметры.
     * @param {number} [params.cash] - Стартовый капитал.
     * @param {number} [params.commission] - Комиссия за сторону.
     * @param {number} [params.slots] - Число слотов (одновременных позиций).
     * @param {number} [params.leverage] - Плечо шорта.
     */
    constructor({ cash = 10000, commission = 0.0005, slots = 1, leverage = 1 } = {}) {
        this.initialCash = cash;
        this.cash = cash;
        this.commission = commission;
        this.slots = Math.max(1, Math.floor(slots));
        this.leverage = Number.isFinite(Number(leverage)) && Number(leverage) > 0 ? Number(leverage) : 1;
        this.positions = new Array(this.slots).fill(null);
        this.trades = [];
    }

    /** Число занятых слотов. @returns {number} Занято. */
    get openCount() {
        let n = 0;
        for (const position of this.positions) if (position) n += 1;
        return n;
    }

    /**
     * Позиция по бумаге (одна бумага — один слот).
     * @param {string} ticker - Тикер.
     * @returns {{slot: number, position: object}|null} Слот и позиция.
     */
    positionOf(ticker) {
        for (let i = 0; i < this.slots; i += 1) {
            if (this.positions[i]?.ticker === ticker) return { slot: i, position: this.positions[i] };
        }
        return null;
    }

    /** Индекс первого свободного слота или -1. @returns {number} Слот. */
    freeSlot() {
        return this.positions.indexOf(null);
    }

    /**
     * Размер позиции в штуках, округлённый вниз до целого числа лотов.
     * Формула — из Portfolio._defaultSize, с бюджетом вместо всего кэша.
     * @param {number} price - Цена сайзинга.
     * @param {number} lot - Лот инструмента.
     * @param {number} budget - Бюджет слота.
     * @param {number} [leverage] - Плечо.
     * @returns {number} Размер в штуках.
     */
    sizeFor(price, lot, budget, leverage = this.leverage) {
        if (!Number.isFinite(price) || price <= 0) return 0;
        const priceFill = price * (1 + SIZING_SLIPPAGE_PAD);
        const perLotCost = priceFill * (1 / leverage + this.commission) * lot;
        return Math.floor(budget / perLotCost) * lot;
    }

    /**
     * Бюджет слота: доля капитала, но не больше свободного кэша.
     * @param {number} equity - Текущий капитал.
     * @returns {number} Бюджет.
     */
    budgetFor(equity) {
        return Math.min(equity / this.slots, this.cash);
    }

    /**
     * Открыть позицию в слоте.
     * @param {number} slot - Индекс слота.
     * @param {object} order - Параметры ордера.
     * @returns {object|null} Позиция либо null, если размер/кэш не позволяют.
     */
    open(slot, { side = "short", price, datetime, ticker, lot = 1, size = null,
                 budget = null, sl = null, tp = null, exitDeadline = null }) {
        if (this.positions[slot]) return null;
        const leverage = side === "short" ? this.leverage : 1;
        const actualSize = size || this.sizeFor(price, lot, budget ?? this.cash, leverage);
        if (actualSize <= 0) return null;

        if (side === "long") {
            const cost = actualSize * price * (1 + this.commission);
            if (cost > this.cash) return null;
            this.cash -= cost;
        } else {
            const margin = (actualSize * price) / leverage;
            if (margin > this.cash) return null;
            this.cash -= margin;
        }

        this.positions[slot] = {
            entryTime: datetime, entryPrice: price, size: actualSize, side,
            ticker, lot, sl, tp, exitDeadline,
        };
        return this.positions[slot];
    }

    /**
     * Закрыть слот по цене.
     * @param {number} slot - Индекс слота.
     * @param {object} params - { price, datetime, reason }.
     * @returns {object|null} Сделка.
     */
    close(slot, { price, datetime, reason = "manual" }) {
        const position = this.positions[slot];
        if (!position) return null;
        const { size, entryPrice, side } = position;
        const fee = size * (entryPrice + price) * this.commission;
        let pnl;
        if (side === "long") {
            pnl = size * (price - entryPrice) - fee;
            this.cash += size * price * (1 - this.commission);
        } else {
            pnl = size * (entryPrice - price) - fee;
            this.cash += (size * entryPrice) / this.leverage + pnl;
        }

        this.positions[slot] = null;
        const trade = {
            entryTime: position.entryTime, exitTime: datetime,
            entryPrice, exitPrice: price, size, side,
            ticker: position.ticker, sl: position.sl, tp: position.tp,
            reason, pnl, pnlPct: (pnl / this.initialCash) * 100,
        };
        this.trades.push(trade);
        return trade;
    }

    /**
     * Капитал: кэш плюс маржа и нереализованный P&L по открытым слотам.
     * @param {(slot: number, position: object) => number|null} priceOf - Текущая цена слота.
     * @returns {number} Капитал.
     */
    equity(priceOf) {
        let total = this.cash;
        for (let i = 0; i < this.slots; i += 1) {
            const position = this.positions[i];
            if (!position) continue;
            const price = priceOf(i, position) ?? position.entryPrice;
            if (position.side === "long") {
                total += position.size * price;
            } else {
                total += (position.size * position.entryPrice) / this.leverage
                    + position.size * (position.entryPrice - price);
            }
        }
        return total;
    }
}
