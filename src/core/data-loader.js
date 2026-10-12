import * as parquet from "@dsnp/parquetjs";
import { PARQUET_METADATA_KEY } from "./candle-parquet.js";
import { CandleSeriesBuilder } from "./candle-series.js";

/**
 * Load candles from a Parquet file.
 */
export async function loadData(pathOrBuffer) {
    const dataset = await loadDataset(pathOrBuffer);
    return dataset.candles;
}

/**
 * Load candles and metadata from a Parquet file.
 *
 * A file may hold several intervals (minute, daily and so on): each row is then tagged
 * with the `interval` column (length in minutes). Candles are grouped by interval into
 * `series` (Map<minutes, candles[]>). `candles` is the base (smallest) interval: the
 * engine streams it, and it keeps backward compatibility. Old files without the
 * `interval` column are read as one base interval taken from `metadata.intervalMinutes`
 * (1 by default).
 *
 * A file may also hold several instruments — each row is then tagged with the `ticker`
 * column. Besides the shared `series` (all instruments mixed in chronological order — the
 * stream for the multi-ticker engine) the dataset provides `bySymbol`: ticker → (minutes →
 * candles). A single-ticker file behaves exactly as before, with one entry in `bySymbol`
 * and a `ticker` field on every candle.
 *
 * @param {string|Buffer} pathOrBuffer - Parquet path or Buffer.
 * @returns {Promise<{ candles: Array<object>, series: Map<number, Array<object>>,
 *   metadata: object, symbols: Array<string>, bySymbol: Map<string, Map<number, Array<object>>>,
 *   instruments: Map<string, object> }>} Dataset.
 */
export async function loadDataset(pathOrBuffer) {
    let reader;

    if (typeof pathOrBuffer === "string") {
        reader = await parquet.ParquetReader.openFile(pathOrBuffer);
    } else {
        reader = await parquet.ParquetReader.openBuffer(pathOrBuffer);
    }

    try {
        const metadata = parseDivinerMetadata(reader.getMetadata?.() || {});
        const baseMinutesMeta = Number(metadata.intervalMinutes) || 1;

        // Files built by bundle.js carry the ticker list in their metadata and are read
        // as columns: a year of the universe does not fit the heap as objects. Downloaded
        // single-ticker listings have no such field and take the old path — their
        // behaviour does not change by a byte.
        if (Array.isArray(metadata.tickers)) {
            return await readColumnar(reader, metadata, baseMinutesMeta);
        }

        const cursor = reader.getCursor();
        const series = new Map();
        const bySymbol = new Map();
        const defaultTicker = metadata.ticker || metadata.instrument?.ticker || null;
        let row;

        while (row = await cursor.next()) {
            let datetime;
            const ts = row.datetime;

            if (typeof ts === "bigint") {
                datetime = new Date(Number(ts / 1_000_000n));
            } else if (typeof ts === "number") {
                datetime = ts > 1e12 ? new Date(ts) : new Date(ts * 1000);
            } else if (ts instanceof Date) {
                datetime = ts;
            } else {
                datetime = new Date();
            }

            const ticker = normalizeTicker(row.ticker) || defaultTicker;
            const candle = {
                datetime,
                open: Number(row.open ?? row.Open ?? 0),
                high: Number(row.high ?? row.High ?? 0),
                low: Number(row.low ?? row.Low ?? 0),
                close: Number(row.close ?? row.Close ?? 0),
                volume: Number(row.volume ?? row.Volume ?? 0),
                ticker,
            };

            const minutes = row.interval != null ? Number(row.interval) : baseMinutesMeta;
            let bucket = series.get(minutes);
            if (!bucket) {
                bucket = [];
                series.set(minutes, bucket);
            }
            bucket.push(candle);

            if (ticker) {
                let symbolSeries = bySymbol.get(ticker);
                if (!symbolSeries) {
                    symbolSeries = new Map();
                    bySymbol.set(ticker, symbolSeries);
                }
                let symbolBucket = symbolSeries.get(minutes);
                if (!symbolBucket) {
                    symbolBucket = [];
                    symbolSeries.set(minutes, symbolBucket);
                }
                symbolBucket.push(candle);
            }
        }

        // Chronological order; the ticker is a deterministic tie-break, otherwise
        // instruments of one minute would come in random order and runs would not reproduce.
        for (const bucket of series.values()) {
            bucket.sort(compareCandles);
        }
        for (const symbolSeries of bySymbol.values()) {
            for (const bucket of symbolSeries.values()) {
                bucket.sort(compareCandles);
            }
        }

        const baseMinutes = series.size > 0 ? Math.min(...series.keys()) : baseMinutesMeta;
        const candles = series.get(baseMinutes) || [];
        const symbols = [...bySymbol.keys()].sort();
        const instruments = new Map();
        for (const symbol of symbols) {
            const info = metadata.instruments?.[symbol]
                ?? (symbol === defaultTicker ? metadata.instrument : null);
            instruments.set(symbol, info || { ticker: symbol, lot: 1 });
        }

        return { candles, series, metadata, symbols, bySymbol, instruments };
    } finally {
        await reader.close();
    }
}

