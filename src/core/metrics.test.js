import { test } from "node:test";
import assert from "node:assert/strict";
import { PerformanceMetrics } from "./metrics.js";

const DAY = 24 * 60 * 60 * 1000;

/** Report for an equity curve: one candle per day, no trades. */
function report(equity, initialCash = 100) {
    const data = equity.map((_, i) => ({ datetime: new Date(Date.UTC(2026, 0, 1) + i * DAY), close: 1 }));
    return new PerformanceMetrics({ data, equity, trades: [], initialCash }).compile();
}

test("drawdown is measured from the peak before it, not from the run's maximum", () => {
    // 100 → 90 at the start (−10%), then a rise to 300 and a fall to 280 (−6.7%, but 20 in money).
    const m = report([100, 90, 150, 300, 280, 290]);
    assert.equal(m.maxDrawdownPct, 10, "an early −10% drawdown does not dissolve in the final peak");
    assert.equal(m.maxDrawdown, 20, "in money — the deepest, the late one");
});

test("a late drawdown from a higher peak is visible too", () => {
    const m = report([100, 110, 99, 200, 150]);
    assert.equal(m.maxDrawdownPct, 25, "200 → 150");
    assert.equal(m.maxDrawdown, 50);
});

test("a drawdown from the first candle is measured from the starting capital", () => {
    const m = report([95, 97, 120]);
    assert.equal(m.maxDrawdownPct, 5);
    assert.equal(m.maxDrawdown, 5);
});

test("a curve without falls — zero drawdown, Calmar undefined", () => {
    const m = report([100, 105, 110, 120]);
    assert.equal(m.maxDrawdownPct, 0);
    assert.equal(m.maxDrawdown, 0);
    assert.equal(m.calmar, null);
    assert.equal(m.returnOnMaxDD, null);
});

test("Calmar and return-over-drawdown divide by the drawdown percentage from the peak", () => {
    const m = report([100, 90, 150, 300, 280, 290]);
    assert.equal(m.returnPct, 190);
    assert.equal(m.returnOnMaxDD, 19, "190% / 10%");
    assert.equal(m.calmar, Math.round((m.annualizedReturnPct / 10) * 100) / 100);
});
