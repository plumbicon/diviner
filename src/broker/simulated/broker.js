import { readFileSync } from "node:fs";
import { Portfolio } from "../../core/portfolio.js";
import { MultiPortfolio } from "../../core/multi-portfolio.js";
import { MultiSymbolExecutor } from "./multi-executor.js";
import { PerformanceMetrics } from "../../core/metrics.js";
import { loadDataset } from "../../core/data-loader.js";
import { evaluateIntrabarStop } from "../../core/stops.js";
import {
    DEFAULT_EXCHANGE,
    MOSCOW_OFFSET_MS,
    buildCandleDerivedTradingSchedule,
    getCandleIntervalConfig,
    toDate,
} from "../../core/market-data.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// This broker can take its parquet listing from a pipe when no path is given,
// so the CLI may read stdin for it. Live brokers omit this flag and the CLI
// never blocks on stdin for them.
export const readsSourceFromStdin = true;

/**
 * Plugin option descriptors for the CLI (validated by the shared layer, п.3).
 */
export const options = [
    { flags: "--balance <amount>", description: "Initial balance", default: "10000" },
    { flags: "--commission <rate>", description: "Commission rate", default: "0.0005" },
    { flags: "--leverage <n>", description: "Short-side leverage: scales position size and locked margin (default 1 = unleveraged)", default: "1" },
    { flags: "--fill-next-open", description: "Fill orders at the open of the next candle (more realistic than current-close fill)" },
    { flags: "--intrabar-stops", description: "Evaluate SL/TP intrabar by candle high/low and fill at the level (default off = close-only). Used by A07." },
    { flags: "--model-liquidation", description: "With --intrabar-stops + leverage>1: gap-aware stop fills + margin-call liquidation (loss capped at posted margin). Off = stops always fill at the level (no liquidation)." },
    { flags: "--risk-rates <file>", description: "JSON with per-instrument short risk rates: {TICKER: 0.25} or {TICKER: {dshort: 0.25}}. Short leverage of a name is capped at 1/dshort, --leverage stays the upper bound. Multi-symbol runs only." },
];

/**
 * Потолки плеча шорта из файла ставок риска.
 *
 * Формат — либо {TICKER: 0.25}, либо {TICKER: {dshort: 0.25}}: ставка риска брокера,
 * плечо бумаги равно 1/dshort. Бумага без ставки ограничений не получает: остаётся
 * общий --leverage. Файл читается один раз, ошибка чтения — исключение, а не тихий
 * откат к плечу без лимитов: молча посчитать более выгодный прогон хуже, чем упасть.
 *
 * @param {string|null} file - Путь к JSON.
 * @returns {((ticker: string) => number)|null} Плечо бумаги или null, если файла нет.
 */
export function loadShortLeverageCaps(file) {
    if (!file) return null;
    const raw = JSON.parse(readFileSync(file, "utf8"));
    const caps = new Map();
    for (const [ticker, value] of Object.entries(raw)) {
        const dshort = Number(typeof value === "object" && value !== null ? value.dshort : value);
        if (Number.isFinite(dshort) && dshort > 0) caps.set(ticker, 1 / dshort);
    }
    if (caps.size === 0) throw new Error(`--risk-rates: в ${file} нет ни одной ставки dshort`);
    console.error(`[SimulatedBroker] ставки риска: ${caps.size} бумаг, плечо шорта ограничено 1/dshort`);
    return (ticker) => caps.get(ticker) ?? Infinity;
}

/**
 * Plugin entry point: build a simulated broker from CLI config.
 * Encapsulates loading the parquet listing (path or stdin buffer).
 * @param {object} config - Parsed CLI options.
 * @returns {Promise<object>} Broker { data, exec, finalize, metadata, needsCache }.
 */
