import {
    TinkoffMarketDataProvider,
    buildInstrumentMetadata,
    getMoscowDateKey,
} from "../core/market-data.js";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { TinkoffClient } from "./tinkoff/client.js";
import { OrderManager } from "./tinkoff/order-manager.js";
import { StateManager } from "./common/state-manager.js";
import { PositionStore } from "./common/position-store.js";
import { evaluateIntrabarStop } from "../core/stops.js";
import { runUtility, isUtilityRequest } from "./tinkoff/sandbox-utils.js";

// Account utilities (no strategy) live in sandbox-utils; re-exported so the CLI
// can call broker.runUtility(config) when no strategy is given (п.2).
export { runUtility, isUtilityRequest };

/**
 * Plugin option descriptors for the CLI (validated by the shared layer, п.3).
 */
export const options = [
    { flags: "--ticker <symbol>", description: "Instrument ticker (e.g. SBER)" },
    { flags: "--account <id>", description: "Account ID" },
    { flags: "--sandbox", description: "Sandbox mode (virtual money)", default: false },
    { flags: "--dry-run", description: "Strategy runs, but no real orders are sent", default: false },
    { flags: "--interval <minutes>", description: "Candle interval in minutes", default: "1" },
    { flags: "--close-on-exit", description: "Close open position when the session stops", default: false },
    { flags: "--order-retries <count>", description: "Retry count for transient order errors", default: "2" },
    { flags: "--order-tag <tag>", description: "Short label embedded in each order's idempotency key for log correlation (e.g. strategy name). Default: \"div\"", default: "div" },
    { flags: "--stall-timeout <minutes>", description: "Exit if no candle arrives for N minutes during a trading session (0 disables). Raise for illiquid instruments whose no-trade gaps are long.", default: "30" },
    { flags: "--state-file <path>", description: "Path to persist software SL/TP across restarts (default: .diviner-state/<account>_<ticker>.json)" },
    { flags: "--intrabar-stops", description: "Check SL/TP against the live candle's high/low (not just close) and close at market the moment a level is touched. Default off = check on close.", default: false },
    { flags: "--leverage <n>", description: "Margin leverage: default order size = 95% of cash × leverage. >1 sends confirmMarginTrade=true (uncovered/margin positions). Requires a margin-enabled account. Default 1.", default: "1" },
    // Account utilities (run without a strategy):
    { flags: "--list-sandboxes", description: "List sandbox accounts and exit", default: false },
    { flags: "--create-account", description: "Create a new sandbox account", default: false },
    { flags: "--remove-account", description: "Remove the sandbox account from --account", default: false },
    { flags: "--print-balance", description: "Print sandbox balance and positions", default: false },
    { flags: "--print-history", description: "Print operations history for --account and exit", default: false },
    { flags: "--history-from <date>", description: "Start date (YYYY-MM-DD) for --print-history (default: 6 months ago)" },
    { flags: "--reset-positions", description: "Reset sandbox share positions (keep RUB)", default: false },
    { flags: "--increase-balance <amount>", description: "Increase sandbox RUB balance by amount" },
    { flags: "--log <path>", description: "Append all output to a log file" },
];

/**
 * Plugin entry point: build a live T-Invest broker from CLI config.
 * Creates and initialises the client and resolves the instrument.
 * @param {object} config - Parsed CLI options.
 * @returns {Promise<object>} Broker { data, exec, finalize, metadata, needsCache }.
 */
export async function createBroker(config = {}) {
    const token = process.env.T_INVEST_TOKEN || "";
    if (!token) {
        throw new Error("T_INVEST_TOKEN environment variable is required");
    }

    const client = new TinkoffClient(token, {
        sandbox: Boolean(config.sandbox),
        accountId: config.account || null,
        orderRetries: parseInt(config.orderRetries ?? "2", 10),
        verbose: Boolean(config.verbose),
    });
    // Print before the first network call so a connection hang (bad token,
    // network) is immediately distinguishable from "the process never started".
    console.log(`[Tinkoff] Connecting to T-Invest API (${config.sandbox ? "SANDBOX" : "REAL"})…`);
    await client.init();

    const instrument = await client.getInstrumentByTicker(config.ticker);
    const interval = parseInt(config.interval ?? "1", 10);

    const broker = createTinkoffBroker({
        client,
        instrument,
        interval,
        options: {
            verbose: Boolean(config.verbose),
            dryRun: Boolean(config.dryRun),
            closeOnExit: Boolean(config.closeOnExit),
            stallTimeoutMin: parseInt(config.stallTimeout ?? "30", 10),
            stateFile: config.stateFile || null,
            orderTag: config.orderTag || "div",
            intrabarStops: Boolean(config.intrabarStops),
            leverage: parseFloat(config.leverage ?? "1"),
        },
    });

    // History (TemporalView) goes through a cache; the engine still tactics the
    // raw stream and calls requestStop on broker.data directly. CLI wraps for
    // history when needsCache is set.
    broker.needsCache = true;
    broker.metadata = {
        source: "tinkoff",
        instrument: broker.instrumentMetadata,
        interval,
        intervalMinutes: interval,
        intervalLabel: `${interval}m`,
        timezone: "Europe/Moscow",
    };
    broker.client = client;

    // Unconditional startup banner so the operator always sees the bot is alive
    // and how it's configured — without this, a flat sandbox account run without
    // --verbose produces zero output until the first trade, looking like a hang.
    const lev = parseFloat(config.leverage ?? "1");
    console.log(
        `[Tinkoff] Connected (${config.sandbox ? "SANDBOX" : "REAL"}). `
        + `account=${client.accountId} instrument=${instrument.ticker} (${instrument.figi}) `
        + `interval=${interval}m leverage=${lev}x intrabar-stops=${Boolean(config.intrabarStops)} `
        + `dry-run=${Boolean(config.dryRun)}`,
    );
    return broker;
}

