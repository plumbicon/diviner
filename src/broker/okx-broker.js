import { join } from "node:path";
import { createHash } from "node:crypto";
import { OkxClient } from "./okx/client.js";
import { getOkxIntervalConfig, getSupportedOkxIntervals } from "./okx/intervals.js";
import { StateManager } from "./common/state-manager.js";
import { PositionStore } from "./common/position-store.js";

/**
 * Plugin option descriptors for the CLI (validated by the shared layer).
 */
export const options = [
    { flags: "--symbol <symbol>", description: "Perpetual swap symbol (e.g. BTC/USDT:USDT)" },
    { flags: "--interval <tf>", description: `Candle timeframe: ${getSupportedOkxIntervals().join(", ")}`, default: "1m" },
    { flags: "--leverage <n>", description: "Leverage (set on the exchange before trading)", default: "1" },
    { flags: "--margin-fraction <f>", description: "Fraction of (free balance * leverage) to deploy per position; leaves margin buffer", default: "0.5" },
    { flags: "--margin-mode <mode>", description: "Margin mode: cross | isolated", default: "cross" },
    { flags: "--demo", description: "OKX demo trading (requires demo API keys)", default: false },
    { flags: "--dry-run", description: "Strategy runs, but no real orders are sent", default: false },
    { flags: "--close-on-exit", description: "Close open position when the session stops", default: false },
    { flags: "--order-retries <count>", description: "Retry count for transient order errors", default: "2" },
    { flags: "--order-tag <tag>", description: "Short label embedded in each order's client id", default: "div" },
    { flags: "--stall-timeout <minutes>", description: "Reconnect the candle stream if no candle arrives for N minutes (0 disables)", default: "30" },
    { flags: "--state-file <path>", description: "Path to persist software SL/TP across restarts" },
    { flags: "--key-prefix <name>", description: "Read keys from OKX_<NAME>_API_KEY/SECRET/PASSWORD instead of OKX_API_KEY/...", default: "" },
    { flags: "--log <path>", description: "Append all output to a log file" },
    // Account utilities (run without a strategy):
    { flags: "--print-balance", description: "Print free USDT balance and exit", default: false },
    { flags: "--print-position", description: "Print current position and exit", default: false },
];

/**
 * Resolve OKX credentials from the environment, honouring an optional key prefix
 * so each pair/process can map to a different sub-account.
 * @param {string} prefix - Optional uppercase prefix (e.g. "BTC").
 * @returns {{apiKey: string, secret: string, password: string}} Credentials.
 */
function resolveCreds(prefix) {
    const p = prefix ? `${String(prefix).toUpperCase()}_` : "";
    const apiKey = process.env[`OKX_${p}API_KEY`] || "";
    const secret = process.env[`OKX_${p}API_SECRET`] || "";
    const password = process.env[`OKX_${p}API_PASSWORD`] || "";
    return { apiKey, secret, password };
}

/**
 * Whether the CLI invocation is an account utility (no strategy needed).
 * @param {object} config - Parsed CLI options.
 * @returns {boolean} True for utility requests.
 */
export function isUtilityRequest(config = {}) {
    return Boolean(config.printBalance || config.printPosition);
}

/**
 * Run an account utility (balance/position) and return a process exit code.
 * @param {object} config - Parsed CLI options.
 * @returns {Promise<number>} Exit code.
 */
export async function runUtility(config = {}) {
    if (!config.symbol) {
        console.error("Error: --symbol is required for account utilities");
        return 1;
    }
    const creds = resolveCreds(config.keyPrefix);
    if (!creds.apiKey || !creds.secret || !creds.password) {
        console.error("Error: OKX API key/secret/password are required (set OKX_API_KEY/OKX_API_SECRET/OKX_API_PASSWORD)");
        return 1;
    }
    const client = new OkxClient(creds, {
        demo: Boolean(config.demo),
        verbose: Boolean(config.verbose),
        marginMode: config.marginMode || "cross",
    });
    try {
        await client.init(config.symbol);
        if (config.printBalance) {
            const usdt = await client.fetchBalance();
            console.log(`Free USDT balance: ${usdt}`);
        }
        if (config.printPosition) {
            const position = await client.fetchPosition(config.symbol);
            console.log(`Position: ${position ? `${position.side} ${position.size} contracts @ ${position.entryPrice}` : "none"}`);
        }
        return 0;
    } catch (error) {
        console.error(`Error: ${error?.message || error}`);
        return 1;
    } finally {
        await client.close();
    }
}

