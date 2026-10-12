import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "./engine.js";
import { Strategy } from "./strategy.js";

const MIN = 60_000;
const t0 = Date.UTC(2026, 0, 5, 7, 0);
const candle = (n, close = 100) => ({ n, datetime: new Date(t0 + n * MIN), open: close, high: close, low: close, close });

/**
 * Broker stub: a stream of the given candles and an executor that records every engine
 * call into a shared journal — the tick order is checked against it.
 */
function makeBroker(candles, { intrabarStops = false, position = null, hooks = true } = {}) {
    const calls = [];
    const exec = {
        intrabarStops,
        position,
        setCurrentCandle: (c) => calls.push(`candle:${c.n}`),
        getPosition: () => exec.position,
        checkStops: (c) => calls.push(`checkStops:${c.n}`),
        closePosition: (reason) => { calls.push(`close:${reason}`); exec.position = null; },
        syncStrategyState: (s) => { s._position = exec.position; calls.push("sync"); },
    };
    if (hooks) {
        exec.init = async () => calls.push("exec.init");
        exec.drainOrders = async () => calls.push("drain");
    }
    const broker = {
        data: { async *stream() { yield* candles; } },
        exec,
        finalize: () => ({ finalized: true }),
    };
    return { broker, calls };
}

/** A strategy that only records itself in the journal. */
function probe(calls, data = []) {
    return new (class extends Strategy {
        init() { calls.push("strategy.init"); }
        next(c) { calls.push(`next:${c.n}`); }
    })(data);
}

const context = (calls) => ({ setNow: (d) => calls.push(`now:${(d.getTime() - t0) / MIN}`) });

test("tick: initialization, then for every candle — time, candle, decision, sync, orders", async () => {
    const { broker, calls } = makeBroker([candle(0), candle(1)]);
    const result = await new Engine().run({ broker, strategy: probe(calls), context: context(calls) });

    assert.deepEqual(calls, [
        "exec.init", "strategy.init",
        "now:0", "candle:0", "next:0", "sync", "drain",
        "now:1", "candle:1", "next:1", "sync", "drain",
    ]);
    assert.deepEqual(result, { finalized: true }, "the end of the stream returns finalize's result");
});

test("a close-based stop fires before the strategy decides", async () => {
    const position = { side: "short", sl: 105, tp: null };
    const { broker, calls } = makeBroker([candle(0, 106)], { position });
    await new Engine().run({ broker, strategy: probe(calls), context: context(calls) });

    assert.ok(calls.indexOf("close:sl") < calls.indexOf("next:0"), calls.join(" "));
});

test("in intrabar mode the executor checks stops, there is no close-based check", async () => {
    const position = { side: "short", sl: 105, tp: null };
    const { broker, calls } = makeBroker([candle(0, 106)], { intrabarStops: true, position });
    await new Engine().run({ broker, strategy: probe(calls), context: context(calls) });

    assert.ok(calls.includes("checkStops:0"));
    assert.ok(!calls.some((c) => c.startsWith("close:")), "no close-based exit happens");
});

test("a deadline closes the position with reason time", async () => {
    const position = { side: "short", sl: 200, tp: null, exitDeadline: t0 + MIN };
    const { broker, calls } = makeBroker([candle(0), candle(1)], { position });
    await new Engine().run({ broker, strategy: probe(calls), context: context(calls) });

    assert.deepEqual(calls.filter((c) => c.startsWith("close:")), ["close:time"]);
    assert.ok(calls.indexOf("close:time") > calls.indexOf("candle:1"), "not before the deadline");
});

test("a stop and a deadline in one tick — one close, by the stop", async () => {
    const position = { side: "short", sl: 105, tp: null, exitDeadline: t0 };
    const { broker, calls } = makeBroker([candle(0, 106)], { position });
    await new Engine().run({ broker, strategy: probe(calls), context: context(calls) });

    assert.deepEqual(calls.filter((c) => c.startsWith("close:")), ["close:sl"]);
});

test("history accumulates in this.data only when the run did not preload it", async () => {
    const live = makeBroker([candle(0), candle(1)]);
    const growing = probe(live.calls, []);
    await new Engine().run({ broker: live.broker, strategy: growing });
    assert.deepEqual(growing.data.map((c) => c.n), [0, 1], "live: candles are appended");

    const preloaded = [candle(0), candle(1)];
    const backtest = makeBroker(preloaded);
    const replay = probe(backtest.calls, preloaded);
    await new Engine().run({ broker: backtest.broker, strategy: replay });
    assert.equal(replay.data.length, 2, "backtest: the listing is already complete, no duplicates");
    assert.equal(replay.getDataIndex(), 1);
});

test("the executor's init and drainOrders are optional", async () => {
    const { broker, calls } = makeBroker([candle(0)], { hooks: false });
    await new Engine().run({ broker, strategy: probe(calls) });
    assert.deepEqual(calls, ["strategy.init", "candle:0", "next:0", "sync"]);
});
