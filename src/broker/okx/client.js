import ccxt from "ccxt";

/**
 * Thin wrapper around the ccxt OKX exchange (REST + ccxt.pro WebSocket) for
 * perpetual swap trading. This is the OKX counterpart of tinkoff/client.js, but
 * much smaller — ccxt already unifies request signing, rate limiting, and
 * WebSocket reconnect, so this layer only adapts ccxt to the shapes the broker
 * needs: a pull-style candle stream, paginated history, normalized positions,
 * and an order call with retry on transient errors.
 *
 * One client = one OKX account (the apiKey/secret/password triple). Sub-account
 * isolation is achieved by pointing each process at a different credential set
 * (see --key-prefix in okx-broker.js).
 */
export class OkxClient {
    /**
     * @param {object} creds - { apiKey, secret, password }.
     * @param {object} [options] - { demo, verbose, marginMode, orderRetries, orderRetryDelayMs }.
     */
    constructor({ apiKey, secret, password } = {}, options = {}) {
        this.verbose = Boolean(options.verbose);
        this.marginMode = options.marginMode || "cross";
        this.orderRetries = Number.isFinite(options.orderRetries) ? options.orderRetries : 2;
        this.orderRetryDelayMs = Number.isFinite(options.orderRetryDelayMs) ? options.orderRetryDelayMs : 1000;

        this.exchange = new ccxt.pro.okx({
            apiKey: apiKey || undefined,
            secret: secret || undefined,
            password: password || undefined,
            enableRateLimit: true,
            // Default ccxt timeout (10s) is tight for loadMarkets (it fans out over
            // several instrument-type endpoints) on slower links; 30s is safer.
            timeout: Number(options.timeoutMs) || 30000,
            options: { defaultType: "swap" },
        });
        if (options.demo) {
            // OKX demo trading: routes REST + WS to the demo environment. Requires
            // API keys created in the demo environment (live keys won't work here).
            this.exchange.setSandboxMode(true);
        }

        this.market = null;
        this._closed = false;
    }

    /**
     * Load markets and resolve the swap market for `symbol`.
     * @param {string} symbol - Unified ccxt symbol (e.g. "BTC/USDT:USDT").
     * @returns {Promise<object>} The resolved ccxt market.
     */
    async init(symbol) {
        // loadMarkets fans out over several endpoints and can fail transiently on
        // a slow/flaky link; retry with backoff before giving up.
        for (let attempt = 0; ; attempt += 1) {
            try {
                await this.exchange.loadMarkets();
                break;
            } catch (error) {
                if (attempt >= this.orderRetries || !this._isRetryable(error)) {
                    throw error;
                }
                const delay = this.orderRetryDelayMs * 2 ** attempt;
                console.warn(`[OkxClient] loadMarkets attempt ${attempt + 1} failed (${error?.message || error}); retrying in ${delay}ms.`);
                await this._sleep(delay);
            }
        }
        this.market = this.exchange.market(symbol);
        if (!this.market) {
            throw new Error(`OKX market not found for symbol '${symbol}'`);
        }
        if (this.market.type !== "swap") {
            throw new Error(
                `Symbol '${symbol}' is a ${this.market.type} market, not a perpetual swap. `
                + `Use a swap symbol like "BTC/USDT:USDT".`,
            );
        }
        return this.market;
    }

    /**
     * Contract size (units of base currency per contract) for the resolved market.
     * @returns {number} Contract size (defaults to 1 when unknown).
     */
    get contractSize() {
        return Number(this.market?.contractSize) || 1;
    }

    /**
     * Minimum order size in contracts for the resolved market.
     * @returns {number} Minimum amount (defaults to 0 when unknown).
     */
    get minAmount() {
        return Number(this.market?.limits?.amount?.min) || 0;
    }

    /**
     * Smallest tradeable increment expressed in base currency: the contract
     * amount step (precision.amount, in contracts on OKX's tick-size mode) times
     * contractSize. e.g. BTC swap: 0.01 contracts * 0.01 BTC = 0.0001 BTC. This is
     * the realistic backtest "lot" — crypto is not whole-unit quantised, so the
     * simulated Portfolio should size in fractional base-coin steps, not whole
     * coins.
     * @returns {number} Base-currency step (defaults to contractSize).
     */
    get baseStep() {
        const amountStep = Number(this.market?.precision?.amount) || 1;
        return amountStep * this.contractSize;
    }

