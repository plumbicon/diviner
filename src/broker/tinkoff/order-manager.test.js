import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOrderId } from "./order-manager.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const at = new Date("2026-10-08T04:00:00.000Z");
// The key the function produced before it moved out of the removed single-ticker broker.
const EXPECTED = "963642a9-b583-5bbb-8d89-5ef53aaf9712";

test("the order key is a UUIDv5: the sandbox and the live API accept only UUIDs", () => {
    assert.match(buildOrderId({ tag: "div", ticker: "SBER", action: "open", direction: "sell", at }), UUID);
});

test("the key is deterministic: the broker drops a repeat of the same order in the same second as a duplicate", () => {
    const params = { tag: "div", ticker: "SBER", action: "open", direction: "sell", at };
    assert.equal(buildOrderId(params), buildOrderId({ ...params }));
});

test("the key tells apart instrument, action, direction, tag and second", () => {
    const base = { tag: "div", ticker: "SBER", action: "open", direction: "sell", at };
    const ids = new Set([
        buildOrderId(base),
        buildOrderId({ ...base, ticker: "GAZP" }),
        buildOrderId({ ...base, action: "close" }),
        buildOrderId({ ...base, direction: "buy" }),
        buildOrderId({ ...base, tag: "other" }),
        buildOrderId({ ...base, at: new Date(at.getTime() + 1000) }),
    ]);
    assert.equal(ids.size, 6);
});

test("the key does not change when the function moves between modules", () => {
    // Changing the algorithm would silently break order idempotency after a bot restart.
    assert.equal(
        buildOrderId({ tag: "a", ticker: "SBER", action: "open", direction: "sell", at }),
        EXPECTED,
    );
});

