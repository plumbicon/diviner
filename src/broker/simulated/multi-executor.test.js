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

/** Candles of an instrument at the given closes; high/low spread by ±1%. */
const bars = (ticker, closes) => closes.map((close, i) => ({
    datetime: new Date(base + i * MIN),
    open: close, high: close * 1.01, low: close * 0.99, close, volume: 1000, ticker,
}));

/** Multi-ticker broker over a synthetic dataset. */
function makeBroker({ aaa, bbb, lots = { AAA: 10, BBB: 1 }, slippage = 0, entryLimitTtl = 0, entryLimitFallback = "cancel", entryLimitStrict = false }) {
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
        fillOnNextOpen: true, intrabarStops: true, slippage, entryLimitTtl, entryLimitFallback, entryLimitStrict,
    });
}

/**
 * Shorts the listed instruments at the end of the given minute.
 *
 * It computes the allocation itself: `maxPositions` and the budget
 * `equity / maxPositions` are its parameters; the executor knows nothing about them and
 * receives a ready amount with the order.
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

test("both positions fill at the next open of their own instrument", async () => {
    // Both instruments fall — the shorts are in profit, stops are not touched.
    const broker = makeBroker({ aaa: [100, 100, 98, 96, 94], bbb: [50, 50, 49, 48, 47] });
    const strategy = new ShortBoth(new StreamingCandleSink(), 10000, 0.0005);
    const report = await run(broker, strategy);

    assert.equal(report.trade_log.length, 2);
    const byTicker = Object.fromEntries(report.trade_log.map((t) => [t.ticker, t]));
    // Signal at minute 0, fill at the open of minute 1.
    assert.equal(byTicker.AAA.entryPrice, 100);
    assert.equal(byTicker.BBB.entryPrice, 50);
    // The instrument's lot, not a shared one: AAA in multiples of 10, BBB of 1.
    assert.equal(byTicker.AAA.size % 10, 0);
    // The strategy allotted half the equity each: ~5000 per instrument, not all to the first.
    assert.ok(byTicker.AAA.size * 100 <= 5100, `AAA notional ${byTicker.AAA.size * 100}`);
    assert.ok(byTicker.BBB.size * 50 <= 5100, `BBB notional ${byTicker.BBB.size * 50}`);
    // Both shorts are closed in profit at the end of the data.
    assert.ok(byTicker.AAA.pnl > 0 && byTicker.BBB.pnl > 0);
    assert.equal(byTicker.AAA.reason, "eod");
});

test("a stop fires on its own instrument and leaves the other alone", async () => {
    // AAA shoots up (the +5% stop is hit at minute 3), BBB falls calmly.
    const broker = makeBroker({ aaa: [100, 100, 103, 112, 112], bbb: [50, 50, 49, 48, 47] });
    const strategy = new ShortBoth(new StreamingCandleSink(), 10000, 0.0005);
    const report = await run(broker, strategy);

    const byTicker = Object.fromEntries(report.trade_log.map((t) => [t.ticker, t]));
    assert.equal(byTicker.AAA.reason, "sl");
    assert.equal(byTicker.AAA.exitPrice.toFixed(4), (100 * 1.05).toFixed(4), "exit exactly at the stop level");
    assert.ok(byTicker.AAA.pnl < 0);
    // The second instrument reached the end of the data and stayed profitable.
    assert.equal(byTicker.BBB.reason, "eod");
    assert.ok(byTicker.BBB.pnl > 0);
});

test("equity is marked once per minute, not per candle", async () => {
    const broker = makeBroker({ aaa: [100, 100, 98, 96, 94], bbb: [50, 50, 49, 48, 47] });
    const strategy = new ShortBoth(new StreamingCandleSink(), 10000, 0.0005);
    await run(broker, strategy);
    // 5 minutes × 2 instruments = 10 candles, but there must be 5 equity marks.
    assert.equal(broker.exec.equity.length, 5);
    assert.equal(broker.exec.timeline.length, 5);
    assert.ok(broker.exec.equity.every((v) => Number.isFinite(v) && v > 0));
});

test("one instrument — one position: a repeated order for a busy one is refused", async () => {
    // An exchange constraint, not a policy: one net position per instrument.
    const broker = makeBroker({ aaa: [100, 100, 98, 96, 94], bbb: [50, 50, 49, 48, 47] });
    const strategy = new ShortBoth(new StreamingCandleSink(), 10000, 0.0005);
    strategy.tickers = ["AAA", "AAA", "BBB"];
    const report = await run(broker, strategy);
    assert.equal(report.trade_log.length, 2, "AAA must not open twice");
});

test("how many instruments to hold and for how much is the strategy's decision", async () => {
    const prices = { aaa: [100, 100, 98, 96, 94], bbb: [50, 50, 49, 48, 47] };
    const withOne = new ShortBoth(new StreamingCandleSink(), 10000, 0.0005);
    withOne.maxPositions = 1;
    const one = await run(makeBroker(prices), withOne);
    const two = await run(makeBroker(prices), new ShortBoth(new StreamingCandleSink(), 10000, 0.0005));

    assert.equal(one.trade_log.length, 1, "the strategy itself did not open a second one");
    assert.equal(one.trade_log[0].ticker, "AAA");
    // One position takes all the equity, two split it — a twofold difference.
    const sizeOf = (report, ticker) => report.trade_log.find((t) => t.ticker === ticker).size;
    assert.ok(sizeOf(one, "AAA") >= 2 * sizeOf(two, "AAA"),
        `1 position: ${sizeOf(one, "AAA")}, 2 positions: ${sizeOf(two, "AAA")}`);
});

test("the executor does not impose an allocation: without a budget all the cash is used", async () => {
    const broker = makeBroker({ aaa: [100, 100, 98, 96, 94], bbb: [50, 50, 49, 48, 47] });
    const strategy = new ShortBoth(new StreamingCandleSink(), 10000, 0.0005);
    strategy.tickers = ["AAA"];
    // Replace the order with one "without an amount" — that is what single-ticker strategies do.
    const original = broker.exec.sell.bind(broker.exec);
    broker.exec.sell = ({ budget, ...order }) => original(order);
    const report = await run(broker, strategy);
    assert.equal(report.trade_log.length, 1);
    assert.ok(report.trade_log[0].size * 100 >= 9000, "the size is computed from all the cash");
});

test("the report names the run's universe", async () => {
    const broker = makeBroker({ aaa: [100, 100, 98, 96, 94], bbb: [50, 50, 49, 48, 47] });
    const report = await run(broker, new ShortBoth(new StreamingCandleSink(), 10000, 0.0005));
    assert.deepEqual(report.backtest_parameters.symbols, ["AAA", "BBB"]);
    assert.ok(Number.isFinite(report.performance_metrics.returnPct));
    assert.equal(report.performance_metrics.tradesCount, 2);
});

test("closeAtLast closes at once at the last trade price and drops the pending order", () => {
    const broker = makeBroker({ aaa: [100, 101, 102, 103], bbb: [50, 50, 50, 50] });
    const exec = broker.exec;
    const aaa = bars("AAA", [100, 101, 102, 103]);
    exec.setCurrentCandle(aaa[0]);
    assert.equal(exec.buy({ ticker: "AAA", budget: 5000 }), true);
    exec.setCurrentCandle(aaa[1]);                       // fill at open 101
    const position = exec.getPositionOf("AAA");
    assert.equal(position?.entryPrice, 101);
    exec.setCurrentCandle(aaa[2]);                       // the instrument's last candle: close 102
    exec.closePosition("time", "AAA");                   // an ordinary exit would wait for the next candle
    assert.deepEqual(exec.getPendingTickers(), ["AAA"]);
    const trade = exec.closeAtLast("time", "AAA", new Date(base + 10 * MIN));
    assert.equal(trade.exitPrice, 102);
    assert.equal(trade.exitTime.getTime(), base + 10 * MIN);
    assert.equal(exec.getPositionOf("AAA"), null);
    assert.deepEqual(exec.getPendingTickers(), []);
    exec.setCurrentCandle(aaa[3]);                       // the next candle no longer fills anything
    assert.equal(exec.getPositions().length, 0);
    assert.equal(exec.closeAtLast("time", "AAA"), null);
});

test("slippage: a market order fills against itself, a stop at the level", () => {
    const broker = makeBroker({ aaa: [100, 100, 100, 100, 100], bbb: [50, 50, 50, 50, 50], slippage: 0.01 });
    const exec = broker.exec;
    const aaa = bars("AAA", [100, 100, 100, 100, 100]);
    const bbb = bars("BBB", [50, 50, 50, 50, 50]);
    exec.setCurrentCandle(aaa[0]);
    exec.sell({ ticker: "AAA", budget: 3000 });
    exec.setCurrentCandle(bbb[0]);
    exec.buy({ ticker: "BBB", budget: 3000, sl: 45 });
    exec.setCurrentCandle(aaa[1]);                       // short sold 1% below the open
    exec.setCurrentCandle(bbb[1]);                       // long bought 1% above the open
    assert.equal(exec.getPositionOf("AAA").entryPrice.toFixed(4), "99.0000");
    assert.equal(exec.getPositionOf("BBB").entryPrice.toFixed(4), "50.5000");

    exec.closePosition("signal", "AAA");
    exec.setCurrentCandle(aaa[2]);                       // short covered 1% above the open
    const covered = broker.portfolio.trades.find((t) => t.ticker === "AAA");
    assert.equal(covered.exitPrice.toFixed(4), "101.0000");

    // The stop is touched intrabar: it fills exactly at the level, no slippage.
    const stopped = exec.checkStops({ ...bbb[2], low: 44 });
    assert.equal(stopped.exitPrice, 45);
    assert.equal(stopped.reason, "sl");
});

test("slippage is off by default and shows in the report", async () => {
    const broker = makeBroker({ aaa: [100, 100, 98, 96, 94], bbb: [50, 50, 49, 48, 47] });
    const report = await run(broker, new ShortBoth(new StreamingCandleSink(), 10000, 0.0005));
    assert.equal(report.backtest_parameters.slippage, 0);
    assert.equal(report.trade_log.find((t) => t.ticker === "AAA").entryPrice, 100);
});

/** Candle of AAA at minute i with explicit OHLC. */
const ohlc = (i, open, high, low, close) => ({
    datetime: new Date(base + i * MIN), open, high, low, close, volume: 1000, ticker: "AAA",
});

