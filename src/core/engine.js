import { BacktestRunner } from "./runner.js";

/**
 * Backwards-compatible facade for the old Engine API.
 *
 * New code should use BacktestRunner directly.
 */
export class Engine {
    constructor(data, StrategyClass, cash = 10000, commission = 0.0001) {
        this.runner = new BacktestRunner({
            data,
            StrategyClass,
            initialCash: cash,
            commission,
        });
    }

    /**
     * Run a backtest.
     * @param {object|null} context - Strategy execution context.
     * @returns {Promise<object>} Backtest report.
     */
    async run(context = null) {
        this.runner.context = context;
        return this.runner.run();
    }
}
