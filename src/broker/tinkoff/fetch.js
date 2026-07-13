#!/usr/bin/env node
import { Command } from "commander";
import { rename } from "node:fs/promises";
import { TinkoffInvestApi } from "tinkoff-invest-api";
import { InstrumentIdType } from "tinkoff-invest-api/dist/generated/instruments.js";
import {
    writeCandleRowsAsParquet,
    writeCandleSeriesAsParquet,
} from "../../core/candle-parquet.js";
import { loadDataset } from "../../core/data-loader.js";
import {
    DEFAULT_EXCHANGE,
    MOSCOW_TIMEZONE,
    buildInstrumentMetadata,
    getCandleIntervalConfig,
    getSupportedIntervalValues,
} from "../../core/market-data.js";

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;

const COLUMNS = [
    "open",
    "high",
    "low",
    "close",
    "value",
    "volume",
    "begin",
    "end",
];

/**
 * Fetch historical candles from Tinkoff Invest API.
 * @param {object} params - Fetch parameters.
 * @param {TinkoffInvestApi} params.api - Initialized Tinkoff API client.
 * @param {object} params.instrument - Tinkoff instrument descriptor.
 * @param {Date} params.from - Start datetime.
 * @param {Date} params.to - End datetime.
 * @param {object} params.interval - Interval configuration.
 * @param {number} params.requestDelayMs - Delay between API requests.
 * @returns {Promise<Array<object>>} Historical candles sorted by time.
 */
async function fetchAllCandles({
    api,
    instrument,
    from,
    to,
    interval,
    requestDelayMs,
}) {
    const candlesByTime = new Map();
    let cursor = from;
    let requestNumber = 0;

    while (cursor < to) {
        const chunkTo = new Date(
            Math.min(cursor.getTime() + interval.maxSpanMs, to.getTime()),
        );
        requestNumber += 1;

        console.error(
            `Request ${requestNumber}: ${cursor.toISOString()} -> ${chunkTo.toISOString()}`,
        );

        const response = await api.marketdata.getCandles({
            instrumentId: instrument.uid || instrument.figi,
            from: cursor,
            to: chunkTo,
            interval: interval.apiInterval,
        });

        for (const candle of response.candles || []) {
            const candleTime = candle.time;
            if (!candleTime || candleTime < from || candleTime > to) {
                continue;
            }
            const time = candleTime.toISOString();
            candlesByTime.set(time, candle);
        }

        cursor = chunkTo;
        if (cursor < to && requestDelayMs > 0) {
            await sleep(requestDelayMs);
        }
    }

    return Array.from(candlesByTime.values())
        .sort((a, b) => a.time.getTime() - b.time.getTime());
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Find a MOEX stock instrument by ticker and class code.
 * @param {TinkoffInvestApi} api - Initialized Tinkoff API client.
 * @param {string} ticker - Security ticker.
 * @param {string} classCode - Exchange class code.
 * @returns {Promise<object>} Instrument descriptor.
 */
async function findInstrument(api, ticker, classCode) {
    const { instruments } = await api.instruments.findInstrument({
        query: ticker,
    });
    const instrument = instruments.find(
        (item) => item.ticker === ticker && item.classCode === classCode,
    );

    if (!instrument) {
        // Fallback: индексы/индикативы (IMOEX, RTSI, RVI…) не возвращаются
        // findInstrument как shares — их отдаёт отдельный метод indicatives().
        const { instruments: indicatives } = await api.instruments.indicatives({});
        const indicative = indicatives.find((item) => item.ticker === ticker);
        if (indicative) {
            return indicative;   // имеет uid/figi — достаточно для getCandles
        }
        throw new Error(`Instrument ${ticker} with class code ${classCode} not found.`);
    }

    const response = await api.instruments.getInstrumentBy({
        idType: InstrumentIdType.INSTRUMENT_ID_TYPE_UID,
        id: instrument.uid,
        classCode: instrument.classCode,
    });

    return {
        ...instrument,
        ...(response.instrument || {}),
    };
}

function toMoexCompatibleRow(api, candle) {
    const begin = candle.time;

    return [
        api.helpers.toNumber(candle.open),
        api.helpers.toNumber(candle.high),
        api.helpers.toNumber(candle.low),
        api.helpers.toNumber(candle.close),
        null,
        Number(candle.volume || 0),
        begin.toISOString(),
        null,
    ];
}

/**
 * Convert a Tinkoff API candle into a normalized record for the Parquet writer.
 * @param {TinkoffInvestApi} api - Initialized Tinkoff API client.
 * @param {object} candle - API candle.
 * @returns {object} Normalized candle record.
 */
function toCandleRecord(api, candle) {
    return {
        datetime: candle.time,
        open: api.helpers.toNumber(candle.open),
        high: api.helpers.toNumber(candle.high),
        low: api.helpers.toNumber(candle.low),
        close: api.helpers.toNumber(candle.close),
        volume: Number(candle.volume || 0),
    };
}

/**
 * Map an interval length in minutes back to a valid --interval token.
 * Most intervals use their minute count, but daily/weekly use API codes.
 * @param {number} minutes - Interval length in minutes.
 * @returns {string} A token accepted by getCandleIntervalConfig.
 */
function minutesToIntervalValue(minutes) {
    if (minutes === 1440) return "24";
    if (minutes === 10080) return "7";
    return String(minutes);
}

function parseMoscowDateStart(value, optionName) {
    assertDate(value, optionName);
    return new Date(`${value}T00:00:00.000+03:00`);
}

function parseMoscowDateEnd(value, optionName) {
    assertDate(value, optionName);
    return new Date(`${value}T23:59:59.999+03:00`);
}

function assertDate(value, optionName) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw new Error(`${optionName} must be in YYYY-MM-DD format.`);
    }
}

