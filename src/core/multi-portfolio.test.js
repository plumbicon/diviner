import { test } from "node:test";
import assert from "node:assert/strict";
import { Portfolio } from "./portfolio.js";
import { MultiPortfolio } from "./multi-portfolio.js";

const bar = (price, ts = 0) => ({
    datetime: new Date(ts), open: price, high: price, low: price, close: price, volume: 0,
});

test("одна позиция с бюджетом во весь кэш совпадает с Portfolio цифра в цифру", () => {
    // Один и тот же сценарий: серия шортов с разными ценами входа/выхода,
    // включая лот 10 (округление вниз) и нецелые цены.
    const script = [
        [57.57, 56.10], [612.95, 592.11], [18.66, 18.90], [310.55, 305.02], [1.23, 1.19],
    ];
    for (const lot of [1, 10, 100]) {
        const legacy = new Portfolio({ cash: 10000, commission: 0.0005, lot, leverage: 1 });
        const slotted = new MultiPortfolio({ cash: 10000, commission: 0.0005, leverage: 1 });
        for (const [entry, exit] of script) {
            legacy.openShort({ candle: bar(entry) });
            slotted.open("X", { price: entry, datetime: new Date(0), lot, budget: slotted.cash });
            legacy.closePosition({ candle: bar(exit) });
            slotted.close("X", { price: exit, datetime: new Date(1) });
        }
        assert.equal(slotted.cash.toFixed(10), legacy.cash.toFixed(10), `cash @lot=${lot}`);
        assert.equal(slotted.trades.length, legacy.trades.length);
        for (let i = 0; i < legacy.trades.length; i += 1) {
            assert.equal(slotted.trades[i].size, legacy.trades[i].size, `size #${i} @lot=${lot}`);
            assert.equal(slotted.trades[i].pnl.toFixed(10), legacy.trades[i].pnl.toFixed(10), `pnl #${i} @lot=${lot}`);
        }
    }
});

test("совпадает и с плечом", () => {
    const legacy = new Portfolio({ cash: 10000, commission: 0.0005, lot: 10, leverage: 4 });
    const slotted = new MultiPortfolio({ cash: 10000, commission: 0.0005, leverage: 4 });
    legacy.openShort({ candle: bar(57.57) });
    slotted.open("X", { price: 57.57, datetime: new Date(0), lot: 10, budget: slotted.cash });
    assert.equal(slotted.positionOf("X").size, legacy.position.size);
    assert.equal(slotted.cash.toFixed(10), legacy.cash.toFixed(10));
    legacy.closePosition({ candle: bar(55) });
    slotted.close("X", { price: 55, datetime: new Date(1) });
    assert.equal(slotted.trades[0].pnl.toFixed(10), legacy.trades[0].pnl.toFixed(10));
});

test("без бюджета и размера берётся весь кэш — как в однопозиционном Portfolio", () => {
    const legacy = new Portfolio({ cash: 10000, commission: 0.0005, lot: 10 });
    const pf = new MultiPortfolio({ cash: 10000, commission: 0.0005 });
    legacy.openShort({ candle: bar(57.57) });
    pf.open("X", { price: 57.57, datetime: new Date(0), lot: 10 });
    assert.equal(pf.positionOf("X").size, legacy.position.size);
});

test("сумму на бумагу задаёт вызывающий; касса не уходит в минус", () => {
    // Портфель не знает про «k слотов» — делит депозит тот, кто ставит ордера.
    const pf = new MultiPortfolio({ cash: 10000, commission: 0.0005 });
    for (let i = 0; i < 4; i += 1) {
        const budget = pf.equity(() => null) / 4;
        assert.ok(pf.open(`T${i}`, { price: 100, datetime: new Date(0), lot: 1, budget }));
    }
    assert.equal(pf.openCount, 4);
    assert.ok(pf.cash >= 0, "касса не уходит в минус");
});

test("повторный вход по занятой бумаге отклоняется", () => {
    const pf = new MultiPortfolio({ cash: 10000, commission: 0.0005 });
    assert.ok(pf.open("AAA", { price: 100, datetime: new Date(0), lot: 1, budget: 5000 }));
    assert.equal(pf.open("AAA", { price: 100, datetime: new Date(0), lot: 1, budget: 5000 }), null);
    assert.equal(pf.openCount, 1);
});

test("лот берётся у инструмента сделки, а не общий на портфель", () => {
    const pf = new MultiPortfolio({ cash: 10000, commission: 0.0005 });
    pf.open("LOT1", { price: 100, datetime: new Date(0), lot: 1, budget: 5000 });
    pf.open("LOT10", { price: 100, datetime: new Date(0), lot: 10, budget: 5000 });
    assert.equal(pf.positionOf("LOT1").size % 1, 0);
    assert.equal(pf.positionOf("LOT10").size % 10, 0, "размер кратен лоту инструмента");
});

test("positionOf находит позицию по бумаге, equity считает по всем", () => {
    const pf = new MultiPortfolio({ cash: 10000, commission: 0.0005 });
    pf.open("AAA", { price: 100, datetime: new Date(0), lot: 1, budget: 5000 });
    pf.open("BBB", { price: 50, datetime: new Date(0), lot: 1, budget: 5000 });
    assert.equal(pf.positionOf("BBB").entryPrice, 50);
    assert.equal(pf.positionOf("ZZZ"), null);
    // Обе бумаги упали на 10% — шорт в плюсе на обе.
    const withMove = pf.equity((ticker) => (ticker === "AAA" ? 90 : 45));
    const flat = pf.equity((_t, position) => position.entryPrice);
    assert.ok(withMove > flat);
});

test("закрытие снимает позицию и пишет сделку с тикером и причиной", () => {
    const pf = new MultiPortfolio({ cash: 10000, commission: 0.0005 });
    pf.open("AAA", { price: 100, datetime: new Date(0), lot: 1, budget: 5000 });
    const trade = pf.close("AAA", { price: 95, datetime: new Date(60_000), reason: "sl" });
    assert.equal(trade.ticker, "AAA");
    assert.equal(trade.reason, "sl");
    assert.ok(trade.pnl > 0, "шорт со 100 до 95 прибылен");
    assert.equal(pf.positionOf("AAA"), null);
    assert.equal(pf.openCount, 0);
});
