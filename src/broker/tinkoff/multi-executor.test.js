import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MultiSymbolTinkoffExecutor, quotationToNumber } from "./multi-executor.js";

const MIN = 60_000;
const instruments = [
    { ticker: "AAA", figi: "figi_AAA", uid: "uid_AAA", lot: 1, exchange: "MOEX" },
    { ticker: "BBB", figi: "figi_BBB", uid: "uid_BBB", lot: 10, exchange: "MOEX" },
];

const figiToTicker = { figi_AAA: "AAA", figi_BBB: "BBB" };

function build({ balance = 10_000, orders = {}, positions = {}, status = {} } = {}) {
    const placed = [];
    const state = { balance, calls: 0, fail: false };
    const client = {
        accountId: "acc1",
        async getRubBalance() {
            state.calls += 1;
            if (state.fail) throw new Error("the broker is silent");
            return state.balance;
        },
        async getInstrumentPosition(figi) { return positions[figi] ?? null; },
        async getTradingStatus(figi) { return status[figi] ?? { marketOrderAvailableFlag: true }; },
    };
    // Method names and response shape match the real OrderManager/client: a stub with an
    // invented interface would let a call to a non-existent method slip through.
    const orderManager = {
        async postMarketOrder(order) {
            placed.push(order);
            if (orders.throwOn === figiToTicker[order.figi]) {
                throw new Error(orders.throwMessage ?? "exchange rejection");
            }
            return { __lots: orders.executedLots ?? order.quantity };
        },
        async closePosition({ figi, instrumentId, quantity, currentSide, orderId }) {
            const direction = currentSide === "long" ? "sell" : "buy";
            return this.postMarketOrder({ figi, instrumentId, quantity, direction, orderId });
        },
    };
    client.getOrderExecutionSummary = (result) => ({
        lotsExecuted: result?.__lots ?? 0,
        avgPrice: orders.avgPrice ?? null,
        statusName: "FILL",
    });
    const exec = new MultiSymbolTinkoffExecutor({
        client, instruments, interval: 1,
        options: { orderManager, stateDir: mkdtempSync(join(tmpdir(), "mexec-")), commission: 0.0005 },
    });
    return { exec, placed, client, state };
}

const candle = (ticker, close, extra = {}) => ({
    ticker, datetime: new Date(), open: close, high: close + 1, low: close - 1, close, volume: 1, ...extra,
});

test("the budget is converted to lots, rounded down", async () => {
    const { exec } = build();
    await exec.refreshBalance();
    exec.setCurrentCandle(candle("BBB", 100));           // lot 10 → 1 lot ≈ 1010 ₽ with the reserve
    const position = exec.sell({ ticker: "BBB", budget: 2500 });
    assert.equal(position.size, 2, "2 lots, not 2.5");
    await exec.drainOrders();
});

test("the budget is capped by free cash", async () => {
    const { exec } = build({ balance: 900 });
    await exec.refreshBalance();
    exec.setCurrentCandle(candle("BBB", 100));
    assert.equal(exec.sell({ ticker: "BBB", budget: 100000 }), null, "a 1000 ₽ lot cannot be bought with 900 ₽");
});

test("one instrument — one position; the instrument is busy while an order is in flight", async () => {
    const { exec, placed } = build();
    await exec.refreshBalance();
    exec.setCurrentCandle(candle("AAA", 50));
    assert.ok(exec.sell({ ticker: "AAA", budget: 5000 }));
    assert.equal(exec.isBusy("AAA"), true);
    assert.equal(exec.sell({ ticker: "AAA", budget: 5000 }), null, "a second entry into the same instrument is refused");
    await exec.drainOrders();
    assert.equal(placed.length, 1);
    assert.deepEqual(exec.getPendingTickers(), [], "the instrument is free after the fill");
    assert.equal(exec.getPositions().length, 1);
});

test("a stale candle does not trade", async () => {
    const { exec } = build();
    await exec.refreshBalance();
    exec.setCurrentCandle(candle("AAA", 50, { datetime: new Date(Date.now() - 10 * MIN) }));
    assert.equal(exec.sell({ ticker: "AAA", budget: 5000 }), null);
});

