#!/usr/bin/env node
import { Command } from "commander";
import { TinkoffInvestApi } from "tinkoff-invest-api";
import { InstrumentIdType } from "tinkoff-invest-api/dist/generated/instruments.js";
import { writeCandleRowsAsParquet } from "./core/candle-parquet.js";
import {
    DEFAULT_EXCHANGE,
    MOSCOW_TIMEZONE,
    buildInstrumentMetadata,
    getCandleIntervalConfig,
    getSupportedIntervalValues,
} from "./core/market-data.js";

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

function getInterval(value) {
    return getCandleIntervalConfig(value);
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

function buildMetadata(options, instrument, interval) {
    const instrumentMetadata = buildInstrumentMetadata(instrument, {
        ticker: options.security,
        classCode: options.classCode,
        exchange: instrument.exchange || DEFAULT_EXCHANGE,
    });

    return {
        source: "tinkoff",
        schemaVersion: 1,
        instrument: instrumentMetadata,
        ticker: instrumentMetadata.ticker,
        classCode: instrumentMetadata.classCode,
        figi: instrumentMetadata.figi,
        instrumentUid: instrumentMetadata.instrumentUid,
        exchange: instrumentMetadata.exchange,
        interval: options.interval,
        intervalLabel: interval.label,
        intervalMinutes: interval.minutes,
        fromDate: options.fromDate,
        tillDate: options.tillDate,
        timezone: MOSCOW_TIMEZONE,
    };
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
            "--interval <number>",
            `Candle interval: ${getSupportedIntervalValues().join(", ")}`,
            "24",
        )
        .option("--parquet", "Write Parquet to stdout instead of JSON")
        .option("--request-delay-ms <ms>", "Delay between API requests", "100");

    program.parse();
    const options = program.opts();
    options.security = options.ticker || options.security;

    const token = process.env.T_INVEST_TOKEN;
    if (!token) {
        program.error("T_INVEST_TOKEN environment variable is required");
    }

    let interval;
    let from;
    let to;

    try {
        interval = getInterval(options.interval);
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

    const api = new TinkoffInvestApi({ token });
    const instrument = await findInstrument(api, options.security, options.classCode);

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
    const rows = candles.map((candle) => toMoexCompatibleRow(api, candle));

    console.error(`Total rows fetched: ${rows.length}`);
    const metadata = buildMetadata(options, instrument, interval);

    if (options.parquet) {
        const buffer = await writeCandleRowsAsParquet(rows, null, metadata);
        if (buffer) {
            process.stdout.write(buffer);
        }
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

main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
});
