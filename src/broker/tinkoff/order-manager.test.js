import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOrderId } from "./order-manager.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const at = new Date("2026-10-08T04:00:00.000Z");
// Ключ, который давала функция до переноса из удалённого однобумажного брокера.
const EXPECTED = "963642a9-b583-5bbb-8d89-5ef53aaf9712";

test("ключ заявки — UUIDv5: песочница и боевой API принимают только UUID", () => {
    assert.match(buildOrderId({ tag: "div", ticker: "SBER", action: "open", direction: "sell", at }), UUID);
});

test("ключ детерминирован: повтор той же заявки в ту же секунду брокер отбросит как дубль", () => {
    const params = { tag: "div", ticker: "SBER", action: "open", direction: "sell", at };
    assert.equal(buildOrderId(params), buildOrderId({ ...params }));
});

test("ключ различает бумагу, действие, направление, метку и секунду", () => {
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

test("ключ не меняется при переносе функции между модулями", () => {
    // Смена алгоритма тихо сломала бы идемпотентность заявок после рестарта бота.
    assert.equal(
        buildOrderId({ tag: "a", ticker: "SBER", action: "open", direction: "sell", at }),
        EXPECTED,
    );
});

