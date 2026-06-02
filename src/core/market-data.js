import {
    CandleInterval,
    GetCandlesRequest_CandleSource,
} from "tinkoff-invest-api/dist/generated/marketdata.js";

export const DEFAULT_EXCHANGE = "MOEX";
export const MOSCOW_TIMEZONE = "Europe/Moscow";
export const MOSCOW_OFFSET_MS = 3 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;
const SCHEDULE_CHUNK_MS = 14 * DAY_MS;
// T-Invest TradingSchedules rejects a `to` further than ~14 days ahead of the
// current date (error: "period should not exceed 14 days"), regardless of the
// from..to span. Clamp the requested end below that limit.
const SCHEDULE_MAX_AHEAD_MS = 13 * DAY_MS;

const INTERVAL_CONFIGS = new Map([
    ["1", {
        apiInterval: CandleInterval.CANDLE_INTERVAL_1_MIN,
        label: "1m",
        minutes: 1,
        maxSpanMs: DAY_MS,
    }],
    ["1m", {
        apiInterval: CandleInterval.CANDLE_INTERVAL_1_MIN,
        label: "1m",
        minutes: 1,
        maxSpanMs: DAY_MS,
    }],
    ["2", {
        apiInterval: CandleInterval.CANDLE_INTERVAL_2_MIN,
        label: "2m",
        minutes: 2,
        maxSpanMs: DAY_MS,
    }],
    ["2m", {
        apiInterval: CandleInterval.CANDLE_INTERVAL_2_MIN,
        label: "2m",
        minutes: 2,
        maxSpanMs: DAY_MS,
    }],
    ["3", {
        apiInterval: CandleInterval.CANDLE_INTERVAL_3_MIN,
        label: "3m",
        minutes: 3,
        maxSpanMs: DAY_MS,
    }],
    ["3m", {
        apiInterval: CandleInterval.CANDLE_INTERVAL_3_MIN,
        label: "3m",
        minutes: 3,
        maxSpanMs: DAY_MS,
    }],
    ["5", {
        apiInterval: CandleInterval.CANDLE_INTERVAL_5_MIN,
        label: "5m",
        minutes: 5,
        maxSpanMs: 7 * DAY_MS,
    }],
    ["5m", {
        apiInterval: CandleInterval.CANDLE_INTERVAL_5_MIN,
        label: "5m",
        minutes: 5,
        maxSpanMs: 7 * DAY_MS,
    }],
    ["10", {
        apiInterval: CandleInterval.CANDLE_INTERVAL_10_MIN,
        label: "10m",
        minutes: 10,
        maxSpanMs: 7 * DAY_MS,
    }],
    ["10m", {
        apiInterval: CandleInterval.CANDLE_INTERVAL_10_MIN,
        label: "10m",
        minutes: 10,
        maxSpanMs: 7 * DAY_MS,
    }],
    ["15", {
        apiInterval: CandleInterval.CANDLE_INTERVAL_15_MIN,
        label: "15m",
        minutes: 15,
        maxSpanMs: 21 * DAY_MS,
    }],
    ["15m", {
        apiInterval: CandleInterval.CANDLE_INTERVAL_15_MIN,
        label: "15m",
        minutes: 15,
        maxSpanMs: 21 * DAY_MS,
    }],
    ["30", {
        apiInterval: CandleInterval.CANDLE_INTERVAL_30_MIN,
        label: "30m",
        minutes: 30,
        maxSpanMs: 21 * DAY_MS,
    }],
    ["30m", {
        apiInterval: CandleInterval.CANDLE_INTERVAL_30_MIN,
        label: "30m",
        minutes: 30,
        maxSpanMs: 21 * DAY_MS,
    }],
    ["60", {
        apiInterval: CandleInterval.CANDLE_INTERVAL_HOUR,
        label: "1h",
        minutes: 60,
        maxSpanMs: 90 * DAY_MS,
    }],
    ["1h", {
        apiInterval: CandleInterval.CANDLE_INTERVAL_HOUR,
        label: "1h",
        minutes: 60,
        maxSpanMs: 90 * DAY_MS,
    }],
    ["120", {
        apiInterval: CandleInterval.CANDLE_INTERVAL_2_HOUR,
        label: "2h",
        minutes: 120,
        maxSpanMs: 90 * DAY_MS,
    }],
    ["2h", {
        apiInterval: CandleInterval.CANDLE_INTERVAL_2_HOUR,
        label: "2h",
        minutes: 120,
        maxSpanMs: 90 * DAY_MS,
    }],
    ["240", {
        apiInterval: CandleInterval.CANDLE_INTERVAL_4_HOUR,
        label: "4h",
        minutes: 240,
        maxSpanMs: 90 * DAY_MS,
    }],
    ["4h", {
        apiInterval: CandleInterval.CANDLE_INTERVAL_4_HOUR,
        label: "4h",
        minutes: 240,
        maxSpanMs: 90 * DAY_MS,
    }],
    ["24", {
        apiInterval: CandleInterval.CANDLE_INTERVAL_DAY,
        label: "1d",
        minutes: 1440,
        maxSpanMs: 6 * 366 * DAY_MS,
    }],
    ["1d", {
        apiInterval: CandleInterval.CANDLE_INTERVAL_DAY,
        label: "1d",
        minutes: 1440,
        maxSpanMs: 6 * 366 * DAY_MS,
    }],
    ["day", {
        apiInterval: CandleInterval.CANDLE_INTERVAL_DAY,
        label: "1d",
        minutes: 1440,
        maxSpanMs: 6 * 366 * DAY_MS,
    }],
    ["7", {
        apiInterval: CandleInterval.CANDLE_INTERVAL_WEEK,
        label: "1w",
        minutes: 7 * 1440,
        maxSpanMs: 5 * 366 * DAY_MS,
    }],
    ["1w", {
        apiInterval: CandleInterval.CANDLE_INTERVAL_WEEK,
        label: "1w",
        minutes: 7 * 1440,
        maxSpanMs: 5 * 366 * DAY_MS,
    }],
    ["31", {
        apiInterval: CandleInterval.CANDLE_INTERVAL_MONTH,
        label: "1M",
        minutes: 31 * 1440,
        maxSpanMs: 10 * 366 * DAY_MS,
    }],
    ["1M", {
        apiInterval: CandleInterval.CANDLE_INTERVAL_MONTH,
        label: "1M",
        minutes: 31 * 1440,
        maxSpanMs: 10 * 366 * DAY_MS,
    }],
]);