test("a warm-up candle from the catch-up does not trade", async () => {
    const { exec } = build();
    await exec.refreshBalance();
    exec.setCurrentCandle(candle("AAA", 50, { noTrade: true }));
    assert.equal(exec.sell({ ticker: "AAA", budget: 5000 }), null);
});

test("an exchange rejection rolls back the optimistically opened position", async () => {
    const { exec } = build({ orders: { throwOn: "AAA" } });
    await exec.refreshBalance();
    exec.setCurrentCandle(candle("AAA", 50));
    assert.ok(exec.sell({ ticker: "AAA", budget: 5000 }), "the position is set optimistically");
    await exec.drainOrders();
    assert.equal(exec.getPositionOf("AAA"), null, "the state is cleared after the rejection");
    assert.equal(exec.isBusy("AAA"), false);
});

test("auction: market orders unavailable — the entry is cancelled", async () => {
    const { exec, placed } = build({ status: { figi_AAA: { marketOrderAvailableFlag: false } } });
    await exec.refreshBalance();
    exec.setCurrentCandle(candle("AAA", 50));
    exec.sell({ ticker: "AAA", budget: 5000 });
    await exec.drainOrders();
    assert.equal(placed.length, 0, "no order sent");
    assert.equal(exec.getPositionOf("AAA"), null);
});

test("a partial fill adjusts the position size", async () => {
    const { exec } = build({ orders: { executedLots: 3 } });
    await exec.refreshBalance();
    exec.setCurrentCandle(candle("AAA", 50));
    exec.sell({ ticker: "AAA", budget: 5000 });
    await exec.drainOrders();
    assert.equal(exec.getPositionOf("AAA").size, 3);
});

test("an intrabar stop closes the position of the candle's instrument", async () => {
    const { exec, placed } = build();
    await exec.refreshBalance();
    exec.setCurrentCandle(candle("AAA", 50));
    exec.sell({ ticker: "AAA", budget: 5000, sl: 52 });
    await exec.drainOrders();
    const hit = candle("AAA", 51, { high: 53 });          // the wick touched 52
    exec.setCurrentCandle(hit);
    assert.ok(exec.checkStops(hit), "the stop fired");
    await exec.drainOrders();
    assert.equal(exec.getPositionOf("AAA"), null);
    assert.equal(placed.at(-1).direction, "buy", "a short is closed by a buy");
});

test("positions in different instruments are independent", async () => {
    const { exec } = build();
    await exec.refreshBalance();
    exec.setCurrentCandle(candle("AAA", 50));
    exec.sell({ ticker: "AAA", budget: 3000 });
    await exec.drainOrders();
    exec.setCurrentCandle(candle("BBB", 100));
    exec.sell({ ticker: "BBB", budget: 3000 });
    await exec.drainOrders();
    assert.equal(exec.getPositions().length, 2);
    exec.closePosition("signal", "AAA");
    await exec.drainOrders();
    assert.equal(exec.getPositionOf("AAA"), null);
    assert.ok(exec.getPositionOf("BBB"), "the second instrument is untouched");
});

test("reconciliation picks up actual account positions", async () => {
    const { exec } = build({
        positions: { figi_BBB: { side: "short", lots: 4, averagePrice: 99, currentPrice: 98 } },
    });
    await exec.init();
    const restored = exec.getPositionOf("BBB");
    assert.equal(restored.size, 4);
    assert.equal(restored.side, "short");
    assert.equal(restored.sl, null, "no levels without a state file");
    assert.equal(exec.getPositionOf("AAA"), null);
});

test("equity = cash minus short value, profit included", async () => {
    const { exec, state } = build();
    await exec.refreshBalance();
    exec.setCurrentCandle(candle("AAA", 100));
    exec.sell({ ticker: "AAA", budget: 5000 });
    await exec.drainOrders();
    const size = exec.getPositionOf("AAA").size;
    state.balance = 10_000 + size * 100;                 // the broker credited the sale proceeds
    await exec.refreshBalance();
    exec.setCurrentCandle(candle("AAA", 90));            // the short is up 10 per share
    assert.equal(Math.round(exec.getEquity()), Math.round(10_000 + size * 10));
});


