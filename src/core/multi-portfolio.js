import { SIZING_SLIPPAGE_PAD } from "./portfolio.js";

/**
 * Портфель на несколько одновременных позиций с общей кассой.
 *
 * Позиции хранятся по бумагам: на счёте по инструменту бывает только одна нетто-
 * позиция, и это ограничение биржи, а не политика. А вот **как делить депозит
 * между бумагами — решает стратегия**, портфель об этом не знает. Он умеет
 * перевести выделенную сумму в размер позиции (округление до лотов, резерв под
 * комиссию и проскальзывание), но саму сумму получает извне.
 *
 * Отличие от {@link Portfolio} только в этом: размер считается от переданного
 * бюджета, а не от всего кэша, и лот берётся у инструмента сделки — у бумаг
 * вселенной он разный. Арифметика скопирована, поэтому портфель с одной позицией
 * и бюджетом во весь кэш обязан совпасть с однопозиционным цифра в цифру; это и
 * проверяется тестом.
 */
export class MultiPortfolio {
    /**
     * @param {object} params - Параметры.
     * @param {number} [params.cash] - Стартовый капитал.
     * @param {number} [params.commission] - Комиссия за сторону.
     * @param {number} [params.leverage] - Плечо шорта.
     */
    constructor({ cash = 10000, commission = 0.0005, leverage = 1, leverageFor = null } = {}) {
        this.initialCash = cash;
        this.cash = cash;
        this.commission = commission;
        this.leverage = Number.isFinite(Number(leverage)) && Number(leverage) > 0 ? Number(leverage) : 1;
        // Плечо по бумаге: биржа и брокер ограничивают шорт ставкой риска, и потолок у
        // каждой бумаги свой. Функция возвращает разрешённое плечо тикера; общий --leverage
        // остаётся верхней границей. Без неё поведение прежнее — одно плечо на всё.
        this.leverageFor = typeof leverageFor === "function" ? leverageFor : null;
        /** Тикер → позиция. @type {Map<string, object>} */
        this.positions = new Map();
        this.trades = [];
    }

    /** Число открытых позиций. @returns {number} Открыто. */
    get openCount() {
        return this.positions.size;
    }

    /**
     * Позиция по бумаге.
     * @param {string} ticker - Тикер.
     * @returns {object|null} Позиция.
     */
    positionOf(ticker) {
        return this.positions.get(ticker) ?? null;
    }

    /**
     * Плечо, с которым открывается шорт по бумаге: минимум из общего и разрешённого
     * по этой бумаге. Лонги в симуляторе без плеча.
     * @param {string} ticker - Тикер.
     * @returns {number} Плечо.
     */
    leverageOf(ticker) {
        if (!this.leverageFor) return this.leverage;
        const own = Number(this.leverageFor(ticker));
        if (!Number.isFinite(own) || own <= 0) return this.leverage;
        return Math.min(this.leverage, own);
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
     * Открыть позицию по бумаге.
     *
     * Либо `size` (стратегия посчитала размер сама), либо `budget` — сумма, из
     * которой размер получается округлением вниз до лотов по цене исполнения.
     * Без обоих берётся весь свободный кэш: так ведёт себя однопозиционный
     * Portfolio, и однобумажные стратегии на этом стоят.
     *
     * @param {string} ticker - Тикер.
     * @param {object} order - Параметры ордера.
     * @returns {object|null} Позиция либо null, если размер/кэш не позволяют.
     */
    open(ticker, {
        side = "short", price, datetime, lot = 1, size = null,
        budget = null, sl = null, tp = null, exitDeadline = null,
    }) {
        if (this.positions.has(ticker)) return null;
        const leverage = side === "short" ? this.leverageOf(ticker) : 1;
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

        const position = {
            entryTime: datetime, entryPrice: price, size: actualSize, side,
            ticker, lot, sl, tp, exitDeadline, leverage,
        };
        this.positions.set(ticker, position);
        return position;
    }

    /**
     * Закрыть позицию по бумаге.
     * @param {string} ticker - Тикер.
     * @param {object} params - { price, datetime, reason }.
     * @returns {object|null} Сделка.
     */
    close(ticker, { price, datetime, reason = "manual" }) {
        const position = this.positions.get(ticker);
        if (!position) return null;
        const { size, entryPrice, side } = position;
        const fee = size * (entryPrice + price) * this.commission;
        let pnl;
        if (side === "long") {
            pnl = size * (price - entryPrice) - fee;
            this.cash += size * price * (1 - this.commission);
        } else {
            pnl = size * (entryPrice - price) - fee;
            // Возвращается залог именно этой позиции: при плече по бумаге общий
            // this.leverage к ней отношения не имеет.
            this.cash += (size * entryPrice) / (position.leverage || this.leverage) + pnl;
        }

        this.positions.delete(ticker);
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
     * Капитал: кэш плюс маржа и нереализованный P&L по открытым позициям.
     * @param {(ticker: string, position: object) => number|null} priceOf - Текущая цена бумаги.
     * @returns {number} Капитал.
     */
    equity(priceOf) {
        let total = this.cash;
        for (const [ticker, position] of this.positions) {
            const price = priceOf(ticker, position) ?? position.entryPrice;
            if (position.side === "long") {
                total += position.size * price;
            } else {
                total += (position.size * position.entryPrice) / (position.leverage || this.leverage)
                    + position.size * (position.entryPrice - price);
            }
        }
        return total;
    }
}
