#!/usr/bin/env node
/**
 * Собрать однобумажные листинги в один мультитикерный Parquet.
 *
 * Кросс-секционной стратегии нужен доступ к любой бумаге вселенной, а не только
 * к той, на которой её запустили, — значит вселенная должна лежать одним
 * датасетом. Каждая строка результата помечена тикером и интервалом, метаданные
 * несут `tickers` и `instruments` (лот, биржа, figi по каждой бумаге).
 *
 * Слияние потоковое: 62 читателя открываются одновременно, строки сливаются
 * по времени и пишутся сразу. Ни один листинг целиком в память не поднимается —
 * иначе год по всей вселенной (~40 млн свечей) не собрать.
 *
 * Исходные файлы только читаются. Существующий выходной файл не перезаписывается
 * без --force: листинги не удаляем и не подменяем укороченной выборкой (AGENTS.md).
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

// Запас дневной истории перед --from: 21-дневное окно фич плюс праздники.
const HISTORY_LOOKBACK_DAYS = 40;

/** Дата строки Parquet → Date. @private */
function toDate(ts) {
    if (typeof ts === "bigint") return new Date(Number(ts / 1_000_000n));
    if (typeof ts === "number") return new Date(ts > 1e12 ? ts : ts * 1000);
    if (ts instanceof Date) return ts;
    return new Date(ts);
}

/** UTF8-колонка parquetjs приходит Buffer'ом. @private */
function text(value) {
    if (value == null) return null;
    return Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
}

/** Тикер файла: из метаданных, иначе из имени (AFKS_2025_1m.parquet → AFKS). @private */
function tickerOfFile(metadata, filePath) {
    const fromMeta = metadata?.ticker || metadata?.instrument?.ticker;
    if (fromMeta) return fromMeta;
    const match = basename(filePath).match(/^([A-Z0-9]+)_/);
    return match ? match[1] : null;
}

/**
 * Двоичная куча-минимум по (datetime, ticker, interval) — порядок слияния.
 * Линейный поиск минимума на 60+ источниках и 40 млн строк заметно тормозит.
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
 * Слить листинги в один мультитикерный Parquet.
 * @param {string[]} inputs - Пути к исходным файлам.
 * @param {object} options - { out, tickers, from, to, force }.
 * @returns {Promise<object>} Сводка { tickers, rows, intervals }.
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
    // Нижняя граница режет только минутки. Дневные свечи нужны стратегиям как
    // история d-1..d-5 (окно 21 календарный день), и если обрезать их по той же
    // дате, первые недели прогона молча выпадут: истории для фич не наберётся.
    // Верхняя граница общая — заглядывать вперёд нельзя ни на каком интервале.
    const historyFromTs = from
        ? fromTs - HISTORY_LOOKBACK_DAYS * 24 * 60 * 60 * 1000
        : -Infinity;

    // Открываем все источники сразу: слияние по времени требует одновременного
    // доступа к головам всех потоков.
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
            console.error(`  ${basename(filePath)}: тикер не определён — пропуск`);
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

    /** Дотянуть следующую подходящую строку источника в кучу. @private */
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

    const symbols = sources.map((s) => s.ticker).sort();
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
    .description("Собрать однобумажные листинги в один мультитикерный Parquet")
    .argument("<inputs...>", "Исходные Parquet-файлы")
    .requiredOption("--out <path>", "Выходной файл")
    .option("--tickers <list>", "Только эти тикеры (через запятую)")
    .option("--from <YYYY-MM-DD>", "Нижняя граница по дате МСК")
    .option("--to <YYYY-MM-DD>", "Верхняя граница по дате МСК")
    .option("--force", "Перезаписать существующий выходной файл", false);

if (import.meta.url === `file://${process.argv[1]}`) {
    program.parse();
    const opts = program.opts();
    const t0 = Date.now();
    const summary = await bundle(program.args, {
        ...opts,
        tickers: opts.tickers ? opts.tickers.split(",").map((t) => t.trim()) : null,
    });
    console.log(
        `${opts.out}: ${summary.tickers.length} тикеров, `
        + `${summary.rows.toLocaleString("ru-RU")} строк, интервалы [${summary.intervals.join(", ")}]m `
        + `— ${((Date.now() - t0) / 1000).toFixed(1)}s`,
    );
}
