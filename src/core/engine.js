import { evaluateStops } from "./stops.js";

/**
 * Unified, режим-слепой engine.
 *
 * It owns the tick loop and time, orchestrates SL/TP centrally, and drives the
 * strategy. It talks to a broker only through { data, exec, finalize } — it does
 * not know money, mode, or why the stream stopped.
 */
export class Engine {
    /**
     * Drive a strategy against a broker until its candle stream ends.
     *
     * The stream ending is the universal stop signal — for backtest it exhausts
     * the listing, for live the broker's requestStop() makes it end. Once the
     * stream is done the engine calls broker.finalize() (backtest → report;
     * live → teardown + summary).
     *
     * Optional executor hooks are called only if present, keeping the engine
     * mode-blind: exec.init() (live: refresh balance + sync account position)
     * and exec.drainOrders() (live: await serialised order execution).
     *
     * @param {object} params - Run parameters.
     * @param {object} params.broker - { data, exec, finalize? }.
     * @param {object} params.strategy - Strategy instance.
     * @param {object} params.context - Temporal view passed to the strategy.
     * @param {object} [params.options] - { verbose }.
     * @returns {Promise<*>} Whatever broker.finalize() returns (report or nothing).
     */
    async run({ broker, strategy, context, options = {} }) {
        strategy.execution = broker.exec;
        strategy.verbose = Boolean(options.verbose);
        if (context) {
            strategy.setContext(context);
        }

        if (typeof broker.exec.init === "function") {
            await broker.exec.init();
        }
        await strategy.init();

        let index = -1;
        for await (const candle of broker.data.stream()) {
            index += 1;
            // Ensure the current candle is visible to the strategy at this index.
            // Backtest pre-loads the whole listing; live grows it candle by candle.
            if (strategy.data.length <= index) {
                strategy.data.push(candle);
            }

            if (context) {
                context.setNow(candle.datetime);
            }
            strategy.setDataIndex(index);
            broker.exec.setCurrentCandle(candle);

            // Backtest exposes checkStops() for intrabar (high/low) SL/TP that
            // fills at the stop level. Live has no future high/low, so it falls
            // back to the shared close-based evaluation on the latest tick.
            if (typeof broker.exec.checkStops === "function") {
                broker.exec.checkStops(candle);
            } else if (evaluateStops(broker.exec.getPosition(), candle.close)) {
                broker.exec.closePosition();
            }

            await strategy.next();
            broker.exec.syncStrategyState(strategy);

            if (typeof broker.exec.drainOrders === "function") {
                await broker.exec.drainOrders();
            }
        }

        return broker.finalize ? broker.finalize() : undefined;
    }
}
