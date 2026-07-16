#!/usr/bin/env node
/**
 * Merge OKX order-book Parquet chunks (produced by
 * src/broker/okx/orderbook-logger.js on a remote host, then copied down) into
 * one combined Parquet file. Streams rows chunk-by-chunk (never loads a whole
 * chunk into memory), so this scales to the multi-GB combined archives this
 * pipeline is meant to produce.
 *
 * Chunk files are named ob_okx_<ISO-timestamp>.parquet and each covers a
 * contiguous, non-overlapping time window (one rotation of the logger), so
 * sorting inputs by filename and concatenating in that order reproduces
 * global chronological order without needing to sort rows in memory.
 *
 * Usage:
 *   node scripts/merge-okx-orderbook.mjs data/okx-orderbook-chunks/*.parquet --output data/okx-orderbook-2026-Q3.parquet
 */

import { Command } from "commander";
import * as parquet from "@dsnp/parquetjs";
import { buildOrderbookSchema, PARQUET_METADATA_KEY } from "../src/broker/okx/orderbook-parquet.js";

function parseChunkMetadata(reader) {
    const raw = reader.getMetadata?.() || {};
    const blob = raw[PARQUET_METADATA_KEY];
    if (!blob) return {};
    try {
        return JSON.parse(blob);
    } catch {
        return {};
    }
}

async function main() {
    const program = new Command();
    program
        .name("merge-okx-orderbook")
        .description("Streaming-merge OKX order-book chunks (from orderbook-logger.js) into one Parquet file")
        .argument("<inputs...>", "Chunk .parquet files (sorted chronologically by filename before merging)")
        .requiredOption("--output <path>", "Combined output Parquet path");

    program.parse();
    const inputs = [...program.args].sort();
    const { output } = program.opts();

    if (inputs.length === 0) {
        program.error("Provide at least one input .parquet file.");
    }

    // Pass 1: validate every chunk shares the same depth and collect the
    // union of symbols, without reading any rows yet.
    let depth = null;
    const symbols = new Set();
    for (const path of inputs) {
        const reader = await parquet.ParquetReader.openFile(path);
        try {
            const meta = parseChunkMetadata(reader);
            if (depth === null) {
                depth = meta.depth;
                if (!Number.isInteger(depth) || depth <= 0) {
                    throw new Error(`${path}: missing/invalid metadata.depth — is this an orderbook-logger.js chunk?`);
                }
            } else if (meta.depth !== depth) {
                throw new Error(`${path}: depth=${meta.depth} does not match earlier chunk depth=${depth}. All chunks must share the same --depth.`);
            }
            for (const s of meta.symbols || []) symbols.add(s);
        } finally {
            await reader.close();
        }
    }

    const schema = buildOrderbookSchema(depth);
    const writer = await parquet.ParquetWriter.openFile(schema, output);
    writer.setMetadata(PARQUET_METADATA_KEY, JSON.stringify({
        source: "okx",
        schemaVersion: 1,
        kind: "orderbook",
        depth,
        symbols: [...symbols].sort(),
        mergedFrom: inputs,
        mergedAt: new Date().toISOString(),
    }));

    // Pass 2: stream rows chunk-by-chunk straight into the writer.
    let totalRows = 0;
    for (const path of inputs) {
        const reader = await parquet.ParquetReader.openFile(path);
        try {
            const cursor = reader.getCursor();
            let row;
            let rowsInFile = 0;
            while ((row = await cursor.next())) {
                await writer.appendRow(row);
                rowsInFile += 1;
            }
            totalRows += rowsInFile;
            console.error(`  ${path}: +${rowsInFile.toLocaleString()} rows`);
        } finally {
            await reader.close();
        }
    }

    await writer.close();
    console.error(`\nMerged ${inputs.length} file(s), ${totalRows.toLocaleString()} rows -> ${output}`);
}

main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
});
