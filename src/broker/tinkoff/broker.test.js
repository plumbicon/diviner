import { test } from "node:test";
import assert from "node:assert/strict";
import { TinkoffExecutor, quotationToNumber } from "./broker.js";

// Build an executor exposing only the fields _defaultOrderLots reads, without
// running the real constructor (which opens files / managers). Tests the actual
// sizing method against the real class prototype.
function sizer({ balance, leverage = 1, commission = 0.0005, lot = 1, shortRiskRate = null }) {
    const ex = Object.create(TinkoffExecutor.prototype);
    ex.accountRubBalance = balance;
    ex.leverage = leverage;
    ex.commission = commission;
    ex.shortRiskRate = shortRiskRate;
    ex.instrument = { lot, ticker: "TEST" };
    return ex;
}

// priceFill = 100 * 1.01 = 101; exposure at leverage 1 = floor(100000/(101*1.0005)) = 989.
test("leverage 1 short: risk-rate cap never binds — sizing unchanged", () => {
    const noRate = sizer({ balance: 100000 })._defaultOrderLots(100, "short");
    const withRate = sizer({ balance: 100000, shortRiskRate: 0.3 })._defaultOrderLots(100, "short");
    assert.equal(noRate, 989);
    assert.equal(withRate, 989, "dshortClient ≪ 1 → cap far above exposure, leverage-1 size identical");
});

test("high leverage short is capped to broker max by real margin rate", () => {
    // leverage 5 exposure = floor(100000/(101*(0.2+0.0005))) = 4938.
    // margin cap (rate 0.3) = floor(100000/(101*(0.3+0.0005))) = 3294.
    const ex = sizer({ balance: 100000, leverage: 5, shortRiskRate: 0.3 });
    assert.equal(ex._defaultOrderLots(100, "short"), 3294);
});

test("long side ignores the short risk rate (cap not applied)", () => {
    // leverage 5 long exposure = 4938; short rate must not cap a long.
    const ex = sizer({ balance: 100000, leverage: 5, shortRiskRate: 0.3 });
    assert.equal(ex._defaultOrderLots(100, "long"), 4938);
});

test("no risk rate falls back to pure exposure sizing", () => {
    const ex = sizer({ balance: 100000, leverage: 5, shortRiskRate: null });
    assert.equal(ex._defaultOrderLots(100, "short"), 4938);
});

test("invalid price yields zero", () => {
    assert.equal(sizer({ balance: 100000 })._defaultOrderLots(0, "short"), 0);
    assert.equal(sizer({ balance: 100000 })._defaultOrderLots(NaN, "short"), 0);
});

test("quotationToNumber parses {units, nano}, rejects absent/zero", () => {
    assert.equal(quotationToNumber({ units: 0, nano: 300000000 }), 0.3);
    assert.equal(quotationToNumber({ units: 1, nano: 500000000 }), 1.5);
    assert.equal(quotationToNumber(undefined), null);
    assert.equal(quotationToNumber({ units: 0, nano: 0 }), null, "zero rate treated as unset");
});
