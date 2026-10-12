import { test } from "node:test";
import assert from "node:assert/strict";
import { MarketDataCache } from "./market-cache.js";
import { TemporalView } from "./temporal-view.js";

/** Multi-ticker source stub, shaped like the live broker's. */
const source = {
    getSymbols: () => ["AAA", "BBB"],
    getInstrument: (ticker) => ({ ticker, lot: ticker === "AAA" ? 10 : 100 }),
    async getHistory() { return []; },
    async getTradingSchedule() { return []; },
};

test("through the cache the strategy sees the universe and lots, as in the backtest", () => {
    const context = new TemporalView({ dataSource: new MarketDataCache(source), metadata: { source: "tinkoff" } });
    assert.deepEqual(context.getSymbols(), ["AAA", "BBB"]);
    assert.equal(context.getInstrumentMetadata("BBB").lot, 100);
});

test("a single-ticker source without a universe: the cache keeps the metadata fallback working", () => {
    const single = { async getHistory() { return []; }, async getTradingSchedule() { return []; } };
    const context = new TemporalView({
        dataSource: new MarketDataCache(single),
        metadata: { ticker: "SBER", instrument: { ticker: "SBER", lot: 1 } },
    });
    assert.deepEqual(context.getSymbols(), ["SBER"]);
    assert.equal(context.getInstrumentMetadata("SBER").lot, 1);
});
