import { test } from "node:test";
import assert from "node:assert/strict";
import { missingTests, rejectionReasons } from "./universe.js";

// ── matching an instrument's required tests against the account's passed ones ─
// Found live: an instrument passes every Share flag, yet the exchange rejects the order
// with "pass a test in the Profile section". The requirement sits on the asset, not on
// the instrument, and has to be matched against the account's own passed list.

test("without required tests the instrument is available", () => {
    assert.deepEqual(missingTests([], ["russian_shares"]), []);
    assert.deepEqual(missingTests(undefined, ["russian_shares"]), []);
    assert.deepEqual(missingTests(null, null), []);
});

test("a passed test lifts the requirement", () => {
    assert.deepEqual(missingTests(["russian_shares"], ["russian_shares", "derivatives"]), []);
});

test("a missing test is returned as a rejection reason", () => {
    assert.deepEqual(missingTests(["structured_bonds"], ["russian_shares"]), ["structured_bonds"]);
});

test("of several requirements only the missing ones are returned", () => {
    assert.deepEqual(
        missingTests(["a", "b", "c"], ["b"]),
        ["a", "c"],
    );
});

test("an empty passed list rejects any requirement", () => {
    assert.deepEqual(missingTests(["a"], []), ["a"]);
    assert.deepEqual(missingTests(["a"], undefined), ["a"]);
});

// ── flag selection ──────────────────────────────────────────────────────────

const goodShare = {
    ticker: "AAA", shortEnabledFlag: true, liquidityFlag: true, apiTradeAvailableFlag: true,
    sellAvailableFlag: true, otcFlag: false, blockedTcaFlag: false, forQualInvestorFlag: false,
    currency: "rub", exchange: "MOEX", first1minCandleDate: new Date("2020-01-01"),
};

test("a suitable instrument passes without remarks", () => {
    assert.deepEqual(rejectionReasons(goodShare, { now: Date.parse("2026-09-01") }), []);
});

test("a short ban rejects the instrument", () => {
    const reasons = rejectionReasons({ ...goodShare, shortEnabledFlag: false }, { now: Date.parse("2026-09-01") });
    assert.deepEqual(reasons, ["short disabled"]);
});

test("a short history rejects the instrument and states the depth", () => {
    const reasons = rejectionReasons(
        { ...goodShare, first1minCandleDate: new Date("2026-06-01") },
        { now: Date.parse("2026-09-01"), minHistoryDays: 400 },
    );
    assert.equal(reasons.length, 1);
    assert.match(reasons[0], /^history \d+ days < 400$/);
});

test("--allow-qual brings back qualified-investor instruments", () => {
    const share = { ...goodShare, forQualInvestorFlag: true };
    const now = Date.parse("2026-09-01");
    assert.deepEqual(rejectionReasons(share, { now }), ["qualified investors only"]);
    assert.deepEqual(rejectionReasons(share, { now, allowQual: true }), []);
});