/** Short AAA on the decision candle with a limit entry; returns the executor. */
function limitShort({ ttl = 2, fallback = "cancel", slippage = 0, strict = false } = {}) {
    const broker = makeBroker({
        aaa: [100], bbb: [50], slippage, entryLimitTtl: ttl, entryLimitFallback: fallback, entryLimitStrict: strict,
    });
    const exec = broker.exec;
    exec.setCurrentCandle(ohlc(0, 100, 100, 100, 100));  // decision candle, close 100 = the limit
    exec.sell({ ticker: "AAA", budget: 3000 });
    return exec;
}

test("entry limit: an open already past the limit fills at the open, without slippage", () => {
    const exec = limitShort({ slippage: 0.01 });
    exec.setCurrentCandle(ohlc(1, 101, 101, 99, 99));
    assert.equal(exec.getPositionOf("AAA").entryPrice, 101);
});

test("entry limit: on the first candle a touch fills only when the candle closes at the limit", () => {
    let exec = limitShort();
    exec.setCurrentCandle(ohlc(1, 99, 101, 98, 98));     // the high may have come before the order
    assert.equal(exec.getPositionOf("AAA"), null);
    assert.deepEqual(exec.getPendingTickers(), ["AAA"]);

    exec = limitShort();
    exec.setCurrentCandle(ohlc(1, 99, 101, 98, 100));    // closes at the limit — filled at it
    assert.equal(exec.getPositionOf("AAA").entryPrice, 100);
});

