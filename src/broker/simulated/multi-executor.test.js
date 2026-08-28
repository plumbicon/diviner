import { test } from "node:test";
import assert from "node:assert/strict";
import { createSimulatedBroker } from "./broker.js";
import { CandleSeries } from "../../core/candle-series.js";
import { StreamingCandleSink } from "../../core/candle-sink.js";
import { Strategy } from "../../core/strategy.js";
import { Engine } from "../../core/engine.js";
import { TemporalView } from "../../core/temporal-view.js";

const MIN = 60_000;
const base = Date.UTC(2026, 0, 5, 4, 0);

/** Свечи бумаги по заданным ценам закрытия; high/low раздвинуты на ±1%. */
const bars = (ticker, closes) => closes.map((close, i) => ({
    datetime: new Date(base + i * MIN),
    open: close, high: close * 1.01, low: close * 0.99, close, volume: 1000, ticker,
}));

/** Мультитикерный брокер над синтетическим датасетом. */
function makeBroker({ aaa, bbb, lots = { AAA: 10, BBB: 1 } }) {
    const bySymbol = new Map([
        ["AAA", new Map([[1, CandleSeries.from(bars("AAA", aaa))]])],
        ["BBB", new Map([[1, CandleSeries.from(bars("BBB", bbb))]])],
    ]);
    const symbols = ["AAA", "BBB"];
    const instruments = new Map(symbols.map((t) => [t, { ticker: t, lot: lots[t], exchange: "MOEX" }]));
    function* mergeStream(minutes) {
        const heads = symbols.map((t) => ({ t, s: bySymbol.get(t).get(minutes), i: 0 }));
        const next = () => {
            let best = -1;
            for (let k = 0; k < heads.length; k += 1) {
                const h = heads[k];
                if (h.i >= h.s.length) continue;
                if (best < 0 || h.s.tsAt(h.i) < heads[best].s.tsAt(heads[best].i)) best = k;
            }
            if (best < 0) return null;
            const h = heads[best];
            const candle = h.s.at(h.i);
            h.i += 1;
            return candle;
        };
        let held = next();
        while (held) {
            const ahead = next();
            held.isBatchEnd = !ahead || ahead.datetime.getTime() !== held.datetime.getTime();
            yield held;
            held = ahead;
        }
    }
    return createSimulatedBroker({
        candles: null, series: null, bySymbol, symbols, instruments, mergeStream,
        metadata: { intervalMinutes: 1 },
        initialCash: 10000, commission: 0.0005, leverage: 1,
        fillOnNextOpen: true, intrabarStops: true,
    });
}

/**
 * Шортит перечисленные бумаги на конце указанной минуты.
 *
 * Аллокацию считает сама: `maxPositions` и бюджет `капитал / maxPositions` —
 * это её параметры, исполнитель о них не знает и в ордере получает готовую сумму.
 */
class ShortBoth extends Strategy {
    constructor(data, cash, commission) {
        super(data, cash, commission);
        this.atMinute = 0;
        this.tickers = ["AAA", "BBB"];
        this.maxPositions = 2;
        this.slPct = 5;
        this.fired = false;
    }
    async init() {}
    async next(candle) {
        if (this.fired || !candle?.isBatchEnd) return;
        if (candle.datetime.getTime() !== base + this.atMinute * MIN) return;
        this.fired = true;

        const equity = this.execution.getEquity();
        for (const ticker of this.tickers) {
            const busy = this.execution.getPositions().length
                + this.execution.getPendingTickers().length;
            if (busy >= this.maxPositions) break;
            if (this.execution.isBusy(ticker)) continue;
            const last = await this.context.getCandles({ ticker, interval: "1m" });
            const price = last.at(-1).close;
            this.execution.sell({
                ticker,
                budget: equity / this.maxPositions,
                sl: price * (1 + this.slPct / 100),
            });
        }
    }
}

async function run(broker, strategy) {
    const context = new TemporalView({ dataSource: broker.data, metadata: broker.metadata ?? {}, logger: () => {} });
    return new Engine().run({ broker, strategy, context, options: { verbose: false } });
}

test("обе позиции заливаются по open следующей свечи своей бумаги", async () => {
    // Обе бумаги падают — шорты в плюсе, стопы не задеваются.
    const broker = makeBroker({ aaa: [100, 100, 98, 96, 94], bbb: [50, 50, 49, 48, 47] });
    const strategy = new ShortBoth(new StreamingCandleSink(), 10000, 0.0005);
    const report = await run(broker, strategy);

    assert.equal(report.trade_log.length, 2);
    const byTicker = Object.fromEntries(report.trade_log.map((t) => [t.ticker, t]));
    // Сигнал на минуте 0, заливка по open минуты 1.
    assert.equal(byTicker.AAA.entryPrice, 100);
    assert.equal(byTicker.BBB.entryPrice, 50);
    // Лот бумаги, а не общий: AAA кратно 10, BBB кратно 1.
    assert.equal(byTicker.AAA.size % 10, 0);
    // Стратегия выделила по половине капитала: ~5000 на бумагу, а не всё на первую.
    assert.ok(byTicker.AAA.size * 100 <= 5100, `AAA notional ${byTicker.AAA.size * 100}`);
    assert.ok(byTicker.BBB.size * 50 <= 5100, `BBB notional ${byTicker.BBB.size * 50}`);
    // Оба шорта закрыты на конце данных в плюс.
    assert.ok(byTicker.AAA.pnl > 0 && byTicker.BBB.pnl > 0);
    assert.equal(byTicker.AAA.reason, "eod");
});

