import { test } from "node:test";
import assert from "node:assert/strict";
import { TemporalView } from "./temporal-view.js";
import { SimulatedDataSource } from "../broker/simulated/broker.js";

const MIN = 60_000;
const at = (iso) => new Date(iso);
const bar = (iso, close) => ({ datetime: at(iso), open: close, high: close, low: close, close, volume: 1 });

/**
 * A listing with three intervals, as fetch.js stores it. A daily candle is stamped at UTC
 * midnight but means a Moscow day — its period ends at 00:00 Moscow the next day.
 */
function context() {
    const series = new Map([
        [1, ["07:00", "07:01", "07:02", "07:03", "07:04", "07:05"]
            .map((hm, i) => bar(`2026-01-06T${hm}:00.000Z`, 100 + i))],
        [60, [bar("2026-01-06T07:00:00.000Z", 110), bar("2026-01-06T08:00:00.000Z", 111)]],
        [1440, [bar("2026-01-05T00:00:00.000Z", 90), bar("2026-01-06T00:00:00.000Z", 91)]],
    ]);
    const dataSource = new SimulatedDataSource({
        candles: series.get(1), series, metadata: { ticker: "DEMO", intervalMinutes: 1 },
    });
    return new TemporalView({ dataSource, metadata: dataSource.metadata });
}

const times = (candles) => candles.map((c) => c.datetime.toISOString().slice(0, 16));

test("minute candles — up to the current one inclusive, none from the future", async () => {
    const view = context();
    view.setNow(at("2026-01-06T07:03:00.000Z"));
    const candles = await view.getCandles({ interval: "1m" });
    assert.deepEqual(times(candles), ["2026-01-06T07:00", "2026-01-06T07:01", "2026-01-06T07:02", "2026-01-06T07:03"]);
});

test("an hourly candle is visible only after its hour ends", async () => {
    const view = context();
    view.setNow(at("2026-01-06T07:59:00.000Z"));
    assert.deepEqual(await view.getCandles({ interval: "1h" }), [], "the hour is still running — its close is unknown");
    view.setNow(at("2026-01-06T08:00:00.000Z"));
    assert.deepEqual(times(await view.getCandles({ interval: "1h" })), ["2026-01-06T07:00"]);
});

test("today's daily candle is hidden until Moscow midnight, yesterday's is visible", async () => {
    const view = context();
    view.setNow(at("2026-01-06T07:03:00.000Z"));   // 10:03 Moscow, January 6
    assert.deepEqual(times(await view.getCandles({ interval: "1d" })), ["2026-01-05T00:00"]);

    view.setNow(at("2026-01-06T20:59:00.000Z"));   // 23:59 Moscow — the day is not closed yet
    assert.equal((await view.getCandles({ interval: "1d" })).length, 1);

    view.setNow(at("2026-01-06T21:00:00.000Z"));   // 00:00 Moscow, January 7
    assert.deepEqual(times(await view.getCandles({ interval: "1d" })), ["2026-01-05T00:00", "2026-01-06T00:00"]);
});

test("a from/to window narrows the result but never extends it past the current moment", async () => {
    const view = context();
    view.setNow(at("2026-01-06T07:02:00.000Z"));
    const candles = await view.getCandles({ interval: "1m", from: at("2026-01-06T07:01:00.000Z"), to: at("2026-01-06T09:00:00.000Z") });
    assert.deepEqual(times(candles), ["2026-01-06T07:01", "2026-01-06T07:02"]);
});

test("requesting an interval missing from the file is an error, not silent aggregation", async () => {
    const view = context();
    view.setNow(at("2026-01-06T07:03:00.000Z"));
    await assert.rejects(view.getCandles({ interval: "5m" }), /stores only interval/);
});

test("before the first tick there is no current moment — history is unbounded", async () => {
    const calls = [];
    const view = new TemporalView({ dataSource: { getHistory: async (p) => { calls.push(p); return []; } } });
    await view.getCandles({ interval: "1m", ticker: "AAA" });
    assert.equal(calls[0].until, Infinity);
    assert.equal(calls[0].ticker, "AAA", "the other parameters reach the source as is");
    view.setNow(at("2026-01-06T07:03:00.000Z"));
    await view.getCandles({ interval: "1m" });
    assert.equal(calls[1].until.getTime(), at("2026-01-06T07:03:00.000Z").getTime());
});
