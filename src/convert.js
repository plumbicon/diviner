#!/usr/bin/env node
import { Command } from "commander";
import { readFile } from "fs/promises";
import {
    findCandlesDataBlock,
    writeCandleRowsAsParquet,
} from "./core/candle-parquet.js";

async function convertAndWriteParquet(rawData, outputPath) {
    const dataBlock = findCandlesDataBlock(rawData);

    if (!dataBlock || !dataBlock.block.data || dataBlock.block.data.length === 0) {
        throw new Error("Could not find a valid data block in the JSON file.");
    }

    console.error(`Found data block: '${dataBlock.key}'`);

    const buffer = await writeCandleRowsAsParquet(
        dataBlock.block.data,
        outputPath,
        dataBlock.block.metadata || {},
    );

    if (outputPath) {
        console.error(`Successfully converted data and saved to ${outputPath}`);
    } else if (buffer) {
        process.stdout.write(buffer);
    }
}

async function main() {
    const program = new Command();

    program
        .name("convert")
        .description("Convert candles JSON to Parquet format")
        .option("--input-json <path>", "Path to input JSON file (reads from stdin if omitted)")
        .option("--output-parquet <path>", "Path for output Parquet file (writes to stdout if omitted)");

    program.parse();
    const options = program.opts();

    let sourceData;

    if (options.inputJson) {
        const content = await readFile(options.inputJson, "utf-8");
        sourceData = JSON.parse(content);
    } else {
        console.error("Reading JSON data from stdin...");
        const chunks = [];

        for await (const chunk of process.stdin) {
            chunks.push(chunk);
        }

        sourceData = JSON.parse(chunks.join(""));
    }

    await convertAndWriteParquet(sourceData, options.outputParquet || null);
}

main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
});