test("the balance is re-read after an ENTRY, not only after an exit", async () => {
    const { exec, state } = build();
    await exec.init();
    const before = state.calls;
    exec.setCurrentCandle(candle("AAA", 50));
    state.balance = 7_000;                       // the account cash changed
    exec.sell({ ticker: "AAA", budget: 3000 });
    await exec.drainOrders();
    assert.ok(state.calls > before, "the balance was requested after the entry");
    assert.equal(exec.getBalance(), 7_000, "cash updated");
});

test("equity does not double the short sale proceeds", async () => {
    const { exec, state } = build();
    await exec.init();
    exec.setCurrentCandle(candle("AAA", 100));
    exec.sell({ ticker: "AAA", budget: 2500 });
    const lots = exec.getPositionOf("AAA").size;
    // The broker CREDITED the sale proceeds: the cash went up, not down. The previous
    // version of this test assumed the opposite — and that is exactly why it missed the bug.
    state.balance = 10_000 + lots * 100;
    await exec.drainOrders();
    // The price did not move → the equity must stay the same.
    assert.equal(Math.round(exec.getEquity()), 10_000);
});

test("at the end of a minute a stale balance is re-read", async () => {
    const { exec, state } = build();
    await exec.init();
    exec._balanceAt = Date.now() - 120_000;      // the previous read is long ago
    const before = state.calls;
    state.balance = 8_110;                       // a service fee was charged
    exec.setCurrentCandle(candle("AAA", 50, { isBatchEnd: true }));
    await exec.drainOrders();
    assert.equal(state.calls, before + 1);
    assert.equal(exec.getBalance(), 8_110);
});

test("a fresh balance is not requested again at the end of a minute", async () => {
    const { exec, state } = build();
    await exec.init();
    const before = state.calls;
    exec.setCurrentCandle(candle("AAA", 50, { isBatchEnd: true }));
    await exec.drainOrders();
    assert.equal(state.calls, before, "no extra request");
});

test("a failed balance read does not fail the tick and does not mark the value fresh", async () => {
    const { exec, state } = build();
    await exec.init();
    const known = exec.getBalance();
    state.fail = true;
    exec._balanceAt = Date.now() - 120_000;
    exec.setCurrentCandle(candle("AAA", 50, { isBatchEnd: true }));
    await exec.drainOrders();
    assert.equal(exec.getBalance(), known, "keeps working with the previous value");
    state.fail = false;
    state.balance = 5_555;
    exec.setCurrentCandle(candle("BBB", 50, { isBatchEnd: true }));
    await exec.drainOrders();
    assert.equal(exec.getBalance(), 5_555, "the read was retried on the next minute");
});

test("a trailing stop is labelled trail, a protective stop sl", async () => {
    const { exec } = build();
    await exec.init();
    // Protective stop: the level is ABOVE the entry (the short went against us).
    exec.setCurrentCandle(candle("AAA", 50));
    exec.sell({ ticker: "AAA", budget: 3000, sl: 52.5 });
    await exec.drainOrders();
    const hitSl = candle("AAA", 52, { high: 53 });
    exec.setCurrentCandle(hitSl);
    exec.checkStops(hitSl);
    await exec.drainOrders();
    assert.equal(exec.sessionTrades.at(-1).reason, "sl");

    // Trailing stop: the level is BELOW the entry (the profit lock is already armed).
    exec.setCurrentCandle(candle("BBB", 100));
    exec.sell({ ticker: "BBB", budget: 3000, sl: 97 });
    await exec.drainOrders();
    const hitTrail = candle("BBB", 97.5, { high: 98 });
    exec.setCurrentCandle(hitTrail);
    exec.checkStops(hitTrail);
    await exec.drainOrders();
    assert.equal(exec.sessionTrades.at(-1).reason, "trail");
});

