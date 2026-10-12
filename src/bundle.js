#!/usr/bin/env node
/**
 * Merge single-ticker listings into one multi-ticker Parquet.
 *
 * A cross-sectional strategy needs access to any instrument of the universe, not only
 * the one it was started on — so the universe must be one dataset. Every output row is
 * tagged with ticker and interval; the metadata carries `tickers` and `instruments` (lot,
 * exchange, figi per instrument).
 *
 * The merge is streaming: all readers are opened at once, rows are merged by time and
 * written straight away. No listing is loaded into memory as a whole — otherwise a year
 * of the universe (~40M candles) could not be built.
 *
 * Source files are only read. An existing output file is not overwritten without
 * --force: listings are never deleted or replaced with a shorter sample (CONTRIBUTING.md).
 *
 * Usage:
 *   node src/bundle.js --out data/tinkoff/CORE62_2025_1m.parquet data/tinkoff/*_2025_1m.parquet
 *   node src/bundle.js --out u.parquet --tickers ALRS,ROSN --from 2026-01-01 data/tinkoff/*_2026_1m.parquet
 */
import * as parquet from "@dsnp/parquetjs";
import { Command } from "commander";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { candleSchema, PARQUET_METADATA_KEY } from "./core/candle-parquet.js";

// Daily history kept before --from: a 21-day feature window plus holidays.
const HISTORY_LOOKBACK_DAYS = 40;

/** Parquet row date → Date. @private */
function toDate(ts) {
    if (typeof ts === "bigint") return new Date(Number(ts / 1_000_000n));
    if (typeof ts === "number") return new Date(ts > 1e12 ? ts : ts * 1000);
    if (ts instanceof Date) return ts;
    return new Date(ts);
}

/** A parquetjs UTF8 column arrives as a Buffer. @private */
function text(value) {
    if (value == null) return null;
    return Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
}

/** Ticker of a file: from its metadata, otherwise from the name (AFKS_2025_1m.parquet → AFKS). @private */
function tickerOfFile(metadata, filePath) {
    const fromMeta = metadata?.ticker || metadata?.instrument?.ticker;
    if (fromMeta) return fromMeta;
    const match = basename(filePath).match(/^([A-Z0-9]+)_/);
    return match ? match[1] : null;
}

/**
 * Binary min-heap by (datetime, ticker, interval) — the merge order. A linear search for
 * the minimum over 60+ sources and 40M rows is noticeably slow.
 */
class MinHeap {
    constructor() { this.items = []; }
    get size() { return this.items.length; }
    static _less(a, b) {
        const d = a.ts - b.ts;
        if (d !== 0) return d < 0;
        if (a.ticker !== b.ticker) return a.ticker < b.ticker;
        return a.interval < b.interval;
    }
    push(item) {
        const a = this.items;
        a.push(item);
        let i = a.length - 1;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (!MinHeap._less(a[i], a[p])) break;
            [a[i], a[p]] = [a[p], a[i]];
            i = p;
        }
    }
    pop() {
        const a = this.items;
        const top = a[0];
        const last = a.pop();
        if (a.length > 0) {
            a[0] = last;
            let i = 0;
            for (;;) {
                const l = 2 * i + 1, r = l + 1;
                let m = i;
                if (l < a.length && MinHeap._less(a[l], a[m])) m = l;
                if (r < a.length && MinHeap._less(a[r], a[m])) m = r;
                if (m === i) break;
                [a[i], a[m]] = [a[m], a[i]];
                i = m;
            }
        }
        return top;
    }
}

/**
 * Merge listings into one multi-ticker Parquet.
 * @param {string[]} inputs - Source file paths.
 * @param {object} options - { out, tickers, from, to, force }.
 * @returns {Promise<object>} Summary { tickers, rows, intervals }.
 */
