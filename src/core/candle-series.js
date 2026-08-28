/**
 * Колоночное хранение свечей.
 *
 * Свеча-объект стоит ~259 байт в куче V8 (замерено на SBER 2025: 374 тыс. свечей
 * → 92 МБ при 20 МБ файла), из них большая часть — накладные расходы объекта и
 * отдельный Date внутри. Вселенная за год это ~40 млн свечей, то есть ~10 ГБ
 * объектами при лимите кучи 4.3 ГБ — кросс-секционный бэктест так просто не
 * поднять. Колонками та же вселенная занимает ~2 ГБ, причём типизированные
 * массивы живут вне кучи V8 и в её лимит не упираются.
 *
 * Интерфейс намеренно совпадает с подмножеством Array: `length`, `at(i)`,
 * `slice(a, b)`, итератор. Обычный массив свечей ему уже удовлетворяет, поэтому
 * потребителю всё равно, что ему дали, — лишь бы он обращался через `at(i)`, а
 * не `[i]`. Это делает переход постепенным: однобумажные листинги можно оставить
 * массивами объектов, а мультитикерные отдавать колонками.
 *
 * Цены хранятся в Float64 — ровно та же точность, что у чисел в объектах.
 * Float32 сэкономил бы ещё вдвое, но мог бы сдвинуть срабатывание интрабарного
 * стопа в пограничном случае, а регрессия потикерных стратегий должна сходиться
 * цифра в цифру.
 */

/** Поля свечи, хранимые отдельными колонками (кроме тикера и времени). @private */
const PRICE_FIELDS = ["open", "high", "low", "close", "volume"];

export class CandleSeries {
    /**
     * @param {object} columns - Колонки.
     * @param {Float64Array} columns.ts - Время, epoch ms.
     * @param {Float64Array} columns.open - Цена открытия.
     * @param {Float64Array} columns.high - Максимум.
     * @param {Float64Array} columns.low - Минимум.
     * @param {Float64Array} columns.close - Цена закрытия.
     * @param {Float64Array} columns.volume - Объём.
     * @param {Int32Array|null} [columns.sym] - Индекс тикера в `symbols`.
     * @param {Array<string>} [columns.symbols] - Таблица тикеров.
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
     * Свеча по индексу. Объект собирается на месте — держать все свечи объектами
     * и есть та проблема, ради которой существует этот класс.
     * @param {number} index - Индекс; отрицательный отсчитывается с конца (как Array.at).
     * @returns {object|undefined} Свеча.
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

    /** Время свечи без сборки объекта (для поиска и сравнений). */
    tsAt(index) {
        return this.ts[index];
    }

    /** Тикер свечи без сборки объекта. */
    tickerAt(index) {
        return this.sym ? this.symbols[this.sym[index]] : undefined;
    }

    /**
     * Срез-представление: колонки не копируются, только сужается окно.
     * @param {number} [start] - Начало (включительно).
     * @param {number} [end] - Конец (не включая).
     * @returns {CandleSeries} Представление.
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

    /** Первый индекс со временем ≥ ts (колонка отсортирована). */
    lowerBound(ts) {
        let lo = 0, hi = this.ts.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (this.ts[mid] < ts) lo = mid + 1; else hi = mid;
        }
        return lo;
    }

    /** Первый индекс со временем > ts (колонка отсортирована). */
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

    /** Байт в типизированных массивах (вне кучи V8) — для диагностики. */
    get byteLength() {
        return this.ts.byteLength + this.open.byteLength + this.high.byteLength
            + this.low.byteLength + this.close.byteLength + this.volume.byteLength
            + (this.sym ? this.sym.byteLength : 0);
    }

    /**
     * Собрать колонки из массива свечей-объектов.
     * @param {Array<object>} candles - Свечи.
     * @param {Array<string>} [symbols] - Общая таблица тикеров (дополняется).
     * @returns {CandleSeries} Колоночная серия.
     */
    static from(candles, symbols = null) {
        const builder = new CandleSeriesBuilder({ symbols });
        for (const candle of candles) builder.push(candle);
        return builder.build();
    }
}

/**
 * Накопитель колонок с удвоением ёмкости: длина серии заранее неизвестна,
 * а перевыделять на каждую свечу нельзя.
 */
export class CandleSeriesBuilder {
    /**
     * @param {object} [params] - Параметры.
     * @param {number} [params.capacity] - Начальная ёмкость.
     * @param {Array<string>} [params.symbols] - Общая таблица тикеров.
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
     * Добавить свечу.
     * @param {object} candle - Свеча с datetime/OHLCV и необязательным ticker.
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
     * Закрыть накопитель, обрезав ёмкость до фактической длины.
     * @returns {CandleSeries} Готовая серия.
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