    /**
     * Round an order amount (in contracts) down to the market's amount precision.
     * @param {number} amount - Desired amount in contracts.
     * @returns {number} Amount rounded to precision.
     */
    roundAmount(amount) {
        if (!Number.isFinite(amount) || amount <= 0) {
            return 0;
        }
        return Number(this.exchange.amountToPrecision(this.market.symbol, amount));
    }

    /**
     * Ensure the account is in one-way (net) position mode for this symbol.
     * The engine models a single net position, so hedge mode is unsupported.
     * Best-effort: if switching fails because positions are open, throws a clear
     * error telling the user to flatten and switch manually.
     */
    async ensureOneWayMode() {
        try {
            await this.exchange.setPositionMode(false, this.market.symbol);
            if (this.verbose) {
                console.log("[OkxClient] Position mode set to one-way (net).");
            }
        } catch (error) {
            const msg = error?.message || String(error);
            // OKX returns an error if there are open positions/orders, or if the
            // mode is already set. "already" cases are harmless; surface the rest.
            if (/already|not.*chang|no need/i.test(msg)) {
                return;
            }
            throw new Error(
                `Could not switch OKX account to one-way (net) position mode: ${msg}. `
                + `Close all positions/orders and set one-way mode manually, then restart.`,
            );
        }
    }

    /**
     * Set leverage for the symbol (no-op-safe at leverage 1).
     * @param {number} leverage - Desired leverage.
     */
    async setLeverage(leverage) {
        const lev = Number(leverage) || 1;
        try {
            await this.exchange.setLeverage(lev, this.market.symbol, { marginMode: this.marginMode });
            if (this.verbose) {
                console.log(`[OkxClient] Leverage set to ${lev}x (${this.marginMode}).`);
            }
        } catch (error) {
            // Some accounts reject redundant leverage sets; don't abort the session.
            console.warn(`[OkxClient] setLeverage(${lev}) warning: ${error?.message || error}`);
        }
    }

    /**
     * Stream completed candles as a pull-style async generator.
     *
     * ccxt.pro's watchOHLCV returns the rolling OHLCV cache, whose last element is
     * the still-forming candle. We emit only candles that have a newer candle
     * after them (i.e. are closed), de-duplicated by timestamp — the equivalent of
     * Tinkoff's waitingClose:true. The historical backlog from the first batch is
     * skipped (strategy warm-up comes from getHistory); only candles that close
     * after the stream starts are delivered. ccxt reconnects the socket
     * internally; on a thrown error we back off and retry unless stopped.
     *
     * @param {string} symbol - Unified symbol.
     * @param {string} timeframe - ccxt timeframe (e.g. "1m").
     * @returns {AsyncGenerator<object>} Normalized closed candles.
     */
    async *streamCandles(symbol, timeframe) {
        // A candle is "closed" once a candle with a newer open-time appears. We
        // detect that by the timestamp of the most recent (forming) candle
        // advancing — NOT by the cache array growing. ccxt's OKX OHLCV cache keeps
        // only the latest candle (length stays 1, replaced in place), so a
        // length-based rule would never fire. Tracking the timestamp transition
        // works whether the cache replaces or appends.
        let lastEmittedTs = null;
        let lastFormingTs = null;
        let lastFormingCandle = null;
        let primed = false;
        let backoff = this.orderRetryDelayMs;

        const emit = (row) => {
            const candle = normalizeOhlcv(row);
            if (this.verbose) {
                console.log(`[Live] candle ${candle.datetime.toISOString()} close=${candle.close}`);
            }
            return candle;
        };

        while (!this._closed) {
            let batch;
            try {
                batch = await this.exchange.watchOHLCV(symbol, timeframe);
                backoff = this.orderRetryDelayMs; // reset after a good read
            } catch (error) {
                if (this._closed) {
                    break;
                }
                console.warn(`[OkxClient] watchOHLCV error: ${error?.message || error}. Retrying in ${backoff}ms.`);
                await this._sleep(backoff);
                backoff = Math.min(backoff * 2, 30000);
                continue;
            }

            if (!Array.isArray(batch) || batch.length === 0) {
                continue;
            }

            const forming = batch[batch.length - 1];
            const formingTs = forming[0];

            if (!primed) {
                // Anchor so the backlog is not replayed: emit only from the candle
                // currently forming at connect onward (it is emitted once it
                // closes). If the cache happens to carry closed candles, anchor at
                // the most recent so future closes flow forward.
                lastEmittedTs = batch.length > 1 ? batch[batch.length - 2][0] : formingTs - 1;
                lastFormingTs = formingTs;
                lastFormingCandle = forming;
                primed = true;
                continue;
            }

            // Append-style caches: any element before the forming one is closed.
            for (let i = 0; i < batch.length - 1; i += 1) {
                const ts = batch[i][0];
                if (ts > lastEmittedTs) {
                    lastEmittedTs = ts;
                    yield emit(batch[i]);
                }
            }

            // Replace-style caches: the forming timestamp advanced, so the candle
            // that was forming has now closed — emit its last-seen state.
            if (formingTs > lastFormingTs && lastFormingTs > lastEmittedTs) {
                lastEmittedTs = lastFormingTs;
                yield emit(lastFormingCandle);
            }

            lastFormingTs = formingTs;
            lastFormingCandle = forming;
        }
    }