/**
 * Plugin entry point: build a live OKX swap broker from CLI config.
 * @param {object} config - Parsed CLI options.
 * @returns {Promise<object>} Broker { data, exec, finalize, metadata, needsCache }.
 */
export async function createBroker(config = {}) {
    if (!config.symbol) {
        throw new Error("--symbol is required (e.g. BTC/USDT:USDT)");
    }
    const creds = resolveCreds(config.keyPrefix);
    if (!creds.apiKey || !creds.secret || !creds.password) {
        const p = config.keyPrefix ? `${String(config.keyPrefix).toUpperCase()}_` : "";
        throw new Error(
            `OKX credentials are required: set OKX_${p}API_KEY, OKX_${p}API_SECRET and OKX_${p}API_PASSWORD`,
        );
    }

    const intervalConfig = getOkxIntervalConfig(config.interval ?? "1m");
    const leverage = Number(config.leverage ?? "1") || 1;

    const client = new OkxClient(creds, {
        demo: Boolean(config.demo),
        verbose: Boolean(config.verbose),
        marginMode: config.marginMode || "cross",
        orderRetries: parseInt(config.orderRetries ?? "2", 10),
    });
    await client.init(config.symbol);

    // One-way (net) mode + leverage are exchange-side settings; only touch them
    // on a real run (dry-run must not mutate account configuration). Skip the
    // account-mode check in demo: demo accounts are locked at acctLv=1 via the
    // OKX UI and can't be changed without a real deposit, so we let the order
    // attempt surface the 51010 directly if it applies rather than failing fast.
    if (!config.dryRun) {
        if (!config.demo) {
            await client.ensureFuturesAccountMode();
        }
        await client.ensureOneWayMode();
        await client.setLeverage(leverage);
    }

    const broker = createOkxBroker({
        client,
        symbol: config.symbol,
        intervalConfig,
        options: {
            verbose: Boolean(config.verbose),
            dryRun: Boolean(config.dryRun),
            closeOnExit: Boolean(config.closeOnExit),
            stallTimeoutMin: parseInt(config.stallTimeout ?? "30", 10),
            stateFile: config.stateFile || null,
            orderTag: config.orderTag || "div",
            leverage,
            marginFraction: Number(config.marginFraction ?? "0.5") || 0.5,
            keyPrefix: config.keyPrefix || "",
        },
    });

    broker.needsCache = true;
    broker.metadata = {
        source: "okx",
        instrument: broker.instrumentMetadata,
        interval: intervalConfig.label,
        intervalMinutes: intervalConfig.minutes,
        intervalLabel: intervalConfig.label,
        timezone: "UTC",
    };
    broker.client = client;
    return broker;
}

/**
 * Live data source backed by ccxt.pro for OKX.
 *
 * Turns the push-style watchOHLCV into a pull async-iterator. ccxt reconnects the
 * socket internally; on top of that a light watchdog reconnects if candles go
 * silent past --stall-timeout (catches a frozen socket that delivers nothing yet
 * raises no error). Crypto is 24/7, so there is no trading-session gating.
 */
export class OkxDataSource {
    constructor({ client, symbol, intervalConfig, verbose = false, stallTimeoutMin = 30 }) {
        this.client = client;
        this.symbol = symbol;
        this.intervalConfig = intervalConfig;
        this.verbose = verbose;
        this._closed = false;
        this._stallTimeoutMs = Math.max(0, Number(stallTimeoutMin) || 0) * 60 * 1000;
        this._lastCandleWall = Date.now();
        this._stallTimer = null;
    }

    /**
     * Stream completed candles, de-duplicated, with a light stall watchdog.
     * @returns {AsyncGenerator<object>} Candle stream.
     */
    async *stream() {
        this._startStallWatchdog();
        for await (const candle of this.client.streamCandles(this.symbol, this.intervalConfig.ccxtTimeframe)) {
            if (this._closed) {
                break;
            }
            this._lastCandleWall = Date.now();
            yield candle;
        }
    }

