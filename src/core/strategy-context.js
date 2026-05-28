import {
    DEFAULT_EXCHANGE,
    MOSCOW_OFFSET_MS,
    buildCandleDerivedTradingSchedule,
    getCandleIntervalConfig,
    toDate,
} from "./market-data.js";

/**
 * Runtime context exposed to strategies. Strategies ask this object for market
 * data and schedules; runners decide where that data comes from.
 */
export class StrategyContext {
    constructor({
        data = [],
        metadata = {},
        marketDataProvider = null,
        logger = null,
    } = {}) {
        this.data = data;
        this.metadata = metadata || {};
        this.marketDataProvider = marketDataProvider;
        this.logger = logger;
        this.dataIndex = -1;
    }

    /**
     * Update the currently visible candle index.
     * @param {number} index - Current candle index.
     */
    setDataIndex(index) {
        this.dataIndex = index;
    }

    /**
     * Current strategy time.
     * @returns {Date|null} Current candle datetime.
     */
    getNow() {
        if (this.dataIndex < 0 || this.dataIndex >= this.data.length) {
            return null;
        }
        return this.data[this.dataIndex].datetime;
    }

    /**
     * Full metadata attached to the current data source.
     * @returns {object} Metadata.
     */
    getMetadata() {
        return this.metadata;
    }

    /**
     * Instrument metadata for the current context.
     * @returns {object} Instrument metadata.
     */
    getInstrumentMetadata() {
        return this.metadata.instrument || this.metadata;
    }

    /**
     * Exchange for the current context.
     * @returns {string} Exchange code.
     */
    getExchange() {
        return this.getInstrumentMetadata().exchange || this.metadata.exchange || DEFAULT_EXCHANGE;
    }

    /**
     * Write a strategy log message.
     * @param {string} message - Message.
     */
    log(message) {
        if (this.logger) {
            this.logger(message);
        }
    }

    /**
     * Get candles for the current instrument.
     * @param {object} params - Candle request.
     * @returns {Promise<Array<object>>} Candles.
     */
    async getCandles(params = {}) {
        if (!this.marketDataProvider) {
            return this.getCandlesFromLoadedData(params);
        }
        return this.marketDataProvider.getCandles(params);
    }

    /**
     * Get trading schedule for the current instrument/exchange.
     * @param {object} params - Schedule request.
     * @returns {Promise<Array<object>>} Trading days.
     */
    async getTradingSchedule(params = {}) {
        if (!this.marketDataProvider) {
            throw new Error(
                "Trading schedule is not available without a runtime provider.",
            );
        }

        return this.marketDataProvider.getTradingSchedule(params);
    }

    /**
     * Filter loaded candles for the current context.
     * @param {object} params - Candle request.
     * @returns {Array<object>} Candles.
     */
    getCandlesFromLoadedData(params = {}) {
        const {
            from = null,
            to = null,
            interval = this.metadata.intervalLabel || this.metadata.interval || "1m",
        } = params;
        const sourceCandles = this.getVisibleCandles();
        const fromTs = from ? toDate(from).getTime() : -Infinity;
        const toTs = to ? toDate(to).getTime() : Infinity;
        const candles = sourceCandles.filter((candle) => {
            const ts = candle.datetime.getTime();
            return ts >= fromTs && ts < toTs;
        });

        const intervalConfig = getCandleIntervalConfig(interval);
        if (intervalConfig.label === "1d") {
            return aggregateDailyCandles(candles);
        }

        return candles;
    }

    /**
     * Return candles visible to the strategy at the current simulation point.
     * @returns {Array<object>} Visible candles.
     */
    getVisibleCandles() {
        if (this.dataIndex < 0) {
            return [];
        }
        return this.data.slice(0, this.dataIndex + 1);
    }

}

/**
 * Backtest context. It is time-aware and never returns candles beyond the
 * currently processed bar.
 */
export class BacktestStrategyContext extends StrategyContext {
    async getCandles(params = {}) {
        return this.getCandlesFromLoadedData(params);
    }

    async getTradingSchedule(params = {}) {
        return buildCandleDerivedTradingSchedule(this.data, {
            ...params,
            exchange: this.getExchange(),
            intervalMinutes: this.metadata.intervalMinutes,
        });
    }
}

/**
 * Live context. Historical candles come from the live market data provider, while
 * already received live candles are still available through loaded data helpers.
 */
export class LiveStrategyContext extends StrategyContext {
    async getCandles(params = {}) {
        if (this.marketDataProvider) {
            return this.marketDataProvider.getCandles(params);
        }
        return super.getCandles(params);
    }
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
 * Moscow calendar date for a datetime.
 * @param {Date} datetime - Datetime.
 * @returns {string} Date key in YYYY-MM-DD.
 */
export function getMoscowDateKey(datetime) {
    const moscowDate = new Date(datetime.getTime() + MOSCOW_OFFSET_MS);
    const year = moscowDate.getUTCFullYear();
    const month = String(moscowDate.getUTCMonth() + 1).padStart(2, "0");
    const day = String(moscowDate.getUTCDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}
