import * as parquet from "@dsnp/parquetjs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const PARQUET_METADATA_KEY = "diviner.metadata";

export const candleSchema = new parquet.ParquetSchema({
    datetime: { type: "TIMESTAMP_MILLIS" },
    open: { type: "DOUBLE" },
    high: { type: "DOUBLE" },
    low: { type: "DOUBLE" },
    close: { type: "DOUBLE" },
    // DOUBLE (not INT64) so fractional volumes are representable — crypto venues
    // report sub-unit base-currency volume (e.g. 14.3326 BTC). MOEX share volumes
    // are whole numbers and stored exactly within a double's 2^53 integer range,
    // so this is lossless for the Tinkoff path too. Readers normalise via
    // Number(), and existing files keep their own embedded schema on read.
    volume: { type: "DOUBLE" },
    // Interval length in minutes (1, 60, 1440, …). Optional so a single-interval
    // file can omit it (legacy/back-compat: readers treat such rows as the base
    // interval from metadata). A multi-interval file tags every row, letting the
    // backtest serve the exact stored candles for each interval instead of
    // re-aggregating 1m — so daily/hourly closes match what the live API returns.
    interval: { type: "INT64", optional: true },
    // Instrument of the row. Optional — a single-ticker file omits it (compatibility with
    // every listing already downloaded: the reader takes the ticker from metadata). A
    // multi-ticker file tags every row, and then one parquet carries the whole universe:
    // a cross-sectional strategy needs access to any instrument, not only the one it was
    // started on.
    ticker: { type: "UTF8", optional: true },
});

/**
 * Find the first JSON block that looks like a candle table.
 * @param {object} rawData - Parsed JSON data.
 * @returns {{ key: string, block: object } | null} Matching data block.
 */
export function findCandlesDataBlock(rawData) {
    for (const [key, value] of Object.entries(rawData)) {
        if (
            value &&
            typeof value === "object" &&
            "data" in value &&
            Array.isArray(value.data)
        ) {
            return { key, block: value };
        }
    }

    return null;
}

/**
 * Convert candle rows into normalized Parquet records.
 * @param {Array<Array|object>} rows - Candle rows in MOEX-compatible or object format.
 * @returns {Array<object>} Normalized records.
 */
export function rowsToCandleRecords(rows) {
    const records = rows.map((row) => {
        let begin;
        let open;
        let high;
        let low;
        let close;
        let volume;

        if (Array.isArray(row)) {
            open = Number(row[0]);
            high = Number(row[1]);
            low = Number(row[2]);
            close = Number(row[3]);
            volume = Number(row[5]);
            begin = row[6];
        } else {
            begin = row.begin;
            open = Number(row.open);
            high = Number(row.high);
            low = Number(row.low);
            close = Number(row.close);
            volume = Number(row.volume);
        }

        return {
            datetime: new Date(begin),
            open,
            high,
            low,
            close,
            volume,
        };
    });

    records.sort((a, b) => a.datetime.getTime() - b.datetime.getTime());

    return records;
}

/**
 * Write normalized candle records as Parquet.
 * @param {Array<object>} records - Normalized candle records.
 * @param {string|null} outputPath - Output path; when omitted, returns a buffer.
 * @param {object} metadata - JSON-serializable dataset metadata.
 * @returns {Promise<Buffer|null>} Parquet buffer for stdout mode.
 */
