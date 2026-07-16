#!/usr/bin/env node
/**
 * Log OKX perpetual-swap order-book snapshots (top-N levels/side, sampled at
 * a fixed cadence) to rotating Parquet files. Neither T-API nor OKX expose
 * historical order-book data, so this collects it forward in time via the
 * public WebSocket feed (no API credentials needed — order book is public
 * market data).
 *
 * Designed to run on disk-constrained remote hosts: files rotate every
 * --rotate-minutes so they can be copied off and deleted without stopping the
 * process, and a full stop/restart (Ctrl-C, then relaunch later) always
 * starts a fresh, timestamp-named file — no overwrite risk.
 *
 * A file is safe to copy only once its name has no ".inprogress" suffix: the
 * writer opens "<name>.parquet.inprogress" and renames it to "<name>.parquet"
 * only after close() has flushed the Parquet footer. An unclean kill
 * (SIGKILL/OOM/power loss) leaves the in-progress rotation's data unrecovered
 * — keep --rotate-minutes small to bound that loss.
 *
 * Usage:
 *   node src/broker/okx/orderbook-logger.js
 *   node src/broker/okx/orderbook-logger.js --symbols BTC/USDT:USDT,ETH/USDT:USDT --depth 10
 *   node src/broker/okx/orderbook-logger.js --top-liquid 30          # 30 most liquid USDT perps (live 24h vol)
 *   node src/broker/okx/orderbook-logger.js --min-quote-volume 5e7   # only USDT perps with ≥$50M 24h vol
 *   node src/broker/okx/orderbook-logger.js --out-dir /data/okx-orderbook --rotate-minutes 15
 *
 * Stop with Ctrl-C (SIGINT) or `kill <pid>` (SIGTERM): the logger finishes
 * the in-flight snapshot tick, closes the current file cleanly, and exits.
 */

import { mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import * as parquet from "@dsnp/parquetjs";
import { OkxClient } from "./client.js";
import { symbolToInstId, TRAIN_SYMBOLS, rankLiquidUsdtPerps } from "./symbols.js";
import { buildOrderbookSchema, bookToRow, PARQUET_METADATA_KEY } from "./orderbook-parquet.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DEFAULT_OUT_DIR = join(REPO_ROOT, "data", "okx-orderbook");

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePositiveInt(value, optionName) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`${optionName} must be a positive integer.`);
    }
    return parsed;
}

function parsePositiveNumber(value, optionName) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`${optionName} must be a positive number.`);
    }
    return parsed;
}

/**
 * Resolve --symbols (or the default top-50 liquid list) against loaded
 * markets, pairing each ccxt symbol with its OKX instId for storage.
 * @param {OkxClient} client - Initialized client (loadMarkets() already called).
 * @param {Array<string>} symbolList - Unified ccxt symbols.
 * @returns {Array<{symbol: string, instId: string}>} Resolved pairs.
 */
function resolveSymbols(client, symbolList) {
    return symbolList.map((symbol) => {
        const market = client.exchange.market(symbol);
        if (!market || market.type !== "swap") {
            throw new Error(`Symbol '${symbol}' is not a known OKX perpetual swap.`);
        }
        return { symbol, instId: symbolToInstId(symbol) };
    });
}

