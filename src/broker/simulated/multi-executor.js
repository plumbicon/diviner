import { evaluateIntrabarStop, classifyStopExit } from "../../core/stops.js";

/**
 * Executor for multi-ticker backtests: one cash pool, several simultaneous positions in
 * different instruments.
 *
 * The engine keeps its single-position contract — on purpose. It processes one candle
 * per tick, and a candle has a ticker, so `getPosition()`/`closePosition()`/`checkStops()`
 * answer about the position of **the instrument whose candle is being processed**. That
 * way the engine's SL/TP and timeout checks work over a multi-position portfolio without
 * a single change in `core/engine.js`.
 *
 * How many instruments to hold and how to split the deposit is **not its business**.
 * That is the strategy's decision: it looks at the equity (`getEquity`), its open
 * positions and pending orders, and passes an amount (`budget`) or a ready size (`size`)
 * with the order. The executor handles the mechanics: convert the amount into lots at
 * the fill price, check the cash, keep positions and stops.
 *
 * Positions are kept per instrument: an account holds one net position per instrument —
 * an exchange constraint — so a second order for a busy instrument is rejected.
 *
 * Fills happen at the open of the next candle of THE SAME instrument (`fillOnNextOpen`).
 * Stops execute intrabar at the level, bypassing the buffer: an exchange stop triggers on
 * touch, not at the open of the next bar.
 *
 * Market orders (entries and every exit except an intrabar stop) can pay `slippage` — a
 * share of the price against the order: a sale fills lower, a purchase higher. Live the
 * market order crosses the spread and walks the book; the candle open does not. Stops are
 * left at the level: live they filled no worse than it.
 *
 * Entries can instead be limit orders at the decision price (the close of the decision
 * candle), alive for `entryLimitTtl` minutes. A limit pays no slippage. Filling is judged
 * by the instrument's candles after the decision: at the open when the open is already at
 * or better than the limit; otherwise at the limit — on the first candle only when the
 * candle closes at or past it (live the order is placed seconds into that minute, and its
 * high may have come before), on later candles when the range goes strictly past it (a mere
 * touch may leave a resting order unfilled). An order not filled in time is cancelled, or
 * with `entryLimitFallback: "market"` becomes a market order at the next open.
 * `entryLimitStrict` is the pessimistic bound: on the first candle the order fills only at
 * the limit and only when the candle closes at or past it — never at the first open, which
 * live is gone by the time the order is placed.
 */
export class MultiSymbolExecutor {
    /**
     * @param {object} params - Parameters.
     * @param {import("../../core/multi-portfolio.js").MultiPortfolio} params.portfolio - Portfolio.
     * @param {boolean} [params.fillOnNextOpen] - Fill at the next candle's open.
     * @param {boolean} [params.intrabarStops] - Intrabar SL/TP.
     * @param {Map<string, object>} [params.instruments] - Ticker → instrument (lot).
     * @param {number} [params.slippage] - Market order slippage, share of the price (0.001 = 0.1%).
     * @param {number} [params.entryLimitTtl] - Entry limit lifetime, minutes; 0 = market entries.
     * @param {string} [params.entryLimitFallback] - "cancel" or "market" when the limit expires.
     * @param {boolean} [params.entryLimitStrict] - No fill at the first candle's open.
     */
    constructor({
        portfolio, fillOnNextOpen = false, intrabarStops = false, instruments = null, slippage = 0,
        entryLimitTtl = 0, entryLimitFallback = "cancel", entryLimitStrict = false,
    }) {
        this.portfolio = portfolio;
        this.fillOnNextOpen = fillOnNextOpen;
        this.intrabarStops = intrabarStops;
        this.slippage = Number(slippage) || 0;
        this.entryLimitTtl = Math.max(0, Number(entryLimitTtl) || 0);
        if (!["cancel", "market"].includes(entryLimitFallback)) {
            throw new Error(`entryLimitFallback must be "cancel" or "market", got "${entryLimitFallback}"`);
        }
        this.entryLimitFallback = entryLimitFallback;
        this.entryLimitStrict = Boolean(entryLimitStrict);
        this.instruments = instruments instanceof Map ? instruments : new Map();

        this.currentCandle = null;
        this.currentTicker = null;
        /** Last seen candle of each instrument — for marking to market and the final close. */
        this.lastCandle = new Map();
        /** Ticker → pending order { type, budget, size, sl, tp, exitDeadline, reason }. */
        this._pending = new Map();

        /** Equity points and their times — one per minute (end of batch). */
        this.equity = [];
        this.timeline = [];
    }

    // ── engine contract ─────────────────────────────────────────────────────

    /**
     * Candle of the tick. Fills the instrument's pending order at its open.
     * @param {object} candle - Candle with a ticker.
     */
    setCurrentCandle(candle) {
        this.currentCandle = candle;
        this.currentTicker = candle?.ticker ?? null;
        if (candle) this.lastCandle.set(this.currentTicker, candle);

        if (!this.fillOnNextOpen || !candle) return;
        const pending = this._pending.get(this.currentTicker);
        if (!pending) return;
        if (pending.limit != null) this._tryLimit(pending, candle);
        else this._settle(pending, candle.open, candle.datetime);
    }