export async function bundle(inputs, options = {}) {
    const { out, tickers = null, from = null, to = null, force = false } = options;
    if (!out) throw new Error("--out is required");
    if (existsSync(out) && !force) {
        throw new Error(`${out} already exists — pass --force to overwrite (listings are never silently replaced)`);
    }

    const allow = tickers ? new Set(tickers) : null;
    const fromTs = from ? new Date(`${from}T00:00:00.000+03:00`).getTime() : -Infinity;
    const toTs   = to   ? new Date(`${to}T23:59:59.999+03:00`).getTime()   :  Infinity;
    // The lower bound cuts only minute candles. Strategies need daily candles as d-1..d-5
    // history (a 21-calendar-day window); cutting them at the same date would silently
    // drop the first weeks of a run: there would be no history for the features. The
    // upper bound is shared — no interval may look ahead.
    const historyFromTs = from
        ? fromTs - HISTORY_LOOKBACK_DAYS * 24 * 60 * 60 * 1000
        : -Infinity;

    // Open all sources at once: merging by time needs simultaneous access to the heads
    // of all streams.
    const sources = [];
    const instruments = {};
    for (const filePath of inputs) {
        const reader = await parquet.ParquetReader.openFile(filePath);
        let metadata = {};
        try {
            metadata = JSON.parse(reader.getMetadata?.()?.[PARQUET_METADATA_KEY] || "{}");
        } catch { metadata = {}; }
        const ticker = tickerOfFile(metadata, filePath);
        if (!ticker) {
            await reader.close();
            console.error(`  ${basename(filePath)}: ticker unknown — skipped`);
            continue;
        }
        if (allow && !allow.has(ticker)) { await reader.close(); continue; }
        instruments[ticker] = metadata.instrument || { ticker, lot: 1 };
        sources.push({
            ticker, reader, cursor: reader.getCursor(),
            baseMinutes: Number(metadata.intervalMinutes) || 1,
        });
    }
    if (sources.length === 0) throw new Error("no input listings matched");

    const writer = await parquet.ParquetWriter.openFile(candleSchema, out);
    const heap = new MinHeap();
    const intervals = new Set();
    let rows = 0;

    /** Pull the next matching row of a source into the heap. @private */
    const advance = async (src) => {
        for (;;) {
            const row = await src.cursor.next();
            if (!row) return;
            const ts = toDate(row.datetime).getTime();
            const interval = row.interval != null ? Number(row.interval) : src.baseMinutes;
            const lowerBound = interval > src.baseMinutes ? historyFromTs : fromTs;
            if (ts < lowerBound || ts > toTs) continue;
            heap.push({ ts, ticker: src.ticker, interval, src, row });
            return;
        }
    };

    for (const src of sources) await advance(src);

    while (heap.size > 0) {
        const item = heap.pop();
        const { row, ticker, interval } = item;
        intervals.add(interval);
        await writer.appendRow({
            datetime: new Date(item.ts),
            open: Number(row.open ?? 0), high: Number(row.high ?? 0),
            low: Number(row.low ?? 0), close: Number(row.close ?? 0),
            volume: Number(row.volume ?? 0),
            interval, ticker: text(row.ticker) || ticker,
        });
        rows += 1;
        await advance(item.src);
    }

    // A bundle spanning several periods takes several listings of one instrument.
    const symbols = [...new Set(sources.map((s) => s.ticker))].sort();
    writer.setMetadata(PARQUET_METADATA_KEY, JSON.stringify({
        source: "bundle",
        tickers: symbols,
        instruments,
        intervalMinutes: Math.min(...intervals),
        fromDate: from, tillDate: to,
        createdAt: new Date().toISOString(),
    }));
    await writer.close();
    for (const src of sources) await src.reader.close();

    return { tickers: symbols, rows, intervals: [...intervals].sort((a, b) => a - b) };
}

const program = new Command();
program
    .name("diviner-bundle")
    .description("Merge single-ticker listings into one multi-ticker Parquet")
    .argument("<inputs...>", "Source Parquet files")
    .requiredOption("--out <path>", "Output file")
    .option("--tickers <list>", "Only these tickers (comma-separated)")
    .option("--from <YYYY-MM-DD>", "Lower bound by Moscow date")
    .option("--to <YYYY-MM-DD>", "Upper bound by Moscow date")
    .option("--force", "Overwrite an existing output file", false);

if (import.meta.url === `file://${process.argv[1]}`) {
    program.parse();
    const opts = program.opts();
    const t0 = Date.now();
    const summary = await bundle(program.args, {
        ...opts,
        tickers: opts.tickers ? opts.tickers.split(",").map((t) => t.trim()) : null,
    });
    console.log(
        `${opts.out}: ${summary.tickers.length} tickers, `
        + `${summary.rows.toLocaleString("en-US")} rows, intervals [${summary.intervals.join(", ")}]m `
        + `— ${((Date.now() - t0) / 1000).toFixed(1)}s`,
    );
}
