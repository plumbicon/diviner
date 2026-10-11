import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundle } from "./bundle.js";
import { loadDataset } from "./core/data-loader.js";
import { writeCandleSeriesAsParquet } from "./core/candle-parquet.js";

const bar = (iso, close) => ({ datetime: new Date(iso), open: close, high: close, low: close, close, volume: 1 });

/**
 * Два листинга, как их пишет fetch.js: минутки за 6 и 7 января и дневные за 5–7 января.
 * У BBB нет свечи в 07:01 6 января — тонкая бумага, минута без сделок.
 */
async function workspace() {
    const dir = await mkdtemp(join(tmpdir(), "diviner-bundle-"));
    const listing = async (ticker, lot, minutes, base) => {
        const path = join(dir, `${ticker}_2026_1m.parquet`);
        await writeCandleSeriesAsParquet(new Map([
            [1, minutes.map((iso, i) => bar(iso, base + i))],
            [1440, ["2026-01-05", "2026-01-06", "2026-01-07"].map((d, i) => bar(`${d}T00:00:00.000Z`, base - 10 + i))],
        ]), path, { ticker, instrument: { ticker, lot }, intervalMinutes: 1 });
        return path;
    };
    const inputs = [
        await listing("AAA", 10, ["2026-01-06T07:00:00Z", "2026-01-06T07:01:00Z", "2026-01-07T07:00:00Z"], 100),
        await listing("BBB", 1, ["2026-01-06T07:00:00Z", "2026-01-07T07:00:00Z"], 200),
    ];
    return { dir, inputs, out: join(dir, "bundle.parquet") };
}

/** Дни свечей серии: серия бандла — колоночная, обходится итератором. */
const days = (series) => [...series].map((c) => c.datetime.toISOString().slice(0, 10));

test("бандл несёт всю вселенную: тикеры, лоты по бумагам, все интервалы", async () => {
    const { dir, inputs, out } = await workspace();
    try {
        const summary = await bundle(inputs, { out });
        assert.deepEqual(summary.tickers, ["AAA", "BBB"]);
        assert.deepEqual(summary.intervals, [1, 1440]);

        const ds = await loadDataset(out);
        assert.deepEqual(ds.symbols, ["AAA", "BBB"]);
        assert.equal(ds.instruments.get("AAA").lot, 10, "лот у каждой бумаги свой");
        assert.equal(ds.instruments.get("BBB").lot, 1);
        assert.equal(ds.bySymbol.get("AAA").get(1440).length, 3, "дневные свечи на месте");
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("поток бандла идёт по времени, конец каждой минуты помечен isBatchEnd", async () => {
    const { dir, inputs, out } = await workspace();
    try {
        await bundle(inputs, { out });
        const ds = await loadDataset(out);
        const flow = [...ds.mergeStream(1)].map((c) => `${c.ticker} ${c.datetime.toISOString().slice(5, 16)} ${c.isBatchEnd}`);
        assert.deepEqual(flow, [
            "AAA 01-06T07:00 false",
            "BBB 01-06T07:00 true",
            "AAA 01-06T07:01 true",     // BBB в эту минуту не торговалась — пачка из одной свечи
            "AAA 01-07T07:00 false",
            "BBB 01-07T07:00 true",
        ]);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("--from режет минутки, но оставляет дневную историю для фич; --to режет всё", async () => {
    const { dir, inputs, out } = await workspace();
    try {
        await bundle(inputs, { out, from: "2026-01-07" });
        const fromDs = await loadDataset(out);
        assert.deepEqual(days(fromDs.bySymbol.get("AAA").get(1)), ["2026-01-07"]);
        assert.deepEqual(days(fromDs.bySymbol.get("AAA").get(1440)), ["2026-01-05", "2026-01-06", "2026-01-07"],
            "дневные до --from нужны стратегии как история d-1…d-5");

        const toOut = join(dir, "to.parquet");
        await bundle(inputs, { out: toOut, to: "2026-01-06" });
        const toDs = await loadDataset(toOut);
        assert.deepEqual(days(toDs.bySymbol.get("AAA").get(1)), ["2026-01-06", "2026-01-06"]);
        assert.deepEqual(days(toDs.bySymbol.get("AAA").get(1440)), ["2026-01-05", "2026-01-06"],
            "после --to нельзя ни на каком интервале — это заглядывание вперёд");
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("--tickers отбирает бумаги, существующий файл без --force не перезаписывается", async () => {
    const { dir, inputs, out } = await workspace();
    try {
        await bundle(inputs, { out, tickers: ["BBB"] });
        assert.deepEqual((await loadDataset(out)).symbols, ["BBB"]);
        await assert.rejects(bundle(inputs, { out }), /already exists/);
        await bundle(inputs, { out, force: true });
        assert.deepEqual((await loadDataset(out)).symbols, ["AAA", "BBB"]);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