export async function writeCandleRecordsAsParquet(
    records,
    outputPath = null,
    metadata = {},
) {
    if (!outputPath) {
        const tempDir = await mkdtemp(join(tmpdir(), "diviner-parquet-"));
        const tempPath = join(tempDir, "candles.parquet");

        try {
            await writeCandleRecordsAsParquet(records, tempPath, metadata);
            return await readFile(tempPath);
        } finally {
            await rm(tempDir, { recursive: true, force: true });
        }
    }

    const writer = await parquet.ParquetWriter.openFile(candleSchema, outputPath);
    if (metadata && Object.keys(metadata).length > 0) {
        writer.setMetadata(PARQUET_METADATA_KEY, JSON.stringify(metadata));
    }

    for (const record of records) {
        const row = {
            datetime: record.datetime,
            open: record.open,
            high: record.high,
            low: record.low,
            close: record.close,
            volume: record.volume,
        };
        // Only stamp the interval when the record carries one (multi-interval
        // files); single-interval files leave the column unset for back-compat.
        if (Number.isFinite(record.interval)) {
            row.interval = record.interval;
        }
        if (record.ticker) {
            row.ticker = record.ticker;
        }
        await writer.appendRow(row);
    }

    await writer.close();
    return null;
}

/**
 * Write several candle intervals into one Parquet file, tagging each row with
 * its interval length in minutes. The backtest broker can then serve the exact
 * stored candles per interval instead of aggregating the 1m base — so daily and
 * hourly closes match the official values the live API returns.
 *
 * @param {Map<number, Array<object>>|Array<{minutes: number, records: Array<object>}>} series
 *   Candle records grouped by interval minutes.
 * @param {string|null} outputPath - Output path; when omitted, returns a buffer.
 * @param {object} metadata - JSON-serializable dataset metadata.
 * @returns {Promise<Buffer|null>} Parquet buffer for stdout mode.
 */
export async function writeCandleSeriesAsParquet(series, outputPath = null, metadata = {}) {
    const entries = series instanceof Map
        ? [...series.entries()]
        : series.map((item) => [item.minutes, item.records]);

    const all = [];
    for (const [minutes, records] of entries) {
        const intervalMinutes = Number(minutes);
        for (const record of records) {
            all.push({ ...record, interval: intervalMinutes });
        }
    }

    all.sort((a, b) =>
        a.datetime.getTime() - b.datetime.getTime() || a.interval - b.interval);

    return writeCandleRecordsAsParquet(all, outputPath, metadata);
}

/**
 * Write several instruments into one Parquet: each row is tagged with both interval and
 * ticker. Cross-sectional strategies need it — they look at the whole universe at once,
 * and keeping it as a scatter of single-ticker files makes no sense.
 *
 * The metadata gets `tickers` (a list) and `instruments` (ticker → instrument description:
 * lot, exchange, figi). Top-level single-ticker fields stay filled when there is one
 * instrument — older readers will understand such a file.
 *
 * @param {Map<string, Map<number, Array<object>>>} bySymbol - ticker → (minutes → candles).
 * @param {string|null} outputPath - Path; a buffer is returned when null.
 * @param {object} metadata - Dataset metadata.
 * @returns {Promise<Buffer|null>} Buffer for stdout mode.
 */
export async function writeMultiSymbolParquet(bySymbol, outputPath = null, metadata = {}) {
    const all = [];
    for (const [ticker, series] of bySymbol) {
        for (const [minutes, records] of series) {
            const intervalMinutes = Number(minutes);
            for (const record of records) {
                all.push({ ...record, interval: intervalMinutes, ticker });
            }
        }
    }

    all.sort((a, b) =>
        a.datetime.getTime() - b.datetime.getTime()
        || a.interval - b.interval
        || (a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0));

    return writeCandleRecordsAsParquet(all, outputPath, metadata);
}

/**
 * Convert candle rows and write them as Parquet.
 * @param {Array<Array|object>} rows - Candle rows.
 * @param {string|null} outputPath - Output path; when omitted, returns a buffer.
 * @param {object} metadata - JSON-serializable dataset metadata.
 * @returns {Promise<Buffer|null>} Parquet buffer for stdout mode.
 */
export async function writeCandleRowsAsParquet(rows, outputPath = null, metadata = {}) {
    return writeCandleRecordsAsParquet(
        rowsToCandleRecords(rows),
        outputPath,
        metadata,
    );
}