/**
 * Return a normalized candle interval configuration.
 * @param {string|number} value - Interval value from CLI, metadata, or strategy context.
 * @returns {object} Interval configuration.
 */
export function getCandleIntervalConfig(value = "1m") {
    const interval = INTERVAL_CONFIGS.get(String(value));
    if (!interval) {
        throw new Error(
            `Unsupported interval '${value}'. Supported intervals: ${getSupportedIntervalValues().join(", ")}`,
        );
    }
    return interval;
}

/**
 * Return supported interval CLI values.
 * @returns {string[]} Supported values.
 */
export function getSupportedIntervalValues() {
    return Array.from(new Set(
        Array.from(INTERVAL_CONFIGS.keys()).filter((item) => /^\d+$/.test(item)),
    ));
}

/**
 * T-Invest-backed provider for market candles and exchange trading schedule.
 */
export class TinkoffMarketDataProvider {
    constructor({
        api,
        instrument = null,
        exchange = null,
        requestDelayMs = 0,
        onRequest = null,
    }) {
        this.api = api;
        this.instrument = instrument;
        this.exchange = exchange || instrument?.exchange || DEFAULT_EXCHANGE;
        this.requestDelayMs = requestDelayMs;
        this.onRequest = onRequest;
    }

    /**
     * Load candles for the context instrument.
     * @param {object} params - Candle request.
     * @param {Date|string} params.from - Start time.
     * @param {Date|string} params.to - End time.
     * @param {string|number} params.interval - Candle interval.
     * @param {boolean} [params.includeWeekend] - Include weekend candles.
     * @returns {Promise<Array<object>>} Normalized candles.
     */
    async getCandles({ from, to, interval = "1m", includeWeekend = false }) {
        if (!this.instrument) {
            throw new Error("Instrument metadata is required to request candles.");
        }

        const intervalConfig = getCandleIntervalConfig(interval);
        const instrumentId = this.instrument.instrumentUid
            || this.instrument.uid
            || this.instrument.figi;

        if (!instrumentId) {
            throw new Error("Instrument uid or figi is required to request candles.");
        }

        const start = toDate(from);
        const end = toDate(to);
        const candlesByTime = new Map();
        let cursor = start;
        let requestNumber = 0;

        while (cursor < end) {
            const chunkTo = new Date(
                Math.min(cursor.getTime() + intervalConfig.maxSpanMs, end.getTime()),
            );
            requestNumber += 1;
            this.onRequest?.({
                type: "candles",
                requestNumber,
                from: cursor,
                to: chunkTo,
                interval: intervalConfig.label,
            });

            const request = {
                instrumentId,
                from: cursor,
                to: chunkTo,
                interval: intervalConfig.apiInterval,
            };

            if (includeWeekend) {
                request.candleSourceType =
                    GetCandlesRequest_CandleSource.CANDLE_SOURCE_INCLUDE_WEEKEND;
            }

            const response = await this.api.marketdata.getCandles(request);
            for (const candle of response.candles || []) {
                const normalized = this.normalizeApiCandle(candle);
                if (
                    normalized.datetime < start ||
                    normalized.datetime > end
                ) {
                    continue;
                }
                candlesByTime.set(normalized.datetime.toISOString(), normalized);
            }

            cursor = chunkTo;
            if (cursor < end && this.requestDelayMs > 0) {
                await sleep(this.requestDelayMs);
            }
        }

        return Array.from(candlesByTime.values())
            .sort((a, b) => a.datetime.getTime() - b.datetime.getTime());
    }