    /**
     * Start the stall watchdog: if no candle arrives for longer than the timeout,
     * drop and re-establish the socket. No session gating (crypto trades 24/7).
     * @private
     */
    _startStallWatchdog() {
        if (this._stallTimeoutMs <= 0 || this._stallTimer) {
            return;
        }
        this._lastCandleWall = Date.now();
        this._stallTimer = setInterval(() => {
            if (this._closed) {
                return;
            }
            const silentMs = Date.now() - this._lastCandleWall;
            if (silentMs < this._stallTimeoutMs) {
                return;
            }
            console.warn(
                `[OkxDataSource] No candle for ${Math.round(silentMs / 60000)}min — reconnecting candle stream.`,
            );
            this._lastCandleWall = Date.now();
            this.client.reconnectSocket().catch((error) => {
                console.error("[OkxDataSource] Reconnect failed:", error?.message || error);
            });
        }, 60 * 1000);
        this._stallTimer.unref?.();
    }

    /**
     * Historical candles for [from, to), clamped by the look-ahead bound `until`.
     * @param {object} params - { from, to, interval, until }.
     * @returns {Promise<Array<object>>} Candles.
     */
    async getHistory({ from = null, to = null, interval = null, until } = {}) {
        const cfg = interval ? getOkxIntervalConfig(interval) : this.intervalConfig;
        const nowMs = Date.now();
        const untilMs = until === undefined || until === Infinity ? nowMs : new Date(until).getTime();
        const toMs = to ? new Date(to).getTime() : untilMs;
        const effectiveUntil = Math.min(toMs, untilMs) + 1; // inclusive of the current bar
        const intervalMs = cfg.minutes * 60 * 1000;
        // Default lookback if no explicit start: enough bars to warm up indicators.
        const sinceMs = from ? new Date(from).getTime() : effectiveUntil - 500 * intervalMs;

        return this.client.fetchHistory({
            symbol: this.symbol,
            timeframe: cfg.ccxtTimeframe,
            since: sinceMs,
            until: effectiveUntil,
            limit: cfg.maxCandlesPerCall,
        });
    }

    /**
     * Trading schedule: crypto trades 24/7, so every day in range is fully open.
     * Shape matches buildCandleDerivedTradingSchedule for consumer compatibility.
     * @param {object} params - { from, to }.
     * @returns {Array<object>} Trading days (00:00–24:00 UTC).
     */
    async getTradingSchedule({ from = null, to = null } = {}) {
        const DAY_MS = 24 * 60 * 60 * 1000;
        const start = from ? new Date(from).getTime() : Date.now() - DAY_MS;
        const end = to ? new Date(to).getTime() : Date.now() + DAY_MS;
        const days = [];
        for (let ts = Math.floor(start / DAY_MS) * DAY_MS; ts <= end; ts += DAY_MS) {
            const dateKey = new Date(ts).toISOString().slice(0, 10);
            days.push({
                exchange: "OKX",
                date: `${dateKey}T00:00:00.000Z`,
                dateKey,
                isTradingDay: true,
                startTime: `${dateKey}T00:00:00.000Z`,
                endTime: new Date(ts + DAY_MS).toISOString(),
            });
        }
        return days;
    }

    /**
     * Stop the stream and tear down the socket (the live stop signal).
     */
    async requestStop() {
        this._closed = true;
        if (this._stallTimer) {
            clearInterval(this._stallTimer);
            this._stallTimer = null;
        }
        await this.client.close();
    }
}

/**
 * Build an OKX client order id (clOrdId): alphanumeric, ≤ 32 chars, so the same
 * candle+action+direction in the same second reuses the id (idempotency), while
 * different orders stay unique. Mirrors the intent of tinkoff buildOrderId but
 * fits OKX's stricter clOrdId format (no dashes).
 * @param {object} params - { tag, symbol, action, direction, at }.
 * @returns {string} clOrdId.
 */
