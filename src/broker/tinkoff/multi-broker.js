#!/usr/bin/env node
/**
 * Live T-Invest broker — the only live path on MOEX. A one-ticker universe works the same
 * way as a hundred-ticker one. Only assembly and account utilities live here — all the
 * logic is in {@link MultiSymbolTinkoffDataSource} and {@link MultiSymbolTinkoffExecutor}.
 *
 * The universe is given as a list (`--tickers`) or a file (`--universe-file`) produced by
 * `src/universe.js`. Instrument resolution is cached on disk: 97 tickers through
 * `getInstrumentByTicker` take ~40 seconds, and there is no reason to pay that on every
 * start.
 *
 * Usage:
 *   T_INVEST_TOKEN=<t> diviner src/broker/tinkoff/multi-broker.js \
 *     --strategy <path-to-strategy> --account <id> \
 *     --universe-file data/universe.json --intrabar-stops
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { TinkoffClient } from "./client.js";
import { MultiSymbolTinkoffDataSource } from "./multi-data-source.js";
import { MultiSymbolTinkoffExecutor } from "./multi-executor.js";
import { runUtility, isUtilityRequest } from "./sandbox-utils.js";

export { runUtility, isUtilityRequest };

export const options = [
    { flags: "--tickers <list>", description: "Universe instruments, comma-separated" },
    { flags: "--universe-file <path>", description: "JSON with the ticker list and instrument cache (see src/universe.js)" },
    { flags: "--account <id>", description: "Account ID" },
    { flags: "--sandbox", description: "Sandbox (virtual money)", default: false },
    { flags: "--dry-run", description: "The strategy runs, but no orders are sent", default: false },
    { flags: "--interval <minutes>", description: "Candle interval, minutes", default: "1" },
    { flags: "--close-on-exit", description: "Close open positions on shutdown", default: false },
    { flags: "--order-retries <count>", description: "Retries on transient order errors", default: "2" },
    { flags: "--order-tag <tag>", description: "Label in the order idempotency key", default: "div" },
    { flags: "--stall-timeout <minutes>", description: "Silence threshold of the WHOLE stream before resubscribing (0 disables)", default: "30" },
    { flags: "--batch-grace-ms <ms>", description: "Minute grace window: how long to wait for late instruments before deciding", default: "8000" },
    { flags: "--state-dir <path>", description: "Directory of position state files (default .diviner-state)" },
    { flags: "--intrabar-stops", description: "Check SL/TP against the arrived candle's high/low, not only its close", default: false },
    { flags: "--leverage <n>", description: "Leverage. >1 sends confirmMarginTrade=true", default: "1" },
    { flags: "--print-balance", description: "Print balance and positions and exit", default: false },
    { flags: "--print-history", description: "Print the operations history and exit", default: false },
    { flags: "--history-from <date>", description: "Start of the period for --print-history" },
    // Sandbox account management (without a strategy, only with --sandbox):
    { flags: "--list-sandboxes", description: "List sandbox accounts and exit", default: false },
    { flags: "--create-account", description: "Create a sandbox account", default: false },
    { flags: "--remove-account", description: "Remove the sandbox account given by --account", default: false },
    { flags: "--reset-positions", description: "Reset share positions of the sandbox account (RUB stays)", default: false },
    { flags: "--increase-balance <amount>", description: "Increase the RUB balance of the sandbox account" },
    { flags: "--log <path>", description: "Duplicate output to a file" },
];

/**
 * Read the universe composition: an explicit list wins over the file.
 * @param {object} config - CLI config.
 * @returns {Promise<{tickers: Array<string>, cache: object|null, path: string|null}>} Universe.
 */
async function readUniverse(config) {
    if (config.tickers) {
        return { tickers: config.tickers.split(",").map((t) => t.trim()).filter(Boolean), cache: null, path: null };
    }
    if (!config.universeFile) {
        throw new Error("provide --tickers <list> or --universe-file <path>");
    }
    const raw = JSON.parse(await readFile(config.universeFile, "utf8"));
    const tickers = Array.isArray(raw) ? raw : (raw.tickers || []);
    if (!tickers.length) throw new Error(`${config.universeFile} holds no tickers`);
    return { tickers, cache: Array.isArray(raw) ? null : (raw.instruments || null), path: config.universeFile };
}

/**
 * Resolve instruments with an on-disk cache.
 *
 * `getInstrumentByTicker` fetches one instrument at a time: for 97 tickers that is ~40
 * seconds before subscribing. The cache removes the pause, but lot and risk rate change
 * over time, so it lives for a limited period.
 *
 * @param {object} client - TinkoffClient.
 * @param {object} universe - readUniverse result.
 * @param {number} maxAgeMs - Cache lifetime.
 * @returns {Promise<Array<object>>} Instruments.
 */
