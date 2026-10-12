import { getCandleIntervalConfig, toDate } from "./market-data.js";

/**
 * Caching decorator over a broker data source's history.
 *
 * It is mode-blind: it wraps any object exposing getHistory/getTradingSchedule
 * /stream and only memoises history. Where the candles come from is NOT its
 * concern — the backtest broker serves each interval straight from the
 * multi-interval parquet file (no aggregation), and the live broker requests the
 * needed intervals natively from the exchange; the cache simply remembers what
 * each interval returned. To stay correct around the moving "now", it caches
 * only requests whose whole range is settled in the past (the last candle is
 * complete); anything reaching into the current interval is passed straight
 * through and never stored. Coverage is tracked per interval as a single
 * expanding range, refetched from the source on a miss.
 */
export class MarketDataCache {
    constructor(dataSource) {
        this.dataSource = dataSource;
        this.byInterval = new Map();
    }

    stream() {
        return this.dataSource.stream();
    }

    getTradingSchedule(params = {}) {
        return this.dataSource.getTradingSchedule(params);
    }

    // Universe and instrument descriptions — uncached, straight from the source. Without
    // these two methods context.getSymbols() returned an empty list live, and
    // getInstrumentMetadata(ticker) returned the shared metadata instead of the lot.
    getSymbols() {
        return this.dataSource.getSymbols?.() ?? [];
    }

    getInstrument(ticker) {
        return this.dataSource.getInstrument?.(ticker) ?? null;
    }

    /**
     * History with caching of settled-past ranges.
     * @param {object} params - { from, to, interval, until }.
     * @returns {Promise<Array<object>>} Candles in [from, to).
     */
    async getHistory({ from = null, to = null, interval = "1m", until, ticker = null } = {}) {
        const fromTs = from ? toDate(from).getTime() : -Infinity;
        const toTs = to ? toDate(to).getTime() : Infinity;
        const intervalMs = (getCandleIntervalConfig(interval).minutes || 1) * 60 * 1000;

        // Only cache fully-settled ranges; let live-edge requests pass through.
        const settled = Number.isFinite(toTs) && toTs <= Date.now() - intervalMs;
        if (!settled) {
            return this.dataSource.getHistory({ from, to, interval, until, ticker });
        }

        // The ticker must be part of the key: otherwise a request for a second instrument
        // would hit the first one's coverage and silently return someone else's candles.
        const key = `${ticker ?? ""}|${interval}`;
        const entry = this.byInterval.get(key);

        if (entry && fromTs >= entry.fromTs && toTs <= entry.toTs) {
            return sliceRange(entry.candles, fromTs, toTs);
        }

        const newFromTs = entry ? Math.min(fromTs, entry.fromTs) : fromTs;
        const newToTs = entry ? Math.max(toTs, entry.toTs) : toTs;
        const candles = await this.dataSource.getHistory({
            from: new Date(newFromTs),
            to: new Date(newToTs),
            interval,
            ticker,
        });
        this.byInterval.set(key, { fromTs: newFromTs, toTs: newToTs, candles });

        return sliceRange(candles, fromTs, toTs);
    }
}

/**
 * Candles within [fromTs, toTs).
 * @param {Array<object>} candles - Source candles.
 * @param {number} fromTs - Start (inclusive).
 * @param {number} toTs - End (exclusive).
 * @returns {Array<object>} Filtered candles.
 */
function sliceRange(candles, fromTs, toTs) {
    return candles.filter((candle) => {
        const ts = candle.datetime.getTime();
        return ts >= fromTs && ts < toTs;
    });
}
