/**
 * Base class of trading strategies.
 */
export class Strategy {
    /**
     * @param {Array|object} data - Candle history (an empty sink in a multi-ticker run).
     * @param {number} [cash] - Starting capital; the executor keeps it updated afterwards.
     */
    constructor(data, cash = 10000) {
        this.data = data;
        this.cash = cash;
        this._position = null;
        this.dataIndex = 0;
        this.context = null;
    }

    /**
     * Set the strategy's execution context.
     * @param {object} context - TemporalView provided by the engine.
     */
    setContext(context) {
        this.context = context;
    }

    /**
     * Initialize the strategy (called once before the run starts).
     */
    init() {
        throw new Error("Method init() must be implemented");
    }

    /**
     * Logic for every bar (called for each candle of the stream).
     */
    next() {
        throw new Error("Method next() must be implemented");
    }

    /**
     * Current position.
     */
    get position() {
        return this._position;
    }

    /**
     * Open a long position (buy). The executor (execution adapter / Portfolio) handles the
     * money; the strategy only declares the signal and its exit conditions.
     *
     * @param {{size?: number, sl?: number, tp?: number, exitDeadline?: number}} [opts]
     *   size — position size (the executor's default sizing when omitted);
     *   sl/tp — stop levels; exitDeadline — absolute close deadline (epoch ms).
     */
    buy(opts = {}) {
        if (!this.execution) {
            throw new Error("Strategy.buy requires an attached execution adapter");
        }
        return this.execution.buy(opts);
    }

    /**
     * Open a short position (sell). See {@link Strategy#buy} for opts.
     */
    sell(opts = {}) {
        if (!this.execution) {
            throw new Error("Strategy.sell requires an attached execution adapter");
        }
        return this.execution.sell(opts);
    }

    /**
     * Close the current position.
     */
    closePosition() {
        if (!this.execution) {
            throw new Error("Strategy.closePosition requires an attached execution adapter");
        }
        return this.execution.closePosition();
    }

    /**
     * Log an important event regardless of verbose.
     */
    logInfo(message) {
        if (this.context && typeof this.context.log === "function") {
            this.context.log(message);
            return;
        }
        process.stderr.write(`${message}\n`);
    }

    /**
     * Set the index of the current candle.
     */
    setDataIndex(index) {
        this.dataIndex = index;
    }

    /**
     * Index of the current candle.
     */
    getDataIndex() {
        return this.dataIndex;
    }
}
