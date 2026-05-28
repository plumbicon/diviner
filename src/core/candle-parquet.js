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
    volume: { type: "INT64" },
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
        await writer.appendRow(record);
    }

    await writer.close();
    return null;
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
