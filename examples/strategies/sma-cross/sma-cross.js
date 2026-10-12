/**
 * Example single-ticker strategy: a moving average crossover.
 *
 * Long when the fast average crosses the slow one from below; exit on the opposite cross
 * or by the protective stop. The engine checks the stop; the strategy only declares its
 * level at entry.
 *
 * Parameters are environment variables (that is how every strategy is parameterized: the
 * CLI gives a strategy only its history and the starting capital):
 *   SMA_FAST      — fast average length, candles (20);
 *   SMA_SLOW      — slow average length, candles (60);
 *   SMA_STOP_PCT  — protective stop, % of the entry price (1).
 *
 * Run:
 *   node examples/make-data.mjs --out work/examples/demo.parquet --tickers DEMO
 *   node src/diviner.js src/broker/simulated/broker.js work/examples/demo.parquet \
 *     --strategy examples/strategies/sma-cross/sma-cross.js --balance 10000
 */
import { Strategy } from "../../../src/core/strategy.js";

const FAST = Number(process.env.SMA_FAST ?? 20);
const SLOW = Number(process.env.SMA_SLOW ?? 60);
const STOP_PCT = Number(process.env.SMA_STOP_PCT ?? 1);

/**
 * Average close over `length` candles ending at candle `end` inclusive.
 * @param {{at: (i: number) => object}} data - History.
 * @param {number} end - Index of the last candle.
 * @param {number} length - Window length.
 * @returns {number} Average.
 */
function sma(data, end, length) {
    let sum = 0;
    for (let i = end - length + 1; i <= end; i += 1) sum += data.at(i).close;
    return sum / length;
}

export class SmaCross extends Strategy {
    init() {}

    next() {
        // In a backtest this.data is the whole listing at once. Only read up to the current
        // index: everything beyond it is the future.
        const i = this.getDataIndex();
        if (i < SLOW) return;

        const above = sma(this.data, i, FAST) > sma(this.data, i, SLOW);
        const wasAbove = sma(this.data, i - 1, FAST) > sma(this.data, i - 1, SLOW);
        const close = this.data.at(i).close;

        if (!this.position && above && !wasAbove) {
            this.buy({ sl: close * (1 - STOP_PCT / 100) });
        } else if (this.position && !above && wasAbove) {
            this.closePosition();
        }
    }
}