test("a failed close returns the position to the state instead of leaving a phantom flat", async () => {
    const { exec } = build();
    await exec.init();
    exec.setCurrentCandle(candle("AAA", 50));
    exec.sell({ ticker: "AAA", budget: 4000, sl: 52, exitDeadline: Date.now() + 3_600_000 });
    await exec.drainOrders();
    const before = exec.getPositionOf("AAA");
    assert.ok(before, "position open");

    // The exchange rejects the close.
    const om = exec.orderManager;
    om.closePosition = async () => { throw new Error("exchange rejection"); };
    exec.closePosition("signal", "AAA");
    await exec.drainOrders();

    const after = exec.getPositionOf("AAA");
    assert.ok(after, "the position must return to the state");
    assert.equal(after.size, before.size);
    assert.equal(after.sl, 52, "the protective level is kept");
    assert.equal(exec.isBusy("AAA"), true, "the instrument is busy — no re-entry");
});

test("a partial close keeps the remainder with its levels and deadline", async () => {
    const { exec } = build();
    await exec.init();
    exec.setCurrentCandle(candle("AAA", 50));
    exec.sell({ ticker: "AAA", budget: 4000, sl: 52, exitDeadline: Date.now() + 3_600_000 });
    await exec.drainOrders();
    const size = exec.getPositionOf("AAA").size;
    assert.ok(size > 1, "a size above one lot is needed");

    // The exchange fills only one lot out of several.
    exec.client.getOrderExecutionSummary = () => ({ lotsExecuted: 1, avgPrice: 50, statusName: "PARTIAL" });
    exec.closePosition("signal", "AAA");
    await exec.drainOrders();
    const rest = exec.getPositionOf("AAA");
    assert.ok(rest, "the remainder is tracked");
    assert.equal(rest.size, size - 1);
    assert.equal(rest.sl, 52, "the remainder is not left without a stop");
});

test("the deadline is retried while the instrument has an order in flight", async () => {
    const { exec } = build();
    await exec.init();
    exec.setCurrentCandle(candle("AAA", 50));
    // Deadline in 20 ms, while the order queue is kept busy.
    exec.sell({ ticker: "AAA", budget: 4000, exitDeadline: Date.now() + 20 });
    await exec.drainOrders();
    const slot = exec.slots.get("AAA");
    exec._inFlight.add("AAA");                       // simulate an order in flight
    await new Promise((r) => setTimeout(r, 60));     // the deadline fired and was refused
    assert.ok(slot.exitTimer, "the timer is re-armed, not lost");
    assert.ok(exec.getPositionOf("AAA"), "the position is still there");
    exec._inFlight.delete("AAA");
    slot.exitTimer = null;
});

// ── blocking an instrument after an exchange rejection ──────────────────────
// Found live: the free slot went to the top candidate again and again, the exchange
// rejected the order, the slot rolled back — until the end of the day. The rejection
// must be remembered, otherwise the next candidate never gets a chance.

test("a permanent exchange rejection excludes the instrument until restart", async () => {
    const { exec, placed } = build({
        orders: { throwOn: "AAA", throwMessage: "Dlya torgovli e`tim instrumentom neobxodimo projti test" },
    });
    await exec.refreshBalance();
    exec.setCurrentCandle(candle("AAA", 50));
    assert.ok(exec.sell({ ticker: "AAA", budget: 5000 }), "the first attempt goes to the exchange");
    await exec.drainOrders();

    assert.equal(exec.isBlocked("AAA"), true, "the instrument is blocked after the rejection");
    exec.setCurrentCandle(candle("AAA", 50));
    assert.equal(exec.sell({ ticker: "AAA", budget: 5000 }), null, "no repeated order");
    await exec.drainOrders();
    assert.equal(placed.length, 1, "exactly one order went to the exchange, not one per minute");
});

