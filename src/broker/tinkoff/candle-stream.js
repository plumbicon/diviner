/**
 * Live candle subscription over the T-Invest market data stream, with everything
 * needed to keep it alive: reconnect with back-off, catch-up of missed candles, and
 * watchdogs for a stream that dies without an error.
 *
 * A connection can die silently, with neither data nor an error: on 2026-10-08 the
 * stream hung for 40 minutes before an ECONNRESET, and re-subscriptions into it hung
 * for another 7 hours. The defences, from the transport up:
 *   - gRPC keepalive on the channel (set up by the client) drops a half-open TCP
 *     connection, which surfaces here as an ordinary stream error;
 *   - any stream message (candle, broker ping, subscription status) counts as a sign
 *     of life; a stream silent for longer than `streamSilenceMs` is abandoned;
 *   - every subscription is time-boxed: the library awaits the subscription status
 *     with no timeout and does not reject that wait when the stream closes.
 */
import { MarketStream } from "tinkoff-invest-api/dist/stream/market.js";
import { SubscriptionInterval } from "tinkoff-invest-api/dist/generated/marketdata.js";
import { toNumber, withTimeout } from "./api-utils.js";

const SUBSCRIPTION_INTERVALS = {
    1: SubscriptionInterval.SUBSCRIPTION_INTERVAL_ONE_MINUTE,
    5: SubscriptionInterval.SUBSCRIPTION_INTERVAL_FIVE_MINUTES,
    15: SubscriptionInterval.SUBSCRIPTION_INTERVAL_FIFTEEN_MINUTES,
    60: SubscriptionInterval.SUBSCRIPTION_INTERVAL_HOUR,
    120: SubscriptionInterval.SUBSCRIPTION_INTERVAL_TWO_HOURS,
    240: SubscriptionInterval.SUBSCRIPTION_INTERVAL_FOUR_HOURS,
    1440: SubscriptionInterval.SUBSCRIPTION_INTERVAL_DAY,
};

/**
 * Candle of the market data stream in the engine's shape.
 * @param {object} candle - Stream message candle (or a message wrapping it).
 * @returns {object} Candle with figi/instrumentUid, numbers instead of Quotations.
 */
export function formatCandle(candle) {
    const c = candle.candle || candle;
    return {
        // Identifiers tell the instruments of one shared stream apart.
        figi: c.figi || null,
        instrumentUid: c.instrumentUid || null,
        datetime: new Date(c.time),
        open: toNumber(c.open),
        high: toNumber(c.high),
        low: toNumber(c.low),
        close: toNumber(c.close),
        volume: parseInt(c.volume, 10) || 0,
        isComplete: c.isComplete ?? false,
    };
}

export class CandleStream {
    /**
     * @param {object} api - TinkoffInvestApi instance (its `stream.market` is used).
     * @param {object} [options] - Timeouts and delays, see the field comments.
     */
    constructor(api, options = {}) {
        this.api = api;
        this.verbose = Boolean(options.verbose);
        // Factory for a fresh market stream: an abandoned stream is replaced by a new instance.
        this.createMarketStream = options.createMarketStream || ((target) => new MarketStream(target));

        this.subscription = null;
        this.unsubscribeCurrent = null;
        this.errorHandler = null;
        this.closeHandler = null;
        this.dataHandler = null;

        this.reconnectTimer = null;
        this.reconnectAttempts = 0;
        this.reconnectDelayMs = options.streamReconnectDelayMs || 1000;
        this.reconnectMaxDelayMs = options.streamReconnectMaxDelayMs || 60000;
        this.isClosing = false;
        this.isReplacingStream = false;
        // Held for the whole asynchronous reconnect. The timer is cleared at the start of
        // its callback, so on its own it does not say "a reconnect is running" — without
        // this flag the health check sees "stream down, no reconnect" and starts a second
        // reconnect on top of the first.
        this.isReconnecting = false;

        this.unsubscribeTimeoutMs = options.unsubscribeTimeoutMs || 5000;
        // The library awaits the subscription status with no timeout: on a silent
        // connection the subscription never completes and would hold isReconnecting forever.
        this.subscribeTimeoutMs = options.subscribeTimeoutMs || 30000;
        // The broker pings the stream every ~60 s (120 s per the docs) when nothing else
        // is sent. No candle and no ping for longer than this — the stream is dead, even
        // if the socket looks alive.
        this.silenceMs = options.streamSilenceMs || 300000;
        this.lastMessageAt = 0;

        // Health-check timer, held while a subscription exists. Node exits as soon as the
        // event loop has nothing left to do, so a stream that dies while every pending
        // promise is unsettled would end the process with status 0 — a silent death that
        // looks like a clean shutdown. This ref keeps the bot alive so the reconnect path
        // (or the operator) can act on it.
        this.healthTimer = null;
    }

