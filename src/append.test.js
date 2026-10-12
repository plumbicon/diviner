import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { append } from "./append.js";
import { loadDataset } from "./core/data-loader.js";
import { writeCandleSeriesAsParquet, writeMultiSymbolParquet } from "./core/candle-parquet.js";

const MIN = 60_000;
const t0 = Date.UTC(2026, 0, 6, 7, 0);
const minute = (n, close) => ({ datetime: new Date(t0 + n * MIN), open: close, high: close, low: close, close, volume: 1 });
const day = { datetime: new Date(Date.UTC(2026, 0, 5)), open: 90, high: 90, low: 90, close: 90, volume: 1 };
const meta = (ticker) => ({ ticker, instrument: { ticker, lot: 10 }, intervalMinutes: 1 });

/** Directory with a target listing: minutes 0–4 and one daily candle. */
async function workspace() {
    const dir = await mkdtemp(join(tmpdir(), "diviner-append-"));
    const into = join(dir, "DEMO_2026_1m.parquet");
    await writeCandleSeriesAsParquet(
        new Map([[1, [0, 1, 2, 3, 4].map((n) => minute(n, 100 + n))], [1440, [day]]]),
        into, meta("DEMO"));
    const fresh = async (name, candles, ticker = "DEMO") => {
        const path = join(dir, name);
        await writeCandleSeriesAsParquet(new Map([[1, candles]]), path, meta(ticker));
        return path;
    };
    return { dir, into, fresh };
}

const closes = async (path, minutes = 1) =>
    (await loadDataset(path)).series.get(minutes).map((c) => c.close);

test("свежий период дописывается, история и другие интервалы сохраняются", async () => {
    const { dir, into, fresh } = await workspace();
    try {
        // 3 and 4 overlap: the exchange may have recomputed the bar — the fresh candle wins.
        const src = await fresh("new.parquet", [3, 4, 5, 6].map((n) => minute(n, 200 + n)));
        const { summary } = await append(into, [src]);

        assert.deepEqual(await closes(into), [100, 101, 102, 203, 204, 205, 206]);
        assert.deepEqual(await closes(into, 1440), [90], "дневные свечи не пропали");
        assert.equal((await loadDataset(into)).metadata.instrument.lot, 10, "метаданные листинга на месте");
        assert.deepEqual(summary.find((s) => s.minutes === 1), {
            minutes: 1, was: 5, now: 7, added: 2, from: "2026-01-06", to: "2026-01-06",
        });
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("свежий файл короче листинга — история не укорачивается", async () => {
    // Exactly the mistake the command guards against: a fragment downloaded and put in place of the file.
    const { dir, into, fresh } = await workspace();
    try {
        const src = await fresh("short.parquet", [minute(2, 150)]);
        await append(into, [src]);
        assert.deepEqual(await closes(into), [100, 101, 150, 103, 104]);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("--dry-run считает итог, но файл не трогает", async () => {
    const { dir, into, fresh } = await workspace();
    try {
        const before = await stat(into);
        const src = await fresh("new.parquet", [minute(5, 205)]);
        const { summary } = await append(into, [src], { dryRun: true });
        assert.equal(summary.find((s) => s.minutes === 1).now, 6);
        assert.equal((await stat(into)).mtimeMs, before.mtimeMs);
        assert.deepEqual(await closes(into), [100, 101, 102, 103, 104]);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("свечи другой бумаги в листинг не сливаются", async () => {
    const { dir, into, fresh } = await workspace();
    try {
        const src = await fresh("other.parquet", [minute(5, 999)], "OTHER");
        await assert.rejects(append(into, [src]), /holds OTHER, but .* holds DEMO/);
        assert.deepEqual(await closes(into), [100, 101, 102, 103, 104]);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("в бандл не дописывает — бандл пересобирают из листингов", async () => {
    const dir = await mkdtemp(join(tmpdir(), "diviner-append-"));
    try {
        const bundle = join(dir, "bundle.parquet");
        await writeMultiSymbolParquet(
            new Map([["AAA", new Map([[1, [minute(0, 1)]]])], ["BBB", new Map([[1, [minute(0, 2)]]])]]),
            bundle, { tickers: ["AAA", "BBB"], instruments: {}, intervalMinutes: 1 });
        await assert.rejects(append(bundle, [bundle]), /multi-ticker bundle/);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
