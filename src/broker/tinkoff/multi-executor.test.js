import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MultiSymbolTinkoffExecutor } from "./multi-executor.js";

const MIN = 60_000;
const instruments = [
    { ticker: "AAA", figi: "figi_AAA", uid: "uid_AAA", lot: 1, exchange: "MOEX" },
    { ticker: "BBB", figi: "figi_BBB", uid: "uid_BBB", lot: 10, exchange: "MOEX" },
];

function build({ balance = 10_000, orders = {}, positions = {}, status = {} } = {}) {
    const placed = [];
    const client = {
        accountId: "acc1",
        async getRubBalance() { return balance; },
        async getInstrumentPosition(figi) { return positions[figi] ?? null; },
        async getTradingStatus(figi) { return status[figi] ?? { marketOrderAvailableFlag: true }; },
    };
    const orderManager = {
        async placeMarketOrder(order) {
            placed.push(order);
            if (orders.throwOn === order.instrument.ticker) throw new Error("отказ биржи");
            return { executedLots: orders.executedLots ?? order.quantity };
        },
    };
    const exec = new MultiSymbolTinkoffExecutor({
        client, instruments, interval: 1,
        options: { orderManager, stateDir: mkdtempSync(join(tmpdir(), "mexec-")), commission: 0.0005 },
    });
    return { exec, placed, client };
}

const candle = (ticker, close, extra = {}) => ({
    ticker, datetime: new Date(), open: close, high: close + 1, low: close - 1, close, volume: 1, ...extra,
});

test("бюджет переводится в лоты с округлением вниз", async () => {
    const { exec } = build();
    await exec.refreshBalance();
    exec.setCurrentCandle(candle("BBB", 100));           // лот 10 → 1 лот ≈ 1010 ₽ с резервом
    const position = exec.sell({ ticker: "BBB", budget: 2500 });
    assert.equal(position.size, 2, "2 лота, не 2.5");
    await exec.drainOrders();
});

test("бюджет ограничен свободным кэшом", async () => {
    const { exec } = build({ balance: 900 });
    await exec.refreshBalance();
    exec.setCurrentCandle(candle("BBB", 100));
    assert.equal(exec.sell({ ticker: "BBB", budget: 100000 }), null, "на 900 ₽ лот в 1000 ₽ не берётся");
});

test("одна бумага — одна позиция, пока заявка в полёте бумага занята", async () => {
    const { exec, placed } = build();
    await exec.refreshBalance();
    exec.setCurrentCandle(candle("AAA", 50));
    assert.ok(exec.sell({ ticker: "AAA", budget: 5000 }));
    assert.equal(exec.isBusy("AAA"), true);
    assert.equal(exec.sell({ ticker: "AAA", budget: 5000 }), null, "второй вход в ту же бумагу отклонён");
    await exec.drainOrders();
    assert.equal(placed.length, 1);
    assert.deepEqual(exec.getPendingTickers(), [], "после исполнения бумага свободна");
    assert.equal(exec.getPositions().length, 1);
});

test("устаревшая свеча не торгуется", async () => {
    const { exec } = build();
    await exec.refreshBalance();
    exec.setCurrentCandle(candle("AAA", 50, { datetime: new Date(Date.now() - 10 * MIN) }));
    assert.equal(exec.sell({ ticker: "AAA", budget: 5000 }), null);
});

test("разогревочная свеча из догрузки не торгуется", async () => {
    const { exec } = build();
    await exec.refreshBalance();
    exec.setCurrentCandle(candle("AAA", 50, { noTrade: true }));
    assert.equal(exec.sell({ ticker: "AAA", budget: 5000 }), null);
});

test("отказ биржи откатывает оптимистично открытую позицию", async () => {
    const { exec } = build({ orders: { throwOn: "AAA" } });
    await exec.refreshBalance();
    exec.setCurrentCandle(candle("AAA", 50));
    assert.ok(exec.sell({ ticker: "AAA", budget: 5000 }), "позиция ставится оптимистично");
    await exec.drainOrders();
    assert.equal(exec.getPositionOf("AAA"), null, "после отказа состояние очищено");
    assert.equal(exec.isBusy("AAA"), false);
});

test("аукцион: рыночные заявки недоступны — вход отменяется", async () => {
    const { exec, placed } = build({ status: { figi_AAA: { marketOrderAvailableFlag: false } } });
    await exec.refreshBalance();
    exec.setCurrentCandle(candle("AAA", 50));
    exec.sell({ ticker: "AAA", budget: 5000 });
    await exec.drainOrders();
    assert.equal(placed.length, 0, "заявка не отправлена");
    assert.equal(exec.getPositionOf("AAA"), null);
});

test("частичное исполнение правит размер позиции", async () => {
    const { exec } = build({ orders: { executedLots: 3 } });
    await exec.refreshBalance();
    exec.setCurrentCandle(candle("AAA", 50));
    exec.sell({ ticker: "AAA", budget: 5000 });
    await exec.drainOrders();
    assert.equal(exec.getPositionOf("AAA").size, 3);
});

test("интрабарный стоп закрывает позицию по бумаге свечи", async () => {
    const { exec, placed } = build();
    await exec.refreshBalance();
    exec.setCurrentCandle(candle("AAA", 50));
    exec.sell({ ticker: "AAA", budget: 5000, sl: 52 });
    await exec.drainOrders();
    const hit = candle("AAA", 51, { high: 53 });          // хвостом задели 52
    exec.setCurrentCandle(hit);
    assert.ok(exec.checkStops(hit), "стоп сработал");
    await exec.drainOrders();
    assert.equal(exec.getPositionOf("AAA"), null);
    assert.equal(placed.at(-1).direction, "buy", "шорт закрывается покупкой");
});

test("позиции разных бумаг живут независимо", async () => {
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
    assert.ok(exec.getPositionOf("BBB"), "вторая бумага не задета");
});

test("сверка со счётом поднимает реальные позиции", async () => {
    const { exec } = build({
        positions: { figi_BBB: { side: "short", lots: 4, averagePrice: 99, currentPrice: 98 } },
    });
    await exec.init();
    const restored = exec.getPositionOf("BBB");
    assert.equal(restored.size, 4);
    assert.equal(restored.side, "short");
    assert.equal(restored.sl, null, "без файла состояния уровней нет");
    assert.equal(exec.getPositionOf("AAA"), null);
});

test("капитал складывает кэш, маржу и нереализованный P&L", async () => {
    const { exec } = build();
    await exec.refreshBalance();
    exec.setCurrentCandle(candle("AAA", 100));
    exec.sell({ ticker: "AAA", budget: 5000 });
    await exec.drainOrders();
    const size = exec.getPositionOf("AAA").size;
    exec.setCurrentCandle(candle("AAA", 90));             // шорт в плюсе на 10 за штуку
    assert.equal(Math.round(exec.getEquity()), Math.round(10_000 + size * 100 + size * 10));
});
