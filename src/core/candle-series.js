/**
 * Columnar candle storage.
 *
 * A candle object costs ~259 bytes of V8 heap (measured on SBER 2025: 374k candles →
 * 92 MB for a 20 MB file), mostly object overhead and a separate Date inside. A universe
 * for a year is ~40M candles, i.e. ~10 GB as objects against a 4.3 GB heap limit — a
 * cross-sectional backtest simply cannot be loaded that way. As columns the same universe
 * takes ~2 GB, and typed arrays live outside the V8 heap and do not count against its limit.
 *
 * The interface deliberately matches a subset of Array: `length`, `at(i)`, `slice(a, b)`,
 * the iterator. A plain candle array already satisfies it, so a consumer does not care
 * what it was given — as long as it uses `at(i)` and not `[i]`. That makes the move
 * gradual: single-ticker listings can stay object arrays while multi-ticker ones are
 * served as columns.
 *
 * Prices are stored as Float64 — exactly the precision of numbers in objects. Float32
 * would halve the size again but could shift an intrabar stop in an edge case, and the
 * regression of per-ticker strategies must match to the last digit.
 */

/** Candle fields stored as separate columns (besides the ticker and the time). @private */
const PRICE_FIELDS = ["open", "high", "low", "close", "volume"];

export class CandleSeries {
    /**
     * @param {object} columns - Columns.
     * @param {Float64Array} columns.ts - Time, epoch ms.
     * @param {Float64Array} columns.open - Open price.
     * @param {Float64Array} columns.high - High.
     * @param {Float64Array} columns.low - Low.
     * @param {Float64Array} columns.close - Close price.
     * @param {Float64Array} columns.volume - Volume.
     * @param {Int32Array|null} [columns.sym] - Ticker index into `symbols`.
     * @param {Array<string>} [columns.symbols] - Ticker table.
     */
    constructor({ ts, open, high, low, close, volume, sym = null, symbols = [] }) {
        this.ts = ts;
        this.open = open;
        this.high = high;
        this.low = low;
        this.close = close;
        this.volume = volume;
        this.sym = sym;
        this.symbols = symbols;
    }

    get length() {
        return this.ts.length;
    }

    /**
     * Candle by index. The object is built on the spot — keeping every candle as an
     * object is exactly the problem this class exists to avoid.
     * @param {number} index - Index; a negative one counts from the end (like Array.at).
     * @returns {object|undefined} Candle.
     */
    at(index) {
        const i = index < 0 ? this.ts.length + index : index;
        if (i < 0 || i >= this.ts.length) return undefined;
        return {
            datetime: new Date(this.ts[i]),
            open: this.open[i],
            high: this.high[i],
            low: this.low[i],
            close: this.close[i],
            volume: this.volume[i],
            ticker: this.sym ? this.symbols[this.sym[i]] : undefined,
        };
    }

    /** Candle time without building an object (for searches and comparisons). */
    tsAt(index) {
        return this.ts[index];
    }

    /** Candle ticker without building an object. */
    tickerAt(index) {
        return this.sym ? this.symbols[this.sym[index]] : undefined;
    }

    /**
     * Slice view: the columns are not copied, only the window narrows.
     * @param {number} [start] - Start (inclusive).
     * @param {number} [end] - End (exclusive).
     * @returns {CandleSeries} View.
     */
    slice(start = 0, end = this.ts.length) {
        const n = this.ts.length;
        let a = start < 0 ? Math.max(n + start, 0) : Math.min(start, n);
        let b = end < 0 ? Math.max(n + end, 0) : Math.min(end, n);
        if (b < a) b = a;
        const cut = (arr) => arr.subarray(a, b);
        return new CandleSeries({
            ts: cut(this.ts),
            open: cut(this.open), high: cut(this.high), low: cut(this.low),
            close: cut(this.close), volume: cut(this.volume),
            sym: this.sym ? cut(this.sym) : null,
            symbols: this.symbols,
        });
    }