function buildMetadata(options, instrument, intervals) {
    const instrumentMetadata = buildInstrumentMetadata(instrument, {
        ticker: options.security,
        classCode: options.classCode,
        exchange: instrument.exchange || DEFAULT_EXCHANGE,
    });

    // Base interval = the smallest one present; it is what the engine streams.
    const sorted = [...intervals].sort((a, b) => a.minutes - b.minutes);
    const base = sorted[0];

    return {
        source: "tinkoff",
        schemaVersion: 1,
        instrument: instrumentMetadata,
        ticker: instrumentMetadata.ticker,
        classCode: instrumentMetadata.classCode,
        figi: instrumentMetadata.figi,
        instrumentUid: instrumentMetadata.instrumentUid,
        exchange: instrumentMetadata.exchange,
        interval: base.value,
        intervalLabel: base.label,
        intervalMinutes: base.minutes,
        // Every interval stored in the file (sorted, base first).
        intervals: sorted.map((item) => ({ minutes: item.minutes, label: item.label })),
        fromDate: options.fromDate,
        tillDate: options.tillDate,
        timezone: MOSCOW_TIMEZONE,
    };
}

/**
 * Parse the --interval option into a de-duplicated list of interval configs.
 * Accepts a single value ("1") or a comma-separated list ("1,24").
 * @param {string} value - Raw option value.
 * @returns {Array<object>} Interval configurations (each carries its raw `value`).
 */
function parseIntervalList(value) {
    const seen = new Map();
    for (const part of String(value).split(",")) {
        const token = part.trim();
        if (!token) continue;
        const config = getCandleIntervalConfig(token);
        seen.set(config.minutes, { ...config, value: token });
    }
    if (seen.size === 0) {
        throw new Error("--interval must contain at least one interval value.");
    }
    return [...seen.values()].sort((a, b) => a.minutes - b.minutes);
}

function parseNonNegativeInteger(value, optionName) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error(`${optionName} must be a non-negative integer.`);
    }
    return parsed;
}

