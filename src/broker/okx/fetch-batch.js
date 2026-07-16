#!/usr/bin/env node
/**
 * Batch-download OKX perpetual-swap candles (1m + 1D) for a fixed set of
 * tickers into data/okx/<instId>_<year>_1m.parquet multi-interval files.
 *
 * Mirrors the MOEX fetch.js output format: both 1m and 1440m (daily) rows
 * are stored in the same parquet, tagged with an `interval` column (1 or
 * 1440). train_okx.py splits on this column so that prevClose/prevReturn/
 * prevRange come from the official 1D candle — the same design as A05.
 *
 * Usage:
 *   node src/broker/okx/fetch-batch.js                   # defaults: year=2025, concurrency=5
 *   node src/broker/okx/fetch-batch.js --year 2025 --concurrency 8
 *   node src/broker/okx/fetch-batch.js --only ETH/USDT:USDT,BTC/USDT:USDT
 *   node src/broker/okx/fetch-batch.js --skip ETH/USDT:USDT  # resume: skip already-done
 *
 * Output: data/okx/<instId>_<year>_1m.parquet  (1m + 1D merged)
 *
 * Rate-limiting: 1m data ~5 000 REST calls per ticker; 1D needs only ~4 calls.
 * At concurrency=5 the total wall time for 75 tickers is ~3–4 hours.
 */

import { existsSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { OkxClient } from "./client.js";
import { writeCandleSeriesAsParquet } from "../../core/candle-parquet.js";
import { TRAIN_SYMBOLS, VALID_SYMBOLS, ALL_SYMBOLS, symbolToInstId } from "./symbols.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = join(ROOT, "data", "okx");

export { TRAIN_SYMBOLS, VALID_SYMBOLS, ALL_SYMBOLS, symbolToInstId };

// Intraday timeframe used for signal candles.
// 5m: 5× fewer API calls than 1m (1 052 vs 5 256 per year), identical model
// quality since train_okx.py fires a signal every bar anyway.
const INTRADAY_TF      = "5m";
const INTRADAY_MINUTES = 5;
const INTRADAY_LABEL   = "5m";

function outPath(instId, year) {
    return join(DATA_DIR, `${instId}_${year}_${INTRADAY_LABEL}.parquet`);
}

/**
 * Download 5m + 1D candles for one symbol and write a merged multi-interval
 * parquet (same format as MOEX multi-interval files).
 * Returns {symbol, instId, rows5m, rows1d, skipped, error}.
 */
async function fetchOne(symbol, year, requestDelayMs) {
    const instId = symbolToInstId(symbol);
    const dest   = outPath(instId, year);

    if (existsSync(dest)) {
        return { symbol, instId, rows1m: 0, rows1d: 0, skipped: true };
    }

    const client = new OkxClient({}, {
        verbose: false,
        timeoutMs: 60000,
        orderRetries: 5,
        orderRetryDelayMs: 2000,
    });
    try {
        await client.init(symbol);

        const from = new Date(`${year}-01-01T00:00:00.000Z`).getTime();
        const to   = new Date(`${year}-12-31T23:59:59.999Z`).getTime();

        // 5m intraday candles — ~1 052 API calls per ticker per year
        const candles5m = await client.fetchHistory({
            symbol, timeframe: INTRADAY_TF,
            since: from, until: to, limit: 100, requestDelayMs,
        });
        if (candles5m.length === 0) {
            return { symbol, instId, rows5m: 0, rows1d: 0, skipped: false, error: `no ${INTRADAY_TF} candles returned` };
        }

        // 1D candles — only ~4 API calls; provides official daily close for prevClose
        const candles1d = await client.fetchHistory({
            symbol, timeframe: "1d",
            since: from, until: to, limit: 100, requestDelayMs: 200,
        });

        const market = client.market;
        const contractSize = Number(market?.contractSize) || 1;
        const lot = (Number(market?.precision?.amount) || 1) * contractSize;

        const metadata = {
            source: "okx", schemaVersion: 1,
            instrument: {
                ticker: symbol, symbol, name: market?.id || symbol,
                exchange: "OKX", lot, contractSize,
                currency: market?.quote || "USDT",
            },
            ticker: symbol, symbol, exchange: "OKX",
            interval: INTRADAY_LABEL, intervalLabel: INTRADAY_LABEL, intervalMinutes: INTRADAY_MINUTES,
            intervals: [
                { minutes: INTRADAY_MINUTES, label: INTRADAY_LABEL },
                { minutes: 1440, label: "1d" },
            ],
            fromDate: `${year}-01-01`, tillDate: `${year}-12-31`,
            timezone: "UTC",
        };

        const seriesByMinutes = new Map([
            [INTRADAY_MINUTES, candles5m],
            [1440,             candles1d],
        ]);

        const tmp = `${dest}.tmp${process.pid}`;
        const buf = await writeCandleSeriesAsParquet(seriesByMinutes, null, metadata);
        await writeFile(tmp, buf);
        await rename(tmp, dest);

        return { symbol, instId, rows5m: candles5m.length, rows1d: candles1d.length, skipped: false };
    } finally {
        await client.close();
    }
}

// ── Concurrency pool ──────────────────────────────────────────────────────────

async function runPool(tasks, concurrency, onDone) {
    const queue = [...tasks];
    let running = 0;
    let done    = 0;
    const results = [];

    await new Promise((resolve) => {
        function next() {
            while (running < concurrency && queue.length > 0) {
                const { symbol, fn } = queue.shift();
                running++;
                fn().then((result) => {
                    running--;
                    done++;
                    results.push(result);
                    onDone(result, done, tasks.length);
                    next();
                    if (done === tasks.length) resolve();
                }).catch((err) => {
                    running--;
                    done++;
                    const result = { symbol, error: err?.message || String(err) };
                    results.push(result);
                    onDone(result, done, tasks.length);
                    next();
                    if (done === tasks.length) resolve();
                });
            }
        }
        next();
        if (tasks.length === 0) resolve();
    });

    return results;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    const program = new Command();
    program
        .name("fetch-okx-batch")
        .description("Batch-download 1 m OKX perp candles for the full OKX strategy ticker list")
        .option("--year <year>", "Calendar year to download", "2025")
        .option("--concurrency <n>", "Parallel tickers", "5")
        .option("--request-delay-ms <ms>", "Delay between candle API calls per ticker", "200")
        .option("--only <symbols>", "Comma-separated subset of symbols (overrides full list)")
        .option("--skip <symbols>", "Comma-separated symbols to skip (e.g. already done)")
        .option("--set <set>", "Subset to download: all | train | valid", "all");

    program.parse();
    const opts = program.opts();

    const year        = parseInt(opts.year, 10);
    const concurrency = Math.max(1, parseInt(opts.concurrency, 10) || 5);
    const delayMs     = Math.max(0, parseInt(opts.requestDelayMs, 10) || 200);

    let symbols = opts.only
        ? opts.only.split(",").map((s) => s.trim()).filter(Boolean)
        : opts.set === "train" ? TRAIN_SYMBOLS
        : opts.set === "valid" ? VALID_SYMBOLS
        : ALL_SYMBOLS;

    if (opts.skip) {
        const skipSet = new Set(opts.skip.split(",").map((s) => s.trim()));
        symbols = symbols.filter((s) => !skipSet.has(s));
    }

    console.log(`Downloading ${symbols.length} ticker(s) for ${year}`);
    console.log(`Concurrency: ${concurrency}  delay: ${delayMs} ms/call`);
    console.log(`Output dir : ${DATA_DIR}\n`);

    const started = Date.now();
    const tasks = symbols.map((sym) => ({ symbol: sym, fn: () => fetchOne(sym, year, delayMs) }));

    const results = await runPool(tasks, concurrency, (result, done, total) => {
        const elapsedSec = (Date.now() - started) / 1000;
        const etaSec = done < total ? (elapsedSec / done) * (total - done) : 0;
        const etaMin = (etaSec / 60).toFixed(0);
        if (result.error) {
            console.error(`[${done}/${total}] ✗ ${result.symbol ?? "?"}: ${result.error}  (ETA ~${etaMin}m)`);
        } else if (result.skipped) {
            console.log(`[${done}/${total}] ↩ ${result.instId}  skipped (file exists)`);
        } else {
            console.log(`[${done}/${total}] ✓ ${result.instId}  5m=${result.rows5m?.toLocaleString()} 1d=${result.rows1d}  (ETA ~${etaMin}m)`);
        }
    });

    const ok      = results.filter((r) => !r.error && !r.skipped).length;
    const skipped = results.filter((r) => r.skipped).length;
    const errors  = results.filter((r) => r.error);

    console.log(`\nDone: ${ok} downloaded, ${skipped} skipped, ${errors.length} errors`);
    if (errors.length) {
        console.error("Errors:");
        errors.forEach((r) => console.error(`  ${r.symbol ?? "?"}: ${r.error}`));
    }
    const mins = ((Date.now() - started) / 60000).toFixed(1);
    console.log(`Total time: ${mins} min`);
}

main().catch((e) => { console.error(e?.message || e); process.exit(1); });