    /**
     * Subscribe to candles of one instrument or a whole universe.
     *
     * The gRPC subscription takes a list of instruments, so the universe lives in one
     * stream: a connection per instrument is unnecessary and would hit the limit of
     * subscription requests (100/min). Each candle gets a `ticker` resolved from
     * figi/uid — otherwise instruments of the shared stream are indistinguishable.
     *
     * @param {object|Array<object>} instrumentOrList - Instrument or list.
     * @param {number} interval - Candle interval, minutes.
     * @param {Function} onCandle - Candle handler.
     * @param {object} [options] - { waitingClose, onReconnectCatchUp }.
     */
    async subscribe(instrumentOrList, interval, onCandle, options = {}) {
        const instruments = Array.isArray(instrumentOrList) ? instrumentOrList : [instrumentOrList];
        if (instruments.length === 0) {
            throw new Error("subscribeCandles requires at least one instrument");
        }

        // Both figi and uid lead to the ticker: the broker tags a candle with whichever
        // identifier it was requested by, and they differ between API versions.
        const tickerByKey = new Map();
        for (const item of instruments) {
            if (item.figi) tickerByKey.set(item.figi, item.ticker);
            if (item.uid) tickerByKey.set(item.uid, item.ticker);
            if (item.instrumentUid) tickerByKey.set(item.instrumentUid, item.ticker);
        }

        this.subscription = {
            instruments,
            tickerByKey,
            interval,
            candleInterval: SUBSCRIPTION_INTERVALS[interval] || SubscriptionInterval.SUBSCRIPTION_INTERVAL_ONE_MINUTE,
            waitingClose: options.waitingClose ?? true,
            onCandle,
            onReconnectCatchUp: options.onReconnectCatchUp || null,
        };
        this.isClosing = false;
        this.reconnectAttempts = 0;
        this._attachHandlers();
        this._startHealthCheck();

        await this._subscribeCandles();
    }

    /**
     * Recreate the market stream from scratch: drop the current call and subscribe again.
     *
     * For the external silence watchdog. A stream that is alive for the library but
     * delivers nothing cannot be fixed by an ordinary re-subscription — it would go into
     * the same call. On failure an ordinary back-off reconnect is scheduled and the error
     * is rethrown.
     * @param {string} reason - Reason, for the log.
     */
    async restart(reason) {
        if (this.isClosing) {
            return;
        }
        if (this.isReconnecting || this.reconnectTimer) {
            throw new Error("reconnect already in progress");
        }
        this.isReconnecting = true;
        let failure = null;
        try {
            this._abandonMarketStream(reason);
            if (this.subscription) {
                await this._subscribeCandles();
            }
            this.reconnectAttempts = 0;
        } catch (error) {
            failure = error;
        } finally {
            this.isReconnecting = false;
        }
        if (failure) {
            this._scheduleReconnect(failure);
            throw failure;
        }
    }

    /**
     * Stop the subscription and any pending reconnect. Idempotent; called by the
     * subscription's owner (the data source) on shutdown.
     */
    async stop() {
        this.isClosing = true;
        this.subscription = null;
        this._stopHealthCheck();

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        await this._unsubscribeCurrent();

        if (this.errorHandler || this.closeHandler || this.dataHandler) {
            this._detachHandlers(this.api.stream.market);
        }

        if (this.api?.streamClients?.market) {
            await this.api.stream.market.cancel();
        }
    }

    /** @private */
    _startHealthCheck() {
        if (this.healthTimer) {
            return;
        }
        this.healthTimer = setInterval(() => this._checkHealth(), 30000);
    }

    /** @private */
    _stopHealthCheck() {
        if (this.healthTimer) {
            clearInterval(this.healthTimer);
            this.healthTimer = null;
        }
    }

    /**
     * One tick of the stream watchdog: a dead stream with no reconnect pending, and a
     * "live" stream silent for longer than `silenceMs` (no candles, no broker pings).
     * @param {number} [now] - Current time, ms (for tests).
     * @private
     */
    _checkHealth(now = Date.now()) {
        if (this.isClosing || this.reconnectTimer || this.isReconnecting) {
            return;
        }
        if (!this.api.stream?.market?.connected) {
            console.error("[TinkoffClient] Market stream is down with no reconnect pending — forcing one.");
            this._scheduleReconnect(new Error("stream down, no reconnect pending"));
            return;
        }
        const silentMs = now - this.lastMessageAt;
        if (silentMs > this.silenceMs) {
            const reason = `stream silent ${Math.round(silentMs / 1000)}s, no candles or broker pings`;
            console.error(`[TinkoffClient] Market ${reason} — abandoning it.`);
            this._abandonMarketStream(reason);
            this._scheduleReconnect(new Error(reason));
        }
    }