export async function createBroker(config = {}) {
    const dataset  = await loadDataset(config.source);
    const metadata = { ...dataset.metadata };
    // Parquet files from older pipelines may lack a ticker field; fall back to
    // the filename prefix (e.g. "AFKS_2025_1m.parquet" → ticker="AFKS").
    if (!metadata.ticker && config.sourceName) {
        const base  = String(config.sourceName).split(/[\\/]/).pop();
        const match = base.match(/^([A-Z0-9]+)_/);
        if (match) metadata.ticker = match[1];
    }
    const broker = createSimulatedBroker({
        candles:       dataset.candles,
        series:        dataset.series,
        bySymbol:      dataset.bySymbol,
        symbols:       dataset.symbols,
        instruments:   dataset.instruments,
        mergeStream:   dataset.mergeStream ? dataset.mergeStream.bind(dataset) : null,
        metadata,
        initialCash:   Number(config.balance),
        commission:    Number(config.commission),
        leverage:      Number(config.leverage),
        riskRates:     config.riskRates ?? null,
        fillOnNextOpen: Boolean(config.fillNextOpen),
        intrabarStops: Boolean(config.intrabarStops),
        modelLiquidation: Boolean(config.modelLiquidation),
        meta: {
            historyFile: config.sourceName || "",
            strategyFile: config.strategy || "",
        },
    });
    broker.metadata = metadata;
    broker.needsCache = false;
    return broker;
}

/**
 * Simulated data source for backtests.
 *
 * Owns the loaded candle listing and answers history requests off it. The base
 * (smallest) interval is streamed to drive the engine.
 *
 * Every interval the strategy can request (1m, 1d, …) must be physically stored
 * in the multi-interval parquet file — there is NO aggregation. The broker only
 * ever returns the exact candles fetched from the API, so daily/hourly closes
 * match the official values the live API serves (e.g. the closing-auction daily
 * close, which can differ from the last 1m print on illiquid names). If the
 * strategy asks for an interval the file does not contain, getHistory throws so
 * the gap is obvious — re-fetch the listing with that interval (--merge-into).
 *
 * Requests honour an `until` upper bound on data freshness so nothing peeks past
 * the current simulation moment (look-ahead guard): a higher-interval candle is
 * withheld until its period has fully elapsed (period end ≤ until) — exactly as
 * live would have it. The base interval is the bar stream itself, so the current
 * bar is included (it is the one being processed).
 */
export class SimulatedDataSource {
    constructor({
        candles = [], series = null, metadata = {}, portfolio = null, equity = null,
        bySymbol = null, symbols = null, instruments = null, mergeStream = null,
    } = {}) {
        this.candles = candles;
        this.series = series instanceof Map ? series : null;
        this.metadata = metadata || {};
        this.portfolio = portfolio;
        this.equity = equity;
        // Мультитикерный датасет: физически данные лежат по бумагам, общий
        // хронологический поток даёт mergeStream (слиянием, без копирования).
        this.bySymbol = bySymbol instanceof Map ? bySymbol : null;
        this.symbols = symbols || (this.bySymbol ? [...this.bySymbol.keys()].sort() : []);
        this.instruments = instruments instanceof Map ? instruments : new Map();
        this._mergeStream = mergeStream;
        this.baseMinutes = this._resolveBaseMinutes();
    }

    /** @private */
    _resolveBaseMinutes() {
        if (this.series && this.series.size > 0) return Math.min(...this.series.keys());
        if (this.bySymbol && this.bySymbol.size > 0) {
            const intervals = new Set();
            for (const perInterval of this.bySymbol.values()) {
                for (const minutes of perInterval.keys()) intervals.add(minutes);
            }
            if (intervals.size > 0) return Math.min(...intervals);
        }
        return Number(this.metadata.intervalMinutes) || 1;
    }

    /** Тикеры, доступные датасету. @returns {Array<string>} Тикеры. */
    getSymbols() {
        return this.symbols;
    }

    /**
     * Описание инструмента (лот, биржа, figi).
     * @param {string} [ticker] - Тикер; по умолчанию — инструмент датасета.
     * @returns {object} Метаданные инструмента.
     */
    getInstrument(ticker = null) {
        if (ticker && this.instruments.has(ticker)) return this.instruments.get(ticker);
        return this.metadata.instrument || { ticker: this.metadata.ticker || ticker, lot: 1 };
    }

    /**
     * Серия нужного интервала для нужной бумаги.
     * @param {number} minutes - Интервал в минутах.
     * @param {string|null} ticker - Тикер; null — серия датасета по умолчанию.
     * @returns {Array<object>|object|null} Массив свечей либо CandleSeries.
     * @private
     */
    _seriesFor(minutes, ticker) {
        if (ticker && this.bySymbol) {
            return this.bySymbol.get(ticker)?.get(minutes) ?? null;
        }
        if (this.series) return this.series.get(minutes) ?? null;
        // Однобумажный датасет: тикер, совпадающий с его собственным, — не ошибка.
        return null;
    }

