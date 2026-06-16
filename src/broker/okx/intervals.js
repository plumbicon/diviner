/**
 * Candle interval map for OKX (via ccxt timeframes).
 *
 * The Tinkoff path keys intervals off the `CandleInterval` protobuf enum and
 * Moscow trading days (see core/market-data.js). Crypto is 24/7 in UTC and ccxt
 * speaks plain timeframe strings ("1m", "1h", "1d"), so OKX gets its own tiny
 * map. Each config carries the ccxt timeframe, a human label, the length in
 * minutes (the unit the parquet pipeline and the look-ahead guard work in), and
 * the max number of candles OKX returns per fetchOHLCV call (for pagination).
 */

const MINUTE = 1;
const HOUR = 60;
const DAY = 1440;

// OKX returns up to 300 candles per history request via the public endpoint.
const MAX_CANDLES_PER_CALL = 300;

const INTERVAL_CONFIGS = new Map();

/**
 * Register an interval under all of its accepted CLI tokens.
 * @param {Array<string>} tokens - Accepted values (e.g. ["1", "1m"]).
 * @param {object} config - { ccxtTimeframe, label, minutes }.
 */
function register(tokens, config) {
    const full = { ...config, maxCandlesPerCall: MAX_CANDLES_PER_CALL };
    for (const token of tokens) {
        INTERVAL_CONFIGS.set(token, full);
    }
}

register(["1", "1m"], { ccxtTimeframe: "1m", label: "1m", minutes: 1 * MINUTE });
register(["3", "3m"], { ccxtTimeframe: "3m", label: "3m", minutes: 3 * MINUTE });
register(["5", "5m"], { ccxtTimeframe: "5m", label: "5m", minutes: 5 * MINUTE });
register(["15", "15m"], { ccxtTimeframe: "15m", label: "15m", minutes: 15 * MINUTE });
register(["30", "30m"], { ccxtTimeframe: "30m", label: "30m", minutes: 30 * MINUTE });
register(["60", "1h"], { ccxtTimeframe: "1h", label: "1h", minutes: 1 * HOUR });
register(["120", "2h"], { ccxtTimeframe: "2h", label: "2h", minutes: 2 * HOUR });
register(["240", "4h"], { ccxtTimeframe: "4h", label: "4h", minutes: 4 * HOUR });
register(["360", "6h"], { ccxtTimeframe: "6h", label: "6h", minutes: 6 * HOUR });
register(["720", "12h"], { ccxtTimeframe: "12h", label: "12h", minutes: 12 * HOUR });
register(["1440", "1d", "1D"], { ccxtTimeframe: "1d", label: "1d", minutes: 1 * DAY });

/**
 * Resolve an interval token to its config.
 * @param {string|number} value - CLI token (e.g. "5", "5m", "1h").
 * @returns {{ ccxtTimeframe: string, label: string, minutes: number, maxCandlesPerCall: number }} Config.
 */
export function getOkxIntervalConfig(value = "1m") {
    const token = String(value).trim();
    const config = INTERVAL_CONFIGS.get(token);
    if (!config) {
        throw new Error(
            `Unsupported OKX interval '${value}'. Supported intervals: ${getSupportedOkxIntervals().join(", ")}`,
        );
    }
    return config;
}

/**
 * The canonical (label) tokens, for help text and validation messages.
 * @returns {Array<string>} Sorted unique interval labels.
 */
export function getSupportedOkxIntervals() {
    const labels = new Set();
    for (const config of INTERVAL_CONFIGS.values()) {
        labels.add(config.label);
    }
    return [...labels].sort((a, b) => {
        const ma = getOkxIntervalConfig(a).minutes;
        const mb = getOkxIntervalConfig(b).minutes;
        return ma - mb;
    });
}

/**
 * Map an interval length in minutes back to a canonical CLI token.
 * Used by fetch-okx when rebuilding metadata for a merged multi-interval file.
 * @param {number} minutes - Interval length in minutes.
 * @returns {string} A token accepted by getOkxIntervalConfig.
 */
export function minutesToOkxIntervalToken(minutes) {
    for (const config of INTERVAL_CONFIGS.values()) {
        if (config.minutes === Number(minutes)) {
            return config.label;
        }
    }
    throw new Error(`No OKX interval token for ${minutes} minutes`);
}