    /**
     * Fetch historical candles in [since, until), paginating fetchOHLCV.
     * @param {object} params - Request.
     * @param {string} params.symbol - Unified symbol.
     * @param {string} params.timeframe - ccxt timeframe.
     * @param {number} params.since - Start timestamp (ms, inclusive).
     * @param {number} [params.until] - End timestamp (ms, exclusive; default now).
     * @param {number} [params.limit] - Candles per call.
     * @param {number} [params.requestDelayMs] - Delay between calls.
     * @returns {Promise<Array<object>>} Normalized candles ascending by time.
     */
    async fetchHistory({ symbol, timeframe, since, until = Date.now(), limit = 300, requestDelayMs = 200 }) {
        const byTime = new Map();
        let cursor = Number(since);
        const intervalMs = this.exchange.parseTimeframe(timeframe) * 1000;

        while (cursor < until) {
            let batch;
            let fetchErr;
            for (let attempt = 0; attempt <= this.orderRetries; attempt++) {
                try {
                    batch = await this.exchange.fetchOHLCV(symbol, timeframe, cursor, limit);
                    fetchErr = null;
                    break;
                } catch (error) {
                    fetchErr = error;
                    if (!this._isRetryable(error) || attempt >= this.orderRetries) break;
                    const delay = this.orderRetryDelayMs * 2 ** attempt;
                    console.warn(`[OkxClient] fetchOHLCV at ${new Date(cursor).toISOString()} attempt ${attempt + 1} failed (${error?.message || error}); retrying in ${delay}ms.`);
                    await this._sleep(delay);
                }
            }
            if (fetchErr) {
                throw new Error(`OKX fetchOHLCV failed at ${new Date(cursor).toISOString()}: ${fetchErr?.message || fetchErr}`);
            }
            if (!Array.isArray(batch) || batch.length === 0) {
                break;
            }

            let maxTs = cursor;
            for (const row of batch) {
                const ts = row[0];
                if (ts >= until) {
                    continue;
                }
                byTime.set(ts, normalizeOhlcv(row));
                if (ts > maxTs) {
                    maxTs = ts;
                }
            }

            // Advance past the newest candle returned; stop if no forward progress.
            const next = maxTs + intervalMs;
            if (next <= cursor) {
                break;
            }
            cursor = next;

            if (batch.length < limit) {
                // Reached the head of available data.
                if (cursor < until && requestDelayMs > 0) {
                    await this._sleep(requestDelayMs);
                }
                if (batch[batch.length - 1][0] + intervalMs >= until) {
                    break;
                }
            } else if (cursor < until && requestDelayMs > 0) {
                await this._sleep(requestDelayMs);
            }
        }

        return [...byTime.values()].sort((a, b) => a.datetime.getTime() - b.datetime.getTime());
    }

    /**
     * Place a market order with retry on transient errors.
     * @param {object} params - { symbol, side, amount, reduceOnly, clientOrderId }.
     * @returns {Promise<object>} ccxt order structure.
     */
    async createMarketOrder({ symbol, side, amount, reduceOnly = false, clientOrderId }) {
        const params = {};
        if (reduceOnly) {
            params.reduceOnly = true;
        }
        if (clientOrderId) {
            params.clientOrderId = clientOrderId;
        }

        for (let attempt = 0; attempt <= this.orderRetries; attempt += 1) {
            try {
                return await this.exchange.createOrder(symbol, "market", side, amount, undefined, params);
            } catch (error) {
                const last = attempt >= this.orderRetries;
                if (last || !this._isRetryable(error)) {
                    throw error;
                }
                const delay = this.orderRetryDelayMs * 2 ** attempt;
                console.warn(`[OkxClient] order ${side} attempt ${attempt + 1} failed (${error?.message || error}); retrying in ${delay}ms.`);
                await this._sleep(delay);
            }
        }
        // Unreachable, but keeps the type checker happy.
        throw new Error("order placement exhausted retries");
    }

