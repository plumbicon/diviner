import * as parquet from "@dsnp/parquetjs";

export { PARQUET_METADATA_KEY } from "../../core/candle-parquet.js";

/**
 * Build a Parquet schema for order-book snapshots at a fixed depth: one row
 * per (instrument, snapshot time), with bid/ask price+size flattened into
 * per-level columns (bidPx0..bidPx{depth-1}, etc). Levels are optional since a
 * thin book can have fewer than `depth` levels on either side at a given
 * moment.
 * @param {number} depth - Levels per side to persist.
 * @returns {parquet.ParquetSchema} Schema for ParquetWriter/ParquetReader.
 */
export function buildOrderbookSchema(depth) {
    const fields = {
        ts: { type: "TIMESTAMP_MILLIS" },
        instId: { type: "UTF8" },
    };
    for (let i = 0; i < depth; i += 1) {
        fields[`bidPx${i}`] = { type: "DOUBLE", optional: true };
        fields[`bidSz${i}`] = { type: "DOUBLE", optional: true };
        fields[`askPx${i}`] = { type: "DOUBLE", optional: true };
        fields[`askSz${i}`] = { type: "DOUBLE", optional: true };
    }
    return new parquet.ParquetSchema(fields);
}

/**
 * Convert a ccxt order book structure into a flat Parquet row for `instId`,
 * keeping only the top `depth` levels per side.
 * @param {string} instId - OKX instrument id (e.g. "BTC-USDT-SWAP").
 * @param {object} book - ccxt order book ({bids, asks, timestamp, ...}).
 * @param {number} depth - Levels per side to persist.
 * @returns {object} Row matching buildOrderbookSchema(depth).
 */
export function bookToRow(instId, book, depth) {
    const row = { ts: new Date(book.timestamp || Date.now()), instId };
    const bids = book.bids || [];
    const asks = book.asks || [];
    for (let i = 0; i < depth; i += 1) {
        if (bids[i]) {
            row[`bidPx${i}`] = Number(bids[i][0]);
            row[`bidSz${i}`] = Number(bids[i][1]);
        }
        if (asks[i]) {
            row[`askPx${i}`] = Number(asks[i][0]);
            row[`askSz${i}`] = Number(asks[i][1]);
        }
    }
    return row;
}