    /**
     * Stream the listing candle-by-candle (drives the engine tick loop) and
     * record an equity point per bar. A request for the next candle means the
     * previous bar has been fully processed by the engine, so its equity is
     * marked at that point (and the last bar after the loop ends).
     * @returns {AsyncGenerator<object>} Candle stream.
     */
    async *stream() {
        // Мультитикерный датасет: единый поток по всей вселенной, свечи несут
        // поле `ticker`. Отметку equity здесь не делаем — при нескольких открытых
        // позициях она считается по ценам всех удерживаемых бумаг сразу, и это
        // забота мультипозиционного исполнителя, а не источника данных.
        if (!this.candles && this._mergeStream) {
            for (const candle of this._mergeStream(this.baseMinutes)) {
                yield candle;
            }
            return;
        }

        const candles = this.candles;
        const n = candles.length;
        const at = typeof candles.at === "function"
            ? (i) => candles.at(i)
            : (i) => candles[i];
        for (let i = 0; i < n; i += 1) {
            if (i > 0) {
                this._markEquity(at(i - 1));
            }
            yield at(i);
        }
        if (n > 0) {
            this._markEquity(at(n - 1));
        }
    }

    /**
     * Append a mark-to-market equity point for a processed bar.
     * @param {object} candle - Bar just processed.
     * @private
     */
    _markEquity(candle) {
        if (this.portfolio && this.equity) {
            this.equity.push(this.portfolio.calculateEquity(candle));
        }
    }

    /**
     * History for the requested interval, clamped by `until`.
     *
     * Served exclusively from the stored series — no aggregation. The requested
     * interval must exist in the parquet file; otherwise this throws so a missing
     * interval surfaces immediately rather than silently producing aggregated
     * (and therefore inaccurate) candles.
     *
     * @param {object} params - Request.
     * @param {Date|string} [params.from] - Start (inclusive).
     * @param {Date|string} [params.to] - End (exclusive).
     * @param {string|number} [params.interval] - Candle interval.
     * @param {Date|string|number} [params.until] - Upper data-freshness bound.
     * @returns {Array<object>} Candles.
     */
    async getHistory({ from = null, to = null, interval = "1m", until = Infinity, ticker = null } = {}) {
        const fromTs = from ? toDate(from).getTime() : -Infinity;
        const toTs = to ? toDate(to).getTime() : Infinity;
        const untilTs = until === Infinity ? Infinity : toDate(until).getTime();

        // Effective exclusive upper bound: the earlier of `to` and just past
        // `until`, so the freshness guard and the requested window combine into
        // one cut and a request "up to now" includes the current minute.
        const upperExcl = Math.min(toTs, untilTs === Infinity ? Infinity : untilTs + 1);

        const config = getCandleIntervalConfig(interval);
        const minutes = config.minutes;

        const stored = this._seriesFor(minutes, ticker);
        if (!stored) {
            if (!ticker && this.bySymbol && !this.series) {
                throw new Error(
                    "Multi-symbol dataset needs an explicit ticker in the history request: "
                    + `getCandles({ ticker: "…", … }). Available: [${this.symbols.join(", ")}].`,
                );
            }
            if (ticker && this.bySymbol && !this.bySymbol.has(ticker)) {
                throw new Error(
                    `Backtest data has no candles for ${ticker}. `
                    + `The dataset holds [${this.symbols.join(", ")}]. `
                    + `Re-bundle the universe with this ticker: node src/bundle.js --out <file> …`,
                );
            }
            const available = [...(
                ticker && this.bySymbol
                    ? this.bySymbol.get(ticker)?.keys() || []
                    : this.series?.keys() || []
            )].sort((a, b) => a - b).join(", ");
            throw new Error(
                `Backtest data has no ${config.label} (${minutes}m) candles`
                + `${ticker ? ` for ${ticker}` : ""}. `
                + `The parquet file stores only interval(s) [${available}m]. `
                + `Re-fetch the listing with this interval, e.g.: `
                + `node src/broker/tinkoff/fetch.js --security <TICKER> --from-date <YYYY-MM-DD> `
                + `--till-date <YYYY-MM-DD> --interval ${config.label} --merge-into <file>`,
            );
        }

        const slice = sliceAscending(stored, fromTs, upperExcl);

        // The base interval IS the bar stream: upperExcl already includes the
        // current bar (the one being processed), so return it as-is. Higher
        // intervals need the look-ahead guard so a still-forming day/hour never
        // leaks its final close before its period has fully elapsed.
        if (minutes === this.baseMinutes || untilTs === Infinity) {
            return slice;
        }
        return slice.filter(
            (candle) => candlePeriodEnd(candle.datetime.getTime(), minutes) <= untilTs,
        );
    }