    /**
     * Whether a ccxt error is a transient one worth retrying.
     * @param {Error} error - ccxt error.
     * @returns {boolean} True if retryable.
     * @private
     */
    _isRetryable(error) {
        return (
            error instanceof ccxt.NetworkError
            || error instanceof ccxt.ExchangeNotAvailable
            || error instanceof ccxt.RequestTimeout
            || error instanceof ccxt.DDoSProtection
            || error instanceof ccxt.RateLimitExceeded
        );
    }

    /**
     * Fetch the current net position for the symbol, normalized.
     * @param {string} symbol - Unified symbol.
     * @returns {Promise<{side: string, size: number, entryPrice: number}|null>} Position or null.
     */
    async fetchPosition(symbol) {
        let raw;
        try {
            raw = await this.exchange.fetchPosition(symbol);
        } catch (error) {
            // Fall back to fetchPositions on exchanges/versions that lack fetchPosition.
            const list = await this.exchange.fetchPositions([symbol]);
            raw = Array.isArray(list) ? list.find((p) => p.symbol === symbol) : null;
            if (!raw && this.verbose) {
                console.warn(`[OkxClient] fetchPosition fallback note: ${error?.message || error}`);
            }
        }

        const contracts = Number(raw?.contracts);
        if (!raw || !Number.isFinite(contracts) || contracts === 0) {
            return null;
        }
        return {
            side: raw.side === "short" ? "short" : "long",
            size: Math.abs(contracts),
            entryPrice: Number(raw.entryPrice) || 0,
        };
    }

    /**
     * Account trading level (OKX acctLv): 1 = Spot only, 2 = Spot and futures
     * (single-currency margin), 3 = multi-currency margin, 4 = portfolio margin.
     * Perpetual swaps require acctLv >= 2.
     * @returns {Promise<number|null>} Account level, or null if unavailable.
     */
    async fetchAccountMode() {
        try {
            const res = await this.exchange.privateGetAccountConfig();
            const acctLv = res?.data?.[0]?.acctLv;
            return acctLv != null ? Number(acctLv) : null;
        } catch (error) {
            if (this.verbose) {
                console.warn(`[OkxClient] fetchAccountMode note: ${error?.message || error}`);
            }
            return null;
        }
    }

    /**
     * Throw a clear error if the account cannot trade perpetual swaps because it
     * is in Spot-only mode. Fails fast at startup instead of after the first
     * candle triggers a rejected order (OKX sCode 51010).
     */
    async ensureFuturesAccountMode() {
        const acctLv = await this.fetchAccountMode();
        if (acctLv !== null && acctLv < 2) {
            throw new Error(
                "OKX account is in Spot-only mode (acctLv=1) and cannot trade perpetual swaps. "
                + "Switch the account mode to 'Spot and futures' (single-currency margin) or higher in "
                + "OKX settings (demo: Assets/Account -> Account mode), then restart.",
            );
        }
        if (this.verbose) {
            console.log(`[OkxClient] Account mode OK (acctLv=${acctLv ?? "unknown"}).`);
        }
    }

    /**
     * Free USDT balance available for sizing.
     * @returns {Promise<number>} Free USDT.
     */
    async fetchBalance() {
        const balance = await this.exchange.fetchBalance();
        const usdt = balance?.USDT?.free ?? balance?.free?.USDT ?? 0;
        return Number(usdt) || 0;
    }

    /**
     * Drop the current WebSocket connection without ending the stream, so the
     * streamCandles loop re-subscribes on its next iteration. Used by the data
     * source's stall watchdog to recover from a silently-frozen socket (one that
     * stops delivering candles without raising an error).
     */
    async reconnectSocket() {
        try {
            await this.exchange.close();
        } catch {
            // best-effort; the watch loop will re-establish the connection
        }
    }

    /**
     * Tear down WebSocket connections permanently (ends streamCandles).
     */
    async close() {
        this._closed = true;
        try {
            await this.exchange.close();
        } catch {
            // best-effort
        }
    }

    /**
     * @param {number} ms - Milliseconds.
     * @returns {Promise<void>} Resolves after ms.
     * @private
     */
    _sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}

/**
 * Normalize a ccxt OHLCV row [ts, open, high, low, close, volume] into the
 * broker's candle shape.
 * @param {Array<number>} row - ccxt OHLCV row.
 * @returns {object} Normalized candle.
 */
export function normalizeOhlcv(row) {
    return {
        datetime: new Date(row[0]),
        open: Number(row[1]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4]),
        volume: Number(row[5] || 0),
        isComplete: true,
    };
}
