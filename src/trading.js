#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MODES = {
    backtest: "backtest.js",
    live: "live.js",
    fetch: "fetch.js",
};

const MODE_NAMES = Object.keys(MODES);

/**
 * Parse only the top-level --mode flag and leave mode-specific arguments intact.
 */
function parseTradingArgs(argv) {
    const args = [];
    let mode = null;

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];

        if (arg === "--mode") {
            mode = argv[i + 1] || null;
            i += 1;
            continue;
        }

        if (arg.startsWith("--mode=")) {
            mode = arg.slice("--mode=".length);
            continue;
        }

        args.push(arg);
    }

    return { mode, args };
}

function printHelp() {
    const command = "trading";

    console.log(`Usage: ${command} --mode <mode> [mode options]

Unified entry point for Diviner.

Modes:
  backtest    Run a strategy on historical data
  live        Run live trading or sandbox utilities
  fetch       Fetch historical candles from Tinkoff Invest API

Examples:
  T_INVEST_TOKEN=<token> ${command} --mode fetch --security SBER --from-date 2024-01-01
  ${command} --mode backtest data/sber.parquet --strategy src/strategies/sma_cross.js --balance 10000
  T_INVEST_TOKEN=<token> ${command} --mode live --create-account --increase-balance 10000
  T_INVEST_TOKEN=<token> ${command} --mode live --strategy src/strategies/test_odd_even.js --ticker SBER --sandbox --account <sandbox-account-id>

Use mode-specific help:
  ${command} --mode backtest --help
  ${command} --mode live --help
  ${command} --mode fetch --help`);
}

function exitWithError(message) {
    console.error(`Error: ${message}`);
    console.error(`Allowed modes: ${MODE_NAMES.join(", ")}`);
    process.exit(1);
}

async function main() {
    const { mode, args } = parseTradingArgs(process.argv.slice(2));

    if (!mode) {
        if (args.includes("--help") || args.includes("-h")) {
            printHelp();
            return;
        }
        exitWithError("required option '--mode <mode>' not specified");
    }

    if (!MODES[mode]) {
        exitWithError(`invalid mode '${mode}'`);
    }

    const scriptDir = dirname(fileURLToPath(import.meta.url));
    const scriptPath = join(scriptDir, MODES[mode]);
    const child = spawn(process.execPath, [scriptPath, ...args], {
        stdio: "inherit",
    });

    child.on("error", (error) => {
        console.error(`Error: failed to start ${mode}: ${error.message}`);
        process.exit(1);
    });

    child.on("exit", (code, signal) => {
        if (signal) {
            process.kill(process.pid, signal);
            return;
        }
        process.exit(code ?? 0);
    });
}

main().catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exit(1);
});
