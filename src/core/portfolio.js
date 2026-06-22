/**
 * Simulated trading portfolio for backtests.
 */
export class Portfolio {
    constructor({ cash = 10000, commission = 0.0005, lot = 1, leverage = 1 } = {}) {
        this.initialCash = cash;
        this.cash = cash;
        this.commission = commission;
        // Exchange lot size. Default order sizing floors to whole lots so the
        // backtest matches the live broker, which can only trade in multiples of
        // `lot` (e.g. ALRS lot=10). Carried from the dataset's instrument
        // metadata; defaults to 1 (one share per lot) when unknown.
        this.lot = Number.isFinite(Number(lot)) && Number(lot) > 0 ? Number(lot) : 1;
        // Short-side leverage. Scales the default short position size (notional =
        // cash·0.95·leverage) and the locked margin (notional/leverage), so P&L
        // and drawdowns scale ~linearly with leverage. Default 1 = unleveraged
        // sizing; the margin posted then equals the full notional. Longs remain
        // cash-funded (always 1×) — see openLong. Invalid values fall back to 1.
        this.leverage = Number.isFinite(Number(leverage)) && Number(leverage) > 0 ? Number(leverage) : 1;
        this.position = null;
        this.trades = [];
    }

    /**
     * Default position size (in shares) for a given price: 95% of cash times the
     * leverage multiplier, floored to a whole number of exchange lots. Mirrors
     * the live broker's `_defaultOrderLots` at leverage 1. @private
     * @param {number} price - Entry price per share.
     * @param {number} [leverage=1] - Buying-power multiplier (short side only).
     * @returns {number} Size in shares (a multiple of `this.lot`).
     */
    _defaultSize(price, leverage = 1) {
        const lots = Math.floor((this.cash * 0.95 * leverage) / (price * this.lot));
        return lots * this.lot;
    }

    /**
     * Open a long position at the current candle close.
     * @param {object} params - Order parameters.
     * @returns {object|null} Opened position or null.
     */
    openLong({ candle, size = null, sl = null, tp = null, exitDeadline = null }) {
        if (this.position) {
            return null;
        }

        const price = candle.close;
        const actualSize = size || this._defaultSize(price);
        if (actualSize <= 0) {
            return null;
        }

        const cost = actualSize * price * (1 + this.commission);
        if (cost > this.cash) {
            return null;
        }

        this.cash -= cost;
        this.position = {
            entryTime: candle.datetime,
            entryPrice: price,
            size: actualSize,
            side: "long",
            sl,
            tp,
            exitDeadline,
        };

        return this.position;
    }

    /**
     * Open a short position at the current candle close.
     * @param {object} params - Order parameters.
     * @returns {object|null} Opened position or null.
     */
    openShort({ candle, size = null, sl = null, tp = null, exitDeadline = null }) {
        if (this.position) {
            return null;
        }

        const price = candle.close;
        const actualSize = size || this._defaultSize(price, this.leverage);
        if (actualSize <= 0) {
            return null;
        }

        const margin = (actualSize * price) / this.leverage;
        if (margin > this.cash) {
            return null;
        }

        this.cash -= margin;
        this.position = {
            entryTime: candle.datetime,
            entryPrice: price,
            size: actualSize,
            side: "short",
            sl,
            tp,
            exitDeadline,
        };

        return this.position;
    }

    /**
     * Close the current position at the current candle close.
     * @param {object} params - Close parameters.
     * @returns {object|null} Closed trade or null.
     */
    closePosition({ candle }) {
        if (!this.position) {
            return null;
        }

        const price = candle.close;
        const position = this.position;
        const trade = {
            entryTime: position.entryTime,
            exitTime: candle.datetime,
            entryPrice: position.entryPrice,
            exitPrice: price,
            size: position.size,
            side: position.side,
            sl: position.sl,
            tp: position.tp,
        };

        if (position.side === "long") {
            trade.pnl = position.size * (price - position.entryPrice)
                - position.size * (position.entryPrice + price) * this.commission;
            this.cash += position.size * price * (1 - this.commission);
        } else {
            trade.pnl = position.size * (position.entryPrice - price)
                - position.size * (position.entryPrice + price) * this.commission;
            this.cash += (position.size * position.entryPrice) / this.leverage + trade.pnl;
        }

        trade.pnlPct = (trade.pnl / this.initialCash) * 100;
        this.position = null;
        this.trades.push(trade);

        return trade;
    }

    /**
     * Calculate current total equity.
     * @param {object} candle - Current candle.
     * @returns {number} Portfolio equity.
     */
    calculateEquity(candle) {
        let equity = this.cash;
        if (!this.position) {
            return equity;
        }

        const currentPrice = candle.close;
        if (this.position.side === "long") {
            equity += this.position.size * currentPrice;
        } else {
            const pnl = this.position.size * (this.position.entryPrice - currentPrice);
            equity += (this.position.size * this.position.entryPrice) / this.leverage + pnl;
        }

        return equity;
    }
}