async function main() {
    const program = new Command();

    program
        .name("fetch")
        .description("Fetch historical candle data from Tinkoff Invest API")
        .requiredOption("--from-date <date>", "Start date in YYYY-MM-DD format")
        .option("--security <ticker>", "Security ticker (e.g., SBER)", "SBER")
        .option("--ticker <ticker>", "Alias for --security")
        .option("--class-code <code>", "Exchange class code", "TQBR")
        .option(
            "--till-date <date>",
            "End date in YYYY-MM-DD format",
            new Date(Date.now() + MSK_OFFSET_MS).toISOString().slice(0, 10),
        )
        .option(
            "--interval <list>",
            `Candle interval(s), comma-separated for a multi-interval file: ${getSupportedIntervalValues().join(", ")}`,
            "24",
        )
        .option("--parquet", "Write Parquet to stdout instead of JSON")
        .option(
            "--merge-into <path>",
            "Augment an existing Parquet file with the fetched interval(s) and rewrite it in place",
        )
        .option("--request-delay-ms <ms>", "Delay between API requests", "100");

    program.parse();
    const options = program.opts();
    options.security = options.ticker || options.security;

    const token = process.env.T_INVEST_TOKEN;
    if (!token) {
        program.error("T_INVEST_TOKEN environment variable is required");
    }

    let intervals;
    let from;
    let to;

    try {
        intervals = parseIntervalList(options.interval);
        from = parseMoscowDateStart(options.fromDate, "--from-date");
        to = parseMoscowDateEnd(options.tillDate, "--till-date");
        options.requestDelayMs = parseNonNegativeInteger(
            options.requestDelayMs,
            "--request-delay-ms",
        );
    } catch (error) {
        program.error(error.message);
    }

    if (from > to) {
        program.error("--from-date must be earlier than or equal to --till-date");
    }

    const multiInterval = intervals.length > 1;
    if (multiInterval && !options.parquet && !options.mergeInto) {
        program.error("multiple --interval values require --parquet or --merge-into");
    }

    const api = new TinkoffInvestApi({ token });
    const instrument = await findInstrument(api, options.security, options.classCode);

    // Fetch every requested interval into a Map<minutes, records>.
    const seriesByMinutes = new Map();
    for (const interval of intervals) {
        console.error(
            `Fetching ${interval.label} candles for ${options.security} (${instrument.figi}) from ${options.fromDate} to ${options.tillDate} via Tinkoff...`,
        );
        const candles = await fetchAllCandles({
            api,
            instrument,
            from,
            to,
            interval,
            requestDelayMs: options.requestDelayMs,
        });
        console.error(`  ${interval.label}: ${candles.length} rows`);
        seriesByMinutes.set(interval.minutes, candles.map((c) => toCandleRecord(api, c)));
    }

    // Augment an existing file: merge fetched intervals into its stored series.
    if (options.mergeInto) {
        await mergeIntoExistingFile({ path: options.mergeInto, seriesByMinutes, instrument, options });
        return;
    }

    const metadata = buildMetadata(options, instrument, intervals);

    if (multiInterval) {
        const buffer = await writeCandleSeriesAsParquet(seriesByMinutes, null, metadata);
        if (buffer) process.stdout.write(buffer);
        return;
    }

    // Single interval: keep the legacy MOEX-row output (JSON or Parquet).
    const records = seriesByMinutes.get(intervals[0].minutes);
    const rows = records.map((r) => [r.open, r.high, r.low, r.close, null, r.volume, r.datetime.toISOString(), null]);

    if (options.parquet) {
        const buffer = await writeCandleRowsAsParquet(rows, null, metadata);
        if (buffer) process.stdout.write(buffer);
        return;
    }

    console.log(JSON.stringify({
        candles: {
            metadata,
            columns: COLUMNS,
            data: rows,
        },
    }));
}

/**
 * Merge freshly fetched intervals into an existing Parquet file and rewrite it.
 *
 * Existing intervals are preserved; a fetched interval replaces the stored one
 * of the same length (deduplicated by timestamp, fetched candles win). The file
 * is written to a temporary path and atomically renamed over the original.
 *
 * @param {object} params - Merge parameters.
 * @param {string} params.path - Existing Parquet path to augment in place.
 * @param {Map<number, Array<object>>} params.seriesByMinutes - Fetched candles by interval minutes.
 * @param {object} params.instrument - Tinkoff instrument descriptor.
 * @param {object} params.options - CLI options.
 */
async function mergeIntoExistingFile({ path, seriesByMinutes, instrument, options }) {
    const existing = await loadDataset(path);
    const merged = new Map(existing.series);

    for (const [minutes, records] of seriesByMinutes) {
        const byTime = new Map();
        for (const candle of merged.get(minutes) || []) {
            byTime.set(candle.datetime.getTime(), candle);
        }
        for (const record of records) {
            byTime.set(record.datetime.getTime(), record); // fetched wins
        }
        merged.set(minutes, [...byTime.values()].sort(
            (a, b) => a.datetime.getTime() - b.datetime.getTime(),
        ));
    }

    const intervalConfigs = [...merged.keys()]
        .sort((a, b) => a - b)
        .map((minutes) => {
            const value = minutesToIntervalValue(minutes);
            return { ...getCandleIntervalConfig(value), value };
        });

    const metadata = {
        ...existing.metadata,
        ...buildMetadata(options, instrument, intervalConfigs),
        // Preserve the original fetched date range from the file metadata.
        fromDate: existing.metadata.fromDate || options.fromDate,
        tillDate: existing.metadata.tillDate || options.tillDate,
    };

    const tmpPath = `${path}.tmp${process.pid}`;
    await writeCandleSeriesAsParquet(merged, tmpPath, metadata);
    await rename(tmpPath, path);

    const summary = [...merged.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([minutes, rows]) => `${minutes}m:${rows.length}`)
        .join(", ");
    console.error(`Merged into ${path} — intervals [${summary}]`);
}

main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
});
