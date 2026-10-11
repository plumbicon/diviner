import { test } from "node:test";
import assert from "node:assert/strict";
import { PerformanceMetrics } from "./metrics.js";

const DAY = 24 * 60 * 60 * 1000;

/** Отчёт по кривой капитала: одна свеча в день, сделок нет. */
function report(equity, initialCash = 100) {
    const data = equity.map((_, i) => ({ datetime: new Date(Date.UTC(2026, 0, 1) + i * DAY), close: 1 }));
    return new PerformanceMetrics({ data, equity, trades: [], initialCash }).compile();
}

test("просадка считается от пика перед ней, а не от максимума прогона", () => {
    // 100 → 90 в начале (−10%), потом рост до 300 и падение до 280 (−6.7%, но 20 в деньгах).
    const m = report([100, 90, 150, 300, 280, 290]);
    assert.equal(m.maxDrawdownPct, 10, "ранняя просадка −10% не растворяется в финальном пике");
    assert.equal(m.maxDrawdown, 20, "в деньгах — самая глубокая, поздняя");
});

test("поздняя просадка от большего пика тоже видна", () => {
    const m = report([100, 110, 99, 200, 150]);
    assert.equal(m.maxDrawdownPct, 25, "200 → 150");
    assert.equal(m.maxDrawdown, 50);
});

test("просадка с первой свечи отсчитывается от стартового капитала", () => {
    const m = report([95, 97, 120]);
    assert.equal(m.maxDrawdownPct, 5);
    assert.equal(m.maxDrawdown, 5);
});

test("кривая без падений — нулевая просадка, Calmar не определён", () => {
    const m = report([100, 105, 110, 120]);
    assert.equal(m.maxDrawdownPct, 0);
    assert.equal(m.maxDrawdown, 0);
    assert.equal(m.calmar, null);
    assert.equal(m.returnOnMaxDD, null);
});

test("Calmar и доходность на просадку делятся на процент просадки от пика", () => {
    const m = report([100, 90, 150, 300, 280, 290]);
    assert.equal(m.returnPct, 190);
    assert.equal(m.returnOnMaxDD, 19, "190% / 10%");
    assert.equal(m.calmar, Math.round((m.annualizedReturnPct / 10) * 100) / 100);
});
