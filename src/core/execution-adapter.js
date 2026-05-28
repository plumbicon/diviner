import { BacktestBroker, LiveBroker } from "./broker.js";

/**
 * Attach an execution adapter to a strategy while keeping the legacy strategy
 * API (`buy`, `sell`, `closePosition`) available.
 * @param {object} strategy - Strategy instance.
 * @param {ExecutionAdapter} adapter - Execution adapter.
 */
export function attachExecutionAdapter(strategy, adapter) {
    strategy.execution = adapter;
    strategy.buy = (size, sl, tp) => adapter.buy(size, sl, tp);
    strategy.sell = (size, sl, tp) => adapter.sell(size, sl, tp);
    strategy.closePosition = () => adapter.closePosition();
}

/**
 * Execution adapter translating strategy signals into broker actions.
 */
export class ExecutionAdapter {
    constructor({ strategy, broker, getCurrentCandle }) {
        this.strategy = strategy;
        this.broker = broker;
        this.getCurrentCandle = getCurrentCandle;
    }

    buy(size, sl, tp) {
        return this.open("long", size, sl, tp);
    }

    sell(size, sl, tp) {
        return this.open("short", size, sl, tp);
    }

    closePosition() {
        const result = this.broker.closePosition({
            candle: this.getCurrentCandle(),
        });
        this.syncStrategyState();
        return result;
    }

    open(side, size, sl, tp) {
        const result = this.broker.openPosition({
            side,
            candle: this.getCurrentCandle(),
            size,
            sl,
            tp,
        });
        this.syncStrategyState();
        return result;
    }

    syncStrategyState() {
        this.broker.syncStrategyState(this.strategy);
    }
}

/**
 * Backtest execution adapter backed by a simulated Portfolio.
 */
export class BacktestExecutionAdapter extends ExecutionAdapter {
    constructor({ strategy, portfolio }) {
        super({
            strategy,
            broker: new BacktestBroker({ portfolio }),
            getCurrentCandle: () => strategy.data[strategy.getDataIndex()],
        });
        this.portfolio = portfolio;
    }
}

/**
 * Live execution adapter backed by the broker-facing order pipeline.
 */
export class LiveExecutionAdapter extends ExecutionAdapter {
    constructor({
        strategy,
        stateManager,
        logger,
        getCurrentCandle,
        getDefaultOrderSize,
        enqueueOpenOrder,
        enqueueCloseOrder,
    }) {
        super({
            strategy,
            broker: new LiveBroker({
                stateManager,
                logger,
                getDefaultOrderSize,
                enqueueOpenOrder,
                enqueueCloseOrder,
            }),
            getCurrentCandle,
        });
        this.stateManager = stateManager;
    }
}
