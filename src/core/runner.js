import { BacktestExecutionAdapter, attachExecutionAdapter } from "./execution-adapter.js";
import { PerformanceMetrics } from "./metrics.js";
import { Portfolio } from "./portfolio.js";

/**
 * Sequential backtest runner.
 */
export class BacktestRunner {
    constructor({
        data,
        StrategyClass,
        initialCash = 10000,
        commission = 0.0005,
        context = null,
    }) {
        this.data = data;
        this.StrategyClass = StrategyClass;
        this.initialCash = initialCash;
        this.commission = commission;
        this.context = context;
        this.equity = [];
        this.portfolio = new Portfolio({ cash: initialCash, commission });
    }

    /**
     * Run the strategy on all candles and return the report.
     * @returns {Promise<object>} Backtest result.
     */
    async run() {
        const strategy = new this.StrategyClass(
            this.data,
            this.initialCash,
            this.commission,
        );
        const execution = new BacktestExecutionAdapter({
            strategy,
            portfolio: this.portfolio,
        });

        attachExecutionAdapter(strategy, execution);
        if (this.context && typeof strategy.setContext === "function") {
            strategy.setContext(this.context);
        }

        await strategy.init();

        for (let i = 0; i < this.data.length; i += 1) {
            this.setCurrentIndex(strategy, i);

            strategy.checkStopLossTakeProfit();
            await strategy.next();
            execution.syncStrategyState();

            this.equity.push(this.portfolio.calculateEquity(this.data[i]));
        }

        if (this.portfolio.position) {
            this.setCurrentIndex(strategy, this.data.length - 1);
            execution.closePosition();
            this.equity[this.equity.length - 1] = this.portfolio.calculateEquity(
                this.data[this.data.length - 1],
            );
        }

        const metrics = new PerformanceMetrics({
            data: this.data,
            equity: this.equity,
            trades: this.portfolio.trades,
            initialCash: this.initialCash,
        });

        return {
            backtest_parameters: {
                history_file: "",
                strategy_file: "",
            },
            performance_metrics: metrics.compile(),
            trade_log: this.portfolio.trades,
        };
    }

    setCurrentIndex(strategy, index) {
        if (this.context && typeof this.context.setDataIndex === "function") {
            this.context.setDataIndex(index);
        }
        strategy.setDataIndex(index);
    }
}