/**
 * Live data source backed by the T-Invest API.
 *
 * Turns the push-style candle subscription into a pull async-iterator the
 * engine can drive, and owns all the live "messiness" (stale-candle dedup,
 * reconnect catch-up) so neither the engine nor strategies see it. History and
 * trading schedule are answered by {@link TinkoffMarketDataProvider}.
 */
export class TinkoffDataSource {
    constructor({ client, instrument, interval = 1, verbose = false, stallTimeoutMin = 30 }) {
        this.client = client;
        this.instrument = instrument;
        this.interval = interval;
        this.verbose = verbose;
        this.provider = new TinkoffMarketDataProvider({
            api: client.api,
            instrument,
            exchange: instrument.exchange,
        });

        this._queue = [];
        this._notify = null;
        this._closed = false;
        this._lastTime = null;
        this._catchUpFrom = null;

        // Stall watchdog: a silently-frozen gRPC stream (TCP killed without RST)
        // delivers no candles and raises no error, so the built-in reconnect never
        // fires. We detect the gap in wall-clock time and force-reconnect the
        // subscription in-process, preserving in-memory SL/TP and strategy state.
        // Only if the reconnect itself fails do we fall back to process.exit(1).
        //
        // Liquidity-aware: a long silence on an illiquid instrument is normal
        // (KZOS can go 60–90min without a trade), so before reconnecting we probe
        // REST to confirm a completed candle was actually missed. If REST shows
        // none, the stream is healthy and the market is just quiet — no reconnect.
        this._stallTimeoutMs = Math.max(0, Number(stallTimeoutMin) || 0) * 60 * 1000;
        this._lastCandleWall = Date.now();
        this._stallTimer = null;
        // dateKey (MSK) -> { isTradingDay, openTs, closeTs }. Populated from the
        // exchange trading schedule so the watchdog respects weekend sessions and
        // holidays instead of assuming a fixed weekday calendar.
        this._scheduleCache = new Map();
        this._loadingSchedule = false;
    }

    /**
     * Subscribe and stream completed candles in order, de-duplicated.
     * @returns {AsyncGenerator<object>} Candle stream.
     */
    async *stream() {
        this._catchUpFrom = new Date();
        await this.client.subscribeCandles(
            this.instrument,
            this.interval,
            (candle) => this._enqueue(candle),
            {
                waitingClose: true,
                onReconnectCatchUp: () => this._catchUpMissed(),
            },
        );
        this._startStallWatchdog();
        console.log(
            `[Tinkoff] Subscribed to ${this.instrument.ticker} ${this.interval}m candles. `
            + `Waiting for completed candles (one per ${this.interval}m while the market is open)…`,
        );

        while (!this._closed) {
            if (this._queue.length === 0) {
                await new Promise((resolve) => { this._notify = resolve; });
            }
            while (this._queue.length > 0) {
                yield this._queue.shift();
            }
        }
    }

    /**
     * Accept a candle from the subscription, dropping stale/duplicate ones.
     * @param {object} candle - Incoming candle.
     * @private
     */
    _enqueue(candle) {
        const time = candle?.datetime instanceof Date ? candle.datetime.getTime() : NaN;
        if (!Number.isFinite(time)) {
            return;
        }
        if (this._lastTime !== null && time <= this._lastTime) {
            if (this.verbose) {
                console.log(`[TinkoffDataSource] Candle skipped: stale/duplicate ${candle.datetime.toISOString()}`);
            }
            return;
        }
        this._lastTime = time;
        this._lastCandleWall = Date.now();
        // Per-candle heartbeat is verbose-only (one line per interval is noisy in
        // prod); the startup banner already confirms the bot is alive.
        if (this.verbose) {
            console.log(`[Live] candle ${candle.datetime.toISOString()} close=${candle.close}`);
        }
        this._queue.push(candle);
        if (this._notify) {
            const notify = this._notify;
            this._notify = null;
            notify();
        }
    }

