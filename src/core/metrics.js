// Moscow UTC+3 offset for daily return bucketing
const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;

function mskDateKey(datetime) {
    const d = new Date(datetime.getTime() + MSK_OFFSET_MS);
    return d.toISOString().slice(0, 10);
}

/**
 * Build a backtest performance report from portfolio equity and trades.
 */
export class PerformanceMetrics {
    constructor({ data, equity, trades, initialCash }) {
        this.data = data;
        this.equity = equity;
        this.trades = trades;
        this.initialCash = initialCash;
    }

    /**
     * Compile JSON-ready metrics.
     * @returns {object} Performance metrics.
     */
    compile() {
        const start = this.data[0].datetime;
        const end = this.data[this.data.length - 1].datetime;
        const durationDays = (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);
        const equityFinal = this.equity[this.equity.length - 1] || this.initialCash;
        const equityPeak = this.equity.reduce(
            (peak, value) => Math.max(peak, value),
            this.initialCash,
        );
        const equityDrawdown = equityPeak - equityFinal;
        const maxDrawdown = this.calculateMaxDrawdown();
        const totalReturn = equityFinal - this.initialCash;
        const totalReturnPct = (totalReturn / this.initialCash) * 100;
        const buyAndHoldReturn = (
            (this.data[this.data.length - 1].close - this.data[0].close) / this.data[0].close
        ) * this.initialCash;
        const buyAndHoldReturnPct = (
            (this.data[this.data.length - 1].close - this.data[0].close) / this.data[0].close
        ) * 100;
        const winningTrades = this.trades.filter((trade) => (trade.pnl || 0) > 0);
        const losingTrades = this.trades.filter((trade) => (trade.pnl || 0) <= 0);
        const winRate = this.trades.length > 0
            ? (winningTrades.length / this.trades.length) * 100
            : 0;
        const totalProfit = winningTrades.reduce((sum, trade) => sum + (trade.pnl || 0), 0);
        const totalLoss = Math.abs(losingTrades.reduce((sum, trade) => sum + (trade.pnl || 0), 0));
        const profitFactor = totalLoss > 0
            ? totalProfit / totalLoss
            : (totalProfit > 0 ? Infinity : 0);
        const avgTrade = this.average(this.trades.map((trade) => trade.pnl || 0));
        const avgTradePct = this.average(this.trades.map((trade) => trade.pnlPct || 0));
        const avgWin = this.average(winningTrades.map((trade) => trade.pnl || 0));
        const avgLoss = this.average(losingTrades.map((trade) => trade.pnl || 0));
        const largestWin = winningTrades.length > 0
            ? Math.max(...winningTrades.map((trade) => trade.pnl || 0))
            : 0;
        const largestLoss = losingTrades.length > 0
            ? Math.min(...losingTrades.map((trade) => trade.pnl || 0))
            : 0;
        const avgTradeDuration = this.calculateAverageTradeDuration();
        const avgTradesPerDay = durationDays > 0 ? this.trades.length / durationDays : 0;
        const exposureTimePct = this.calculateExposureTimePct();

        const maxDrawdownPct = equityPeak > 0 ? (maxDrawdown / equityPeak) * 100 : 0;
        const annualizedReturnPct = durationDays > 0
            ? totalReturnPct * (365 / durationDays)
            : 0;
        const sharpe = this.calculateSharpe();
        const calmar = maxDrawdownPct > 0
            ? round(annualizedReturnPct / maxDrawdownPct)
            : (annualizedReturnPct > 0 ? null : 0);
        const returnOnMaxDD = maxDrawdownPct > 0
            ? round(totalReturnPct / maxDrawdownPct)
            : (totalReturnPct > 0 ? null : 0);

        return {
            start,
            end,
            durationDays: round(durationDays),
            exposureTimePct: round(exposureTimePct),
            equityFinal: round(equityFinal),
            equityPeak: round(equityPeak),
            equityDrawdown: round(equityDrawdown),
            return: round(totalReturn),
            returnPct: round(totalReturnPct),
            annualizedReturnPct: round(annualizedReturnPct),
            maxDrawdown: round(maxDrawdown),
            maxDrawdownPct: round(maxDrawdownPct),
            sharpe,
            calmar,
            returnOnMaxDD,
            buyAndHoldReturn: round(buyAndHoldReturn),
            buyAndHoldReturnPct: round(buyAndHoldReturnPct),
            tradesCount: this.trades.length,
            winningTrades: winningTrades.length,
            losingTrades: losingTrades.length,
            winRate: round(winRate),
            profitFactor: profitFactor === Infinity ? null : round(profitFactor),
            avgTrade: round(avgTrade),
            avgTradePct: round(avgTradePct),
            avgWin: round(avgWin),
            avgLoss: round(avgLoss),
            largestWin: round(largestWin),
            largestLoss: round(largestLoss),
            avgTradeDuration: round(avgTradeDuration),
            avgTradesPerDay: round(avgTradesPerDay),
        };
    }

