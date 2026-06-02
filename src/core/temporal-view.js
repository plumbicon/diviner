import { DEFAULT_EXCHANGE } from "./market-data.js";

/**
 * Temporal view over a data source.
 *
 * This is the only layer that knows the strategy's current time (`now`). The
 * engine pushes `now` down via {@link setNow}; the view injects it as the
 * `until` bound on history requests so a strategy can never read candles past
 * the current moment (look-ahead guard). It exposes the stable data facade that
 * strategies use: getCandles / getTradingSchedule / log / metadata.
 *
 * It is режим-слепой: it talks only to a data source (raw broker data source in
 * backtest, or a cache wrapping the live data source) and never knows whether
 * it is live or backtest.
 */
export class TemporalView {
    constructor({ dataSource, metadata = {}, logger = null } = {}) {
        this.dataSource = dataSource;
        this.metadata = metadata || {};
        this.logger = logger;
        this.now = null;
    }

    /**
     * Set the current strategy time (pushed by the engine on each tick).
     * @param {Date|null} now - Current candle datetime.
     */
    setNow(now) {
        this.now = now;
    }

    /**
     * Current strategy time.
     * @returns {Date|null} Now.
     */
    getNow() {
        return this.now;
    }

    getMetadata() {
        return this.metadata;
    }

    getInstrumentMetadata() {
        return this.metadata.instrument || this.metadata;
    }

    getExchange() {
        return this.getInstrumentMetadata().exchange
            || this.metadata.exchange
            || DEFAULT_EXCHANGE;
    }

    log(message) {
        if (this.logger) {
            this.logger(message);
        }
    }

    /**
     * History for the strategy, clamped to `now`.
     * @param {object} params - Candle request.
     * @returns {Promise<Array<object>>} Candles up to now.
     */
    async getCandles(params = {}) {
        return this.dataSource.getHistory({ ...params, until: this.now ?? Infinity });
    }

    /**
     * Trading schedule for the strategy.
     * @param {object} params - Schedule request.
     * @returns {Promise<Array<object>>} Trading days.
     */
    async getTradingSchedule(params = {}) {
        return this.dataSource.getTradingSchedule(params);
    }
}