    /**
     * Start the stall watchdog. Checks once a minute whether candles have gone
     * silent for longer than the timeout while the market is open; if so, and a
     * REST probe confirms a completed candle was missed, force-reconnects the
     * subscription in-process (state preserved). A quiet but healthy stream is
     * left untouched.
     * @private
     */
    _startStallWatchdog() {
        if (this._stallTimeoutMs <= 0 || this._stallTimer) {
            return;
        }
        this._lastCandleWall = Date.now();
        // Warm the schedule cache up front so the first checks have data even if
        // the network later degrades.
        this._loadScheduleAround(new Date()).catch(() => {});
        this._stallTimer = setInterval(() => {
            this._checkStall().catch((error) => {
                if (this.verbose) {
                    console.warn("[TinkoffDataSource] Stall check error:", error.message);
                }
            });
        }, 60 * 1000);
        this._stallTimer.unref?.();
    }

    /**
     * Reconnect only if the stream is genuinely stalled. While the exchange is in
     * session and candles have been silent past the timeout, probe REST: if a
     * completed candle was missed, the stream is dead — force-reconnect; if none
     * was missed, the market is merely quiet (illiquid name) and the stream is
     * left alone. Outside a session, silence is normal, so the clock is reset and
     * nothing is reported.
     * @param {Date} [now] - Current time (injectable for tests).
     * @private
     */
    async _checkStall(now = new Date()) {
        if (this._closed) {
            return;
        }
        const nowMs = now.getTime();
        const inSession = await this._isWithinTradingSession(now);
        if (!inSession) {
            this._lastCandleWall = nowMs;
            return;
        }
        const silentMs = nowMs - this._lastCandleWall;
        if (silentMs < this._stallTimeoutMs) {
            return;
        }

        // Silence exceeded the timeout. Tell a dead stream apart from an illiquid
        // instrument that simply hasn't traded by probing REST for a completed
        // candle the stream should have delivered.
        const missed = await this._hasMissedCandle(now);
        // Reset either way so a persistent quiet period re-probes once per timeout
        // window rather than every minute.
        this._lastCandleWall = nowMs;
        if (!missed) {
            if (this.verbose) {
                console.log(
                    `[TinkoffDataSource] No candle for ${Math.round(silentMs / 60000)}min, but REST shows `
                    + `none missed — stream healthy, market quiet (no reconnect).`,
                );
            }
            return;
        }

        console.warn(
            `[TinkoffDataSource] Candle stream stalled: a completed candle was missed after `
            + `${Math.round(silentMs / 60000)}min of silence. Reconnecting stream (SL/TP preserved in memory).`,
        );
        this._forceReconnect().catch((error) => {
            console.error("[TinkoffDataSource] Force-reconnect failed, exiting for systemd restart:", error.message);
            process.exit(1);
        });
    }

    /**
     * Probe REST for a completed candle newer than the last one the stream
     * delivered — evidence the live subscription is actually stalled rather than
     * the instrument simply being quiet. Uses the same completeness criteria as
     * {@link _catchUpMissed}. If the probe itself fails (e.g. network down), the
     * stream health can't be confirmed, so it returns true to preserve the
     * reconnect safety net.
     * @param {Date} [now] - Current time.
     * @returns {Promise<boolean>} True if a completed candle was missed.
     * @private
     */
    async _hasMissedCandle(now = new Date()) {
        const intervalMs = (Number(this.interval) || 1) * 60 * 1000;
        const lowerBound = this._lastTime ?? this._catchUpFrom?.getTime() ?? null;
        if (lowerBound === null) {
            return false;
        }
        const from = new Date(lowerBound + 1);
        if (from >= now) {
            return false;
        }

        let candles;
        try {
            candles = await this.provider.getCandles({
                from,
                to: now,
                interval: this.interval,
                includeWeekend: true,
            });
        } catch (error) {
            if (this.verbose) {
                console.warn("[TinkoffDataSource] Stall probe failed, assuming stalled:", error.message);
            }
            return true;
        }

        return candles.some((candle) => (
            candle.isComplete !== false
            && candle.datetime instanceof Date
            && candle.datetime.getTime() > lowerBound
            && candle.datetime.getTime() + intervalMs <= now.getTime()
        ));
    }

