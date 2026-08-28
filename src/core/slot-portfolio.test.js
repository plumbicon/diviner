import { test } from "node:test";
import assert from "node:assert/strict";
import { Portfolio } from "./portfolio.js";
import { SlotPortfolio } from "./slot-portfolio.js";

const bar = (price, ts = 0) => ({
    datetime: new Date(ts), open: price, high: price, low: price, close: price, volume: 0,
});

test("slots=1 совпадает с однопозиционным Portfolio цифра в цифру", () => {
    // Один и тот же сценарий: серия шортов с разными ценами входа/выхода,
    // включая лот 10 (округление вниз) и нецелые цены.
    const script = [
        [57.57, 56.10], [612.95, 592.11], [18.66, 18.90], [310.55, 305.02], [1.23, 1.19],
    ];
    for (const lot of [1, 10, 100]) {
        const legacy = new Portfolio({ cash: 10000, commission: 0.0005, lot, leverage: 1 });
        const slotted = new SlotPortfolio({ cash: 10000, commission: 0.0005, slots: 1, leverage: 1 });
        for (const [entry, exit] of script) {
            legacy.openShort({ candle: bar(entry) });
            slotted.open(0, { price: entry, datetime: new Date(0), ticker: "X", lot,
                budget: slotted.budgetFor(slotted.equity(() => null)) });
            legacy.closePosition({ candle: bar(exit) });
            slotted.close(0, { price: exit, datetime: new Date(1) });
        }
        assert.equal(slotted.cash.toFixed(10), legacy.cash.toFixed(10), `cash @lot=${lot}`);
        assert.equal(slotted.trades.length, legacy.trades.length);
        for (let i = 0; i < legacy.trades.length; i += 1) {
            assert.equal(slotted.trades[i].size, legacy.trades[i].size, `size #${i} @lot=${lot}`);
            assert.equal(slotted.trades[i].pnl.toFixed(10), legacy.trades[i].pnl.toFixed(10), `pnl #${i} @lot=${lot}`);
        }
    }
});

test("slots=1 совпадает и с плечом", () => {
    const legacy = new Portfolio({ cash: 10000, commission: 0.0005, lot: 10, leverage: 4 });
    const slotted = new SlotPortfolio({ cash: 10000, commission: 0.0005, slots: 1, leverage: 4 });
    legacy.openShort({ candle: bar(57.57) });
    slotted.open(0, { price: 57.57, datetime: new Date(0), ticker: "X", lot: 10,
        budget: slotted.budgetFor(slotted.equity(() => null)) });
    assert.equal(slotted.positions[0].size, legacy.position.size);
    assert.equal(slotted.cash.toFixed(10), legacy.cash.toFixed(10));
    legacy.closePosition({ candle: bar(55) });
    slotted.close(0, { price: 55, datetime: new Date(1) });
    assert.equal(slotted.trades[0].pnl.toFixed(10), legacy.trades[0].pnl.toFixed(10));
});

test("k слотов делят капитал и не превышают кассу", () => {
    const pf = new SlotPortfolio({ cash: 10000, commission: 0.0005, slots: 4 });
    for (let i = 0; i < 4; i += 1) {
        const budget = pf.budgetFor(pf.equity(() => null));
        assert.ok(budget <= 2500 + 1e-9, `бюджет слота ${i} = ${budget}`);
        assert.ok(pf.open(i, { price: 100, datetime: new Date(0), ticker: `T${i}`, lot: 1, budget }));
    }
    assert.equal(pf.openCount, 4);
    assert.ok(pf.cash >= 0, "касса не уходит в минус");
    // Пятый вход некуда положить.
    assert.equal(pf.freeSlot(), -1);
});

test("лот берётся у инструмента сделки, а не общий на портфель", () => {
    const pf = new SlotPortfolio({ cash: 10000, commission: 0.0005, slots: 2 });
    pf.open(0, { price: 100, datetime: new Date(0), ticker: "LOT1", lot: 1, budget: 5000 });
    pf.open(1, { price: 100, datetime: new Date(0), ticker: "LOT10", lot: 10, budget: 5000 });
    assert.equal(pf.positions[0].size % 1, 0);
    assert.equal(pf.positions[1].size % 10, 0, "размер кратен лоту инструмента");
});

test("positionOf находит слот по бумаге, equity считает по всем", () => {
    const pf = new SlotPortfolio({ cash: 10000, commission: 0.0005, slots: 2 });
    pf.open(0, { price: 100, datetime: new Date(0), ticker: "AAA", lot: 1, budget: 5000 });
    pf.open(1, { price: 50, datetime: new Date(0), ticker: "BBB", lot: 1, budget: 5000 });
    assert.equal(pf.positionOf("BBB").slot, 1);
    assert.equal(pf.positionOf("ZZZ"), null);
    // Обе бумаги упали на 10% — шорт в плюсе на обе.
    const withMove = pf.equity((slot) => (slot === 0 ? 90 : 45));
    const flat = pf.equity((slot, position) => position.entryPrice);
    assert.ok(withMove > flat);
});

test("закрытие освобождает слот и пишет сделку с тикером и причиной", () => {
    const pf = new SlotPortfolio({ cash: 10000, commission: 0.0005, slots: 2 });
    pf.open(0, { price: 100, datetime: new Date(0), ticker: "AAA", lot: 1, budget: 5000 });
    const trade = pf.close(0, { price: 95, datetime: new Date(60_000), reason: "sl" });
    assert.equal(trade.ticker, "AAA");
    assert.equal(trade.reason, "sl");
    assert.ok(trade.pnl > 0, "шорт со 100 до 95 прибылен");
    assert.equal(pf.positions[0], null);
    assert.equal(pf.freeSlot(), 0);
});