    calculateMaxDrawdown() {
        let maxDrawdown = 0;
        let peak = this.equity[0] || this.initialCash;

        for (const value of this.equity) {
            if (value > peak) {
                peak = value;
            }
            maxDrawdown = Math.max(maxDrawdown, peak - value);
        }

        return maxDrawdown;
    }

    calculateAverageTradeDuration() {
        const tradesWithDuration = this.trades.filter((trade) => trade.entryTime && trade.exitTime);
        if (tradesWithDuration.length === 0) {
            return 0;
        }

        return tradesWithDuration.reduce(
            (sum, trade) => sum + (trade.exitTime.getTime() - trade.entryTime.getTime()),
            0,
        ) / tradesWithDuration.length / (1000 * 60);
    }

    calculateExposureTimePct() {
        if (this.trades.length === 0) return 0;

        const timeToIndex = new Map();
        for (let i = 0; i < this.data.length; i += 1) {
            timeToIndex.set(this.data[i].datetime.getTime(), i);
        }

        const barsWithPosition = this.trades.reduce((sum, trade) => {
            if (!trade.entryTime || !trade.exitTime) {
                return sum;
            }

            const entryIdx = timeToIndex.get(trade.entryTime.getTime());
            const exitIdx = timeToIndex.get(trade.exitTime.getTime());

            if (entryIdx === undefined || exitIdx === undefined) {
                return sum;
            }

            return sum + (exitIdx - entryIdx);
        }, 0);

        return (barsWithPosition / this.data.length) * 100;
    }

    /**
     * Annualised Sharpe ratio (risk-free rate = 0) from daily equity returns.
     * Groups per-candle equity values by Moscow date and takes the last value
     * per day as the day's closing equity, then computes daily log-returns.
     * @returns {number} Sharpe ratio, or 0 if insufficient data.
     */
    calculateSharpe() {
        if (this.equity.length < 2 || this.data.length < 2) return 0;

        // Last equity value per Moscow calendar day
        const dailyEquity = new Map();
        for (let i = 0; i < this.data.length; i++) {
            const dk = mskDateKey(this.data[i].datetime);
            dailyEquity.set(dk, this.equity[i] ?? this.initialCash);
        }

        const values = [...dailyEquity.values()];
        if (values.length < 2) return 0;

        // Daily simple returns
        const returns = [];
        for (let i = 1; i < values.length; i++) {
            const prev = values[i - 1];
            if (prev > 0) returns.push((values[i] - prev) / prev);
        }
        if (returns.length < 2) return 0;

        const n = returns.length;
        const mean = returns.reduce((s, r) => s + r, 0) / n;
        // Population std dev (consistent with the Sharpe literature)
        const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / n;
        const std = Math.sqrt(variance);
        if (std === 0) return 0;

        // Annualise assuming 252 trading days
        return round((mean / std) * Math.sqrt(252));
    }

    average(values) {
        if (values.length === 0) {
            return 0;
        }
        return values.reduce((sum, value) => sum + value, 0) / values.length;
    }
}

function round(value) {
    return Math.round(value * 100) / 100;
}