    /** @private */
    async _subscribeCandles() {
        if (!this.subscription) {
            throw new Error("Candle subscription is not configured.");
        }
        const { instruments, tickerByKey, interval, candleInterval, waitingClose, onCandle } = this.subscription;

        try {
            await this._unsubscribeCurrent();

            const label = instruments.length === 1 ? instruments[0].ticker : `${instruments.length} instruments`;
            if (this.verbose) {
                console.log(
                    `[TinkoffClient] Subscribing to ${waitingClose ? "closed " : ""}candles for ${label}, interval: ${interval}min`,
                );
            }

            this.unsubscribeCurrent = await this._subscribeWithTimeout("candle", () => this.api.stream.market.candles(
                {
                    instruments: instruments.map((item) => ({
                        figi: item.figi,
                        instrumentId: item.uid || item.figi,
                        interval: candleInterval,
                    })),
                    waitingClose,
                },
                (candle) => {
                    const formatted = formatCandle(candle);
                    formatted.ticker = tickerByKey.get(formatted.instrumentUid)
                        ?? tickerByKey.get(formatted.figi)
                        ?? instruments[0].ticker;
                    if (onCandle) {
                        Promise.resolve(onCandle(formatted)).catch((error) => {
                            console.error("[TinkoffClient] Candle handler error:", error.message);
                        });
                    }
                },
            ));
        } catch (error) {
            throw new Error(`Failed to subscribe to candles: ${error.message}`);
        }
    }

    /** @private */
    _attachHandlers() {
        if (this.errorHandler) {
            return;
        }

        // Disable the library's own auto-reconnect. Its MarketStream.onClose() fires
        // `setTimeout(() => this.reconnect(), …)` on an async method whose promise is
        // never awaited and has no .catch(), so a failed re-subscribe (e.g. the broker
        // answering `status 9` while our old subscription is still registered) becomes
        // an unhandled rejection and kills the process — observed live on 2026-07-27,
        // taking the bot down while holding a short. Ours (_scheduleReconnect) is also
        // the only path that runs the missed-candle catch-up, so racing the library's
        // reconnect could silently skip it even when it did succeed.
        if (this.api.stream?.market?.options) {
            this.api.stream.market.options.autoReconnect = false;
        }

        this.errorHandler = (error) => {
            if (this.isClosing || this.isReplacingStream) {
                return;
            }
            console.error("[TinkoffClient] Stream error:", error.message);
            this._scheduleReconnect(error);
        };

        this.closeHandler = (error) => {
            if (this.isClosing || this.isReplacingStream) {
                return;
            }
            // The 'error' event fires first when there is an error, so a reconnect is
            // already scheduled — skip to avoid double-scheduling.
            if (error) {
                return;
            }
            console.warn("[TinkoffClient] Stream closed unexpectedly (clean close), reconnecting...");
            this._scheduleReconnect(new Error("Stream closed unexpectedly"));
        };

        // Any stream message — candle, broker ping, subscription status — is a sign of
        // life for _checkHealth.
        this.dataHandler = () => {
            this.lastMessageAt = Date.now();
        };
        this.lastMessageAt = Date.now();

        this.api.stream.market.on("error", this.errorHandler);
        this.api.stream.market.on("close", this.closeHandler);
        this.api.stream.market.on("data", this.dataHandler);
    }

    /**
     * Remove our handlers from a market stream.
     * @param {object} market - Library stream instance.
     * @private
     */
    _detachHandlers(market) {
        const handlers = [
            ["error", this.errorHandler],
            ["close", this.closeHandler],
            ["data", this.dataHandler],
        ];
        for (const [event, handler] of handlers) {
            if (!handler) continue;
            if (typeof market.off === "function") {
                market.off(event, handler);
            } else if (typeof market.removeListener === "function") {
                market.removeListener(event, handler);
            }
        }
        this.errorHandler = null;
        this.closeHandler = null;
        this.dataHandler = null;
    }