    /** First index with time ≥ ts (the column is sorted). */
    lowerBound(ts) {
        let lo = 0, hi = this.ts.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (this.ts[mid] < ts) lo = mid + 1; else hi = mid;
        }
        return lo;
    }

    /** First index with time > ts (the column is sorted). */
    upperBound(ts) {
        let lo = 0, hi = this.ts.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (this.ts[mid] <= ts) lo = mid + 1; else hi = mid;
        }
        return lo;
    }

    *[Symbol.iterator]() {
        for (let i = 0; i < this.ts.length; i += 1) yield this.at(i);
    }

    /** Bytes in typed arrays (outside the V8 heap) — for diagnostics. */
    get byteLength() {
        return this.ts.byteLength + this.open.byteLength + this.high.byteLength
            + this.low.byteLength + this.close.byteLength + this.volume.byteLength
            + (this.sym ? this.sym.byteLength : 0);
    }

    /**
     * Build columns from an array of candle objects.
     * @param {Array<object>} candles - Candles.
     * @param {Array<string>} [symbols] - Shared ticker table (appended to).
     * @returns {CandleSeries} Columnar series.
     */
    static from(candles, symbols = null) {
        const builder = new CandleSeriesBuilder({ symbols });
        for (const candle of candles) builder.push(candle);
        return builder.build();
    }
}

/**
 * Column accumulator with capacity doubling: the series length is not known in advance,
 * and reallocating on every candle is not an option.
 */
export class CandleSeriesBuilder {
    /**
     * @param {object} [params] - Parameters.
     * @param {number} [params.capacity] - Initial capacity.
     * @param {Array<string>} [params.symbols] - Shared ticker table.
     */
    constructor({ capacity = 1024, symbols = null } = {}) {
        this.n = 0;
        this.cap = Math.max(1, capacity);
        this.ts = new Float64Array(this.cap);
        for (const field of PRICE_FIELDS) this[field] = new Float64Array(this.cap);
        this.sym = new Int32Array(this.cap);
        this.symbols = symbols || [];
        this.symbolIndex = new Map(this.symbols.map((s, i) => [s, i]));
        this.hasTicker = false;
    }

    /** @private */
    _grow() {
        const cap = this.cap * 2;
        const copy = (arr, Ctor) => { const next = new Ctor(cap); next.set(arr); return next; };
        this.ts = copy(this.ts, Float64Array);
        for (const field of PRICE_FIELDS) this[field] = copy(this[field], Float64Array);
        this.sym = copy(this.sym, Int32Array);
        this.cap = cap;
    }

    /**
     * Append a candle.
     * @param {object} candle - Candle with datetime/OHLCV and an optional ticker.
     */
    push(candle) {
        if (this.n === this.cap) this._grow();
        const i = this.n;
        this.ts[i] = candle.datetime instanceof Date
            ? candle.datetime.getTime()
            : Number(candle.datetime);
        this.open[i] = candle.open;
        this.high[i] = candle.high;
        this.low[i] = candle.low;
        this.close[i] = candle.close;
        this.volume[i] = candle.volume;
        if (candle.ticker) {
            this.hasTicker = true;
            let index = this.symbolIndex.get(candle.ticker);
            if (index === undefined) {
                index = this.symbols.length;
                this.symbols.push(candle.ticker);
                this.symbolIndex.set(candle.ticker, index);
            }
            this.sym[i] = index;
        }
        this.n += 1;
    }

    /**
     * Close the accumulator, trimming the capacity to the actual length.
     * @returns {CandleSeries} Finished series.
     */
    build() {
        const n = this.n;
        const cut = (arr) => arr.slice(0, n);
        return new CandleSeries({
            ts: cut(this.ts),
            open: cut(this.open), high: cut(this.high), low: cut(this.low),
            close: cut(this.close), volume: cut(this.volume),
            sym: this.hasTicker ? cut(this.sym) : null,
            symbols: this.symbols,
        });
    }
}
