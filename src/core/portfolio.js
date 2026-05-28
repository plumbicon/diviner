/**
 * Simulated trading portfolio for backtests.
 */
export class Portfolio {
    constructor({ cash = 10000, commission = 0.0001 } = {}) {
        this.initialCash = cash;
        this.cash = cash;
        this.commission = commission;
        this.position = null;
        this.trades = [];
    }

    /**
     * Open a long position at the current candle close.
     * @param {object} params - Order parameters.
     * @returns {object|null} Opened position or null.
     */
    openLong({ candle, size = null, sl = null, tp = null }) {
        if (this.position) {
            return null;
        }

        const price = candle.close;
        const actualSize = size || Math.floor((this.cash * 0.95) / price);
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
        };

        return this.position;
    }

    /**
     * Open a short position at the current candle close.
     * @param {object} params - Order parameters.
     * @returns {object|null} Opened position or null.
     */
    openShort({ candle, size = null, sl = null, tp = null }) {
        if (this.position) {
            return null;
        }

        const price = candle.close;
        const actualSize = size || Math.floor((this.cash * 0.95) / price);
        if (actualSize <= 0) {
            return null;
        }

        const margin = actualSize * price * 0.25;
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
            this.cash += position.size * position.entryPrice * 0.25 + trade.pnl;
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
            equity += this.position.size * this.position.entryPrice * 0.25 + pnl;
        }

        return equity;
    }
}
