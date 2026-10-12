import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateStops, evaluateIntrabarStop, classifyStopExit } from "./stops.js";

const bar = (high, low) => ({ high, low, close: (high + low) / 2 });

test("intrabar short: SL triggers when high touches level (even if close reverts)", () => {
    const pos = { side: "short", sl: 102, tp: 98 };
    // The wick touched 102 but the candle closed inside the range (100) — a close-based
    // check would stay silent, the intrabar check must fire.
    assert.equal(evaluateStops(pos, 100), null);
    assert.equal(evaluateIntrabarStop(pos, bar(102, 99)), "sl");
});

test("intrabar short: TP triggers when low touches level", () => {
    const pos = { side: "short", sl: 102, tp: 98 };
    assert.equal(evaluateIntrabarStop(pos, bar(101, 98)), "tp");
});

test("intrabar long: SL on low, TP on high", () => {
    const pos = { side: "long", sl: 98, tp: 102 };
    assert.equal(evaluateIntrabarStop(pos, bar(100, 98)), "sl");
    assert.equal(evaluateIntrabarStop(pos, bar(102, 100)), "tp");
});

test("double touch in one bar → SL wins (pessimistic)", () => {
    const shortPos = { side: "short", sl: 102, tp: 98 };
    // The candle touched both 102 (sl) and 98 (tp) — SL wins.
    assert.equal(evaluateIntrabarStop(shortPos, bar(103, 97)), "sl");
    const longPos = { side: "long", sl: 98, tp: 102 };
    assert.equal(evaluateIntrabarStop(longPos, bar(103, 97)), "sl");
});

test("no touch → null; no position/candle → null", () => {
    const pos = { side: "short", sl: 102, tp: 98 };
    assert.equal(evaluateIntrabarStop(pos, bar(101, 99)), null);
    assert.equal(evaluateIntrabarStop(null, bar(103, 97)), null);
    assert.equal(evaluateIntrabarStop(pos, null), null);
});

test("a trailing stop is told from a protective stop by the level's position", () => {
    // Short: the protective stop is above the entry, the trailing stop arms only after a favourable move.
    assert.equal(classifyStopExit({ side: "short", entryPrice: 100, sl: 105 }), "sl");
    assert.equal(classifyStopExit({ side: "short", entryPrice: 100, sl: 98 }), "trail");
    // Long — mirrored.
    assert.equal(classifyStopExit({ side: "long", entryPrice: 100, sl: 95 }), "sl");
    assert.equal(classifyStopExit({ side: "long", entryPrice: 100, sl: 102 }), "trail");
    // Without a level or an entry there is nothing to judge — stay with the conservative "sl".
    assert.equal(classifyStopExit({ side: "short", entryPrice: 100, sl: null }), "sl");
    assert.equal(classifyStopExit(null), "sl");
});