test("стоп срабатывает по своей бумаге и не трогает вторую", async () => {
    // AAA улетает вверх (стоп +5% пробит на минуте 3), BBB спокойно падает.
    const broker = makeBroker({ aaa: [100, 100, 103, 112, 112], bbb: [50, 50, 49, 48, 47] });
    const strategy = new ShortBoth(new StreamingCandleSink(), 10000, 0.0005);
    const report = await run(broker, strategy);

    const byTicker = Object.fromEntries(report.trade_log.map((t) => [t.ticker, t]));
    assert.equal(byTicker.AAA.reason, "sl");
    assert.equal(byTicker.AAA.exitPrice.toFixed(4), (100 * 1.05).toFixed(4), "выход ровно по уровню стопа");
    assert.ok(byTicker.AAA.pnl < 0);
    // Вторая бумага доехала до конца данных и осталась прибыльной.
    assert.equal(byTicker.BBB.reason, "eod");
    assert.ok(byTicker.BBB.pnl > 0);
});

test("капитал отмечается по одной точке на минуту, а не на свечу", async () => {
    const broker = makeBroker({ aaa: [100, 100, 98, 96, 94], bbb: [50, 50, 49, 48, 47] });
    const strategy = new ShortBoth(new StreamingCandleSink(), 10000, 0.0005);
    await run(broker, strategy);
    // 5 минут × 2 бумаги = 10 свечей, но отметок капитала должно быть 5.
    assert.equal(broker.exec.equity.length, 5);
    assert.equal(broker.exec.timeline.length, 5);
    assert.ok(broker.exec.equity.every((v) => Number.isFinite(v) && v > 0));
});

test("одна бумага — одна позиция: повторный ордер по занятой отклоняется", async () => {
    // Ограничение биржи, а не политика: нетто-позиция по инструменту одна.
    const broker = makeBroker({ aaa: [100, 100, 98, 96, 94], bbb: [50, 50, 49, 48, 47] });
    const strategy = new ShortBoth(new StreamingCandleSink(), 10000, 0.0005);
    strategy.tickers = ["AAA", "AAA", "BBB"];
    const report = await run(broker, strategy);
    assert.equal(report.trade_log.length, 2, "AAA не должна открыться дважды");
});

test("сколько бумаг держать и на какую сумму — решает стратегия", async () => {
    const prices = { aaa: [100, 100, 98, 96, 94], bbb: [50, 50, 49, 48, 47] };
    const withOne = new ShortBoth(new StreamingCandleSink(), 10000, 0.0005);
    withOne.maxPositions = 1;
    const one = await run(makeBroker(prices), withOne);
    const two = await run(makeBroker(prices), new ShortBoth(new StreamingCandleSink(), 10000, 0.0005));

    assert.equal(one.trade_log.length, 1, "стратегия сама не открыла вторую");
    assert.equal(one.trade_log[0].ticker, "AAA");
    // Одна позиция забирает весь капитал, две делят пополам — разница вдвое.
    const sizeOf = (report, ticker) => report.trade_log.find((t) => t.ticker === ticker).size;
    assert.ok(sizeOf(one, "AAA") >= 2 * sizeOf(two, "AAA"),
        `1 позиция: ${sizeOf(one, "AAA")}, 2 позиции: ${sizeOf(two, "AAA")}`);
});

test("исполнитель не навязывает аллокацию: без бюджета берётся весь кэш", async () => {
    const broker = makeBroker({ aaa: [100, 100, 98, 96, 94], bbb: [50, 50, 49, 48, 47] });
    const strategy = new ShortBoth(new StreamingCandleSink(), 10000, 0.0005);
    strategy.tickers = ["AAA"];
    // Подменяем ордер на «без суммы» — так делают однобумажные стратегии.
    const original = broker.exec.sell.bind(broker.exec);
    broker.exec.sell = ({ budget, ...order }) => original(order);
    const report = await run(broker, strategy);
    assert.equal(report.trade_log.length, 1);
    assert.ok(report.trade_log[0].size * 100 >= 9000, "размер посчитан от всего кэша");
});

test("отчёт называет вселенную прогона", async () => {
    const broker = makeBroker({ aaa: [100, 100, 98, 96, 94], bbb: [50, 50, 49, 48, 47] });
    const report = await run(broker, new ShortBoth(new StreamingCandleSink(), 10000, 0.0005));
    assert.deepEqual(report.backtest_parameters.symbols, ["AAA", "BBB"]);
    assert.ok(Number.isFinite(report.performance_metrics.returnPct));
    assert.equal(report.performance_metrics.tradesCount, 2);
});
