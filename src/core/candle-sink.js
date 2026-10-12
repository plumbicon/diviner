/**
 * Stream sink for a multi-ticker run.
 *
 * The engine appends every incoming candle to `strategy.data` — for a single-ticker
 * strategy that is its history. A universe has tens of millions of candles, and keeping
 * them as objects brings back exactly the problem columnar storage was made for. A
 * cross-sectional strategy reads history through `context.getCandles({ ticker })` and gets
 * the current candle as the `next()` argument, so there is no reason to accumulate the
 * stream.
 *
 * The sink remembers only the last candle and counts the length (the engine compares it
 * with the tick index). Accessing an earlier candle does not silently return `undefined`
 * but throws with a hint: silently wrong history is worse than an explicit error.
 */
export class StreamingCandleSink {
    constructor() {
        this.length = 0;
        this.last = null;
    }

    /**
     * Accept the tick's candle.
     * @param {object} candle - Candle.
     * @returns {number} New length.
     */
    push(candle) {
        this.last = candle;
        this.length += 1;
        return this.length;
    }

    /**
     * Candle by index — only the current one is available.
     * @param {number} index - Index; a negative one counts from the end.
     * @returns {object|null} Current candle.
     */
    at(index) {
        const i = index < 0 ? this.length + index : index;
        if (i === this.length - 1) return this.last;
        throw new Error(
            `Multi-symbol run keeps no candle history in strategy.data (asked for #${index}, `
            + `current #${this.length - 1}). Use context.getCandles({ ticker, from, to }).`,
        );
    }
}