async function main() {
    const program = new Command();
    program
        .name("orderbook-logger")
        .description("Log OKX perpetual-swap order-book snapshots to rotating Parquet files")
        .option("--symbols <list>", "Comma-separated ccxt symbols (overrides liquidity selection)")
        .option("--top-liquid <n>", "Watch the N most liquid USDT perps by live 24h volume")
        .option("--min-quote-volume <usd>", "Drop USDT perps below this 24h quote volume (USDT)")
        .option("--include-non-crypto", "Keep tokenized commodity/metal perps (XAU, CL, …) in liquidity ranking")
        .option("--depth <n>", "Levels per side to persist", "20")
        .option("--interval-ms <ms>", "Snapshot cadence in milliseconds", "1000")
        .option("--rotate-minutes <n>", "Close the current file and start a new one every N minutes", "30")
        .option("--out-dir <path>", "Output directory", DEFAULT_OUT_DIR);

    program.parse();
    const options = program.opts();

    const depth = parsePositiveInt(options.depth, "--depth");
    const intervalMs = parsePositiveInt(options.intervalMs, "--interval-ms");
    const rotateMs = parsePositiveInt(options.rotateMinutes, "--rotate-minutes") * 60_000;
    const topLiquid = options.topLiquid != null ? parsePositiveInt(options.topLiquid, "--top-liquid") : null;
    const minQuoteVolume = options.minQuoteVolume != null
        ? parsePositiveNumber(options.minQuoteVolume, "--min-quote-volume") : null;
    if (options.symbols && (topLiquid != null || minQuoteVolume != null)) {
        throw new Error("--symbols cannot be combined with --top-liquid/--min-quote-volume (explicit list overrides liquidity selection).");
    }

    await mkdir(options.outDir, { recursive: true });

    const client = new OkxClient({}, { timeoutMs: 60000, orderRetries: 5, orderRetryDelayMs: 2000 });
    await client.loadMarkets();

    // Symbol selection: explicit --symbols wins; otherwise rank live liquidity if
    // --top-liquid/--min-quote-volume were given; otherwise the static default set.
    let symbolList;
    if (options.symbols) {
        symbolList = options.symbols.split(",").map((s) => s.trim()).filter(Boolean);
    } else if (topLiquid != null || minQuoteVolume != null) {
        console.error("Fetching 24h tickers to rank USDT perps by liquidity...");
        const tickers = await client.exchange.fetchTickers();
        symbolList = rankLiquidUsdtPerps(client.exchange.markets, tickers, {
            top: topLiquid ?? undefined,
            minQuoteVolume: minQuoteVolume ?? 0,
            includeNonCrypto: Boolean(options.includeNonCrypto),
        });
        if (symbolList.length === 0) {
            throw new Error("Liquidity filter matched no USDT perps — loosen --top-liquid/--min-quote-volume.");
        }
        console.error(`Selected ${symbolList.length} liquid USDT perp(s): ${symbolList.join(", ")}`);
    } else {
        symbolList = TRAIN_SYMBOLS;
    }

    const resolved = resolveSymbols(client, symbolList);
    console.error(`Watching ${resolved.length} symbol(s), depth=${depth}, interval=${intervalMs}ms, rotate every ${options.rotateMinutes}min`);
    console.error(`Output: ${options.outDir}`);

    const schema = buildOrderbookSchema(depth);
    const latestBooks = new Map(); // instId -> ccxt order book

    let stopped = false;
    let shuttingDown = false;
    function requestStop(signal) {
        if (shuttingDown) {
            console.error(`\nReceived ${signal} again — forcing exit.`);
            process.exit(1);
        }
        shuttingDown = true;
        stopped = true;
        console.error(`\nReceived ${signal}; finishing current snapshot tick and closing the file...`);
    }
    process.on("SIGINT", () => requestStop("SIGINT"));
    process.on("SIGTERM", () => requestStop("SIGTERM"));

    // One perpetual watch loop per symbol, feeding the shared latestBooks map.
    // ccxt.pro multiplexes these over a single WebSocket connection.
    async function watchSymbol(symbol, instId) {
        let backoff = 1000;
        while (!stopped) {
            try {
                const book = await client.watchOrderBook(symbol, depth);
                latestBooks.set(instId, book);
                backoff = 1000;
            } catch (error) {
                if (stopped) break;
                console.warn(`[watch ${instId}] ${error?.message || error}; retrying in ${backoff}ms`);
                await sleep(backoff);
                backoff = Math.min(backoff * 2, 30000);
            }
        }
    }
    const watchPromises = resolved.map(({ symbol, instId }) => watchSymbol(symbol, instId));

    let writer = null;
    let tmpPath = null;
    let finalPath = null;
    let openedAt = 0;
    let rowsInFile = 0;

    async function openNewFile() {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        finalPath = join(options.outDir, `ob_okx_${stamp}.parquet`);
        tmpPath = `${finalPath}.inprogress`;
        writer = await parquet.ParquetWriter.openFile(schema, tmpPath);
        writer.setMetadata(PARQUET_METADATA_KEY, JSON.stringify({
            source: "okx",
            schemaVersion: 1,
            kind: "orderbook",
            depth,
            intervalMs,
            symbols: resolved.map((r) => r.instId),
            generatedAt: new Date().toISOString(),
        }));
        openedAt = Date.now();
        rowsInFile = 0;
        console.error(`Opened ${finalPath}`);
    }

    async function closeCurrentFile() {
        if (!writer) return;
        const w = writer;
        const rows = rowsInFile;
        const from = tmpPath;
        const to = finalPath;
        writer = null;
        await w.close();
        await rename(from, to);
        console.error(`Closed ${to} (${rows} rows)`);
    }

    await openNewFile();

    while (!stopped) {
        const tickStart = Date.now();
        for (const { instId } of resolved) {
            const book = latestBooks.get(instId);
            if (!book || !book.bids?.length || !book.asks?.length) continue;
            await writer.appendRow(bookToRow(instId, book, depth));
            rowsInFile += 1;
        }
        if (!stopped && Date.now() - openedAt >= rotateMs) {
            await closeCurrentFile();
            await openNewFile();
        }
        const elapsed = Date.now() - tickStart;
        await sleep(Math.max(0, intervalMs - elapsed));
    }

    await closeCurrentFile();
    await client.close();
    await Promise.allSettled(watchPromises);
    console.error("Stopped cleanly.");
}

main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
});
