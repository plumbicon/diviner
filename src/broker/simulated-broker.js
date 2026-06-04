import { Portfolio } from "../core/portfolio.js";
import { PerformanceMetrics } from "../core/metrics.js";
import { loadDataset } from "../core/data-loader.js";
import {
    DEFAULT_EXCHANGE,
    buildCandleDerivedTradingSchedule,
    getCandleIntervalConfig,
    getMoscowDateKey,
    toDate,
} from "../core/market-data.js";

/**
 * Plugin option descriptors for the CLI (validated by the shared layer, п.3).
 */
export const options = [
    { flags: "--balance <amount>", description: "Initial balance", default: "10000" },
    { flags: "--commission <rate>", description: "Commission rate", default: "0.0005" },
];

/**
 * Plugin entry point: build a simulated broker from CLI config.
 * Encapsulates loading the parquet listing (path or stdin buffer).
 * @param {object} config - Parsed CLI options.
 * @returns {Promise<object>} Broker { data, exec, finalize, metadata, needsCache }.
 */
export async function createBroker(config = {}) {
    const dataset  = await loadDataset(config.source);
    const metadata = { ...dataset.metadata };
    // Parquet files from older pipelines may lack a ticker field; fall back to
    // the filename prefix (e.g. "AFKS_2025_1m.parquet" → ticker="AFKS").
    if (!metadata.ticker && config.sourceName) {
        const base  = String(config.sourceName).split(/[\\/]/).pop();
        const match = base.match(/^([A-Z0-9]+)_/);
        if (match) metadata.ticker = match[1];
    }
    const broker = createSimulatedBroker({
        candles:     dataset.candles,
        metadata,
        initialCash: Number(config.balance),
        commission:  Number(config.commission),
        meta: {
            historyFile: config.sourceName || "",
            strategyFile: config.strategy || "",
        },
    });
    broker.metadata = metadata;
    broker.needsCache = false;
    return broker;
}

/**
 * Simulated data source for backtests.
 *
 * Owns the loaded 1m candle listing and answers history requests off it. This
 * is the backtest broker, so aggregation to higher intervals (1h/1d) happens
 * here, from the 1m base. Honours an `until` upper bound on data freshness so
 * neither the slice nor the aggregation ever peeks past the current simulation
 * moment (look-ahead guard) — the current hour/day is therefore aggregated only
 * from the minutes seen so far, exactly as live would build them.
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

        // Effective exclusive upper bound: the earlier of `to` and just past
        // `until`, so the freshness guard and the requested window combine into
        // one cut and a request "up to now" includes the current minute.
        const upperExcl = Math.min(toTs, untilTs === Infinity ? Infinity : untilTs + 1);
        const base = sliceAscending(this.candles, fromTs, upperExcl);

        const label = getCandleIntervalConfig(interval).label;
        if (label === "1h") return aggregateHourlyCandles(base);
        if (label === "1d") return aggregateDailyCandles(base);
        return base;
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
 * Aggregate 1m candles into hourly candles bucketed by UTC hour.
 * @param {Array<object>} candles - Source 1m candles (ascending).
 * @returns {Array<object>} Hourly candles.
 */
export function aggregateHourlyCandles(candles) {
    const buckets = new Map();
    for (const bar of candles) {
        const key = Math.floor(bar.datetime.getTime() / 3_600_000) * 3_600_000;
        const existing = buckets.get(key);
        if (!existing) {
            buckets.set(key, {
                datetime: new Date(key),
                open: bar.open,
                high: bar.high,
                low: bar.low,
                close: bar.close,
                volume: Number(bar.volume || 0),
                isComplete: true,
            });
            continue;
        }
        existing.high = Math.max(existing.high, bar.high);
        existing.low = Math.min(existing.low, bar.low);
        existing.close = bar.close;
        existing.volume += Number(bar.volume || 0);
    }
    return Array.from(buckets.values())
        .sort((a, b) => a.datetime.getTime() - b.datetime.getTime());
}

/**
 * Aggregate intraday candles into Moscow-date daily candles.
 * @param {Array<object>} candles - Source candles (ascending).
 * @returns {Array<object>} Daily candles (carry both datetime and dateKey).
 */
export function aggregateDailyCandles(candles) {
    const grouped = new Map();
    for (const candle of candles) {
        const dateKey = getMoscowDateKey(candle.datetime);
        const existing = grouped.get(dateKey);
        if (!existing) {
            grouped.set(dateKey, {
                datetime: candle.datetime,
                dateKey,
                open: candle.open,
                high: candle.high,
                low: candle.low,
                close: candle.close,
                volume: Number(candle.volume || 0),
                isComplete: true,
            });
            continue;
        }
        existing.high = Math.max(existing.high, candle.high);
        existing.low = Math.min(existing.low, candle.low);
        existing.close = candle.close;
        existing.volume += Number(candle.volume || 0);
    }
    return Array.from(grouped.values())
        .sort((a, b) => a.datetime.getTime() - b.datetime.getTime());
}

/**
 * Candles within [fromTs, toTs) via binary search (input ascending by time),
 * so repeated per-bar history slices over the full listing stay O(log n + win).
 * @param {Array<object>} candles - Source candles (ascending).
 * @param {number} fromTs - Start (inclusive).
 * @param {number} toTs - End (exclusive).
 * @returns {Array<object>} Filtered candles.
 */
function sliceAscending(candles, fromTs, toTs) {
    const n = candles.length;
    if (n === 0) return [];

    let lo = 0;
    let hi = n;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (candles[mid].datetime.getTime() < fromTs) lo = mid + 1;
        else hi = mid;
    }

    const out = [];
    for (let i = lo; i < n; i += 1) {
        if (candles[i].datetime.getTime() >= toTs) break;
        out.push(candles[i]);
    }
    return out;
}