    /**
     * Trading schedule derived from the listing itself.
     * @param {object} params - Request.
     * @returns {Array<object>} Trading days.
     */
    async getTradingSchedule({ ticker = null, ...params } = {}) {
        // Расписание выводится из самих свечей, поэтому у каждой бумаги оно своё:
        // на неликвидной сессия начинается позже, и общее расписание вселенной
        // соврало бы про её открытие.
        const source = ticker && this.bySymbol
            ? this._seriesFor(this.baseMinutes, ticker)
            : this.candles;
        return buildCandleDerivedTradingSchedule(source, {
            ...params,
            exchange: this.getInstrument(ticker).exchange
                || this.metadata.exchange
                || DEFAULT_EXCHANGE,
            intervalMinutes: this.metadata.intervalMinutes,
        });
    }
}

/**
 * Simulated executor backed by a {@link Portfolio}. Translates strategy
 * buy/sell/close signals into simulated fills.
 *
 * Two fill modes:
 *   fillOnNextOpen=false (default): fills at the close of the candle that
 *     triggered the signal — the classic zero-slippage assumption.
 *   fillOnNextOpen=true: buffers the order and fills at the *open* of the
 *     next candle, which better represents the real latency of transmitting
 *     a market order after a bar closes.
 *
 * In next-open mode orders are settled inside setCurrentCandle() at the
 * start of each new tick, before stop evaluation or strategy logic runs.
 * The portfolio position is NOT updated until settlement, so the strategy
 * correctly observes its state during the signal tick.
 *
 * Edge case — end of data: any pending order from the last tick is settled
 * at the last candle's close (no next candle available). See finalize().
 */
export class SimulatedExecutor {
    /**
     * @param {object} params
     * @param {Portfolio} params.portfolio
     * @param {boolean} [params.fillOnNextOpen=false]
     */
    constructor({ portfolio, fillOnNextOpen = false, intrabarStops = false,
                  modelLiquidation = false }) {
        this.portfolio = portfolio;
        this.fillOnNextOpen = fillOnNextOpen;
        // When true, the engine routes SL/TP through checkStops() (intrabar
        // high/low). When false (default), SL/TP is close-only. See engine.run().
        this.intrabarStops = intrabarStops;
        // When true (only meaningful with intrabarStops + leverage>1): stops
        // fill gap-aware (at the bar open if it gapped past the level), and a
        // bar that opens past the liquidation price (adverse move ≥ 1/leverage)
        // force-closes the position with the loss capped at the posted margin.
        this.modelLiquidation = modelLiquidation;
        this.liquidations = 0;
        this.currentCandle = null;
        // Pending order buffered for next-open settlement:
        // { type: 'close' | 'open-long' | 'open-short', size?, sl?, tp?, exitDeadline? }
        this._pending = null;
    }

    /**
     * Set the candle used as the fill reference for the current tick.
     * In next-open mode, settles any order buffered by the previous tick
     * at this candle's open price — before stop evaluation runs.
     * @param {object} candle - Current candle.
     */
    setCurrentCandle(candle) {
        if (this.fillOnNextOpen && this._pending && candle) {
            this._settleAt(candle.open, candle.datetime);
        }
        this.currentCandle = candle;
    }

