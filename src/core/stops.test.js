import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateStops, evaluateIntrabarStop } from "./stops.js";

const bar = (high, low) => ({ high, low, close: (high + low) / 2 });

test("intrabar short: SL triggers when high touches level (even if close reverts)", () => {
    const pos = { side: "short", sl: 102, tp: 98 };
    // Коснулись 102 хвостом, но закрылись в коридоре (100) — close-проверка
    // молчала бы, интрабар обязан сработать.
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
    // Свеча задела и 102 (sl), и 98 (tp) — приоритет SL.
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