async function resolveInstruments(client, universe, maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
    const fresh = universe.cache?.resolvedAt
        && Date.now() - Date.parse(universe.cache.resolvedAt) < maxAgeMs;
    if (fresh) {
        const cached = universe.tickers.map((t) => universe.cache.byTicker?.[t]).filter(Boolean);
        if (cached.length === universe.tickers.length) {
            console.log(`[MultiBroker] Instruments from cache: ${cached.length}.`);
            return cached;
        }
    }

    const started = Date.now();
    const instruments = [];
    const missing = [];
    for (const ticker of universe.tickers) {
        try {
            instruments.push(await client.getInstrumentByTicker(ticker));
        } catch (error) {
            missing.push(`${ticker} (${error.message})`);
        }
    }
    if (missing.length) console.warn(`[MultiBroker] Not resolved: ${missing.join(", ")}`);
    if (!instruments.length) throw new Error("no instruments resolved");
    console.log(`[MultiBroker] Resolved ${instruments.length} instruments in ${((Date.now() - started) / 1000).toFixed(1)}s.`);

    if (universe.path) {
        const byTicker = Object.fromEntries(instruments.map((i) => [i.ticker, i]));
        try {
            await mkdir(dirname(universe.path), { recursive: true });
            await writeFile(universe.path, JSON.stringify({
                tickers: universe.tickers,
                instruments: { resolvedAt: new Date().toISOString(), byTicker },
            }, null, 2));
        } catch (error) {
            console.warn(`[MultiBroker] Instrument cache not saved: ${error.message}`);
        }
    }
    return instruments;
}

/**
 * Plugin entry point: build the live multi-instrument broker.
 * @param {object} config - Parsed CLI options.
 * @returns {Promise<object>} Broker { data, exec, finalize, metadata, needsCache }.
 */
export async function createBroker(config = {}) {
    const token = process.env.T_INVEST_TOKEN || "";
    if (!token) throw new Error("T_INVEST_TOKEN environment variable is required");

    const client = new TinkoffClient(token, {
        sandbox: Boolean(config.sandbox),
        accountId: config.account || null,
        orderRetries: parseInt(config.orderRetries ?? "2", 10),
        verbose: Boolean(config.verbose),
    });
    console.log(`[MultiBroker] Connecting to T-Invest (${config.sandbox ? "SANDBOX" : "REAL"})…`);
    await client.init();

    const universe = await readUniverse(config);
    const instruments = await resolveInstruments(client, universe);
    const interval = parseInt(config.interval ?? "1", 10);

    const data = new MultiSymbolTinkoffDataSource({
        client, instruments, interval,
        verbose: Boolean(config.verbose),
        stallTimeoutMin: parseInt(config.stallTimeout ?? "30", 10),
        batchGraceMs: parseInt(config.batchGraceMs ?? "8000", 10),
    });
    const exec = new MultiSymbolTinkoffExecutor({
        client, instruments, interval,
        options: {
            verbose: Boolean(config.verbose),
            dryRun: Boolean(config.dryRun),
            orderTag: config.orderTag || "div",
            intrabarStops: Boolean(config.intrabarStops),
            leverage: parseFloat(config.leverage ?? "1"),
            stateDir: config.stateDir || join(process.cwd(), ".diviner-state"),
        },
    });

    return {
        data,
        exec,
        client,
        needsCache: true,
        metadata: {
            source: "tinkoff",
            interval,
            intervalMinutes: interval,
            intervalLabel: `${interval}m`,
            timezone: "Europe/Moscow",
            tickers: instruments.map((i) => i.ticker),
            instruments: Object.fromEntries(instruments.map((i) => [i.ticker, i])),
        },
        /** Wind the session down: close positions if asked, drop the subscription, report. */
        async finalize() {
            if (config.closeOnExit) {
                for (const position of exec.getPositions()) {
                    console.log(`[MultiBroker] Closing ${position.ticker} on exit (--close-on-exit).`);
                    exec.closePosition("shutdown", position.ticker);
                }
                await exec.drainOrders();
            }
            await data.requestStop();
            const opens = exec.sessionTrades.filter((t) => t.kind === "open").length;
            const closes = exec.sessionTrades.filter((t) => t.kind === "close").length;
            const held = exec.getPositions().map((p) => `${p.ticker} ${p.side} ${p.size}`);
            console.log(`[MultiBroker] Session: ${opens} entries / ${closes} exits. Cash ${exec.getBalance().toFixed(2)} ₽.`);
            console.log(`[MultiBroker] Open at exit: ${held.length ? held.join(", ") : "none"}.`);
            const blocked = exec.getBlocked?.() ?? [];
            if (blocked.length) {
                console.log(
                    "[MultiBroker] Rejected by the exchange: "
                    + blocked.map((b) => `${b.ticker} (${b.permanent ? "permanently" : "no margin"})`).join(", "),
                );
            }
            await client.close();
        },
    };
}