    /**
     * Reconnect the candle subscription without restarting the process.
     *
     * The stream() generator stays alive (it just awaits _notify), so the engine
     * loop is unaffected and in-memory state (SL/TP, strategy position) is fully
     * preserved. We tear down the dead gRPC channel, back-fill any missed closed
     * candles, and start a fresh subscription — the generator then picks up from
     * the first new candle that arrives.
     * @private
     */
    async _forceReconnect() {
        if (this._closed) {
            return;
        }
        try {
            // Back-fill closed candles that arrived while the stream was frozen.
            await this._catchUpMissed();
        } catch (error) {
            if (this.verbose) {
                console.warn("[TinkoffDataSource] Catch-up before reconnect failed:", error.message);
            }
        }
        // _startCandleStream internally calls _unsubscribeCurrentCandleStream first,
        // so the dead subscription is torn down cleanly before we re-subscribe.
        await this.client._startCandleStream();
        console.log("[TinkoffDataSource] Candle stream reconnected (process kept alive).");
    }

    /**
     * Whether `now` falls inside an exchange trading session, per the schedule
     * fetched from T-Invest (so weekend sessions and holidays are honoured). If
     * the schedule for today is not cached, a best-effort load is attempted; when
     * no schedule is available at all, falls back to a broad Moscow window
     * (06:50–23:50, any weekday) so a stall is still caught during plausible
     * trading times.
     * @param {Date} now - Current time.
     * @returns {Promise<boolean>} True if within a session.
     * @private
     */
    async _isWithinTradingSession(now) {
        const dateKey = getMoscowDateKey(now);
        if (!this._scheduleCache.has(dateKey)) {
            await this._loadScheduleAround(now);
        }
        const entry = this._scheduleCache.get(dateKey);
        if (entry) {
            if (!entry.isTradingDay) {
                return false;
            }
            const ts = now.getTime();
            if (entry.openTs && entry.closeTs) {
                return ts >= entry.openTs && ts <= entry.closeTs;
            }
            return true; // trading day, but session bounds unknown
        }
        // No schedule available (e.g. network down): broad daily window.
        const msk = new Date(now.getTime() + 3 * 60 * 60 * 1000);
        const minutes = msk.getUTCHours() * 60 + msk.getUTCMinutes();
        return minutes >= 6 * 60 + 50 && minutes <= 23 * 60 + 50;
    }

    /**
     * Best-effort fetch of the trading schedule around `now`, populating the
     * cache. Failures are swallowed — the caller falls back to the clock window.
     * @param {Date} now - Reference time.
     * @private
     */
    async _loadScheduleAround(now) {
        if (this._loadingSchedule) {
            return;
        }
        this._loadingSchedule = true;
        try {
            const from = new Date(now.getTime() - 24 * 60 * 60 * 1000);
            const to = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
            const days = await this.getTradingSchedule({ from, to });
            for (const day of days || []) {
                const dk = day.dateKey || day.date?.slice(0, 10);
                if (!dk) {
                    continue;
                }
                this._scheduleCache.set(dk, {
                    isTradingDay: Boolean(day.isTradingDay),
                    openTs: day.startTime ? new Date(day.startTime).getTime() : null,
                    closeTs: day.endTime ? new Date(day.endTime).getTime() : null,
                });
            }
        } catch (error) {
            if (this.verbose) {
                console.warn("[TinkoffDataSource] Schedule load for watchdog failed:", error.message);
            }
        } finally {
            this._loadingSchedule = false;
        }
    }

    /**
     * Re-fetch candles missed during a stream outage and enqueue them.
     * @private
     */
    async _catchUpMissed() {
        const intervalMs = (Number(this.interval) || 1) * 60 * 1000;
        const lowerBound = this._lastTime ?? this._catchUpFrom?.getTime() ?? null;
        if (lowerBound === null) {
            return;
        }

        const from = new Date(lowerBound + 1);
        const now = new Date();
        if (from >= now) {
            return;
        }

        let candles;
        try {
            candles = await this.provider.getCandles({
                from,
                to: now,
                interval: this.interval,
                includeWeekend: true,
            });
        } catch (error) {
            console.error("[TinkoffDataSource] Catch-up failed:", error.message);
            return;
        }

        const closed = candles
            .filter((candle) => (
                candle.isComplete !== false
                && candle.datetime instanceof Date
                && candle.datetime.getTime() > lowerBound
                && candle.datetime.getTime() + intervalMs <= now.getTime()
            ))
            .sort((a, b) => a.datetime.getTime() - b.datetime.getTime());

        if (closed.length > 0) {
            console.log(`[TinkoffDataSource] Catching up ${closed.length} missed candle(s).`);
            // Replay every missed candle so the strategy's running state (per-bar
            // volume windows, day-boundary detection, return windows) stays
            // contiguous — skipping candles would corrupt those features. But only
            // the freshest candle may actually trade: on the older ones close is
            // stale, so an order would fill far from the modeled price. Mark all
            // but the last as no-trade (warm-up only).
            const lastIdx = closed.length - 1;
            for (let i = 0; i < closed.length; i += 1) {
                closed[i].isCatchUp = true;
                if (i < lastIdx) {
                    closed[i].noTrade = true;
                }
                this._enqueue(closed[i]);
            }
        }
    }