    /**
     * Load exchange trading schedule.
     * @param {object} params - Schedule request.
     * @param {Date|string} params.from - Start time.
     * @param {Date|string} params.to - End time.
     * @returns {Promise<Array<object>>} Normalized trading days.
     */
    async getTradingSchedule({ from, to }) {
        const requestedStart = toDate(from);
        const maxEnd = new Date(Date.now() + SCHEDULE_MAX_AHEAD_MS);
        const requestedEnd = toDate(to);
        const end = requestedEnd > maxEnd ? maxEnd : requestedEnd;
        const start = clampTradingScheduleStart(requestedStart, end);
        if (!start || start >= end) {
            return [];
        }

        const daysByKey = new Map();
        let cursor = start;
        let requestNumber = 0;

        while (cursor < end) {
            const chunkTo = new Date(
                Math.min(cursor.getTime() + SCHEDULE_CHUNK_MS, end.getTime()),
            );
            requestNumber += 1;
            this.onRequest?.({
                type: "schedule",
                requestNumber,
                exchange: this.exchange,
                from: cursor,
                to: chunkTo,
            });

            const response = await this.fetchTradingScheduleChunk(cursor, chunkTo, requestNumber);

            for (const day of normalizeTradingScheduleResponse(response)) {
                daysByKey.set(`${day.exchange}:${day.dateKey}`, day);
            }

            cursor = chunkTo;
            if (cursor < end && this.requestDelayMs > 0) {
                await sleep(this.requestDelayMs);
            }
        }

        return Array.from(daysByKey.values())
            .sort((a, b) => (
                a.dateKey === b.dateKey
                    ? a.exchange.localeCompare(b.exchange)
                    : a.dateKey.localeCompare(b.dateKey)
            ));
    }

    /**
     * Fetch one schedule chunk and retry from current time if the API rejects
     * a start inside today's Moscow session but before today's UTC date.
     * @param {Date} from - API request start.
     * @param {Date} to - API request end.
     * @param {number} requestNumber - Request sequence number.
     * @returns {Promise<object>} Raw T-Invest schedule response.
     */
    async fetchTradingScheduleChunk(from, to, requestNumber) {
        try {
            return await this.api.instruments.tradingSchedules({
                exchange: this.exchange,
                from,
                to,
            });
        } catch (error) {
            if (!isHistoricalTradingScheduleError(error)) {
                throw error;
            }

            const retryFrom = new Date();
            if (retryFrom >= to) {
                throw error;
            }

            this.onRequest?.({
                type: "schedule_retry",
                requestNumber,
                exchange: this.exchange,
                from: retryFrom,
                to,
            });

            return this.api.instruments.tradingSchedules({
                exchange: this.exchange,
                from: retryFrom,
                to,
            });
        }
    }

    /**
     * Convert a T-Invest SDK candle to Diviner candle shape.
     * @param {object} candle - API candle.
     * @returns {object} Normalized candle.
     */
    normalizeApiCandle(candle) {
        return {
            datetime: new Date(candle.time),
            open: this.api.helpers.toNumber(candle.open),
            high: this.api.helpers.toNumber(candle.high),
            low: this.api.helpers.toNumber(candle.low),
            close: this.api.helpers.toNumber(candle.close),
            volume: Number(candle.volume || 0),
            isComplete: candle.isComplete ?? true,
        };
    }
}

/**
 * T-Invest TradingSchedules does not accept historical `from` dates. A Moscow
 * trading day starts at 21:00 UTC on the previous calendar date, so live
 * requests for today's schedule need to be shifted to today's UTC date.
 * @param {Date} from - Requested schedule start.
 * @param {Date} to - Requested schedule end.
 * @param {Date} [now] - Current time.
 * @returns {Date|null} API-safe request start, or null for wholly historical ranges.
 */
export function clampTradingScheduleStart(from, to, now = new Date()) {
    const todayUtcStart = new Date(Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
    ));

    if (to <= todayUtcStart) {
        return null;
    }

    return from < todayUtcStart ? todayUtcStart : from;
}

function isHistoricalTradingScheduleError(error) {
    const message = String(error?.message || error || "");
    return message.includes("from") && message.includes("current date");
}

/**
 * Normalize T-Invest trading schedule response into stable JSON-ready days.
 * @param {object} response - T-Invest TradingSchedules response.
 * @returns {Array<object>} Normalized trading days.
 */
