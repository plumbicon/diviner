import { test } from "node:test";
import assert from "node:assert/strict";
import { TinkoffClient } from "./client.js";
import { OrderExecutionReportStatus } from "tinkoff-invest-api/dist/generated/orders.js";

// The TinkoffInvestApi constructor opens nothing, so a client can be built without network.

test("the facade delegates candle work to the stream", async () => {
    const client = new TinkoffClient("t.test");
    const calls = [];
    client.candles = {
        subscribe: async (...args) => calls.push(["subscribe", args.length]),
        restart: async (reason) => calls.push(["restart", reason]),
        stop: async () => calls.push(["stop"]),
    };
    await client.subscribeCandles([{ ticker: "AAA" }], 1, () => {}, {});
    await client.restartMarketStream("silence");
    await client.unsubscribeCandles();
    await client.close();
    assert.deepEqual(calls, [["subscribe", 4], ["restart", "silence"], ["stop"], ["stop"]]);
});

test("an order before init() gives a clear error instead of failing on undefined", async () => {
    const client = new TinkoffClient("t.test");
    await assert.rejects(client.postOrder({ figi: "F", quantity: 1, direction: "sell" }), /Call init\(\) first/);
});

test("the order execution summary reads status, lots and price", () => {
    const client = new TinkoffClient("t.test");
    const summary = client.getOrderExecutionSummary({
        executionReportStatus: OrderExecutionReportStatus.EXECUTION_REPORT_STATUS_FILL,
        lotsRequested: 3, lotsExecuted: 3,
        executedOrderPrice: { units: 285, nano: 600000000, currency: "rub" },
    });
    assert.equal(summary.isFilled, true);
    assert.equal(summary.lotsExecuted, 3);
    assert.equal(summary.avgPrice, 285.6);
    assert.equal(summary.statusName, "EXECUTION_REPORT_STATUS_FILL");
});
