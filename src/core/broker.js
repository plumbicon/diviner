/**
 * Base broker interface used by execution adapters.
 */
export class Broker {
    openPosition() {
        throw new Error("Broker.openPosition() must be implemented");
    }

    closePosition() {
        throw new Error("Broker.closePosition() must be implemented");
    }

    getPosition() {
        return null;
    }

    getCash() {
        return 0;
    }

    syncStrategyState(strategy) {
        strategy._position = this.getPosition();
        strategy.cash = this.getCash();
    }
}

/**
 * Broker implementation backed by a simulated Portfolio.
 */
export class BacktestBroker extends Broker {
    constructor({ portfolio }) {
        super();
        this.portfolio = portfolio;
    }

    /**
     * Open a simulated position.
     * @param {object} params - Position parameters.
     * @returns {object|null} Opened position or null.
     */
    openPosition({ side, candle, size = null, sl = null, tp = null }) {
        if (side === "long") {
            return this.portfolio.openLong({ candle, size, sl, tp });
        }
        if (side === "short") {
            return this.portfolio.openShort({ candle, size, sl, tp });
        }
        throw new Error(`Unsupported position side: ${side}`);
    }

    /**
     * Close the simulated position.
     * @param {object} params - Close parameters.
     * @returns {object|null} Closed trade or null.
     */
    closePosition({ candle }) {
        return this.portfolio.closePosition({ candle });
    }

    getPosition() {
        return this.portfolio.position;
    }

    getCash() {
        return this.portfolio.cash;
    }
}

/**
 * Broker implementation backed by live state and order callbacks.
 */
export class LiveBroker extends Broker {
    constructor({
        stateManager,
        logger = null,
        getDefaultOrderSize,
        enqueueOpenOrder,
        enqueueCloseOrder,
    }) {
        super();
        this.stateManager = stateManager;
        this.logger = logger;
        this.getDefaultOrderSize = getDefaultOrderSize;
        this.enqueueOpenOrder = enqueueOpenOrder;
        this.enqueueCloseOrder = enqueueCloseOrder;
    }

    /**
     * Open a live position and enqueue the corresponding broker order.
     * @param {object} params - Position parameters.
     * @returns {object|null} Opened position or null.
     */
    openPosition({ side, candle, size = null, sl = null, tp = null }) {
        if (this.stateManager.hasPosition()) {
            this.logger?.log?.(`[LiveEngine] ${side.toUpperCase()} skipped: position already open`);
            return null;
        }

        const actualSize = size || this.getDefaultOrderSize(candle.close);
        if (!Number.isFinite(actualSize) || actualSize <= 0) {
            this.logger?.log?.(`[LiveEngine] ${side.toUpperCase()} skipped: invalid size`);
            return null;
        }

        this.stateManager.openPosition({
            side,
            size: actualSize,
            entryPrice: candle.close,
            entryTime: candle.datetime,
            sl,
            tp,
        });
        this.enqueueOpenOrder(side === "long" ? "buy" : "sell", actualSize);

        return this.stateManager.getPosition();
    }

    /**
     * Close the live position and enqueue the corresponding broker order.
     * @returns {object|null} Closed position or null.
     */
    closePosition() {
        if (!this.stateManager.hasPosition()) {
            this.logger?.log?.("[LiveEngine] CLOSE skipped: no position open");
            return null;
        }

        const closedPosition = this.stateManager.closePosition();
        this.enqueueCloseOrder(closedPosition);
        return closedPosition;
    }

    getPosition() {
        return this.stateManager.getPosition();
    }

    syncStrategyState(strategy) {
        this.stateManager.syncWithStrategy(strategy);
    }
}