    /**
     * Historical candles for the instrument.
     * @param {object} params - { from, to, interval }. `until` is ignored live.
     * @returns {Promise<Array<object>>} Candles.
     */
    async getHistory({ until, ...params } = {}) {
        return this.provider.getCandles(params);
    }

    /**
     * Trading schedule for the instrument exchange.
     * @param {object} params - { from, to }.
     * @returns {Promise<Array<object>>} Trading days.
     */
    async getTradingSchedule(params = {}) {
        return this.provider.getTradingSchedule(params);
    }

    /**
     * Request the stream to end and cancel the underlying candle subscription.
     * This is the live "stop signal": it makes stream() finish, so the engine
     * leaves its loop and calls broker.finalize().
     * @returns {Promise<void>} Resolves once the subscription is torn down.
     */
    async requestStop() {
        this._closed = true;
        if (this._stallTimer) {
            clearInterval(this._stallTimer);
            this._stallTimer = null;
        }
        if (this._notify) {
            const notify = this._notify;
            this._notify = null;
            notify();
        }
        if (typeof this.client?.unsubscribeCandles === "function") {
            try {
                await this.client.unsubscribeCandles();
            } catch (error) {
                // Cancelling an active subscription often returns a cancel status;
                // expected during shutdown, so keep it quiet unless verbose.
                if (this.verbose) {
                    console.warn("[TinkoffDataSource] Unsubscribe note:", error.message);
                }
            }
        }
    }
}

/**
 * Build a human-meaningful idempotency key for an order, so it can later be
 * correlated with strategy logs.
 *
 * Layout (sanitised to [A-Za-z0-9_-], hard-capped at the API's 36-char limit):
 *   <tag>-<ticker>-<O|C><B|S>-<yyMMddHHmmss>   (timestamp in UTC)
 * e.g. `a05-ALRS-OS-260613040100` = open short on ALRS for the 2026-06-13
 * 04:01:00 candle.
 *
 * IMPORTANT — what this id is and isn't:
 *  - It is the API's `order_id` / `order_request_id` (idempotency key). It is
 *    echoed back by PostOrder and visible via getOrderState / getOrders / the
 *    order-state stream, so you can match an order to the candle that triggered
 *    it.
 *  - It is NOT a free-text comment and does NOT appear in the operations
 *    history (getOperations) or broker report — those carry only the exchange
 *    order id. The T-Invest API has no per-operation comment field.
 *  - The broker dedups idempotency keys for ~1 month, so the trailing timestamp
 *    keeps each order unique; same-second retries intentionally reuse the key.
 *
 * The API (and the sandbox especially) validates order_id as a UUID, so the
 * human-readable key above is used only as the *seed* for a deterministic
 * UUIDv5. Same seed → same UUID, which preserves the idempotency property
 * (same-second retries reuse the id, broker dedups for ~1 month) while
 * satisfying the strict UUID format requirement.
 *
 * @param {object} params - { tag, ticker, action: 'open'|'close', direction:
 *                            'buy'|'sell', at?: Date }
 * @returns {string} Deterministic UUIDv5 idempotency key.
 */