    /** Position of the instrument whose candle is being processed. @returns {object|null} Position. */
    getPosition() {
        return this.currentTicker ? this.portfolio.positionOf(this.currentTicker) : null;
    }

    /** Free cash. @returns {number} Cash. */
    getBalance() {
        return this.portfolio.cash;
    }

    /**
     * Intrabar SL/TP for the current instrument: closes exactly at the level, bypassing
     * the pending order buffer.
     * @param {object} candle - Current candle.
     * @returns {object|null} Trade.
     */
    checkStops(candle) {
        const position = this.portfolio.positionOf(candle?.ticker);
        if (!position) return null;
        const reason = evaluateIntrabarStop(position, candle);
        if (!reason) return null;

        this._pending.delete(candle.ticker);
        return this.portfolio.close(candle.ticker, {
            price: reason === "sl" ? position.sl : position.tp,
            datetime: candle.datetime,
            // Same label as live: the protective stop and the trailing stop are distinct events.
            reason: reason === "sl" ? classifyStopExit(position) : reason,
        });
    }

    /**
     * Close the position of the current instrument (or an explicitly given one).
     * @param {string} [reason] - Exit reason.
     * @param {string} [ticker] - Instrument; the current one by default.
     * @returns {object|null} Trade when closed immediately.
     */
    closePosition(reason = "manual", ticker = this.currentTicker) {
        if (!this.portfolio.positionOf(ticker)) return null;

        if (this.fillOnNextOpen) {
            // One buffer per instrument: a repeated exit signal in the same tick (say, a
            // stop and the schedule at once) must not queue a second order.
            if (!this._pending.has(ticker)) {
                this._pending.set(ticker, { type: "close", ticker, reason });
            }
            return null;
        }
        return this._marketClose(ticker, this.lastCandle.get(ticker)?.close, this.currentCandle?.datetime, reason);
    }

    /**
     * Close the position immediately at the instrument's last trade price (the close of its
     * last candle), dropping a pending close order. Needed for a same-day exit when there
     * will be no more candles of the instrument today: otherwise the order would wait for the
     * next candle's open — overnight, or after two months without trading.
     * @param {string} [reason] - Exit reason.
     * @param {string} [ticker] - Instrument; the current one by default.
     * @param {Date|null} [datetime] - Exit time; the time of the instrument's last candle by default.
     * @returns {object|null} Trade.
     */
    closeAtLast(reason = "manual", ticker = this.currentTicker, datetime = null) {
        const position = this.portfolio.positionOf(ticker);
        if (!position) return null;
        if (this._pending.get(ticker)?.type === "close") this._pending.delete(ticker);
        const candle = this.lastCandle.get(ticker);
        return this._marketClose(
            ticker, candle?.close ?? position.entryPrice,
            datetime ?? candle?.datetime ?? this.currentCandle?.datetime, reason,
        );
    }

    /**
     * State to the strategy. The equity mark at the end of a minute is taken here too: with
     * several open positions it uses the prices of all held instruments at once, so there is
     * one point per minute, not per candle.
     * @param {object} strategy - Strategy.
     */
    syncStrategyState(strategy) {
        strategy._position = this.getPosition();
        strategy.cash = this.portfolio.cash;
        if (this.currentCandle?.isBatchEnd) {
            this.equity.push(this.getEquity());
            this.timeline.push(this.currentCandle.datetime);
        }
    }

    // ── strategy contract ───────────────────────────────────────────────────

    /**
     * Open a short in an instrument. The strategy sets the amount (`budget`) or the size
     * (`size`) — splitting the deposit between instruments is its decision.
     * @param {object} order - { ticker, budget, size, sl, tp, exitDeadline }.
     * @returns {boolean} Whether the order was accepted.
     */
    sell(order = {}) {
        return this._queueOpen("short", order);
    }

    /**
     * Open a long in an instrument.
     * @param {object} order - { ticker, budget, size, sl, tp, exitDeadline }.
     * @returns {boolean} Whether the order was accepted.
     */
    buy(order = {}) {
        return this._queueOpen("long", order);
    }

    /** Open positions. @returns {Array<object>} Positions. */
    getPositions() {
        return [...this.portfolio.positions.values()];
    }

    /**
     * Position of an instrument.
     * @param {string} ticker - Ticker.
     * @returns {object|null} Position.
     */
    getPositionOf(ticker) {
        return this.portfolio.positionOf(ticker);
    }

    /**
     * Instruments with pending orders. The strategy needs this to count its occupied slots:
     * the order is placed, but there is no position yet.
     * @returns {Array<string>} Tickers.
     */
    getPendingTickers() {
        return [...this._pending.keys()];
    }

    /** Whether the instrument has a position or a pending order. @returns {boolean} Busy. */
    isBusy(ticker) {
        return Boolean(this.portfolio.positionOf(ticker)) || this._pending.has(ticker);
    }