    /**
     * Drop the current market stream and put a fresh instance in its place.
     *
     * The library considers the connection alive until the gRPC call ends and sends a
     * new subscription into the same call. If that call is silent without an error, a
     * retry hangs the same way. The library cannot abort a call, so the old stream is
     * detached instead: our handlers and the subscriptions' handlers are removed, its
     * requests are closed (cancel is not awaited — on a dead connection it never
     * completes), and the next subscription opens a new call in a new instance.
     * @param {string} reason - Reason, for the log.
     * @private
     */
    _abandonMarketStream(reason) {
        const streams = this.api.streamClients;
        const old = streams?.market;
        if (!old) {
            return;
        }
        console.warn(`[TinkoffClient] Market stream abandoned (${reason}); next subscribe opens a new call.`);
        this._detachHandlers(old);
        // Without an 'error' listener EventEmitter throws if the abandoned call fails later.
        old.on?.("error", () => {});
        old.emitter?.removeAllListeners?.("data");
        Promise.resolve(old.cancel?.()).catch(() => {});
        streams.market = this.createMarketStream(this.api);
        this.unsubscribeCurrent = null;
        this._attachHandlers();
    }

    /**
     * Subscribe in the market stream with a time limit. On timeout the stream is
     * abandoned, so the retry opens a new call instead of going into the same silent one.
     * @param {string} label - Subscription kind, for the log.
     * @param {() => Promise<Function>} subscribe - Library subscription call.
     * @returns {Promise<Function>} Unsubscribe function.
     * @private
     */
    async _subscribeWithTimeout(label, subscribe) {
        let timedOut = false;
        try {
            return await withTimeout(subscribe(), this.subscribeTimeoutMs, () => {
                timedOut = true;
                return `${label} subscribe timed out after ${this.subscribeTimeoutMs}ms`;
            });
        } catch (error) {
            if (timedOut) {
                this._abandonMarketStream(error.message);
            }
            throw error;
        }
    }

    /** @private */
    _scheduleReconnect(error) {
        if (this.isClosing || !this.subscription || this.reconnectTimer || this.isReconnecting) {
            return;
        }

        const delay = Math.min(this.reconnectDelayMs * 2 ** this.reconnectAttempts, this.reconnectMaxDelayMs);
        this.reconnectAttempts += 1;

        console.warn(`[TinkoffClient] Candle stream reconnect in ${delay}ms after error: ${error?.message ?? error}`);

        this.reconnectTimer = setTimeout(async () => {
            this.reconnectTimer = null;
            this.isReconnecting = true;
            let failure = null;

            try {
                await this._runCatchUp(error);
                if (this.subscription) {
                    await this._subscribeCandles();
                }
                this.reconnectAttempts = 0;
                console.log("[TinkoffClient] Market stream reconnected.");
            } catch (reconnectError) {
                failure = reconnectError;
                console.error("[TinkoffClient] Candle stream reconnect failed:", reconnectError.message);
            } finally {
                this.isReconnecting = false;
            }

            // The retry is scheduled only after the flag is cleared: from inside the try
            // block _scheduleReconnect's own guard would drop it.
            if (failure) {
                this._scheduleReconnect(failure);
            }
        }, delay);
    }

    /** @private */
    async _runCatchUp(error) {
        const catchUp = this.subscription?.onReconnectCatchUp;
        if (typeof catchUp !== "function") {
            return;
        }
        try {
            await catchUp({ error });
        } catch (catchUpError) {
            console.error("[TinkoffClient] Candle stream catch-up failed:", catchUpError.message);
        }
    }

    /** @private */
    async _unsubscribeCurrent() {
        if (!this.unsubscribeCurrent) {
            return;
        }
        const unsubscribe = this.unsubscribeCurrent;
        this.unsubscribeCurrent = null;
        this.isReplacingStream = true;
        try {
            await this._unsubscribeSafely(unsubscribe, "candle");
        } finally {
            this.isReplacingStream = false;
        }
    }

    /**
     * Run a library unsubscribe without ever hanging on it.
     *
     * The library's unwatch() awaits a status frame that a closed stream will never
     * send. That promise settles never — and an unsettled promise keeps nothing alive,
     * so the event loop drains and Node exits 0. For a live bot that is worse than a
     * crash: systemd's Restart=always is then the only thing standing between a dropped
     * stream and a silently dead bot (observed on 2026-07-27 — a live bot exited cleanly
     * ~1s after a reconnect was scheduled). Skip the round-trip when the stream is
     * already gone, and cap it otherwise; the reconnect path re-subscribes from scratch
     * either way.
     * @private
     */
    async _unsubscribeSafely(unsubscribe, label) {
        if (!this.api.stream?.market?.connected) {
            return; // stream already down — nothing to unsubscribe from
        }
        try {
            await withTimeout(unsubscribe(), this.unsubscribeTimeoutMs, () => "unsubscribe timed out");
        } catch (error) {
            console.warn(`[TinkoffClient] ${label} unsubscribe skipped: ${error.message}`);
        }
    }
}