export function normalizeTradingScheduleResponse(response) {
    const days = [];

    for (const exchangeSchedule of response.exchanges || []) {
        const exchange = exchangeSchedule.exchange || DEFAULT_EXCHANGE;

        for (const day of exchangeSchedule.days || []) {
            const date = toNullableIso(day.date);
            const dateKey = date ? date.slice(0, 10) : null;

            if (!dateKey) {
                continue;
            }

            days.push({
                exchange,
                date,
                dateKey,
                isTradingDay: Boolean(day.isTradingDay),
                startTime: toNullableIso(day.startTime),
                endTime: toNullableIso(day.endTime),
            });
        }
    }

    return days;
}

/**
 * Build portable instrument metadata for Parquet and strategy contexts.
 * @param {object} instrument - T-Invest instrument descriptor.
 * @param {object} [extra] - Additional metadata.
 * @returns {object} JSON-ready instrument metadata.
 */
export function buildInstrumentMetadata(instrument, extra = {}) {
    return {
        ticker: instrument?.ticker || extra.ticker || null,
        classCode: instrument?.classCode || extra.classCode || null,
        figi: instrument?.figi || extra.figi || null,
        uid: instrument?.uid || instrument?.instrumentUid || extra.uid || null,
        instrumentUid: instrument?.instrumentUid || instrument?.uid || extra.instrumentUid || null,
        positionUid: instrument?.positionUid || extra.positionUid || null,
        name: instrument?.name || extra.name || null,
        exchange: instrument?.exchange || extra.exchange || DEFAULT_EXCHANGE,
        lot: Number(instrument?.lot || extra.lot || 1),
        currency: instrument?.currency || extra.currency || null,
    };
}

/**
 * Build a best-effort schedule from the candles themselves. This is used for
 * historical backtests when the broker API no longer returns old schedules.
 * @param {Array<object>} candles - Candles with datetime or time.
 * @param {object} params - Schedule parameters.
 * @param {string} [params.exchange] - Exchange code.
 * @param {Date|string} [params.from] - Start time.
 * @param {Date|string} [params.to] - End time.
 * @param {number} [params.intervalMinutes] - Candle interval in minutes.
 * @returns {Array<object>} Schedule days.
 */
export function buildCandleDerivedTradingSchedule(
    candles,
    {
        exchange = DEFAULT_EXCHANGE,
        from = null,
        to = null,
        intervalMinutes = 1,
    } = {},
) {
    const fromTs = from ? toDate(from).getTime() : -Infinity;
    const toTs = to ? toDate(to).getTime() : Infinity;
    const intervalMs = Math.max(Number(intervalMinutes) || 1, 1) * 60 * 1000;
    const candlesByDate = new Map();

    for (const candle of candles || []) {
        const datetime = toDate(candle.datetime || candle.time);
        const ts = datetime.getTime();
        if (!Number.isFinite(ts) || ts < fromTs || ts >= toTs) {
            continue;
        }

        const dateParts = getMoscowDateParts(datetime);
        if (!candlesByDate.has(dateParts.dateKey)) {
            candlesByDate.set(dateParts.dateKey, []);
        }
        candlesByDate.get(dateParts.dateKey).push({ ts });
    }

    return Array.from(candlesByDate.entries())
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([dateKey, items]) => {
            items.sort((a, b) => a.ts - b.ts);

            const firstTs = items[0].ts;
            const endTs = items[items.length - 1].ts + intervalMs;

            return {
                exchange,
                date: `${dateKey}T00:00:00.000Z`,
                dateKey,
                isTradingDay: true,
                startTime: new Date(firstTs).toISOString(),
                endTime: new Date(endTs).toISOString(),
            };
        });
}

/**
 * Convert a Date-like value into Date.
 * @param {Date|string|number} value - Input value.
 * @returns {Date} Date object.
 */
export function toDate(value) {
    if (value instanceof Date) {
        return value;
    }
    return new Date(value);
}

/**
 * Convert a Date-like value to ISO string or null.
 * @param {Date|string|null|undefined} value - Input value.
 * @returns {string|null} ISO value.
 */
export function toNullableIso(value) {
    if (!value) {
        return null;
    }
    return toDate(value).toISOString();
}

function getMoscowDateParts(datetime) {
    const moscowDate = new Date(datetime.getTime() + MOSCOW_OFFSET_MS);
    const year = moscowDate.getUTCFullYear();
    const month = String(moscowDate.getUTCMonth() + 1).padStart(2, "0");
    const day = String(moscowDate.getUTCDate()).padStart(2, "0");

    return {
        dateKey: `${year}-${month}-${day}`,
        hour: moscowDate.getUTCHours(),
        minute: moscowDate.getUTCMinutes(),
    };
}

function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}
