#!/usr/bin/env node
import { Command } from "commander";
import { rename } from "node:fs/promises";
import { OkxClient } from "./broker/okx/client.js";
import {
    getOkxIntervalConfig,
    getSupportedOkxIntervals,
    minutesToOkxIntervalToken,
} from "./broker/okx/intervals.js";
import {
    writeCandleRecordsAsParquet,
    writeCandleSeriesAsParquet,
} from "./core/candle-parquet.js";
import { loadDataset } from "./core/data-loader.js";

/**
 * Fetch historical OKX perpetual-swap candles into Parquet, reusing the existing
 * candle-parquet writers so the output is consumable by the simulated broker for
 * backtests — exactly like fetch.js does for Tinkoff/MOEX, but via ccxt.
 *
 * Crypto is 24/7 UTC; metadata records exchange "OKX" / timezone "UTC".
 */

function assertDate(value, optionName) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw new Error(`${optionName} must be in YYYY-MM-DD format.`);
    }
}

function parseUtcStart(value, optionName) {
    assertDate(value, optionName);
    return new Date(`${value}T00:00:00.000Z`);
}

function parseUtcEnd(value, optionName) {
    assertDate(value, optionName);
    return new Date(`${value}T23:59:59.999Z`);
}

/**
 * Parse --interval into a de-duplicated, ascending list of interval configs.
 * @param {string} value - Single value or comma-separated list.
 * @returns {Array<object>} Interval configs (each with its raw token).
 */
function parseIntervalList(value) {
    const seen = new Map();
    for (const part of String(value).split(",")) {
        const token = part.trim();
        if (!token) continue;
        const config = getOkxIntervalConfig(token);
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

/**
 * Build dataset metadata for the fetched intervals.
 * @param {object} options - CLI options.
 * @param {object} market - Resolved ccxt market.
 * @param {Array<object>} intervals - Interval configs.
 * @returns {object} Metadata.
 */
function buildMetadata(options, market, intervals) {
    const sorted = [...intervals].sort((a, b) => a.minutes - b.minutes);
    const base = sorted[0];
    const contractSize = Number(market?.contractSize) || 1;
    // Backtest granularity in base currency: contract amount step * contractSize
    // (crypto is fractional, not whole-unit quantised). e.g. BTC: 0.01 * 0.01.
    const lot = (Number(market?.precision?.amount) || 1) * contractSize;
    return {
        source: "okx",
        schemaVersion: 1,
        instrument: {
            ticker: options.symbol,
            symbol: options.symbol,
            name: market?.id || options.symbol,
            exchange: "OKX",
            lot,
            contractSize,
            currency: market?.quote || market?.settle || "USDT",
        },
        ticker: options.symbol,
        symbol: options.symbol,
        exchange: "OKX",
        interval: base.value,
        intervalLabel: base.label,
        intervalMinutes: base.minutes,
        intervals: sorted.map((item) => ({ minutes: item.minutes, label: item.label })),
        fromDate: options.fromDate,
        tillDate: options.tillDate,
        timezone: "UTC",
    };
}

/**
 * Merge fetched intervals into an existing Parquet file and rewrite it in place.
 * @param {object} params - { path, seriesByMinutes, market, options }.
 */
async function mergeIntoExistingFile({ path, seriesByMinutes, market, options }) {
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
            const value = minutesToOkxIntervalToken(minutes);
            return { ...getOkxIntervalConfig(value), value };
        });

    const metadata = {
        ...existing.metadata,
        ...buildMetadata(options, market, intervalConfigs),
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

async function main() {
    const program = new Command();
    program
        .name("fetch-okx")
        .description("Fetch historical OKX perpetual-swap candles via ccxt")
        .requiredOption("--symbol <symbol>", "Swap symbol (e.g. BTC/USDT:USDT)")
        .requiredOption("--from-date <date>", "Start date in YYYY-MM-DD (UTC)")
        .option("--till-date <date>", "End date in YYYY-MM-DD (UTC)", new Date().toISOString().slice(0, 10))
        .option(
            "--interval <list>",
            `Candle interval(s), comma-separated: ${getSupportedOkxIntervals().join(", ")}`,
            "1m",
        )
        .option("--parquet", "Write Parquet to stdout instead of JSON")
        .option("--merge-into <path>", "Augment an existing Parquet file with the fetched interval(s)")
        .option("--demo", "Use OKX demo environment", false)
        .option("--request-delay-ms <ms>", "Delay between API requests", "200");

    program.parse();
    const options = program.opts();

    let intervals;
    let from;
    let to;
    try {
        intervals = parseIntervalList(options.interval);
        from = parseUtcStart(options.fromDate, "--from-date");
        to = parseUtcEnd(options.tillDate, "--till-date");
        options.requestDelayMs = parseNonNegativeInteger(options.requestDelayMs, "--request-delay-ms");
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

    const client = new OkxClient(
        {
            apiKey: process.env.OKX_API_KEY,
            secret: process.env.OKX_API_SECRET,
            password: process.env.OKX_API_PASSWORD,
        },
        { demo: Boolean(options.demo) },
    );
    await client.init(options.symbol);

    const seriesByMinutes = new Map();
    for (const interval of intervals) {
        console.error(`Fetching ${interval.label} candles for ${options.symbol} from ${options.fromDate} to ${options.tillDate} via OKX...`);
        const candles = await client.fetchHistory({
            symbol: options.symbol,
            timeframe: interval.ccxtTimeframe,
            since: from.getTime(),
            until: to.getTime(),
            limit: interval.maxCandlesPerCall,
            requestDelayMs: options.requestDelayMs,
        });
        console.error(`  ${interval.label}: ${candles.length} rows`);
        seriesByMinutes.set(interval.minutes, candles);
    }

    const market = client.market;
    await client.close();

    if (options.mergeInto) {
        await mergeIntoExistingFile({ path: options.mergeInto, seriesByMinutes, market, options });
        return;
    }

    const metadata = buildMetadata(options, market, intervals);

    if (multiInterval) {
        const buffer = await writeCandleSeriesAsParquet(seriesByMinutes, null, metadata);
        if (buffer) process.stdout.write(buffer);
        return;
    }

    const records = seriesByMinutes.get(intervals[0].minutes);
    if (options.parquet) {
        const buffer = await writeCandleRecordsAsParquet(records, null, metadata);
        if (buffer) process.stdout.write(buffer);
        return;
    }

    // JSON fallback (object rows the parquet/convert path also accepts).
    console.log(JSON.stringify({
        candles: {
            metadata,
            columns: ["open", "high", "low", "close", "value", "volume", "begin", "end"],
            data: records.map((r) => [r.open, r.high, r.low, r.close, null, r.volume, r.datetime.toISOString(), null]),
        },
    }));
}

main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
});