test("a permanent block is not lifted by cash growth", async () => {
    const { exec, state } = build({
        balance: 1000,
        orders: { throwOn: "AAA", throwMessage: "trading is not available for this instrument" },
    });
    await exec.refreshBalance();
    exec.setCurrentCandle(candle("AAA", 50));
    exec.sell({ ticker: "AAA", budget: 500 });
    await exec.drainOrders();

    state.balance = 100_000;
    await exec.refreshBalance();
    assert.equal(exec.isBlocked("AAA"), true, "money does not replace a test in the app");
});

test("an insufficient-margin block is lifted once cash grows", async () => {
    const { exec, state } = build({
        balance: 1000,
        orders: { throwOn: "AAA", throwMessage: "Not enough assets for a margin trade" },
    });
    await exec.refreshBalance();
    exec.setCurrentCandle(candle("AAA", 50));
    exec.sell({ ticker: "AAA", budget: 500 });
    await exec.drainOrders();
    assert.equal(exec.isBlocked("AAA"), true, "no point retrying with the same cash");

    state.balance = 1200;                    // +20%, short of the 25% threshold
    await exec.refreshBalance();
    assert.equal(exec.isBlocked("AAA"), true, "a penny of cash growth does not lift the block");

    state.balance = 2000;                    // a position closed, noticeably more money
    await exec.refreshBalance();
    assert.equal(exec.isBlocked("AAA"), false, "after cash growth the instrument can be tried again");

    exec.setCurrentCandle(candle("AAA", 50));
    assert.ok(exec.sell({ ticker: "AAA", budget: 500 }), "the order is accepted again");
    await exec.drainOrders();
});

test("a rejection for one instrument does not block the others", async () => {
    const { exec, placed } = build({ orders: { throwOn: "AAA", throwMessage: "neobxodimo projti test" } });
    await exec.refreshBalance();
    exec.setCurrentCandle(candle("AAA", 50));
    exec.sell({ ticker: "AAA", budget: 5000 });
    await exec.drainOrders();

    exec.setCurrentCandle(candle("BBB", 100));
    assert.ok(exec.sell({ ticker: "BBB", budget: 2500 }), "the slot goes to the next candidate");
    await exec.drainOrders();
    assert.equal(placed.length, 2);
    assert.deepEqual(exec.getBlocked().map((b) => b.ticker), ["AAA"]);
});

// ── the entry price comes from the fill, not from the decision price ────────
// The position is opened optimistically at the signal candle's close. If that price were
// kept, MFE — and so the moment the trailing stop arms — would be measured from it, and
// live would drift from the backtest by the slippage.

test("the entry price is replaced by the actual fill price", async () => {
    const { exec } = build({ orders: { avgPrice: 49.4 } });
    await exec.refreshBalance();
    exec.setCurrentCandle(candle("AAA", 50));            // decided at 50
    const position = exec.sell({ ticker: "AAA", budget: 5000 });
    assert.equal(position.entryPrice, 50, "before the fill — the decision price");
    await exec.drainOrders();
    assert.equal(exec.getPositionOf("AAA").entryPrice, 49.4, "after the fill — the trade price");
});

test("SL and TP levels do not move when the price is refined", async () => {
    const { exec } = build({ orders: { avgPrice: 49.4 } });
    await exec.refreshBalance();
    exec.setCurrentCandle(candle("AAA", 50));
    exec.sell({ ticker: "AAA", budget: 5000, sl: 52.5, tp: 47.5 });
    await exec.drainOrders();
    const position = exec.getPositionOf("AAA");
    assert.equal(position.sl, 52.5, "the strategy computes the stop from the decision price — as in the backtest");
    assert.equal(position.tp, 47.5);
});

test("without a fill price from the broker the decision price stays", async () => {
    const { exec } = build({ orders: { avgPrice: null } });
    await exec.refreshBalance();
    exec.setCurrentCandle(candle("AAA", 50));
    exec.sell({ ticker: "AAA", budget: 5000 });
    await exec.drainOrders();
    assert.equal(exec.getPositionOf("AAA").entryPrice, 50, "nothing to invent a price from");
});