export function buildOrderId({ tag, ticker, action, direction, at = new Date() }) {
    const iso = (at instanceof Date && !Number.isNaN(at.getTime()) ? at : new Date()).toISOString();
    const ts = iso.slice(2, 4) + iso.slice(5, 7) + iso.slice(8, 10)
        + iso.slice(11, 13) + iso.slice(14, 16) + iso.slice(17, 19);
    const a = action === "close" ? "C" : "O";
    const d = direction === "sell" ? "S" : "B";
    const raw = `${tag || "div"}-${ticker || "x"}-${a}${d}-${ts}`;
    const h = createHash("sha1").update(raw).digest("hex");
    const variant = ((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, "0");
    return [
        h.slice(0, 8),
        h.slice(8, 12),
        `5${h.slice(13, 16)}`,
        `${variant}${h.slice(18, 20)}`,
        h.slice(20, 32),
    ].join("-");
}

/**
 * Live executor backed by the T-Invest order pipeline.
 *
 * Translates strategy buy/sell/close signals into real (or dry-run) orders via
 * {@link OrderManager}, tracks intended position via {@link StateManager}, and
 * serialises order execution. This is the live counterpart of the simulated
 * executor — same surface the engine and strategy use.
 */
export class TinkoffExecutor {
    constructor({ client, instrument, interval = 1, options = {} }) {
        this.client = client;
        this.instrument = instrument;
        this.options = options;
        this.verbose = Boolean(options.verbose);
        this.dryRun = Boolean(options.dryRun);
        // Short label embedded in every order's idempotency key (see buildOrderId).
        this.orderTag = options.orderTag || "div";

        // Stale-entry guard: refuse to OPEN a position on a candle that is far
        // older than wall-clock — the tell-tale of a back-filled candle replayed
        // after a stream outage. The real market order would fill at the current
        // (reconnect) price, nowhere near the modeled candle close, silently
        // wiping out the trade's edge. Exits are unaffected: an already-open
        // position must still be closed when its SL/TP is hit, even on a stale
        // candle. A freshly completed candle is ~1 interval old when processed,
        // so the default leaves comfortable margin for normal network jitter.
        const intervalMs = (Number(interval) || 1) * 60 * 1000;
        this.maxEntryAgeMs = Number.isFinite(options.maxEntryAgeMs)
            ? options.maxEntryAgeMs
            : intervalMs * 2 + 30_000;

        this.orderManager = new OrderManager(client, {
            verbose: this.verbose,
            dryRun: this.dryRun,
        });
        this.stateManager = new StateManager({ verbose: this.verbose });

        // Software SL/TP persistence (sandbox has no exchange stop orders), so the
        // levels survive the watchdog/systemd restarts and aren't lost when the
        // position is re-synced from the account.
        const accountId = client?.accountId || "acc";
        const stateFile = options.stateFile
            || join(process.cwd(), ".diviner-state", `${accountId}_${instrument.ticker}.json`);
        this.store = new PositionStore(stateFile, { verbose: this.verbose });

        // Intrabar SL/TP: when on, the engine routes stop checks through
        // checkStops() (high/low of the live candle) instead of the close-only
        // evaluateStops path. A touch closes the position at market immediately.
        this.intrabarStops = Boolean(options.intrabarStops);

        // Margin leverage: default order size = 95% of cash × leverage. With
        // leverage>1 we send confirmMarginTrade=true so the broker accepts the
        // resulting uncovered (margin) position; requires a margin-enabled
        // account. At 1× behaviour is unchanged (covered sizing, flag off).
        this.leverage = Number.isFinite(Number(options.leverage)) && Number(options.leverage) > 0
            ? Number(options.leverage)
            : 1;
        this.confirmMarginTrade = this.leverage > 1;

        this.accountRubBalance = 0;
        this.currentCandle = null;
        this.orderQueue = Promise.resolve();
        this.sessionTrades = [];
    }

    /**
     * Prime balance and reconcile state with the actual broker position.
     */
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

    /**
     * Intrabar SL/TP check for live (engine hook, used only when intrabarStops
     * is on). Evaluates the current candle's high/low against the open
     * position's SL/TP — for a short, SL on `high`, TP on `low` — and closes at
     * market the moment a level is touched, rather than waiting for the close.
     * Called by the engine each tick; with a forming-candle subscription the
     * candle's running high/low update continuously, so the exit fires as soon
     * as the level is breached. SL wins a same-bar double touch (evaluateIntrabarStop).
     * @param {object} candle - Current (possibly still-forming) candle.
     * @returns {object|null} Closed position or null.
     */
    checkStops(candle) {
        const position = this.getPosition();
        if (!position || !candle) {
            return null;
        }
        const reason = evaluateIntrabarStop(position, candle);
        if (!reason) {
            return null;
        }
        const level = reason === "sl" ? position.sl : position.tp;
        const label = reason === "sl" ? "Stop Loss" : "Take Profit";
        const extreme = (position.side === "short")
            ? (reason === "sl" ? candle.high : candle.low)
            : (reason === "sl" ? candle.low : candle.high);
        console.log(
            `[TinkoffExecutor] ${label} touched intrabar: ${position.side} `
            + `level=${level} (candle ${reason === "sl" ? "high" : "low"}=${extreme}) `
            + `— closing at market`,
        );
        return this.closePosition();
    }

    getBalance() {
        return this.accountRubBalance;
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
     * Open a position and enqueue the corresponding broker order.
     * @private
     */
    _open(side, size, sl, tp) {
        if (this.stateManager.hasPosition()) {
            if (this.verbose) {
                console.log(`[TinkoffExecutor] ${side.toUpperCase()} skipped: position already open`);
            }
            return null;
        }

        // Warm-up candle replayed during catch-up (all but the freshest): it
        // updates strategy state but must not trade — its close is already stale.
        if (this.currentCandle?.noTrade) {
            if (this.verbose) {
                console.log(`[TinkoffExecutor] ${side.toUpperCase()} skipped: warm-up (back-filled) candle, decision deferred to the freshest candle`);
            }
            return null;
        }

        // Backstop: drop entries triggered on a candle that is stale by wall-clock
        // even if it slipped past the warm-up marker — the real order would fill at
        // the reconnect price, not the modeled candle close.
        const candleTime = this.currentCandle?.datetime instanceof Date
            ? this.currentCandle.datetime.getTime()
            : null;
        if (candleTime !== null) {
            const ageMs = Date.now() - candleTime;
            if (ageMs > this.maxEntryAgeMs) {
                console.warn(
                    `[TinkoffExecutor] ${side.toUpperCase()} skipped: candle is `
                    + `${Math.round(ageMs / 1000)}s old (> ${Math.round(this.maxEntryAgeMs / 1000)}s) — `
                    + `likely back-filled after a stream outage. Entry would fill far from the `
                    + `modeled price ${this.currentCandle?.close}, so the trade is dropped.`,
                );
                return null;
            }
        }

        const actualSize = size || this._defaultOrderLots(this.currentCandle?.close);
        if (!Number.isFinite(actualSize) || actualSize <= 0) {
            if (this.verbose) {
                console.log(`[TinkoffExecutor] ${side.toUpperCase()} skipped: invalid size`);
            }
            return null;
        }

        this.stateManager.openPosition({
            side,
            size: actualSize,
            entryPrice: this.currentCandle?.close,
            entryTime: this.currentCandle?.datetime,
            sl,
            tp,
        });
        // Persist SL/TP so a restart re-attaches them to the re-synced position.
        this.store.save({
            figi: this.instrument.figi,
            ticker: this.instrument.ticker,
            side,
            size: actualSize,
            entryPrice: this.currentCandle?.close ?? null,
            sl: sl ?? null,
            tp: tp ?? null,
        });
        this._enqueue(() => this._executeOrder(side === "long" ? "buy" : "sell", actualSize));
        return this.stateManager.getPosition();
    }

    closePosition() {
        if (!this.stateManager.hasPosition()) {
            if (this.verbose) {
                console.log("[TinkoffExecutor] CLOSE skipped: no position open");
            }
            return null;
        }
        const closed = this.stateManager.closePosition();
        this.store.clear();
        this._enqueue(() => this._closeRealPosition(closed));
        return closed;
    }

    /**
     * Wait for all enqueued orders to settle.
     */
    async drainOrders() {
        await this.orderQueue;
    }

    /**
     * Reconcile intended state with the actual broker position at start.
     */
    async syncWithAccountPosition() {
        if (this.dryRun) {
            return;
        }

        const lotSize = Number(this.instrument?.lot) || 1;
        const position = await this.client.getInstrumentPosition(this.instrument.figi, lotSize);

        if (!position) {
            this.stateManager.reset();
            this.store.clear();   // account is flat → drop any stale persisted SL/TP
            console.log(`[TinkoffExecutor] Account position for ${this.instrument.ticker}: none (flat).`);
            return;
        }

        // Restore SL/TP persisted at open, if it matches the live account position.
        const saved   = this.store.load();
        const matched = saved
            && saved.figi === this.instrument.figi
            && saved.side === position.side;

        this.stateManager.setPosition({
            side: position.side,
            size: position.lots,
            entryPrice: (matched && saved.entryPrice) || position.averagePrice || position.currentPrice || 0,
            entryTime: new Date(),
            sl: matched ? (saved.sl ?? null) : null,
            tp: matched ? (saved.tp ?? null) : null,
            source: "account",
        });
        console.warn(
            `[TinkoffExecutor] Existing account position detected: ${position.side} ${position.quantity} of ${this.instrument.ticker} (~${position.lots} lots). State synced.`,
        );
        if (matched) {
            console.warn(`[TinkoffExecutor] SL/TP restored from state file: sl=${saved.sl} tp=${saved.tp}`);
        } else {
            console.warn(`[TinkoffExecutor] No matching persisted SL/TP — position UNPROTECTED until the strategy re-sets levels.`);
        }
    }

    /**
     * Refresh RUB balance used for order sizing.
     */
    async refreshBalance() {
        if (!this.client?.getRubBalance) {
            return this.accountRubBalance;
        }
        this.accountRubBalance = await this.client.getRubBalance(this.client.accountId);
        console.log(`[TinkoffExecutor] Account RUB balance: ${this.accountRubBalance.toFixed(2)}`);
        return this.accountRubBalance;
    }

    /**
     * Default order size in lots from available cash, scaled by leverage.
     * Mirrors the backtest Portfolio: notional = 95% of cash × leverage,
     * floored to whole lots. At leverage 1 this is the original 1× sizing.
     * @private
     */
    _defaultOrderLots(price) {
        if (!Number.isFinite(price) || price <= 0) {
            return 0;
        }
        const lotSize = Number(this.instrument?.lot) || 1;
        return Math.floor((this.accountRubBalance * 0.95 * this.leverage) / (price * lotSize));
    }

    /**
     * Serialise order operations.
     * @private
     */
    _enqueue(operation) {
        this.orderQueue = this.orderQueue
            .then(operation)
            .catch((error) => {
                console.error("[TinkoffExecutor] Order queue failed:", error.message);
            });
        return this.orderQueue;
    }

    /**
     * Place a real open order and reconcile on partial fills.
     * @private
     */
    /**
     * Build the idempotency key for an order from the current candle's time and
     * the configured tag. @private
     */
    _buildOrderId(action, direction) {
        const at = this.currentCandle?.datetime instanceof Date ? this.currentCandle.datetime : new Date();
        return buildOrderId({ tag: this.orderTag, ticker: this.instrument?.ticker, action, direction, at });
    }

    async _executeOrder(direction, size) {
        try {
            const result = await this.orderManager.postMarketOrder({
                figi: this.instrument.figi,
                instrumentId: this.instrument.uid || this.instrument.figi,
                quantity: size,
                direction,
                orderId: this._buildOrderId("open", direction),
                confirmMarginTrade: this.confirmMarginTrade,
            });
            const summary = this.client.getOrderExecutionSummary(result);
            const executedLots = summary.lotsExecuted || size;

            if (executedLots <= 0) {
                throw new Error(`order was not executed (${summary.statusName})`);
            }
            if (executedLots !== size) {
                this.stateManager.updatePositionSize(executedLots);
            }
            this.sessionTrades.push({ kind: "open", direction, lots: executedLots, at: new Date() });
            console.log(`[TinkoffExecutor] Order executed: ${direction} ${executedLots}/${size} lots of ${this.instrument.ticker} (${summary.statusName})`);
            await this.refreshBalance();
        } catch (error) {
            console.error(`[TinkoffExecutor] Failed to execute ${direction} order:`, error.message);
            this.stateManager.reset();
        }
    }

    /**
     * Place a real close order and reconcile on partial fills.
     * @private
     */
    async _closeRealPosition(position) {
        if (!position) {
            return;
        }
        try {
            const result = await this.orderManager.closePosition({
                figi: this.instrument.figi,
                instrumentId: this.instrument.uid || this.instrument.figi,
                quantity: position.size,
                currentSide: position.side,
                orderId: this._buildOrderId("close", position.side === "long" ? "sell" : "buy"),
            });
            const summary = this.client.getOrderExecutionSummary(result);
            const executedLots = summary.lotsExecuted || position.size;

            if (executedLots <= 0) {
                this.stateManager.setPosition(position);
                throw new Error(`close order was not executed (${summary.statusName})`);
            }
            if (executedLots < position.size) {
                this.stateManager.setPosition({ ...position, size: position.size - executedLots });
            }
            this.sessionTrades.push({ kind: "close", side: position.side, lots: executedLots, at: new Date() });
            console.log(`[TinkoffExecutor] Close order executed: ${position.side} ${executedLots}/${position.size} lots of ${this.instrument.ticker} (${summary.statusName})`);
        } catch (error) {
            console.error("[TinkoffExecutor] Failed to close position:", error.message);
            if (!this.stateManager.hasPosition()) {
                this.stateManager.setPosition(position);
            }
            return;
        }

        try {
            await this.refreshBalance();
        } catch (error) {
            console.error("[TinkoffExecutor] Failed to refresh balance after close:", error.message);
        }
    }
}

/**
 * Assemble a live broker: { data, exec } over the T-Invest API.
 * @param {object} params - { client, instrument, interval, options }.
 * @returns {{ data: TinkoffDataSource, exec: TinkoffExecutor, instrumentMetadata: object }} Broker.
 */
export function createTinkoffBroker({ client, instrument, interval = 1, options = {} }) {
    const data = new TinkoffDataSource({
        client,
        instrument,
        interval,
        verbose: options.verbose,
        stallTimeoutMin: options.stallTimeoutMin,
    });
    const exec = new TinkoffExecutor({ client, instrument, interval, options });

    return {
        data,
        exec,
        instrumentMetadata: buildInstrumentMetadata(instrument),
        /**
         * Wind down the live session: optionally close the open position (only
         * with --close-on-exit), stop the stream/subscription, print a short
         * summary, and close the client. Called by the engine once the stream
         * ends (e.g. after requestStop on SIGINT).
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
            console.log(`[Session] Trades this session: ${opens} open / ${closes} close. Final RUB balance: ${exec.getBalance().toFixed(2)}.`);
            console.log(`[Session] Open position at exit: ${pos ? `${pos.side} ${pos.size} lots` : "none"}.`);

            await client.close();
        },
    };
}