export function buildClientOrderId({ tag, symbol, action, direction, at = new Date() }) {
    const when = at instanceof Date && !Number.isNaN(at.getTime()) ? at : new Date();
    const ts = Math.floor(when.getTime() / 1000).toString(36);
    const sym = createHash("sha1").update(String(symbol || "")).digest("hex").slice(0, 6);
    const a = action === "close" ? "C" : "O";
    const d = direction === "sell" ? "S" : "B";
    const t = (String(tag || "div").replace(/[^a-zA-Z0-9]/g, "").slice(0, 8)) || "div";
    return `${t}${a}${d}${sym}${ts}`.replace(/[^a-zA-Z0-9]/g, "").slice(0, 32);
}

/**
 * Live executor backed by the OKX order pipeline. Sizes positions in contracts
 * and tracks intended state via StateManager; SL/TP are software-enforced by the
 * engine and persisted via PositionStore (no native exchange stops).
 */
export class OkxExecutor {
    constructor({ client, symbol, intervalConfig, options = {} }) {
        this.client = client;
        this.symbol = symbol;
        this.intervalConfig = intervalConfig;
        this.options = options;
        this.verbose = Boolean(options.verbose);
        this.dryRun = Boolean(options.dryRun);
        this.orderTag = options.orderTag || "div";
        this.leverage = Number(options.leverage) || 1;
        this.marginFraction = Number(options.marginFraction) || 0.5;

        const intervalMs = intervalConfig.minutes * 60 * 1000;
        // Stale-entry guard: refuse to open on a back-filled candle replayed after
        // an outage — the real order would fill far from the modeled close.
        this.maxEntryAgeMs = Number.isFinite(options.maxEntryAgeMs)
            ? options.maxEntryAgeMs
            : intervalMs * 2 + 30_000;

        this.stateManager = new StateManager({ verbose: this.verbose });

        const prefix = options.keyPrefix ? String(options.keyPrefix).toLowerCase() : "okx";
        const safeSymbol = String(symbol).replace(/[^a-zA-Z0-9]/g, "_");
        const stateFile = options.stateFile
            || join(process.cwd(), ".diviner-state", `${prefix}_${safeSymbol}.json`);
        this.store = new PositionStore(stateFile, { verbose: this.verbose });

        this.freeBalance = 0;
        this.currentCandle = null;
        this.orderQueue = Promise.resolve();
        this.sessionTrades = [];
    }

    async init() {
        await this.refreshBalance();
        await this.syncWithAccountPosition();
    }

    setCurrentCandle(candle) {
        this.currentCandle = candle;
    }

    getPosition() {
        return this.stateManager.getPosition();
    }

    getBalance() {
        return this.freeBalance;
    }

    syncStrategyState(strategy) {
        this.stateManager.syncWithStrategy(strategy);
    }

    buy(size, sl, tp) {
        return this._open("long", size, sl, tp);
    }

    sell(size, sl, tp) {
        return this._open("short", size, sl, tp);
    }

    /**
     * Open a position and enqueue the corresponding order.
     * @private
     */
    _open(side, size, sl, tp) {
        if (this.stateManager.hasPosition()) {
            if (this.verbose) {
                console.log(`[OkxExecutor] ${side.toUpperCase()} skipped: position already open`);
            }
            return null;
        }
        if (this.currentCandle?.noTrade) {
            if (this.verbose) {
                console.log(`[OkxExecutor] ${side.toUpperCase()} skipped: warm-up (back-filled) candle`);
            }
            return null;
        }

        const candleTime = this.currentCandle?.datetime instanceof Date ? this.currentCandle.datetime.getTime() : null;
        if (candleTime !== null) {
            const ageMs = Date.now() - candleTime;
            if (ageMs > this.maxEntryAgeMs) {
                console.warn(
                    `[OkxExecutor] ${side.toUpperCase()} skipped: candle is ${Math.round(ageMs / 1000)}s old `
                    + `(> ${Math.round(this.maxEntryAgeMs / 1000)}s) — likely back-filled; entry dropped.`,
                );
                return null;
            }
        }

        const price = this.currentCandle?.close;
        const actualSize = size || this._defaultContracts(price);
        if (!Number.isFinite(actualSize) || actualSize <= 0) {
            if (this.verbose) {
                console.log(`[OkxExecutor] ${side.toUpperCase()} skipped: invalid/too-small size`);
            }
            return null;
        }

        this.stateManager.openPosition({
            side,
            size: actualSize,
            entryPrice: price,
            entryTime: this.currentCandle?.datetime,
            sl,
            tp,
        });
        this.store.save({
            symbol: this.symbol,
            side,
            size: actualSize,
            entryPrice: price ?? null,
            sl: sl ?? null,
            tp: tp ?? null,
        });
        this._enqueue(() => this._executeOrder(side === "long" ? "buy" : "sell", actualSize, "open"));
        return this.stateManager.getPosition();
    }

