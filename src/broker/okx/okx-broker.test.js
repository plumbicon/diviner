import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OkxExecutor, buildClientOrderId } from "../okx-broker.js";
import { normalizeOhlcv } from "./client.js";
import { getOkxIntervalConfig } from "./intervals.js";

/**
 * Lightweight in-memory stub of OkxClient — no network. Records placed orders so
 * tests can assert on side / amount / reduceOnly.
 */
function makeStubClient({ contractSize = 1, minAmount = 0, balance = 0, position = null } = {}) {
    return {
        contractSize,
        minAmount,
        orders: [],
        roundAmount(amount) {
            // Emulate a 0.001-contract step (floor to 3 decimals).
            if (!Number.isFinite(amount) || amount <= 0) return 0;
            return Math.floor(amount * 1000) / 1000;
        },
        async fetchBalance() { return balance; },
        async fetchPosition() { return position; },
        async createMarketOrder(order) { this.orders.push(order); return { id: "stub", ...order }; },
    };
}

const intervalConfig = getOkxIntervalConfig("1m");

function makeExecutor(client, overrides = {}) {
    return new OkxExecutor({
        client,
        symbol: "BTC/USDT:USDT",
        intervalConfig,
        options: {
            leverage: 1,
            marginFraction: 0.5,
            stateFile: join(tmpdir(), `okx-test-${process.pid}-${Math.random().toString(36).slice(2)}.json`),
            ...overrides,
        },
    });
}

test("normalizeOhlcv maps a ccxt row to the candle shape", () => {
    const ts = Date.UTC(2025, 5, 1, 0, 0, 0);
    const candle = normalizeOhlcv([ts, 100, 110, 90, 105, 42]);
    assert.equal(candle.datetime.getTime(), ts);
    assert.equal(candle.open, 100);
    assert.equal(candle.high, 110);
    assert.equal(candle.low, 90);
    assert.equal(candle.close, 105);
    assert.equal(candle.volume, 42);
    assert.equal(candle.isComplete, true);
});

test("default sizing: notional = balance * leverage * marginFraction, in contracts", async () => {
    // balance 1000, leverage 1, fraction 0.5 -> notional 500; price 100, contractSize 1
    // -> 5 contracts.
    const client = makeStubClient({ contractSize: 1, balance: 1000 });
    const exec = makeExecutor(client, { leverage: 1, marginFraction: 0.5 });
    await exec.refreshBalance();
    assert.equal(exec._defaultContracts(100), 5);
});

test("default sizing accounts for contractSize and leverage", async () => {
    // balance 1000, leverage 3, fraction 0.5 -> notional 1500; price 100,
    // contractSize 0.01 -> 1500 / (100 * 0.01) = 1500 contracts.
    const client = makeStubClient({ contractSize: 0.01, balance: 1000 });
    const exec = makeExecutor(client, { leverage: 3, marginFraction: 0.5 });
    await exec.refreshBalance();
    assert.equal(exec._defaultContracts(100), 1500);
});

test("default sizing returns 0 below the market minimum", async () => {
    const client = makeStubClient({ contractSize: 1, balance: 10, minAmount: 1 });
    const exec = makeExecutor(client, { leverage: 1, marginFraction: 0.5 });
    await exec.refreshBalance();
    // notional 5; price 100 -> 0.05 contracts, below min 1 -> 0.
    assert.equal(exec._defaultContracts(100), 0);
});

test("buy enqueues a non-reduceOnly order; close enqueues reduceOnly opposite side", async () => {
    const client = makeStubClient({ contractSize: 1, balance: 1000 });
    const exec = makeExecutor(client, { leverage: 1, marginFraction: 0.5 });
    await exec.refreshBalance();

    exec.setCurrentCandle({ datetime: new Date(), close: 100 });
    exec.buy();
    await exec.drainOrders();

    assert.equal(client.orders.length, 1);
    assert.equal(client.orders[0].side, "buy");
    assert.equal(client.orders[0].reduceOnly, false);
    assert.equal(client.orders[0].amount, 5);
    assert.equal(exec.getPosition().side, "long");

    exec.closePosition();
    await exec.drainOrders();

    assert.equal(client.orders.length, 2);
    assert.equal(client.orders[1].side, "sell");
    assert.equal(client.orders[1].reduceOnly, true);
    assert.equal(exec.getPosition(), null);
});

test("sell opens a short (reduceOnly false, side sell)", async () => {
    const client = makeStubClient({ contractSize: 1, balance: 1000 });
    const exec = makeExecutor(client, { leverage: 1, marginFraction: 0.5 });
    await exec.refreshBalance();

    exec.setCurrentCandle({ datetime: new Date(), close: 100 });
    exec.sell();
    await exec.drainOrders();

    assert.equal(client.orders[0].side, "sell");
    assert.equal(client.orders[0].reduceOnly, false);
    assert.equal(exec.getPosition().side, "short");
});

test("stale candle entries are dropped", async () => {
    const client = makeStubClient({ contractSize: 1, balance: 1000 });
    const exec = makeExecutor(client, { leverage: 1, marginFraction: 0.5 });
    await exec.refreshBalance();

    // Candle far older than maxEntryAgeMs (≈ 2.5 min for 1m) -> entry refused.
    exec.setCurrentCandle({ datetime: new Date(Date.now() - 60 * 60 * 1000), close: 100 });
    exec.buy();
    await exec.drainOrders();

    assert.equal(client.orders.length, 0);
    assert.equal(exec.getPosition(), null);
});

test("buildClientOrderId is alphanumeric and ≤ 32 chars", () => {
    const id = buildClientOrderId({
        tag: "a05-strat!",
        symbol: "BTC/USDT:USDT",
        action: "open",
        direction: "buy",
        at: new Date("2026-06-16T04:01:00Z"),
    });
    assert.match(id, /^[a-zA-Z0-9]{1,32}$/);
    // Determinism: same inputs (same second) -> same id (idempotency).
    const again = buildClientOrderId({
        tag: "a05-strat!",
        symbol: "BTC/USDT:USDT",
        action: "open",
        direction: "buy",
        at: new Date("2026-06-16T04:01:00Z"),
    });
    assert.equal(id, again);
});
