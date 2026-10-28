import { SIZING_SLIPPAGE_PAD } from "./portfolio.js";

/**
 * Portfolio for several simultaneous positions with a shared cash pool.
 *
 * Positions are kept per instrument: an account holds only one net position per
 * instrument, an exchange constraint rather than a policy. **How to split the deposit
 * between instruments is the strategy's decision** — the portfolio does not know. It can
 * convert an allotted amount into a position size (lot rounding, a reserve for commission
 * and slippage), but the amount itself comes from outside.
 *
 * That is the only difference from {@link Portfolio}: the size is computed from the given
 * budget instead of the whole cash, and the lot comes from the traded instrument — it
 * differs across the universe. The arithmetic is copied, so a portfolio with one position
 * and a budget of all the cash must match the single-position one to the last digit; a
 * test checks exactly that.
 */
export class MultiPortfolio {
    /**
     * @param {object} params - Parameters.
     * @param {number} [params.cash] - Starting capital.
     * @param {number} [params.commission] - Commission per side.
     * @param {number} [params.leverage] - Short leverage.
     * @param {Function} [params.leverageFor] - Per-instrument short leverage cap.
     * @param {number} [params.longLeverage] - Long leverage (margin buying); 1 = unleveraged.
     * @param {Function} [params.longLeverageFor] - Per-instrument long leverage cap.
     */
    constructor({
        cash = 10000, commission = 0.0005, leverage = 1, leverageFor = null,
        longLeverage = 1, longLeverageFor = null,
    } = {}) {
        this.initialCash = cash;
        this.cash = cash;
        this.commission = commission;
        this.leverage = Number.isFinite(Number(leverage)) && Number(leverage) > 0 ? Number(leverage) : 1;
        // Per-instrument leverage: the exchange and the broker cap shorts by a risk rate,
        // and each instrument has its own cap. The function returns a ticker's allowed
        // leverage; the global --leverage stays the upper bound. Without it behaviour is
        // as before — one leverage for everything.
        this.leverageFor = typeof leverageFor === "function" ? leverageFor : null;
        // Long leverage: the broker lends for buying on margin too, with its own risk rate
        // (dlong). 1 keeps the unleveraged long path exactly as before.
        this.longLeverage = Number.isFinite(Number(longLeverage)) && Number(longLeverage) > 0 ? Number(longLeverage) : 1;
        this.longLeverageFor = typeof longLeverageFor === "function" ? longLeverageFor : null;
        /** Ticker → position. @type {Map<string, object>} */
        this.positions = new Map();
        this.trades = [];
    }

    /** Number of open positions. @returns {number} Open. */
    get openCount() {
        return this.positions.size;
    }

    /**
     * Position of an instrument.
     * @param {string} ticker - Ticker.
     * @returns {object|null} Position.
     */
    positionOf(ticker) {
        return this.positions.get(ticker) ?? null;
    }

    /**
     * Leverage a short in the instrument opens with: the minimum of the global one and the
     * one allowed for this instrument.
     * @param {string} ticker - Ticker.
     * @returns {number} Leverage.
     */
    leverageOf(ticker) {
        return capped(this.leverage, this.leverageFor, ticker);
    }

    /**
     * Leverage a long in the instrument opens with: the minimum of the global long leverage
     * and the one allowed for this instrument, never below 1.
     * @param {string} ticker - Ticker.
     * @returns {number} Leverage.
     */
    longLeverageOf(ticker) {
        return Math.max(1, capped(this.longLeverage, this.longLeverageFor, ticker));
    }

    /**
     * Position size in shares, floored to whole lots. The formula is
     * Portfolio._defaultSize's, with the budget instead of the whole cash.
     * @param {number} price - Sizing price.
     * @param {number} lot - Instrument lot.
     * @param {number} budget - Slot budget.
     * @param {number} [leverage] - Leverage.
     * @returns {number} Size in shares.
     */
    sizeFor(price, lot, budget, leverage = this.leverage) {
        if (!Number.isFinite(price) || price <= 0) return 0;
        const priceFill = price * (1 + SIZING_SLIPPAGE_PAD);
        const perLotCost = priceFill * (1 / leverage + this.commission) * lot;
        return Math.floor(budget / perLotCost) * lot;
    }

    /**
     * Open a position in an instrument.
     *
     * Either `size` (the strategy computed it itself) or `budget` — an amount the size is
     * derived from by flooring to lots at the fill price. Without both, all free cash is
     * used: that is how the single-position Portfolio behaves, and single-ticker
     * strategies rely on it.
     *
     * @param {string} ticker - Ticker.
     * @param {object} order - Order parameters.
     * @returns {object|null} Position, or null when the size/cash does not allow it.
     */
    open(ticker, {
        side = "short", price, datetime, lot = 1, size = null,
        budget = null, sl = null, tp = null, exitDeadline = null,
    }) {
        if (this.positions.has(ticker)) return null;
        const leverage = side === "short" ? this.leverageOf(ticker) : this.longLeverageOf(ticker);
        const actualSize = size || this.sizeFor(price, lot, budget ?? this.cash, leverage);
        if (actualSize <= 0) return null;

        if (side === "long" && leverage === 1) {
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
     * Close the position of an instrument.
     * @param {string} ticker - Ticker.
     * @param {object} params - { price, datetime, reason }.
     * @returns {object|null} Trade.
     */
    close(ticker, { price, datetime, reason = "manual" }) {
        const position = this.positions.get(ticker);
        if (!position) return null;
        const { size, entryPrice, side } = position;
        const fee = size * (entryPrice + price) * this.commission;
        let pnl;
        if (side === "long" && (position.leverage ?? 1) === 1) {
            pnl = size * (price - entryPrice) - fee;
            this.cash += size * price * (1 - this.commission);
        } else if (side === "long") {
            // A margin long: the posted margin comes back together with the P&L, as for a short.
            pnl = size * (price - entryPrice) - fee;
            this.cash += (size * entryPrice) / position.leverage + pnl;
        } else {
            pnl = size * (entryPrice - price) - fee;
            // The margin of this very position is returned: with per-instrument leverage the
            // global this.leverage has nothing to do with it.
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
     * Equity: cash plus margin and unrealized P&L of open positions.
     * @param {(ticker: string, position: object) => number|null} priceOf - Current instrument price.
     * @returns {number} Equity.
     */
    equity(priceOf) {
        let total = this.cash;
        for (const [ticker, position] of this.positions) {
            const price = priceOf(ticker, position) ?? position.entryPrice;
            if (position.side === "long" && (position.leverage ?? 1) === 1) {
                total += position.size * price;
            } else if (position.side === "long") {
                total += (position.size * position.entryPrice) / position.leverage
                    + position.size * (price - position.entryPrice);
            } else {
                total += (position.size * position.entryPrice) / (position.leverage || this.leverage)
                    + position.size * (position.entryPrice - price);
            }
        }
        return total;
    }
}

/**
 * Leverage capped by a per-instrument limit; the global value stays the upper bound.
 * @param {number} global - Global leverage.
 * @param {Function|null} limitFor - Ticker → allowed leverage.
 * @param {string} ticker - Ticker.
 * @returns {number} Leverage.
 * @private
 */
function capped(global, limitFor, ticker) {
    if (!limitFor) return global;
    const own = Number(limitFor(ticker));
    if (!Number.isFinite(own) || own <= 0) return global;
    return Math.min(global, own);
}