    closePosition() {
        if (!this.stateManager.hasPosition()) {
            if (this.verbose) {
                console.log("[OkxExecutor] CLOSE skipped: no position open");
            }
            return null;
        }
        const closed = this.stateManager.closePosition();
        this.store.clear();
        this._enqueue(() => this._closeRealPosition(closed));
        return closed;
    }

    async drainOrders() {
        await this.orderQueue;
    }

    /**
     * Reconcile intended state with the actual exchange position at start.
     */
    async syncWithAccountPosition() {
        if (this.dryRun) {
            return;
        }
        const position = await this.client.fetchPosition(this.symbol);
        if (!position) {
            this.stateManager.reset();
            this.store.clear();
            if (this.verbose) {
                console.log(`[OkxExecutor] Account position for ${this.symbol}: none`);
            }
            return;
        }

        const saved = this.store.load();
        const matched = saved && saved.symbol === this.symbol && saved.side === position.side;
        this.stateManager.setPosition({
            side: position.side,
            size: position.size,
            entryPrice: (matched && saved.entryPrice) || position.entryPrice || 0,
            entryTime: new Date(),
            sl: matched ? (saved.sl ?? null) : null,
            tp: matched ? (saved.tp ?? null) : null,
            source: "account",
        });
        console.warn(
            `[OkxExecutor] Existing position detected: ${position.side} ${position.size} contracts of ${this.symbol}. State synced.`,
        );
        console.warn(matched
            ? `[OkxExecutor] SL/TP restored from state file: sl=${saved.sl} tp=${saved.tp}`
            : "[OkxExecutor] No matching persisted SL/TP — position UNPROTECTED until the strategy re-sets levels.");
    }

    /**
     * Refresh free USDT balance used for sizing.
     */
    async refreshBalance() {
        try {
            this.freeBalance = await this.client.fetchBalance();
        } catch (error) {
            console.error("[OkxExecutor] Failed to refresh balance:", error?.message || error);
        }
        if (this.verbose) {
            console.log(`[OkxExecutor] Free USDT balance: ${this.freeBalance}`);
        }
        return this.freeBalance;
    }

    /**
     * Default position size in contracts from free balance, leverage and the
     * margin fraction, floored to the market's amount precision.
     * @param {number} price - Reference price.
     * @returns {number} Size in contracts (0 if below the minimum).
     * @private
     */
    _defaultContracts(price) {
        if (!Number.isFinite(price) || price <= 0) {
            return 0;
        }
        const notional = this.freeBalance * this.leverage * this.marginFraction;
        const raw = notional / (price * this.client.contractSize);
        const rounded = this.client.roundAmount(raw);
        if (rounded < this.client.minAmount) {
            return 0;
        }
        return rounded;
    }

    /**
     * Serialise order operations.
     * @private
     */
    _enqueue(operation) {
        this.orderQueue = this.orderQueue
            .then(operation)
            .catch((error) => {
                console.error("[OkxExecutor] Order queue failed:", error?.message || error);
            });
        return this.orderQueue;
    }

    _buildClOrdId(action, direction) {
        const at = this.currentCandle?.datetime instanceof Date ? this.currentCandle.datetime : new Date();
        return buildClientOrderId({ tag: this.orderTag, symbol: this.symbol, action, direction, at });
    }

