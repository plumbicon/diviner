import { Portfolio } from "./portfolio.js";
import { PerformanceMetrics } from "./metrics.js";
import {
    DEFAULT_EXCHANGE,
    MOSCOW_OFFSET_MS,
    buildCandleDerivedTradingSchedule,
    getCandleIntervalConfig,
    toDate,
} from "./market-data.js";

/**
 * Simulated data source for backtests.
 *
 * Owns the loaded candle listing and answers history requests off it. Daily
 * candles are aggregated here (not in a shared layer) so that minute parquet
 * files keep working as-is. Honours an `until` upper bound on data freshness so
 * aggregation never peeks past the current simulation moment (look-ahead guard).
 */
export class SimulatedDataSource {
    constructor({ candles = [], metadata = {}, portfolio = null, equity = null } = {}) {
        this.candles = candles;
        this.metadata = metadata || {};
        this.portfolio = portfolio;
        this.equity = equity;
    }

    /**
     * Stream the listing candle-by-candle (drives the engine tick loop) and
     * record an equity point per bar. A request for the next candle means the
     * previous bar has been fully processed by the engine, so its equity is
     * marked at that point (and the last bar after the loop ends).
     * @returns {AsyncGenerator<object>} Candle stream.
     */
    async *stream() {
        for (let i = 0; i < this.candles.length; i += 1) {
            if (i > 0) {
                this._markEquity(this.candles[i - 1]);
            }
            yield this.candles[i];
        }
        if (this.candles.length > 0) {
            this._markEquity(this.candles[this.candles.length - 1]);
        }
    }

    /**
     * Append a mark-to-market equity point for a processed bar.
     * @param {object} candle - Bar just processed.
     * @private
     */
    _markEquity(candle) {
        if (this.portfolio && this.equity) {
            this.equity.push(this.portfolio.calculateEquity(candle));
        }
    }

    /**
     * History for the requested interval, clamped by `until`.
     * @param {object} params - Request.
     * @param {Date|string} [params.from] - Start (inclusive).
     * @param {Date|string} [params.to] - End (exclusive).
     * @param {string|number} [params.interval] - Candle interval.
     * @param {Date|string|number} [params.until] - Upper data-freshness bound.
     * @returns {Array<object>} Candles.
     */
    async getHistory({ from = null, to = null, interval = "1m", until = Infinity } = {}) {
        const fromTs = from ? toDate(from).getTime() : -Infinity;
        const toTs = to ? toDate(to).getTime() : Infinity;
        const untilTs = until === Infinity ? Infinity : toDate(until).getTime();

        const selected = this.candles.filter((candle) => {
            const ts = candle.datetime.getTime();
            return ts >= fromTs && ts < toTs && ts <= untilTs;
        });

        const intervalConfig = getCandleIntervalConfig(interval);
        if (intervalConfig.label === "1d") {
            return aggregateDailyCandles(selected);
        }
        return selected;
    }

    /**
     * Trading schedule derived from the listing itself.
     * @param {object} params - Request.
     * @returns {Array<object>} Trading days.
     */
    async getTradingSchedule(params = {}) {
        return buildCandleDerivedTradingSchedule(this.candles, {
            ...params,
            exchange: this.metadata.instrument?.exchange
                || this.metadata.exchange
                || DEFAULT_EXCHANGE,
            intervalMinutes: this.metadata.intervalMinutes,
        });
    }
}

/**
 * Simulated executor backed by a {@link Portfolio}. Translates strategy
 * buy/sell/close signals into simulated fills at the current candle close.
 */
export class SimulatedExecutor {
    constructor({ portfolio }) {
        this.portfolio = portfolio;
        this.currentCandle = null;
    }

    /**
     * Set the candle used as the fill reference for the current tick.
     * @param {object} candle - Current candle.
     */
    setCurrentCandle(candle) {
        this.currentCandle = candle;
    }

    buy(size, sl, tp) {
        return this.portfolio.openLong({ candle: this.currentCandle, size, sl, tp });
    }

    sell(size, sl, tp) {
        return this.portfolio.openShort({ candle: this.currentCandle, size, sl, tp });
    }

    closePosition() {
        return this.portfolio.closePosition({ candle: this.currentCandle });
    }

    getPosition() {
        return this.portfolio.position;
    }

    getBalance() {
        return this.portfolio.cash;
    }

    /**
     * Push portfolio state back into the strategy so it sees its own position.
     * @param {object} strategy - Strategy instance.
     */
    syncStrategyState(strategy) {
        strategy._position = this.portfolio.position;
        strategy.cash = this.portfolio.cash;
    }
}

/**
 * Assemble a simulated broker: { data, exec } + the backing portfolio.
 * @param {object} params - Broker parameters.
 * @returns {{ data: SimulatedDataSource, exec: SimulatedExecutor, portfolio: Portfolio }} Broker.
 */
export function createSimulatedBroker({
    candles = [],
    metadata = {},
    initialCash = 10000,
    commission = 0.0005,
    meta = {},
} = {}) {
    const portfolio = new Portfolio({ cash: initialCash, commission });
    const equity = [];
    const data = new SimulatedDataSource({ candles, metadata, portfolio, equity });
    const exec = new SimulatedExecutor({ portfolio });

    return {
        data,
        exec,
        portfolio,
        /**
         * Build the backtest report. Closes any position still open on the last
         * candle (so equity is not left marked-to-market in an open position),
         * then compiles metrics. The engine calls this once the stream ends.
         * @returns {object} Backtest report.
         */
        finalize() {
            if (portfolio.position && candles.length > 0) {
                const last = candles[candles.length - 1];
                exec.setCurrentCandle(last);
                exec.closePosition();
                equity[equity.length - 1] = portfolio.calculateEquity(last);
            }

            return {
                backtest_parameters: {
                    history_file: meta.historyFile || "",
                    strategy_file: meta.strategyFile || "",
                },
                performance_metrics: new PerformanceMetrics({
                    data: candles,
                    equity,
                    trades: portfolio.trades,
                    initialCash,
                }).compile(),
                trade_log: portfolio.trades,
            };
        },
    };
}

/**
 * Aggregate intraday candles into Moscow-date daily candles.
 * @param {Array<object>} candles - Source candles.
 * @returns {Array<object>} Daily candles.
 */
export function aggregateDailyCandles(candles) {
    const grouped = new Map();

    for (const candle of candles) {
        const dateKey = getMoscowDateKey(candle.datetime);
        if (!grouped.has(dateKey)) {
            grouped.set(dateKey, {
                datetime: candle.datetime,
                open: candle.open,
                high: candle.high,
                low: candle.low,
                close: candle.close,
                volume: Number(candle.volume || 0),
                isComplete: true,
            });
            continue;
        }

        const daily = grouped.get(dateKey);
        daily.high = Math.max(daily.high, candle.high);
        daily.low = Math.min(daily.low, candle.low);
        daily.close = candle.close;
        daily.volume += Number(candle.volume || 0);
    }

    return Array.from(grouped.values())
        .sort((a, b) => a.datetime.getTime() - b.datetime.getTime());
}

/**
 * Moscow calendar date key for a datetime.
 * @param {Date} datetime - Datetime.
 * @returns {string} Date key YYYY-MM-DD.
 */
export function getMoscowDateKey(datetime) {
    const moscowDate = new Date(datetime.getTime() + MOSCOW_OFFSET_MS);
    const year = moscowDate.getUTCFullYear();
    const month = String(moscowDate.getUTCMonth() + 1).padStart(2, "0");
    const day = String(moscowDate.getUTCDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}