test("the refined entry price survives a restart", async () => {
    const { exec } = build({ orders: { avgPrice: 49.4 } });
    await exec.refreshBalance();
    exec.setCurrentCandle(candle("AAA", 50));
    exec.sell({ ticker: "AAA", budget: 5000 });
    await exec.drainOrders();
    const saved = exec.slots.get("AAA").store.load();
    assert.equal(saved.entryPrice, 49.4, "the trade price is written to the state file");
});

// ── account equity ──────────────────────────────────────────────────────────
// The broker's cash includes the short sale proceeds. Adding the position notional on top
// (as the simulation does, where the margin was debited from the cash) doubles the equity
// by the whole short position, the strategy takes a share of it for the next slot — and
// positions grow through the session.

test("a short at the entry price: equity equals the starting deposit", async () => {
    const { exec, state } = build({ balance: 10_000 });
    await exec.refreshBalance();
    exec.setCurrentCandle(candle("AAA", 50));
    exec.sell({ ticker: "AAA", size: 100 });
    await exec.drainOrders();

    state.balance = 15_000;                 // the broker credited proceeds of 100 × 50
    await exec.refreshBalance();
    exec.setCurrentCandle(candle("AAA", 50));
    assert.equal(exec.getEquity(), 10_000, "short proceeds do not create equity");
});

test("a short's profit raises equity by exactly the profit", async () => {
    const { exec, state } = build({ balance: 10_000 });
    await exec.refreshBalance();
    exec.setCurrentCandle(candle("AAA", 50));
    exec.sell({ ticker: "AAA", size: 100 });
    await exec.drainOrders();

    state.balance = 15_000;
    await exec.refreshBalance();
    exec.setCurrentCandle(candle("AAA", 45));   // the price fell by 5
    assert.equal(exec.getEquity(), 10_500, "100 shares × 5 ₽ profit");
});

test("a lot above one counts in the position value", async () => {
    const { exec, state } = build({ balance: 10_000 });
    await exec.refreshBalance();
    exec.setCurrentCandle(candle("BBB", 37.3));  // lot 10
    exec.sell({ ticker: "BBB", size: 14 });      // 140 shares
    await exec.drainOrders();

    state.balance = 10_000 + 140 * 37.3;
    await exec.refreshBalance();
    exec.setCurrentCandle(candle("BBB", 37.3));
    assert.equal(Math.round(exec.getEquity()), 10_000);
});

test("long: equity equals cash plus the shares' value", async () => {
    const { exec, state } = build({ balance: 10_000 });
    await exec.refreshBalance();
    exec.setCurrentCandle(candle("AAA", 50));
    exec.buy({ ticker: "AAA", size: 100 });
    await exec.drainOrders();

    state.balance = 5_000;                  // the purchase debited 100 × 50
    await exec.refreshBalance();
    exec.setCurrentCandle(candle("AAA", 55));
    assert.equal(exec.getEquity(), 10_500, "rising shares raise equity");
});

test("several shorts do not inflate equity one after another", async () => {
    const { exec, state } = build({ balance: 10_000 });
    await exec.refreshBalance();
    exec.setCurrentCandle(candle("AAA", 50));
    exec.sell({ ticker: "AAA", size: 100 });
    await exec.drainOrders();
    state.balance = 15_000;
    await exec.refreshBalance();

    exec.setCurrentCandle(candle("BBB", 100));   // lot 10 → 20 lots = 200 shares
    exec.sell({ ticker: "BBB", size: 20 });
    await exec.drainOrders();
    state.balance = 15_000 + 20_000;
    await exec.refreshBalance();

    exec.setCurrentCandle(candle("AAA", 50));
    exec.setCurrentCandle(candle("BBB", 100));
    assert.equal(exec.getEquity(), 10_000, "two short positions — equity unchanged");
});

test("quotationToNumber: {units, nano} → number, absent and zero rate → null", () => {
    assert.equal(quotationToNumber({ units: 0, nano: 300000000 }), 0.3);
    assert.equal(quotationToNumber({ units: 1, nano: 500000000 }), 1.5);
    assert.equal(quotationToNumber(undefined), null);
    assert.equal(quotationToNumber({ units: 0, nano: 0 }), null, "a zero rate counts as unset");
});