    /**
     * Whether the instrument is blocked by an exchange rejection. The simulation has no
     * rejections, but the method must exist: the strategy calls it unconditionally, and a
     * silent `undefined` from an optional call would disable the safeguard live.
     * @returns {boolean} Always false.
     */
    isBlocked() {
        return false;
    }

    /** Equity at the last known prices of held instruments. @returns {number} Equity. */
    getEquity() {
        return this.portfolio.equity(
            (ticker) => this.lastCandle.get(ticker)?.close ?? null,
        );
    }

    // ── internals ───────────────────────────────────────────────────────────

    /** @private */
    _queueOpen(side, {
        ticker = this.currentTicker, size = null, budget = null,
        sl = null, tp = null, exitDeadline = null,
    } = {}) {
        if (!ticker || this.isBusy(ticker)) return false;

        const order = { type: `open-${side}`, ticker, size, budget, sl, tp, exitDeadline };
        if (this.fillOnNextOpen) {
            const decision = this.lastCandle.get(ticker);
            if (this.entryLimitTtl > 0 && Number.isFinite(decision?.close)) {
                order.limit = decision.close;
                order.decisionTs = decision.datetime.getTime();
                order.expiresTs = order.decisionTs + this.entryLimitTtl * 60_000;
            }
            this._pending.set(ticker, order);
            return true;
        }
        const candle = this.lastCandle.get(ticker);
        this._settle(order, candle?.close, candle?.datetime);
        return true;
    }

    /**
     * One candle of a resting entry limit: fill, keep waiting, expire.
     * @param {object} order - Pending entry with `limit`, `decisionTs`, `expiresTs`.
     * @param {object} candle - The instrument's candle after the decision.
     * @private
     */
    _tryLimit(order, candle) {
        const sell = order.type === "open-short";
        const limit = order.limit;
        const ts = candle.datetime.getTime();
        const first = ts - order.decisionTs <= 60_000;
        const better = (price) => (sell ? price >= limit : price <= limit);
        const through = (price) => (sell ? price > limit : price < limit);
        let price = null;
        if (better(candle.open) && !(first && this.entryLimitStrict)) price = candle.open;
        else if (first ? better(candle.close) : through(sell ? candle.high : candle.low)) price = limit;
        if (price !== null) {
            this._settle(order, price, candle.datetime, false);
            return;
        }
        if (ts < order.expiresTs) return;
        if (this.entryLimitFallback === "market") {
            delete order.limit;                          // the next candle fills it at its open
            return;
        }
        this._pending.delete(order.ticker);
        this.limitsCancelled = (this.limitsCancelled ?? 0) + 1;
    }

    /** @private */
    _settle(order, price, datetime, slip = true) {
        this._pending.delete(order.ticker);
        if (!Number.isFinite(price)) return;

        if (order.type === "close") {
            this._marketClose(order.ticker, price, datetime, order.reason);
            return;
        }
        const side = order.type === "open-long" ? "long" : "short";
        this.portfolio.open(order.ticker, {
            side,
            price: slip ? this._slip(price, side === "long" ? "buy" : "sell") : price,
            datetime,
            lot: Number(this.instruments.get(order.ticker)?.lot) || 1,
            size: order.size,
            budget: order.budget,
            sl: order.sl, tp: order.tp, exitDeadline: order.exitDeadline,
        });
    }

    /**
     * Close a position with a market order: at the price minus slippage against the order.
     * @private
     */
    _marketClose(ticker, price, datetime, reason) {
        const position = this.portfolio.positionOf(ticker);
        if (!position) return null;
        const action = position.side === "short" ? "buy" : "sell";
        return this.portfolio.close(ticker, { price: this._slip(price, action), datetime, reason });
    }

    /**
     * Market order fill price: a purchase pays more, a sale gets less.
     * @param {number} price - Reference price (candle open or close).
     * @param {"buy"|"sell"} action - Order direction.
     * @returns {number} Fill price.
     * @private
     */
    _slip(price, action) {
        if (!this.slippage || !Number.isFinite(price)) return price;
        return action === "buy" ? price * (1 + this.slippage) : price * (1 - this.slippage);
    }

    /**
     * End of data: fill whatever is pending and close the rest at the last prices. There is
     * nowhere further to go — no next candle will come.
     */
    flush() {
        for (const order of [...this._pending.values()]) {
            if (order.limit != null) {                   // an unfilled limit just lapses
                this._pending.delete(order.ticker);
                continue;
            }
            const candle = this.lastCandle.get(order.ticker);
            this._settle(order, candle?.close, candle?.datetime);
        }
        for (const position of this.getPositions()) {
            const candle = this.lastCandle.get(position.ticker);
            this._marketClose(
                position.ticker, candle?.close ?? position.entryPrice,
                candle?.datetime ?? position.entryTime, "eod",
            );
        }
        if (this.equity.length > 0) this.equity[this.equity.length - 1] = this.getEquity();
    }
}
