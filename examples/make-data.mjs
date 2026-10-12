#!/usr/bin/env node
/**
 * Synthetic minute candles for the examples — to run a backtest without a broker token
 * and without downloaded listings.
 *
 * One ticker gives a single-ticker listing, like `src/broker/tinkoff/fetch.js` writes.
 * Several tickers give a multi-ticker bundle, like `src/bundle.js` builds. The price is a
 * random walk with a fixed seed: the same parameters produce the same file. A trading day
 * is a weekday, 10:00–18:39 Moscow time. Every instrument but the first prints a candle in
 * only 85% of minutes, like thin names on the exchange: a minute of the multi-ticker
 * stream then arrives incomplete, and the strategy has to cope with it.
 *
 * Usage:
 *   node examples/make-data.mjs --out work/examples/demo.parquet --tickers DEMO
 *   node examples/make-data.mjs --out work/examples/universe.parquet --tickers AAA,BBB,CCC,DDD,EEE
 */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import {
    writeCandleRecordsAsParquet,
    writeMultiSymbolParquet,
} from "../src/core/candle-parquet.js";

const MINUTE_MS = 60 * 1000;
const MSK_OFFSET_MS = 3 * 60 * MINUTE_MS;
const SESSION_START_MIN = 10 * 60;      // 10:00 Moscow
const SESSION_END_MIN = 18 * 60 + 39;   // 18:39 Moscow, the last minute

/**
 * Seeded pseudo-random number generator (mulberry32).
 * @param {number} seed - Seed.
 * @returns {() => number} Number in [0, 1).
 */
function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Normally distributed number (Box–Muller).
 * @param {() => number} random - Source of uniform numbers.
 * @returns {number} N(0, 1).
 */
function gauss(random) {
    const u = Math.max(random(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

/**
 * Minute candles of one instrument.
 * @param {object} params - { from, days, seed, startPrice, printProb }.
 * @returns {Array<object>} Candles { datetime, open, high, low, close, volume } by ascending time.
 */
function candlesFor({ from, days, seed, startPrice, printProb }) {
    const random = rng(seed);
    const candles = [];
    let price = startPrice;
    let tradingDays = 0;
    for (let day = 0; tradingDays < days; day += 1) {
        const midnightMsk = from.getTime() + day * 24 * 60 * MINUTE_MS;
        const weekday = new Date(midnightMsk).getUTCDay();
        if (weekday === 0 || weekday === 6) continue;
        tradingDays += 1;
        // Overnight gap: the day's open differs from yesterday's close.
        price *= Math.exp(0.004 * gauss(random));
        for (let minute = SESSION_START_MIN; minute <= SESSION_END_MIN; minute += 1) {
            const open = price;
            price *= Math.exp(0.0012 * gauss(random));
            if (random() > printProb) continue;   // a minute without trades — no candle
            const close = price;
            const wick = Math.abs(gauss(random)) * 0.0006 * open;
            candles.push({
                datetime: new Date(midnightMsk - MSK_OFFSET_MS + minute * MINUTE_MS),
                open: round(open),
                high: round(Math.max(open, close) + wick),
                low: round(Math.min(open, close) - wick),
                close: round(close),
                volume: 1 + Math.floor(random() * 500),
            });
        }
    }
    return candles;
}

const round = (value) => Math.round(value * 100) / 100;

/**
 * Build and write a synthetic dataset.
 * @param {object} params - Parameters.
 * @param {string} params.out - Parquet path.
 * @param {Array<string>} params.tickers - Tickers; one gives a listing, several a bundle.
 * @param {number} [params.days] - Trading days.
 * @param {number} [params.seed] - Seed.
 * @param {string} [params.from] - First calendar day, YYYY-MM-DD (Moscow).
 * @param {number} [params.printProb] - Per-minute candle probability for all instruments but the first.
 * @returns {Promise<{tickers: Array<string>, candles: number}>} Summary.
 */
export async function generate({ out, tickers, days = 20, seed = 1, from = "2026-01-05", printProb = 0.85 }) {
    if (!tickers?.length) throw new Error("at least one ticker is required");
    const start = new Date(`${from}T00:00:00.000Z`);
    const bySymbol = new Map();
    let total = 0;
    tickers.forEach((ticker, index) => {
        const candles = candlesFor({
            from: start,
            days,
            seed: seed * 1000 + index,
            startPrice: 100 + 50 * index,
            printProb: index === 0 ? 1 : printProb,
        });
        bySymbol.set(ticker, candles);
        total += candles.length;
    });

    await mkdir(dirname(out), { recursive: true });
    const instruments = Object.fromEntries(tickers.map((ticker) => [ticker, { ticker, lot: 1 }]));
    if (tickers.length === 1) {
        const [ticker] = tickers;
        await writeCandleRecordsAsParquet(bySymbol.get(ticker), out, {
            source: "synthetic", ticker, instrument: instruments[ticker],
            intervalMinutes: 1, timezone: "Europe/Moscow",
        });
    } else {
        const nested = new Map([...bySymbol].map(([ticker, candles]) => [ticker, new Map([[1, candles]])]));
        await writeMultiSymbolParquet(nested, out, {
            source: "synthetic", tickers, instruments, intervalMinutes: 1,
        });
    }
    return { tickers, candles: total };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const program = new Command()
        .name("make-data")
        .description("Synthetic minute candles for the examples")
        .requiredOption("--out <path>", "Where to write the parquet")
        .option("--tickers <list>", "Comma-separated tickers; several make a multi-ticker bundle", "DEMO")
        .option("--days <n>", "Trading days", "20")
        .option("--seed <n>", "Random walk seed", "1")
        .option("--from <date>", "First calendar day, YYYY-MM-DD", "2026-01-05")
        .parse();
    const opts = program.opts();
    const summary = await generate({
        out: opts.out,
        tickers: opts.tickers.split(",").map((t) => t.trim()).filter(Boolean),
        days: Number(opts.days),
        seed: Number(opts.seed),
        from: opts.from,
    });
    console.error(`[make-data] ${opts.out}: ${summary.tickers.join(",")}, ${summary.candles} candles`);
}
