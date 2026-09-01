import { test } from "node:test";
import assert from "node:assert/strict";
import { missingTests, rejectionReasons } from "./universe.js";

// ── сверка тестов инструмента со сданными на счёте ──────────────────────────
// Найдено в бою: бумага проходит все флаги Share, но биржа отклоняет заявку с
// «пройдите тест в разделе Профиль». Требование лежит не на инструменте, а на
// активе, и сверять его надо со списком пройденного у самого счёта.

test("без требуемых тестов бумага доступна", () => {
    assert.deepEqual(missingTests([], ["russian_shares"]), []);
    assert.deepEqual(missingTests(undefined, ["russian_shares"]), []);
    assert.deepEqual(missingTests(null, null), []);
});

test("сданный тест снимает требование", () => {
    assert.deepEqual(missingTests(["russian_shares"], ["russian_shares", "derivatives"]), []);
});

test("несданный тест возвращается как причина отказа", () => {
    assert.deepEqual(missingTests(["structured_bonds"], ["russian_shares"]), ["structured_bonds"]);
});

test("из нескольких требований возвращаются только несданные", () => {
    assert.deepEqual(
        missingTests(["a", "b", "c"], ["b"]),
        ["a", "c"],
    );
});

test("пустой список сданных отвергает любое требование", () => {
    assert.deepEqual(missingTests(["a"], []), ["a"]);
    assert.deepEqual(missingTests(["a"], undefined), ["a"]);
});

// ── флаговый отбор ──────────────────────────────────────────────────────────

const goodShare = {
    ticker: "AAA", shortEnabledFlag: true, liquidityFlag: true, apiTradeAvailableFlag: true,
    sellAvailableFlag: true, otcFlag: false, blockedTcaFlag: false, forQualInvestorFlag: false,
    currency: "rub", exchange: "MOEX", first1minCandleDate: new Date("2020-01-01"),
};

test("пригодная бумага проходит без замечаний", () => {
    assert.deepEqual(rejectionReasons(goodShare, { now: Date.parse("2026-09-01") }), []);
});

test("запрет шорта отсеивает бумагу", () => {
    const reasons = rejectionReasons({ ...goodShare, shortEnabledFlag: false }, { now: Date.parse("2026-09-01") });
    assert.deepEqual(reasons, ["шорт запрещён"]);
});

test("короткая история отсеивает бумагу и называет глубину", () => {
    const reasons = rejectionReasons(
        { ...goodShare, first1minCandleDate: new Date("2026-06-01") },
        { now: Date.parse("2026-09-01"), minHistoryDays: 400 },
    );
    assert.equal(reasons.length, 1);
    assert.match(reasons[0], /^история \d+ дн\. < 400$/);
});

test("--allow-qual возвращает бумаги для квалов", () => {
    const share = { ...goodShare, forQualInvestorFlag: true };
    const now = Date.parse("2026-09-01");
    assert.deepEqual(rejectionReasons(share, { now }), ["только для квалов"]);
    assert.deepEqual(rejectionReasons(share, { now, allowQual: true }), []);
});