test("entry limit: on a later candle the range must go strictly past the limit", () => {
    const exec = limitShort({ ttl: 3 });
    exec.setCurrentCandle(ohlc(1, 99, 99, 98, 98));
    exec.setCurrentCandle(ohlc(2, 98, 100, 97, 97));     // a touch only — the queue may not reach us
    assert.equal(exec.getPositionOf("AAA"), null);
    exec.setCurrentCandle(ohlc(3, 98, 100.5, 97, 97));
    assert.equal(exec.getPositionOf("AAA").entryPrice, 100);
});

test("entry limit: cancelled after its lifetime, or turned into a market order", () => {
    let exec = limitShort({ ttl: 1 });
    exec.setCurrentCandle(ohlc(1, 99, 99, 98, 98));
    assert.deepEqual(exec.getPendingTickers(), [], "expired and cancelled");
    exec.setCurrentCandle(ohlc(2, 101, 102, 100, 101));
    assert.equal(exec.getPositionOf("AAA"), null);

    exec = limitShort({ ttl: 1, fallback: "market", slippage: 0.01 });
    exec.setCurrentCandle(ohlc(1, 99, 99, 98, 98));
    assert.deepEqual(exec.getPendingTickers(), ["AAA"], "still pending, now as a market order");
    exec.setCurrentCandle(ohlc(2, 97, 98, 96, 96));
    assert.equal(exec.getPositionOf("AAA").entryPrice.toFixed(4), (97 * 0.99).toFixed(4), "market fill pays slippage");
});

test("entry limit, strict: the first candle never fills at its open", () => {
    let exec = limitShort({ strict: true });
    exec.setCurrentCandle(ohlc(1, 101, 101, 99, 99));    // opened past the limit, closed below it
    assert.equal(exec.getPositionOf("AAA"), null);

    exec = limitShort({ strict: true });
    exec.setCurrentCandle(ohlc(1, 101, 102, 100, 101));  // closed past the limit — filled at the limit
    assert.equal(exec.getPositionOf("AAA").entryPrice, 100);
});
