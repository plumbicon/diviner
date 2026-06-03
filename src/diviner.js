#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Command } from "commander";
import { Engine } from "./core/engine.js";
import { TemporalView } from "./core/temporal-view.js";
import { MarketDataCache } from "./core/market-cache.js";
import { loadStrategy } from "./core/strategy-loader.js";
import { encodeBacktestResult } from "./core/json-encoder.js";
import { createLogger } from "./core/logger.js";

const scriptDir = dirname(fileURLToPath(import.meta.url));

const HELP = `Usage:
  diviner --broker <path> --strategy <path> [broker options]
  diviner --fetch   [fetch options]
  diviner --convert [convert options]

Exactly one of --broker / --fetch / --convert.
--broker is a path to a broker module (like --strategy).

Examples:
  diviner --broker src/broker/simulated-broker.js data/SBER_2024_1m.parquet --strategy path/to/strategy.js --balance 10000
  T_INVEST_TOKEN=<t> diviner --broker src/broker/tinkoff-broker.js --strategy path/to/strategy.js --ticker SBER --sandbox --account <id>
  T_INVEST_TOKEN=<t> diviner --broker src/broker/tinkoff-broker.js --sandbox --account <id> --print-balance
  T_INVEST_TOKEN=<t> diviner --fetch --security SBER --from-date 2024-01-01 --parquet > sber.parquet
  diviner --convert --input-json sber.json --output-parquet sber.parquet`;

/**
 * Split off the top-level mode flags, leaving the rest for the mode handler.
 */
function extractModes(argv) {
    const rest = [];
    const modes = new Set();
    let brokerRef = null;

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === "--broker") { brokerRef = argv[i + 1]; i += 1; modes.add("broker"); continue; }
        if (arg.startsWith("--broker=")) { brokerRef = arg.slice("--broker=".length); modes.add("broker"); continue; }
        if (arg === "--fetch") { modes.add("fetch"); continue; }
        if (arg === "--convert") { modes.add("convert"); continue; }
        rest.push(arg);
    }

    return { modes: [...modes], brokerRef, rest };
}

function exitWithError(message) {
    console.error(`Error: ${message}`);
    process.exit(1);
}

/**
 * Delegate fetch/convert to their existing self-contained CLIs.
 */
function delegate(script, rest) {
    const child = spawn(process.execPath, [join(scriptDir, script), ...rest], { stdio: "inherit" });
    child.on("error", (error) => exitWithError(`failed to start ${script}: ${error.message}`));
    child.on("exit", (code, signal) => {
        if (signal) { process.kill(process.pid, signal); return; }
        process.exit(code ?? 0);
    });
}

/**
 * Resolve a broker module path (relative to cwd, like --strategy) to a URL.
 */
function resolveBrokerModule(ref) {
    return pathToFileURL(resolve(process.cwd(), ref)).href;
}

/**
 * Build a commander parser from the broker's declared options plus shared ones,
 * and return the parsed config (п.3: validation lives in this shared layer).
 */
function parseBrokerConfig(brokerOptions, rest) {
    const program = new Command();
    program
        .name("diviner --broker")
        .allowExcessArguments(false)
        .option("--strategy <path>", "Path to the strategy file")
        .option("--verbose", "Verbose output", false)
        .argument("[source]", "Data source (e.g. parquet path for simulated; reads stdin if omitted)");

    for (const opt of brokerOptions || []) {
        program.option(opt.flags, opt.description, opt.default);
    }

    program.parse(rest, { from: "user" });
    const config = program.opts();
    config.source = program.args[0];
    return config;
}

/**
 * Read piped stdin as a Buffer (for simulated source from a pipe).
 */
async function readStdin() {
    const chunks = [];
    for await (const chunk of process.stdin) {
        chunks.push(chunk);
    }
    return chunks.length > 0 ? Buffer.concat(chunks) : null;
}

/**
 * Register SIGINT/SIGTERM → broker stop signal (live brokers only).
 */
function registerSignals(broker) {
    if (typeof broker.data.requestStop !== "function") {
        return;
    }
    const handler = (signal) => {
        console.log(`[Main] ${signal} received, shutting down...`);
        const force = setTimeout(() => process.exit(0), 5000);
        force.unref();
        broker.data.requestStop();
    };
    process.on("SIGINT", () => handler("SIGINT"));
    process.on("SIGTERM", () => handler("SIGTERM"));
}

/**
 * --broker mode: utilities (no strategy) or a strategy run.
 */
async function runBrokerMode(brokerRef, rest) {
    if (!brokerRef) {
        exitWithError("--broker requires a value (simulated | tinkoff | path)");
    }

    const mod = await import(resolveBrokerModule(brokerRef));
    const config = parseBrokerConfig(mod.options, rest);

    const logger = createLogger({ logPath: config.log });
    logger.installConsole();

    // No strategy → account utility (if requested) or error.
    if (!config.strategy) {
        if (typeof mod.isUtilityRequest === "function" && mod.isUtilityRequest(config)) {
            process.exit(await mod.runUtility(config));
        }
        exitWithError("nothing to do: provide --strategy <path> with a data source, or a valid account utility");
    }

    // Strategy run. simulated reads its source from a pipe if no path was given.
    if (config.source === undefined) {
        const buffer = await readStdin();
        if (buffer) {
            config.source = buffer;
            config.sourceName = "stdin";
        }
    } else {
        config.sourceName = config.source;
    }

    const broker = await mod.createBroker(config);
    const StrategyClass = await loadStrategy(config.strategy);

    const dataSource = broker.needsCache ? new MarketDataCache(broker.data) : broker.data;
    const context = new TemporalView({
        dataSource,
        // Route strategy logs through console.error so the installed logger
        // captures them (stderr + --log file). console.error (not log) keeps
        // them off stdout, which carries the backtest JSON report.
        metadata: broker.metadata,
        logger: (message) => console.error(message),
    });

    const initialData = broker.data.candles ?? [];
    const strategy = new StrategyClass(
        initialData,
        Number(config.balance) || 0,
        Number(config.commission) || 0,
    );

    registerSignals(broker);

    const engine = new Engine();
    const result = await engine.run({
        broker,
        strategy,
        context,
        options: { verbose: config.verbose },
    });

    // Backtest brokers return a report; live returns nothing.
    if (result) {
        if (!config.verbose) {
            result.trade_log = [];
        }
        // Raw write so the JSON report bypasses the timestamped logger.
        process.stdout.write(`${encodeBacktestResult(result)}\n`);
    }
    process.exit(0);
}

async function main() {
    const argv = process.argv.slice(2);
    const { modes, brokerRef, rest } = extractModes(argv);

    if (modes.length > 1) {
        exitWithError(`only one of --broker / --fetch / --convert may be used (got: ${modes.join(", ")})`);
    }
    if (modes.length === 0) {
        // No mode: show top-level help, otherwise demand a mode.
        if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
            console.log(HELP);
            return;
        }
        exitWithError("one of --broker / --fetch / --convert is required");
    }

    const mode = modes[0];
    if (mode === "fetch") { delegate("fetch.js", rest); return; }
    if (mode === "convert") { delegate("convert.js", rest); return; }
    await runBrokerMode(brokerRef, rest);
}

main().catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exit(1);
});