    /**
     * Execute a pending order at the given price/time (used for next-open settlement
     * and for the end-of-data flush in finalize).
     * @param {number} price - Fill price.
     * @param {Date} datetime - Fill timestamp.
     */
    _settleAt(price, datetime) {
        const p = this._pending;
        this._pending = null;
        // Synthetic fill candle: all price fields equal the fill price so that
        // Portfolio (which uses candle.close internally) records the right value.
        const fc = {
            datetime: datetime instanceof Date ? datetime : new Date(datetime),
            open: price, high: price, low: price, close: price,
            volume: 0,
        };
        if (p.type === "close") {
            if (this.portfolio.position) {
                this.portfolio.closePosition({ candle: fc });
            }
        } else if (p.type === "open-short") {
            if (!this.portfolio.position) {
                this.portfolio.openShort({ candle: fc, size: p.size, sl: p.sl, tp: p.tp, exitDeadline: p.exitDeadline });
            }
        } else if (p.type === "open-long") {
            if (!this.portfolio.position) {
                this.portfolio.openLong({ candle: fc, size: p.size, sl: p.sl, tp: p.tp, exitDeadline: p.exitDeadline });
            }
        }
    }

    buy({ size = null, sl = null, tp = null, exitDeadline = null } = {}) {
        if (this.fillOnNextOpen) {
            // Buffer if no position and no existing pending order.
            if (!this.portfolio.position && !this._pending) {
                this._pending = { type: "open-long", size, sl, tp, exitDeadline };
            }
            return null;
        }
        return this.portfolio.openLong({ candle: this.currentCandle, size, sl, tp, exitDeadline });
    }

    sell({ size = null, sl = null, tp = null, exitDeadline = null } = {}) {
        if (this.fillOnNextOpen) {
            if (!this.portfolio.position && !this._pending) {
                this._pending = { type: "open-short", size, sl, tp, exitDeadline };
            }
            return null;
        }
        return this.portfolio.openShort({ candle: this.currentCandle, size, sl, tp, exitDeadline });
    }

    closePosition(_reason = "manual") {
        // _reason принимается для совместимости с движком (аудит причины выхода
        // в live); в бэктесте причина не логируется — поведение не меняется.
        if (this.fillOnNextOpen) {
            // Guard: only buffer once; ignore duplicate close signals on the same tick
            // (e.g. SL/TP fires then strategy also tries to exit by schedule).
            if (this.portfolio.position && !this._pending) {
                this._pending = { type: "close" };
            }
            return null;
        }
        return this.portfolio.closePosition({ candle: this.currentCandle });
    }

    /**
     * Внутрисвечная проверка SL/TP (backtest-хук для движка). Триггерит по
     * диапазону свечи (high/low) и закрывает позицию ровно по цене уровня
     * sl/tp в той же свече — в обход next-open-буфера, т.к. стоп-ордер на бирже
     * исполняется при касании уровня, а не на открытии следующего бара.
     * SL имеет приоритет при двойном касании (см. evaluateIntrabarStop).
     * @param {object} candle - Текущая свеча.
     * @returns {object|null} Закрытая сделка или null.
     */
    checkStops(candle) {
        const position = this.portfolio.position;
        if (!position) {
            return null;
        }
        const reason = evaluateIntrabarStop(position, candle);
        if (!reason) {
            return null;
        }

        let fillPrice = reason === "sl" ? position.sl : position.tp;
        let liquidated = false;

        // Liquidation / gap-aware fill (loss side only). Without this the stop
        // always fills exactly at the level, so a position can never lose more
        // than the SL — liquidation is impossible. With it: a stop fills at the
        // bar's open when the open gapped past the level (you couldn't exit at
        // the level), and if the open is past the liquidation price (adverse
        // move ≥ 1/leverage) the broker force-closes there with the loss capped
        // at the posted margin.
        if (this.modelLiquidation && reason === "sl") {
            const lev = this.portfolio.leverage || 1;
            const entry = position.entryPrice;
            if (position.side === "short") {
                const liqPrice = entry * (1 + 1 / lev);
                fillPrice = Math.min(Math.max(position.sl, candle.open), liqPrice);
                liquidated = candle.open >= liqPrice;
            } else {
                const liqPrice = entry * (1 - 1 / lev);
                fillPrice = Math.max(Math.min(position.sl, candle.open), liqPrice);
                liquidated = candle.open <= liqPrice;
            }
        }

        // Синтетическая свеча: все цены = цена исполнения, чтобы Portfolio
        // (использует candle.close) зафиксировал выход именно по ней.
        const fc = {
            datetime: candle.datetime,
            open: fillPrice, high: fillPrice, low: fillPrice, close: fillPrice,
            volume: 0,
        };
        // Стоп исполняется немедленно — отменяем любой буферизованный ордер.
        this._pending = null;
        const trade = this.portfolio.closePosition({ candle: fc });
        if (trade && liquidated) {
            trade.liquidated = true;
            this.liquidations += 1;
        }
        return trade;
    }

