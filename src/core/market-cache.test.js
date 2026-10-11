import { test } from "node:test";
import assert from "node:assert/strict";
import { MarketDataCache } from "./market-cache.js";
import { TemporalView } from "./temporal-view.js";

/** Мультитикерный источник-заглушка, как у живого брокера. */
const source = {
    getSymbols: () => ["AAA", "BBB"],
    getInstrument: (ticker) => ({ ticker, lot: ticker === "AAA" ? 10 : 100 }),
    async getHistory() { return []; },
    async getTradingSchedule() { return []; },
};

test("через кэш стратегия видит вселенную и лоты бумаг, как в бэктесте", () => {
    const context = new TemporalView({ dataSource: new MarketDataCache(source), metadata: { source: "tinkoff" } });
    assert.deepEqual(context.getSymbols(), ["AAA", "BBB"]);
    assert.equal(context.getInstrumentMetadata("BBB").lot, 100);
});

test("однобумажный источник без вселенной: кэш не ломает запасной путь через метаданные", () => {
    const single = { async getHistory() { return []; }, async getTradingSchedule() { return []; } };
    const context = new TemporalView({
        dataSource: new MarketDataCache(single),
        metadata: { ticker: "SBER", instrument: { ticker: "SBER", lot: 1 } },
    });
    assert.deepEqual(context.getSymbols(), ["SBER"]);
    assert.equal(context.getInstrumentMetadata("SBER").lot, 1);
});