    /**
     * Place an opening market order.
     * @private
     */
    async _executeOrder(direction, size, action) {
        if (this.dryRun) {
            console.log(`[OkxExecutor] DRY-RUN ${action} ${direction} ${size} contracts of ${this.symbol}`);
            this.sessionTrades.push({ kind: "open", direction, size, at: new Date() });
            return;
        }
        try {
            await this.client.createMarketOrder({
                symbol: this.symbol,
                side: direction,
                amount: size,
                reduceOnly: false,
                clientOrderId: this._buildClOrdId(action, direction),
            });
            this.sessionTrades.push({ kind: "open", direction, size, at: new Date() });
            console.log(`[OkxExecutor] Order executed: ${direction} ${size} contracts of ${this.symbol}`);
            await this.refreshBalance();
        } catch (error) {
            console.error(`[OkxExecutor] Failed to execute ${direction} order:`, error?.message || error);
            this.stateManager.reset();
            this.store.clear();
        }
    }

    /**
     * Place a reduce-only market order to close the position.
     * @private
     */
    async _closeRealPosition(position) {
        if (!position) {
            return;
        }
        const direction = position.side === "long" ? "sell" : "buy";
        if (this.dryRun) {
            console.log(`[OkxExecutor] DRY-RUN close ${direction} ${position.size} contracts of ${this.symbol}`);
            this.sessionTrades.push({ kind: "close", side: position.side, size: position.size, at: new Date() });
            return;
        }
        try {
            await this.client.createMarketOrder({
                symbol: this.symbol,
                side: direction,
                amount: position.size,
                reduceOnly: true,
                clientOrderId: this._buildClOrdId("close", direction),
            });
            this.sessionTrades.push({ kind: "close", side: position.side, size: position.size, at: new Date() });
            console.log(`[OkxExecutor] Close order executed: ${position.side} ${position.size} contracts of ${this.symbol}`);
        } catch (error) {
            console.error("[OkxExecutor] Failed to close position:", error?.message || error);
            if (!this.stateManager.hasPosition()) {
                this.stateManager.setPosition(position);
            }
            return;
        }
        try {
            await this.refreshBalance();
        } catch (error) {
            console.error("[OkxExecutor] Failed to refresh balance after close:", error?.message || error);
        }
    }
}

/**
 * Assemble a live OKX broker: { data, exec } over the ccxt OKX API.
 * @param {object} params - { client, symbol, intervalConfig, options }.
 * @returns {object} Broker with data, exec, instrumentMetadata, finalize.
 */
export function createOkxBroker({ client, symbol, intervalConfig, options = {} }) {
    const data = new OkxDataSource({
        client,
        symbol,
        intervalConfig,
        verbose: options.verbose,
        stallTimeoutMin: options.stallTimeoutMin,
    });
    const exec = new OkxExecutor({ client, symbol, intervalConfig, options });

    const market = client.market || {};
    const instrumentMetadata = {
        ticker: symbol,
        symbol,
        name: market.id || symbol,
        exchange: "OKX",
        // Backtest granularity: the fractional base-coin step (crypto is not
        // whole-unit quantised). Live sizing uses contracts directly.
        lot: client.baseStep,
        contractSize: client.contractSize,
        currency: market.quote || market.settle || "USDT",
    };

    return {
        data,
        exec,
        instrumentMetadata,
        /**
         * Wind down the live session: optionally close the open position
         * (--close-on-exit), stop the stream, print a short summary, close client.
         */
        async finalize() {
            if (options.closeOnExit && exec.getPosition()) {
                console.log("[Session] Closing open position on exit (--close-on-exit)...");
                exec.closePosition();
                await exec.drainOrders();
            }

            await data.requestStop();

            const opens = exec.sessionTrades.filter((t) => t.kind === "open").length;
            const closes = exec.sessionTrades.filter((t) => t.kind === "close").length;
            const pos = exec.getPosition();
            console.log(`[Session] Trades this session: ${opens} open / ${closes} close. Final free USDT: ${exec.getBalance()}.`);
            console.log(`[Session] Open position at exit: ${pos ? `${pos.side} ${pos.size} contracts` : "none"}.`);
            console.log("[Session] NOTE: trade P&L here does NOT include perpetual funding fees — reconcile against the exchange balance.");
        },
    };
}