    getPosition() {
        return this.portfolio.position;
    }

    getBalance() {
        return this.portfolio.cash;
    }

    /**
     * Push portfolio state back into the strategy so it sees its own position.
     * @param {object} strategy - Strategy instance.
     */
    syncStrategyState(strategy) {
        strategy._position = this.portfolio.position;
        strategy.cash = this.portfolio.cash;
    }
}

/**
 * Assemble a simulated broker: { data, exec } + the backing portfolio.
 * @param {object} params - Broker parameters.
 * @returns {{ data: SimulatedDataSource, exec: SimulatedExecutor, portfolio: Portfolio }} Broker.
 */
export function createSimulatedBroker({
    candles = [],
    series = null,
    bySymbol = null,
    symbols = null,
    instruments = null,
    mergeStream = null,
    metadata = {},
    initialCash = 10000,
    commission = 0.0005,
    leverage = 1,
    riskRates = null,
    fillOnNextOpen = false,
    intrabarStops = false,
    modelLiquidation = false,
    meta = {},
} = {}) {
    // Lot size from the dataset's instrument metadata, so default order sizing
    // floors to whole lots like the live broker (e.g. ALRS lot=10).
    // Мультитикерный датасет: лот у каждой бумаги свой, единый лот портфеля здесь
    // бессмыслен — размер считает мультипозиционный исполнитель по инструменту сделки.
    const multiSymbol = !candles && Boolean(bySymbol);
    const lot = Number(metadata?.instrument?.lot) || 1;
    // Falling back to 1 silently makes a backtest quietly unrealistic: on a
    // lot=100 name it sizes in shares the exchange would never fill, skipping
    // the rounding-down penalty live trading always pays. That is invisible in
    // the report, so say it out loud — a parquet rewritten without its
    // diviner.metadata block is the usual cause.
    if (!multiSymbol && !Number(metadata?.instrument?.lot)) {
        console.error(
            "[SimulatedBroker] No instrument lot size in dataset metadata — assuming lot=1. "
            + "Sizing will not floor to exchange lots; results may be optimistic.",
        );
    }
    // Мультитикерный прогон: касса одна, позиций несколько, лот берётся у
    // инструмента сделки. Сколько бумаг держать и как делить между ними депозит
    // портфель не знает — это решение стратегии, она передаёт сумму в ордере.
    // Однобумажный путь остаётся ровно прежним.
    // Ставки риска шорта по бумагам: у каждой свой потолок плеча (1/dshort), и он ниже
    // общего --leverage. Без файла поведение прежнее — одно плечо на всю вселенную.
    const leverageFor = multiSymbol ? loadShortLeverageCaps(riskRates) : null;
    const portfolio = multiSymbol
        ? new MultiPortfolio({ cash: initialCash, commission, leverage, leverageFor })
        : new Portfolio({ cash: initialCash, commission, lot, leverage });
    const equity = [];
    const data = new SimulatedDataSource({
        candles, series, metadata, portfolio: multiSymbol ? null : portfolio,
        equity: multiSymbol ? null : equity,
        bySymbol, symbols, instruments, mergeStream,
    });
    const exec = multiSymbol
        ? new MultiSymbolExecutor({ portfolio, fillOnNextOpen, intrabarStops, instruments })
        : new SimulatedExecutor({ portfolio, fillOnNextOpen, intrabarStops, modelLiquidation });

    return {
        data,
        exec,
        portfolio,
        /**
         * Build the backtest report. Closes any position still open on the last
         * candle (so equity is not left marked-to-market in an open position),
         * then compiles metrics. The engine calls this once the stream ends.
         *
         * In next-open mode a pending order from the last tick is settled at the
         * last candle's close (no next candle available to open at).
         * @returns {object} Backtest report.
         */
        finalize() {
            if (multiSymbol) {
                // «Последней свечи» у вселенной нет — у каждой бумаги своя, поэтому
                // хвост доводит исполнитель по последним известным ценам. Шкала
                // отчёта — концы минут (по одной отметке капитала на минуту), а не
                // свечи: их на минуту приходит столько, сколько бумаг во вселенной.
                exec.flush();
                const timeline = exec.timeline.map((datetime) => ({ datetime, close: 1 }));
                return {
                    backtest_parameters: {
                        history_file: meta.historyFile || "",
                        strategy_file: meta.strategyFile || "",
                        fill_mode: fillOnNextOpen ? "next-open" : "current-close",
                        symbols: symbols || [],
                    },
                    performance_metrics: new PerformanceMetrics({
                        data: timeline, equity: exec.equity,
                        trades: portfolio.trades, initialCash,
                    }).compile(),
                    trade_log: portfolio.trades,
                };
            }
            if (candles.length > 0) {
                const last = candles.at(-1);

                // Flush any order buffered on the last tick: no next candle,
                // so settle at last candle's close.
                if (exec._pending) {
                    exec._settleAt(last.close, last.datetime);
                }

                // Close any remaining open position at the last candle's close.
                if (portfolio.position) {
                    portfolio.closePosition({ candle: last });
                    equity[equity.length - 1] = portfolio.calculateEquity(last);
                }
            }

            return {
                backtest_parameters: {
                    history_file: meta.historyFile || "",
                    strategy_file: meta.strategyFile || "",
                    fill_mode: fillOnNextOpen ? "next-open" : "current-close",
                },
                performance_metrics: new PerformanceMetrics({
                    data: candles,
                    equity,
                    trades: portfolio.trades,
                    initialCash,
                }).compile(),
                trade_log: portfolio.trades,
            };
        },
    };
}

