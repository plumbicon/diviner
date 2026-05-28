#!/usr/bin/env node
/**
 * Batch fetch: downloads 1m candles for multiple tickers and saves to data/TICKER_YEAR_1m.parquet
 * Usage: node src/fetch_batch.js --tickers ROSN,TATN,NVTK --year 2025
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { TinkoffInvestApi } from "tinkoff-invest-api";
import { InstrumentIdType } from "tinkoff-invest-api/dist/generated/instruments.js";
import { writeCandleRowsAsParquet } from "./core/candle-parquet.js";
import {
    DEFAULT_EXCHANGE,
    MOSCOW_TIMEZONE,
    buildInstrumentMetadata,
    getCandleIntervalConfig,
} from "./core/market-data.js";

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "../data");

async function fetchAllCandles({ api, instrument, from, to, interval, requestDelayMs }) {
    const candlesByTime = new Map();
    let cursor = from;
    let requestNumber = 0;

    while (cursor < to) {
        const chunkTo = new Date(Math.min(cursor.getTime() + interval.maxSpanMs, to.getTime()));
        requestNumber += 1;
        process.stderr.write(`  Request ${requestNumber}: ${cursor.toISOString()} -> ${chunkTo.toISOString()}\n`);

        const response = await api.marketdata.getCandles({
            instrumentId: instrument.uid || instrument.figi,
            from: cursor,
            to: chunkTo,
            interval: interval.apiInterval,
        });

        for (const candle of response.candles || []) {
            const candleTime = candle.time;
            if (!candleTime || candleTime < from || candleTime > to) continue;
            candlesByTime.set(candleTime.toISOString(), candle);
        }

        cursor = chunkTo;
        if (cursor < to && requestDelayMs > 0) {
            await new Promise((r) => setTimeout(r, requestDelayMs));
        }
    }

    return Array.from(candlesByTime.values()).sort((a, b) => a.time.getTime() - b.time.getTime());
}

async function findInstrument(api, ticker) {
    const { instruments } = await api.instruments.findInstrument({ query: ticker });
    const instrument = instruments.find((i) => i.ticker === ticker && i.classCode === "TQBR");
    if (!instrument) throw new Error(`Instrument ${ticker} not found on TQBR`);

    const response = await api.instruments.getInstrumentBy({
        idType: InstrumentIdType.INSTRUMENT_ID_TYPE_UID,
        id: instrument.uid,
        classCode: instrument.classCode,
    });
    return { ...instrument, ...(response.instrument || {}) };
}

async function fetchTicker(api, ticker, fromDate, tillDate, interval, requestDelayMs) {
    const from = new Date(`${fromDate}T00:00:00.000+03:00`);
    const to = new Date(`${tillDate}T23:59:59.999+03:00`);

    process.stderr.write(`\n[${ticker}] Searching instrument...\n`);
    const instrument = await findInstrument(api, ticker);
    process.stderr.write(`[${ticker}] Found: ${instrument.name} (${instrument.figi})\n`);

    const candles = await fetchAllCandles({ api, instrument, from, to, interval, requestDelayMs });
    process.stderr.write(`[${ticker}] Total rows: ${candles.length}\n`);

    const rows = candles.map((c) => [
        api.helpers.toNumber(c.open),
        api.helpers.toNumber(c.high),
        api.helpers.toNumber(c.low),
        api.helpers.toNumber(c.close),
        null,
        Number(c.volume || 0),
        c.time.toISOString(),
        null,
    ]);

    const instrumentMeta = buildInstrumentMetadata(instrument, {
        ticker,
        classCode: "TQBR",
        exchange: instrument.exchange || DEFAULT_EXCHANGE,
    });

    const metadata = {
        source: "tinkoff",
        schemaVersion: 1,
        instrument: instrumentMeta,
        ticker: instrumentMeta.ticker,
        classCode: instrumentMeta.classCode,
        figi: instrumentMeta.figi,
        instrumentUid: instrumentMeta.instrumentUid,
        exchange: instrumentMeta.exchange,
        interval: "1",
        intervalLabel: interval.label,
        intervalMinutes: interval.minutes,
        fromDate,
        tillDate,
        timezone: MOSCOW_TIMEZONE,
    };

    const year = fromDate.slice(0, 4);
    const outFile = path.join(DATA_DIR, `${ticker}_${year}_1m.parquet`);
    const buffer = await writeCandleRowsAsParquet(rows, null, metadata);
    if (!buffer) throw new Error(`No parquet buffer for ${ticker}`);
    fs.writeFileSync(outFile, buffer);
    process.stderr.write(`[${ticker}] Saved to ${outFile} (${(buffer.length / 1024).toFixed(0)} KB)\n`);
}

async function main() {
    const args = process.argv.slice(2);
    const tickersArg = args.find((a) => a.startsWith("--tickers="))?.slice("--tickers=".length) ||
        args[args.indexOf("--tickers") + 1];
    const yearArg = args.find((a) => a.startsWith("--year="))?.slice("--year=".length) ||
        args[args.indexOf("--year") + 1] || "2025";
    const delayArg = Number(args.find((a) => a.startsWith("--delay="))?.slice("--delay=".length) ||
        args[args.indexOf("--delay") + 1] || "150");

    if (!tickersArg) {
        process.stderr.write("Usage: node src/fetch_batch.js --tickers ROSN,TATN --year 2025\n");
        process.exit(1);
    }

    const tickers = tickersArg.split(",").map((t) => t.trim()).filter(Boolean);
    const fromDate = `${yearArg}-01-01`;
    const tillDate = `${yearArg}-12-31`;

    const token = process.env.T_INVEST_TOKEN;
    if (!token) {
        process.stderr.write("T_INVEST_TOKEN is required\n");
        process.exit(1);
    }

    const api = new TinkoffInvestApi({ token });
    const interval = getCandleIntervalConfig("1");

    for (const ticker of tickers) {
        try {
            await fetchTicker(api, ticker, fromDate, tillDate, interval, delayArg);
        } catch (err) {
            process.stderr.write(`[${ticker}] ERROR: ${err.message}\n`);
        }
    }

    process.stderr.write("\n=== Batch fetch complete ===\n");
}

main().catch((e) => { process.stderr.write(`Fatal: ${e.message}\n`); process.exit(1); });
