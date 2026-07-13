#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import { Engine } from "./core/engine.js";
import { TemporalView } from "./core/temporal-view.js";
import { MarketDataCache } from "./core/market-cache.js";
import { loadStrategy } from "./core/strategy-loader.js";
import { encodeBacktestResult } from "./core/json-encoder.js";
import { createLogger } from "./core/logger.js";

const HELP = `Usage:
  diviner <broker-path> [broker options]

<broker-path> is a path to a broker module (like --strategy).

Examples:
  diviner src/broker/simulated/broker.js data/SBER_2024_1m.parquet --strategy path/to/strategy.js --balance 10000
  T_INVEST_TOKEN=<t> diviner src/broker/tinkoff/broker.js --strategy path/to/strategy.js --ticker SBER --sandbox --account <id>
  T_INVEST_TOKEN=<t> diviner src/broker/tinkoff/broker.js --sandbox --account <id> --print-balance
  T_INVEST_TOKEN=<t> diviner src/broker/tinkoff/broker.js --sandbox --account <id> --print-history [--history-from 2026-06-01]`;

function exitWithError(message) {
    console.error(`Error: ${message}`);
    process.exit(1);
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
        .name("diviner")
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
 * Run diviner against a broker: utilities (no strategy) or a strategy run.
 */
async function runBrokerMode(brokerRef, rest) {
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

    // Strategy run. Only brokers that declare readsSourceFromStdin (the
    // simulated backtest broker) may take their source from a pipe. Live brokers
    // never consume stdin — reading it would block forever on an interactive TTY
    // (or an open pipe with no EOF), hanging the process right after startup.
    if (config.source !== undefined) {
        config.sourceName = config.source;
    } else if (mod.readsSourceFromStdin && !process.stdin.isTTY) {
        const buffer = await readStdin();
        if (buffer) {
            config.source = buffer;
            config.sourceName = "stdin";
        }
    }

    const broker = await mod.createBroker(config);
    const StrategyClass = await loadStrategy(config.strategy);

    // Live wraps its data source in a cache so repeated history requests to the
    // exchange are memoised; the backtest source is already in-memory. Either
    // way the strategy sees one history path (context.getCandles) and the
    // broker underneath owns aggregation (backtest) or native fetch (live).
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

    if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
        console.log(HELP);
        return;
    }

    const [brokerRef, ...rest] = argv;
    if (brokerRef.startsWith("-")) {
        exitWithError(`expected a broker path as the first argument (got: ${brokerRef})`);
    }

    await runBrokerMode(brokerRef, rest);
}

main().catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exit(1);
});