/**
 * Time (ms) at which a stored candle's period is fully elapsed — i.e. its close
 * is final and may be served without look-ahead. Daily (and longer) candles are
 * stamped at UTC midnight but represent a Moscow calendar day, so their period
 * ends at the next Moscow midnight, not UTC midnight + 24h (which would be 3h
 * late and hide a finalized close during the first hours of the next day).
 * Sub-daily candles use their plain begin + length.
 * @param {number} startTs - Candle begin (ms).
 * @param {number} minutes - Interval length in minutes.
 * @returns {number} Period-end timestamp (ms).
 */
function candlePeriodEnd(startTs, minutes) {
    if (minutes % 1440 === 0) {
        // Floor to Moscow midnight, then advance by the number of days covered.
        const days = minutes / 1440;
        const local = startTs + MOSCOW_OFFSET_MS;
        const localMidnight = Math.floor(local / DAY_MS) * DAY_MS;
        return localMidnight + days * DAY_MS - MOSCOW_OFFSET_MS;
    }
    return startTs + minutes * 60_000;
}

/**
 * Candles within [fromTs, toTs) via binary search (input ascending by time),
 * so repeated per-bar history slices over the full listing stay O(log n + win).
 * @param {Array<object>} candles - Source candles (ascending).
 * @param {number} fromTs - Start (inclusive).
 * @param {number} toTs - End (exclusive).
 * @returns {Array<object>} Filtered candles.
 */
function sliceAscending(candles, fromTs, toTs) {
    const n = candles.length;
    if (n === 0) return [];

    // Колоночная серия (CandleSeries) знает свои границы двоичным поиском без
    // сборки объектов; массив объектов ищем как раньше. Наружу в обоих случаях
    // отдаём обычный массив свечей — так его ждут все стратегии.
    if (typeof candles.lowerBound === "function") {
        const lo = candles.lowerBound(fromTs);
        const hi = candles.lowerBound(toTs);
        const out = new Array(Math.max(0, hi - lo));
        for (let i = lo; i < hi; i += 1) out[i - lo] = candles.at(i);
        return out;
    }

    let lo = 0;
    let hi = n;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (candles[mid].datetime.getTime() < fromTs) lo = mid + 1;
        else hi = mid;
    }

    const out = [];
    for (let i = lo; i < n; i += 1) {
        if (candles[i].datetime.getTime() >= toTs) break;
        out.push(candles[i]);
    }
    return out;
}
