import { test } from "node:test";
import assert from "node:assert/strict";
import { SimulatedDataSource } from "./broker.js";
import { CandleSeries } from "../../core/candle-series.js";

const MIN = 60_000;
const base = Date.UTC(2026, 0, 5, 4, 0);   // 07:00 МСК, понедельник

/** Минутные свечи одной бумаги: n штук подряд от `startMin`. */
const minutes = (ticker, startMin, n, price) => Array.from({ length: n }, (_, i) => ({
    datetime: new Date(base + (startMin + i) * MIN),
    open: price + i, high: price + i + 1, low: price + i - 1, close: price + i + 0.5,
    volume: 100 + i, ticker,
}));

function multiSource() {
    // AAA открывается на 10 минут раньше BBB — расписание у бумаг обязано отличаться.
    const bySymbol = new Map([
        ["AAA", new Map([[1, CandleSeries.from(minutes("AAA", 0, 30, 100))]])],
        ["BBB", new Map([[1, CandleSeries.from(minutes("BBB", 10, 20, 200))]])],
    ]);
    return new SimulatedDataSource({
        candles: null, series: null, metadata: { intervalMinutes: 1 },
        bySymbol, symbols: ["AAA", "BBB"],
        instruments: new Map([["AAA", { ticker: "AAA", lot: 10 }], ["BBB", { ticker: "BBB", lot: 1 }]]),
        *mergeStream(m) {
            const heads = [...bySymbol].map(([t, s]) => ({ t, s: s.get(m), i: 0 }));
            for (;;) {
                let best = -1;
                for (let k = 0; k < heads.length; k += 1) {
                    const h = heads[k];
                    if (h.i >= h.s.length) continue;
                    if (best < 0 || h.s.tsAt(h.i) < heads[best].s.tsAt(heads[best].i)) best = k;
                }
                if (best < 0) return;
                yield heads[best].s.at(heads[best].i++);
            }
        },
    });
}

test("история отдаётся по запрошенной бумаге", async () => {
    const src = multiSource();
    const aaa = await src.getHistory({ ticker: "AAA", interval: "1m" });
    const bbb = await src.getHistory({ ticker: "BBB", interval: "1m" });
    assert.equal(aaa.length, 30);
    assert.equal(bbb.length, 20);
    assert.ok(aaa.every((c) => c.ticker === "AAA"));
    assert.ok(bbb.every((c) => c.ticker === "BBB"));
    assert.equal(bbb[0].close, 200.5);
});

test("окно from/to режется двоичным поиском по колонкам", async () => {
    const src = multiSource();
    const slice = await src.getHistory({
        ticker: "AAA", interval: "1m",
        from: new Date(base + 5 * MIN), to: new Date(base + 8 * MIN),
    });
    assert.deepEqual(slice.map((c) => c.datetime.getTime() - base).map((v) => v / MIN), [5, 6, 7]);
});

test("мультитикерный датасет требует явного тикера", async () => {
    const src = multiSource();
    await assert.rejects(() => src.getHistory({ interval: "1m" }), /needs an explicit ticker/);
});

test("неизвестный тикер называет доступные", async () => {
    const src = multiSource();
    await assert.rejects(() => src.getHistory({ ticker: "ZZZ", interval: "1m" }), /no candles for ZZZ/);
});

test("расписание выводится из свечей конкретной бумаги", async () => {
    const src = multiSource();
    const aaa = await src.getTradingSchedule({ ticker: "AAA" });
    const bbb = await src.getTradingSchedule({ ticker: "BBB" });
    assert.equal(aaa.length, 1);
    assert.equal(new Date(aaa[0].startTime).getTime(), base);
    // BBB открывается на 10 минут позже — общее расписание вселенной здесь соврало бы.
    assert.equal(new Date(bbb[0].startTime).getTime(), base + 10 * MIN);
});

test("поток слияния идёт по возрастанию времени и несёт тикер", async () => {
    const src = multiSource();
    const out = [];
    for await (const candle of src.stream()) out.push(candle);
    assert.equal(out.length, 50);
    assert.ok(out.every((c, i) => i === 0 || out[i - 1].datetime <= c.datetime));
    assert.equal(out[0].ticker, "AAA");
    assert.ok(out.some((c) => c.ticker === "BBB"));
});

test("инструмент берётся по бумаге, а не из общих метаданных", () => {
    const src = multiSource();
    assert.equal(src.getInstrument("AAA").lot, 10);
    assert.equal(src.getInstrument("BBB").lot, 1);
    assert.deepEqual(src.getSymbols(), ["AAA", "BBB"]);
});
