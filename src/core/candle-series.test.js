import { test } from "node:test";
import assert from "node:assert/strict";
import { CandleSeries, CandleSeriesBuilder } from "./candle-series.js";

const candle = (ms, price, ticker) => ({
    datetime: new Date(ms), open: price, high: price + 1, low: price - 1,
    close: price + 0.5, volume: price * 10, ...(ticker ? { ticker } : {}),
});

const sample = [
    candle(1_000, 10, "AAA"),
    candle(2_000, 20, "BBB"),
    candle(2_000, 30, "AAA"),
    candle(3_000, 40, "BBB"),
];

test("at() воспроизводит свечу-объект поле в поле", () => {
    const series = CandleSeries.from(sample);
    assert.equal(series.length, sample.length);
    for (let i = 0; i < sample.length; i += 1) {
        const got = series.at(i);
        const want = sample[i];
        assert.equal(got.datetime.getTime(), want.datetime.getTime());
        for (const field of ["open", "high", "low", "close", "volume", "ticker"]) {
            assert.equal(got[field], want[field], `${field} @${i}`);
        }
    }
});

test("отрицательный индекс и выход за границы — как у Array.at", () => {
    const series = CandleSeries.from(sample);
    assert.equal(series.at(-1).close, sample.at(-1).close);
    assert.equal(series.at(-4).close, sample.at(-4).close);
    assert.equal(series.at(4), undefined);
    assert.equal(series.at(-5), undefined);
});

test("slice() — представление без копирования, семантика Array.slice", () => {
    const series = CandleSeries.from(sample);
    const view = series.slice(1, 3);
    assert.equal(view.length, 2);
    assert.equal(view.at(0).close, sample[1].close);
    assert.equal(view.at(1).ticker, sample[2].ticker);
    // Out-of-range and negative bounds — same as Array.
    assert.equal(series.slice(2).length, 2);
    assert.equal(series.slice(-2).length, 2);
    assert.equal(series.slice(3, 1).length, 0);
    assert.equal(series.slice(0, 99).length, 4);
    // A slice of a slice stays consistent.
    assert.equal(view.slice(1).at(0).close, sample[2].close);
});

test("итератор обходит серию в порядке индексов", () => {
    const series = CandleSeries.from(sample);
    assert.deepEqual([...series].map((c) => c.close), sample.map((c) => c.close));
});

test("двоичный поиск по времени", () => {
    const series = CandleSeries.from(sample);
    assert.equal(series.lowerBound(2_000), 1);   // the first candle exactly at 2000
    assert.equal(series.upperBound(2_000), 3);   // the first one strictly after 2000
    assert.equal(series.lowerBound(0), 0);
    assert.equal(series.lowerBound(9_999), 4);
    assert.equal(series.upperBound(0), 0);
});

test("серия без тикеров не заводит колонку символов", () => {
    const series = CandleSeries.from([candle(1_000, 10), candle(2_000, 20)]);
    assert.equal(series.sym, null);
    assert.equal(series.at(0).ticker, undefined);
});

test("накопитель переживает рост ёмкости без потери данных", () => {
    const builder = new CandleSeriesBuilder({ capacity: 2 });
    const many = Array.from({ length: 1_000 }, (_, i) => candle(i * 60_000, i + 1, i % 2 ? "AAA" : "BBB"));
    for (const c of many) builder.push(c);
    const series = builder.build();
    assert.equal(series.length, 1_000);
    assert.equal(series.at(0).close, many[0].close);
    assert.equal(series.at(999).close, many[999].close);
    assert.equal(series.at(999).ticker, many[999].ticker);
    assert.equal(series.symbols.length, 2);
});

test("at() отдаёт свежий объект — потребитель может его хранить и править", () => {
    const series = CandleSeries.from(sample);
    const first = series.at(0);
    first.close = -1;
    assert.equal(series.at(0).close, sample[0].close);
});
