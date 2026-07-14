import { test } from "node:test";
import assert from "node:assert/strict";
import { Portfolio } from "./portfolio.js";

const candle = (close) => ({ close, datetime: new Date("2026-06-10T04:31:00Z") });

test("default short size floors to whole lots (lot=10, mirrors live broker)", () => {
    const pf = new Portfolio({ cash: 10000, commission: 0.0005, lot: 10 });
    const pos = pf.openShort({ candle: candle(24.10) });
    // floor(10000 / (24.10*1.01*(1+0.0005)*10)) = floor(41.06) = 41 lots = 410 shares.
    assert.equal(pos.size, 410);
    assert.equal(pos.size % 10, 0, "size must be a whole multiple of the lot");
});

test("default long size floors to whole lots (lot=10)", () => {
    const pf = new Portfolio({ cash: 10000, commission: 0.0005, lot: 10 });
    const pos = pf.openLong({ candle: candle(24.10) });
    assert.equal(pos.size, 410);
});

test("lot=1 keeps per-share sizing unchanged", () => {
    const pf = new Portfolio({ cash: 10000, commission: 0.0005, lot: 1 });
    const pos = pf.openShort({ candle: candle(25.62) });
    // floor(10000 / (25.62*1.01*(1+0.0005))) = floor(386.26) = 386.
    assert.equal(pos.size, 386);
});

test("lot defaults to 1 when unspecified or invalid", () => {
    assert.equal(new Portfolio({ cash: 10000 }).lot, 1);
    assert.equal(new Portfolio({ cash: 10000, lot: 0 }).lot, 1);
    assert.equal(new Portfolio({ cash: 10000, lot: NaN }).lot, 1);
});

test("explicit size bypasses lot flooring (caller owns the value)", () => {
    const pf = new Portfolio({ cash: 10000, commission: 0.0005, lot: 10 });
    const pos = pf.openShort({ candle: candle(24.10), size: 123 });
    assert.equal(pos.size, 123);
});

test("too-small cash yields no position (size floored to 0 lots)", () => {
    const pf = new Portfolio({ cash: 100, commission: 0.0005, lot: 10 });
    // floor(100*0.95 / (24.10*10)) = 0 lots → no position.
    assert.equal(pf.openShort({ candle: candle(24.10) }), null);
});