/**
 * Read a multi-ticker file into columns: ticker → interval → CandleSeries.
 *
 * The physical layout is per instrument (time ascending within each). That matches every
 * hot query: features and the session window ask for one instrument's history. The shared
 * chronological stream over the universe is built by the `mergeStream` iterator as a
 * merge — it makes no copy of the data.
 * @private
 */
async function readColumnar(reader, metadata, baseMinutesMeta) {
    const cursor = reader.getCursor();
    const symbolTable = [];
    const builders = new Map();   // ticker -> Map<minutes, CandleSeriesBuilder>
    let row;

    while (row = await cursor.next()) {
        const ticker = normalizeTicker(row.ticker) || metadata.ticker || null;
        if (!ticker) continue;
        const minutes = row.interval != null ? Number(row.interval) : baseMinutesMeta;

        let perInterval = builders.get(ticker);
        if (!perInterval) { perInterval = new Map(); builders.set(ticker, perInterval); }
        let builder = perInterval.get(minutes);
        if (!builder) {
            builder = new CandleSeriesBuilder({ symbols: symbolTable });
            perInterval.set(minutes, builder);
        }
        builder.push({
            datetime: toDatetime(row.datetime),
            open: Number(row.open ?? 0), high: Number(row.high ?? 0),
            low: Number(row.low ?? 0), close: Number(row.close ?? 0),
            volume: Number(row.volume ?? 0),
            ticker,
        });
    }

    const bySymbol = new Map();
    for (const [ticker, perInterval] of builders) {
        const built = new Map();
        for (const [minutes, builder] of perInterval) built.set(minutes, builder.build());
        bySymbol.set(ticker, built);
    }

    const symbols = [...bySymbol.keys()].sort();
    const instruments = new Map();
    for (const symbol of symbols) {
        instruments.set(symbol, metadata.instruments?.[symbol] || { ticker: symbol, lot: 1 });
    }

    // A bundle is always a universe dataset, even with a single instrument: data is
    // accessed by ticker. It has no shared `candles`/`series`, deliberately — gluing the
    // universe into a second physical array would double the memory for something the
    // multi-ticker engine does not need: it needs a stream.
    const baseMinutes = (() => {
        const intervals = new Set();
        for (const perInterval of bySymbol.values()) {
            for (const minutes of perInterval.keys()) intervals.add(minutes);
        }
        return intervals.size > 0 ? Math.min(...intervals) : baseMinutesMeta;
    })();

    return {
        candles: null,
        series: null,
        metadata, symbols, bySymbol, instruments,
        /**
         * Chronological stream over several instruments (a merge without copying).
         *
         * The last candle of each minute is marked `isBatchEnd`. A cross-sectional
         * decision is only possible once the minute is complete: scores across the
         * universe cannot be compared having seen half of the instruments. The flag is set
         * by looking one candle ahead — there is no other way to tell "the minute ended".
         * @param {number} minutes - Interval.
         * @param {Array<string>} [only] - Ticker subset.
         * @returns {Generator<object>} Candles by ascending time, ticker as the tie-break.
         */
        *mergeStream(minutes, only = null) {
            const heads = [];
            for (const ticker of (only || symbols)) {
                const series = bySymbol.get(ticker)?.get(minutes);
                if (series && series.length > 0) heads.push({ ticker, series, i: 0 });
            }
            const next = () => {
                let best = -1;
                for (let k = 0; k < heads.length; k += 1) {
                    const h = heads[k];
                    if (h.i >= h.series.length) continue;
                    if (best < 0) { best = k; continue; }
                    const bh = heads[best];
                    const diff = h.series.tsAt(h.i) - bh.series.tsAt(bh.i);
                    if (diff < 0 || (diff === 0 && h.ticker < bh.ticker)) best = k;
                }
                if (best < 0) return null;
                const h = heads[best];
                const candle = h.series.at(h.i);
                h.i += 1;
                return candle;
            };

            let held = next();
            while (held) {
                const ahead = next();
                held.isBatchEnd = !ahead || ahead.datetime.getTime() !== held.datetime.getTime();
                yield held;
                held = ahead;
            }
        },
    };
}

/** datetime column value → Date. @private */
function toDatetime(ts) {
    if (typeof ts === "bigint") return new Date(Number(ts / 1_000_000n));
    if (typeof ts === "number") return new Date(ts > 1e12 ? ts : ts * 1000);
    if (ts instanceof Date) return ts;
    return new Date(ts);
}

/** Candle comparison: time, then ticker. @private */
function compareCandles(a, b) {
    const diff = a.datetime.getTime() - b.datetime.getTime();
    if (diff !== 0) return diff;
    const at = a.ticker || "";
    const bt = b.ticker || "";
    return at < bt ? -1 : at > bt ? 1 : 0;
}

/** Ticker from a Parquet row (parquetjs returns UTF8 as a Buffer). @private */
function normalizeTicker(value) {
    if (value == null) return null;
    const text = Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
    return text.length > 0 ? text : null;
}

function parseDivinerMetadata(metadata) {
    const raw = metadata[PARQUET_METADATA_KEY];
    if (!raw) {
        return {};
    }

    try {
        return JSON.parse(raw);
    } catch {
        return {};
    }
}
