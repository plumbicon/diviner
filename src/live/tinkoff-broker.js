import {
    TinkoffMarketDataProvider,
    buildInstrumentMetadata,
} from "../core/market-data.js";
import { OrderManager } from "./order-manager.js";
import { StateManager } from "./state-manager.js";

/**
 * Live data source backed by the T-Invest API.
 *
 * Turns the push-style candle subscription into a pull async-iterator the
 * engine can drive, and owns all the live "messiness" (stale-candle dedup,
 * reconnect catch-up) so neither the engine nor strategies see it. History and
 * trading schedule are answered by {@link TinkoffMarketDataProvider}.
 */
export class TinkoffDataSource {
    constructor({ client, instrument, interval = 1, verbose = false }) {
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
        this._queue.push(candle);
        if (this._notify) {
            const notify = this._notify;
            this._notify = null;
            notify();
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
            for (const candle of closed) {
                this._enqueue(candle);
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
     * Stop the stream and cancel the underlying candle subscription.
     * @returns {Promise<void>} Resolves once the subscription is torn down.
     */
    async close() {
        this._closed = true;
        if (this._notify) {
            const notify = this._notify;
            this._notify = null;
            notify();
        }
        if (typeof this.client?.unsubscribeCandles === "function") {
            try {
                await this.client.unsubscribeCandles();
            } catch (error) {
                console.error("[TinkoffDataSource] Failed to unsubscribe candles:", error.message);
            }
        }
    }
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
    constructor({ client, instrument, options = {} }) {
        this.client = client;
        this.instrument = instrument;
        this.options = options;
        this.verbose = Boolean(options.verbose);
        this.dryRun = Boolean(options.dryRun);

        this.orderManager = new OrderManager(client, {
            verbose: this.verbose,
            dryRun: this.dryRun,
        });
        this.stateManager = new StateManager({ verbose: this.verbose });

        this.accountRubBalance = 0;
        this.currentCandle = null;
        this.orderQueue = Promise.resolve();
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
            if (this.verbose) {
                console.log(`[TinkoffExecutor] Account position for ${this.instrument.ticker}: none`);
            }
            return;
        }

        this.stateManager.setPosition({
            side: position.side,
            size: position.lots,
            entryPrice: position.averagePrice || position.currentPrice || 0,
            entryTime: new Date(),
            sl: null,
            tp: null,
            source: "account",
        });
        console.warn(
            `[TinkoffExecutor] Existing account position detected: ${position.side} ${position.quantity} of ${this.instrument.ticker} (~${position.lots} lots). State synced.`,
        );
    }

    /**
     * Refresh RUB balance used for order sizing.
     */
    async refreshBalance() {
        if (!this.client?.getRubBalance) {
            return this.accountRubBalance;
        }
        this.accountRubBalance = await this.client.getRubBalance(this.client.accountId);
        if (this.verbose) {
            console.log(`[TinkoffExecutor] Account RUB balance: ${this.accountRubBalance.toFixed(2)}`);
        }
        return this.accountRubBalance;
    }

    /**
     * Default order size in lots from available cash.
     * @private
     */
    _defaultOrderLots(price) {
        if (!Number.isFinite(price) || price <= 0) {
            return 0;
        }
        const lotSize = Number(this.instrument?.lot) || 1;
        return Math.floor((this.accountRubBalance * 0.95) / (price * lotSize));
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
    async _executeOrder(direction, size) {
        try {
            const result = await this.orderManager.postMarketOrder({
                figi: this.instrument.figi,
                instrumentId: this.instrument.uid || this.instrument.figi,
                quantity: size,
                direction,
            });
            const summary = this.client.getOrderExecutionSummary(result);
            const executedLots = summary.lotsExecuted || size;

            if (executedLots <= 0) {
                throw new Error(`order was not executed (${summary.statusName})`);
            }
            if (executedLots !== size) {
                this.stateManager.updatePositionSize(executedLots);
            }
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
    return {
        data: new TinkoffDataSource({ client, instrument, interval, verbose: options.verbose }),
        exec: new TinkoffExecutor({ client, instrument, options }),
        instrumentMetadata: buildInstrumentMetadata(instrument),
    };
}
