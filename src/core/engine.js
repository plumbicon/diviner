import { evaluateStops } from "./stops.js";
import { PerformanceMetrics } from "./metrics.js";

/**
 * Unified, режим-слепой engine.
 *
 * It owns the tick loop and time, orchestrates SL/TP centrally, and drives the
 * strategy. It talks to a broker only through { data, exec } and to the
 * strategy's view of time through a temporal view — it does not know whether it
 * runs against a simulated or a live broker.
 */
export class Engine {
    /**
     * Run a backtest over a fully-loaded listing.
     * @param {object} params - Run parameters.
     * @param {Array<object>} params.data - Loaded candles.
     * @param {object} params.strategy - Strategy instance.
     * @param {object} params.broker - { exec, portfolio } simulated broker.
     * @param {object} params.context - Temporal view passed to the strategy.
     * @param {number} params.initialCash - Initial cash for metrics.
     * @param {object} [params.meta] - { historyFile, strategyFile } for the report.
     * @returns {Promise<object>} Backtest report.
     */
    async runBacktest({ data, strategy, broker, context, initialCash, meta = {} }) {
        strategy.execution = broker.exec;
        if (context) {
            strategy.setContext(context);
        }

        await strategy.init();

        const equity = [];
        for (let i = 0; i < data.length; i += 1) {
            const candle = data[i];

            if (context) {
                context.setNow(candle.datetime);
            }
            strategy.setDataIndex(i);
            broker.exec.setCurrentCandle(candle);

            // Centralised SL/TP orchestration (was split between Strategy and StateManager).
            if (evaluateStops(broker.exec.getPosition(), candle.close)) {
                broker.exec.closePosition();
            }

            await strategy.next();
            broker.exec.syncStrategyState(strategy);

            equity.push(broker.portfolio.calculateEquity(candle));
        }

        // Close any position still open at the end on the last candle.
        if (broker.exec.getPosition()) {
            const last = data[data.length - 1];
            broker.exec.setCurrentCandle(last);
            broker.exec.closePosition();
            equity[equity.length - 1] = broker.portfolio.calculateEquity(last);
        }

        const metrics = new PerformanceMetrics({
            data,
            equity,
            trades: broker.portfolio.trades,
            initialCash,
        }).compile();

        return {
            backtest_parameters: {
                history_file: meta.historyFile || "",
                strategy_file: meta.strategyFile || "",
            },
            performance_metrics: metrics,
            trade_log: broker.portfolio.trades,
        };
    }
}
