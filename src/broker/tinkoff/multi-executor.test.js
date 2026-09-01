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

const figiToTicker = { figi_AAA: "AAA", figi_BBB: "BBB" };

function build({ balance = 10_000, orders = {}, positions = {}, status = {} } = {}) {
    const placed = [];
    const state = { balance, calls: 0, fail: false };
    const client = {
        accountId: "acc1",
        async getRubBalance() {
            state.calls += 1;
            if (state.fail) throw new Error("брокер молчит");
            return state.balance;
        },
        async getInstrumentPosition(figi) { return positions[figi] ?? null; },
        async getTradingStatus(figi) { return status[figi] ?? { marketOrderAvailableFlag: true }; },
    };
    // Имена методов и форма ответа — как у настоящих OrderManager/клиента:
    // заглушка с выдуманным интерфейсом пропустила бы вызов несуществующего метода.
    const orderManager = {
        async postMarketOrder(order) {
            placed.push(order);
            if (orders.throwOn === figiToTicker[order.figi]) {
                throw new Error(orders.throwMessage ?? "отказ биржи");
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


test("остаток перечитывается после ВХОДА, а не только после выхода", async () => {
    const { exec, state } = build();
    await exec.init();
    const before = state.calls;
    exec.setCurrentCandle(candle("AAA", 50));
    state.balance = 7_000;                       // биржа заняла маржу
    exec.sell({ ticker: "AAA", budget: 3000 });
    await exec.drainOrders();
    assert.ok(state.calls > before, "запрос остатка после входа был");
    assert.equal(exec.getBalance(), 7_000, "кэш обновлён");
});

test("капитал не удваивает маржу открытой позиции", async () => {
    const { exec, state } = build();
    await exec.init();
    exec.setCurrentCandle(candle("AAA", 100));
    exec.sell({ ticker: "AAA", budget: 2500 });
    const lots = exec.getPositionOf("AAA").size;
    // Брокер занял маржу: свободный кэш упал ровно на неё.
    state.balance = 10_000 - lots * 100;
    await exec.drainOrders();
    // Цена не двигалась → капитал обязан остаться прежним.
    assert.equal(Math.round(exec.getEquity()), 10_000);
});

test("на конце минуты остаток перечитывается, если устарел", async () => {
    const { exec, state } = build();
    await exec.init();
    exec._balanceAt = Date.now() - 120_000;      // прошлое чтение давно
    const before = state.calls;
    state.balance = 8_110;                       // ушла абонентская плата
    exec.setCurrentCandle(candle("AAA", 50, { isBatchEnd: true }));
    await exec.drainOrders();
    assert.equal(state.calls, before + 1);
    assert.equal(exec.getBalance(), 8_110);
});

test("свежий остаток на конце минуты повторно не запрашивается", async () => {
    const { exec, state } = build();
    await exec.init();
    const before = state.calls;
    exec.setCurrentCandle(candle("AAA", 50, { isBatchEnd: true }));
    await exec.drainOrders();
    assert.equal(state.calls, before, "лишнего запроса нет");
});

test("отказ при чтении остатка не роняет такт и не помечает значение свежим", async () => {
    const { exec, state } = build();
    await exec.init();
    const known = exec.getBalance();
    state.fail = true;
    exec._balanceAt = Date.now() - 120_000;
    exec.setCurrentCandle(candle("AAA", 50, { isBatchEnd: true }));
    await exec.drainOrders();
    assert.equal(exec.getBalance(), known, "работаем на прошлом значении");
    state.fail = false;
    state.balance = 5_555;
    exec.setCurrentCandle(candle("BBB", 50, { isBatchEnd: true }));
    await exec.drainOrders();
    assert.equal(exec.getBalance(), 5_555, "попытка повторилась на следующей минуте");
});

test("трейлинг помечается как trail, защитный стоп — как sl", async () => {
    const { exec } = build();
    await exec.init();
    // Защитный стоп: уровень ВЫШЕ входа (шорт ушёл против нас).
    exec.setCurrentCandle(candle("AAA", 50));
    exec.sell({ ticker: "AAA", budget: 3000, sl: 52.5 });
    await exec.drainOrders();
    const hitSl = candle("AAA", 52, { high: 53 });
    exec.setCurrentCandle(hitSl);
    exec.checkStops(hitSl);
    await exec.drainOrders();
    assert.equal(exec.sessionTrades.at(-1).reason, "sl");

    // Трейлинг: уровень НИЖЕ входа (замок прибыли уже взведён).
    exec.setCurrentCandle(candle("BBB", 100));
    exec.sell({ ticker: "BBB", budget: 3000, sl: 97 });
    await exec.drainOrders();
    const hitTrail = candle("BBB", 97.5, { high: 98 });
    exec.setCurrentCandle(hitTrail);
    exec.checkStops(hitTrail);
    await exec.drainOrders();
    assert.equal(exec.sessionTrades.at(-1).reason, "trail");
});

test("провал закрытия возвращает позицию в состояние, а не оставляет фантомный флэт", async () => {
    const { exec } = build();
    await exec.init();
    exec.setCurrentCandle(candle("AAA", 50));
    exec.sell({ ticker: "AAA", budget: 4000, sl: 52, exitDeadline: Date.now() + 3_600_000 });
    await exec.drainOrders();
    const before = exec.getPositionOf("AAA");
    assert.ok(before, "позиция открыта");

    // Биржа отказывает на закрытии.
    const om = exec.orderManager;
    om.closePosition = async () => { throw new Error("отказ биржи"); };
    exec.closePosition("signal", "AAA");
    await exec.drainOrders();

    const after = exec.getPositionOf("AAA");
    assert.ok(after, "позиция обязана вернуться в состояние");
    assert.equal(after.size, before.size);
    assert.equal(after.sl, 52, "уровень защиты сохранён");
    assert.equal(exec.isBusy("AAA"), true, "бумага занята — повторного входа не будет");
});

test("частичное закрытие оставляет остаток с уровнями и дедлайном", async () => {
    const { exec } = build();
    await exec.init();
    exec.setCurrentCandle(candle("AAA", 50));
    exec.sell({ ticker: "AAA", budget: 4000, sl: 52, exitDeadline: Date.now() + 3_600_000 });
    await exec.drainOrders();
    const size = exec.getPositionOf("AAA").size;
    assert.ok(size > 1, "нужен размер больше одного лота");

    // Биржа исполняет только один лот из нескольких.
    exec.client.getOrderExecutionSummary = () => ({ lotsExecuted: 1, avgPrice: 50, statusName: "PARTIAL" });
    exec.closePosition("signal", "AAA");
    await exec.drainOrders();
    const rest = exec.getPositionOf("AAA");
    assert.ok(rest, "остаток под наблюдением");
    assert.equal(rest.size, size - 1);
    assert.equal(rest.sl, 52, "остаток не остался без стопа");
});

test("дедлайн повторяется, если бумага занята заявкой", async () => {
    const { exec } = build();
    await exec.init();
    exec.setCurrentCandle(candle("AAA", 50));
    // Дедлайн через 20 мс, а очередь заявок держим занятой.
    exec.sell({ ticker: "AAA", budget: 4000, exitDeadline: Date.now() + 20 });
    await exec.drainOrders();
    const slot = exec.slots.get("AAA");
    exec._inFlight.add("AAA");                       // имитируем висящую заявку
    await new Promise((r) => setTimeout(r, 60));     // дедлайн сработал и был отклонён
    assert.ok(slot.exitTimer, "таймер перевзведён, а не потерян");
    assert.ok(exec.getPositionOf("AAA"), "позиция ещё на месте");
    exec._inFlight.delete("AAA");
    slot.exitTimer = null;
});

// ── блокировка бумаги после отказа биржи ────────────────────────────────────
// Найдено в бою: свободный слот раз за разом уходил лучшему кандидату, биржа
// отклоняла заявку, слот откатывался — и так до конца дня. Отказ должен
// запоминаться, иначе следующий кандидат шанса не получает.

test("постоянный отказ биржи исключает бумагу до перезапуска", async () => {
    const { exec, placed } = build({
        orders: { throwOn: "AAA", throwMessage: "Dlya torgovli e`tim instrumentom neobxodimo projti test" },
    });
    await exec.refreshBalance();
    exec.setCurrentCandle(candle("AAA", 50));
    assert.ok(exec.sell({ ticker: "AAA", budget: 5000 }), "первая попытка уходит в биржу");
    await exec.drainOrders();

    assert.equal(exec.isBlocked("AAA"), true, "после отказа бумага заблокирована");
    exec.setCurrentCandle(candle("AAA", 50));
    assert.equal(exec.sell({ ticker: "AAA", budget: 5000 }), null, "повторная заявка не ставится");
    await exec.drainOrders();
    assert.equal(placed.length, 1, "в биржу ушла ровно одна заявка, а не по одной в минуту");
});

test("постоянная блокировка не снимается ростом кассы", async () => {
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
    assert.equal(exec.isBlocked("AAA"), true, "тест в приложении деньгами не заменяется");
});

test("нехватка залога снимается, когда касса выросла", async () => {
    const { exec, state } = build({
        balance: 1000,
        orders: { throwOn: "AAA", throwMessage: "Not enough assets for a margin trade" },
    });
    await exec.refreshBalance();
    exec.setCurrentCandle(candle("AAA", 50));
    exec.sell({ ticker: "AAA", budget: 500 });
    await exec.drainOrders();
    assert.equal(exec.isBlocked("AAA"), true, "на той же кассе повторять незачем");

    state.balance = 1200;                    // +20%, порога 25% не хватает
    await exec.refreshBalance();
    assert.equal(exec.isBlocked("AAA"), true, "копеечный рост кассы блокировку не снимает");

    state.balance = 2000;                    // закрылась позиция, денег заметно больше
    await exec.refreshBalance();
    assert.equal(exec.isBlocked("AAA"), false, "после роста кассы бумагу можно пробовать снова");

    exec.setCurrentCandle(candle("AAA", 50));
    assert.ok(exec.sell({ ticker: "AAA", budget: 500 }), "заявка снова принимается");
    await exec.drainOrders();
});

test("отказ по одной бумаге не блокирует остальные", async () => {
    const { exec, placed } = build({ orders: { throwOn: "AAA", throwMessage: "neobxodimo projti test" } });
    await exec.refreshBalance();
    exec.setCurrentCandle(candle("AAA", 50));
    exec.sell({ ticker: "AAA", budget: 5000 });
    await exec.drainOrders();

    exec.setCurrentCandle(candle("BBB", 100));
    assert.ok(exec.sell({ ticker: "BBB", budget: 2500 }), "слот достаётся следующему кандидату");
    await exec.drainOrders();
    assert.equal(placed.length, 2);
    assert.deepEqual(exec.getBlocked().map((b) => b.ticker), ["AAA"]);
});

// ── цена входа берётся из заливки, а не из цены решения ─────────────────────
// Позиция открывается оптимистично по close сигнальной свечи. Если оставить эту
// цену, от неё будет считаться MFE — то есть момент взвода трейлинга, — и живой
// контур разойдётся с бэктестом на величину проскальзывания.

test("цена входа заменяется фактической ценой исполнения", async () => {
    const { exec } = build({ orders: { avgPrice: 49.4 } });
    await exec.refreshBalance();
    exec.setCurrentCandle(candle("AAA", 50));            // решали по 50
    const position = exec.sell({ ticker: "AAA", budget: 5000 });
    assert.equal(position.entryPrice, 50, "до заливки — цена решения");
    await exec.drainOrders();
    assert.equal(exec.getPositionOf("AAA").entryPrice, 49.4, "после заливки — цена сделки");
});

test("уровни SL и TP уточнением цены не двигаются", async () => {
    const { exec } = build({ orders: { avgPrice: 49.4 } });
    await exec.refreshBalance();
    exec.setCurrentCandle(candle("AAA", 50));
    exec.sell({ ticker: "AAA", budget: 5000, sl: 52.5, tp: 47.5 });
    await exec.drainOrders();
    const position = exec.getPositionOf("AAA");
    assert.equal(position.sl, 52.5, "стоп считает стратегия от цены решения — как в бэктесте");
    assert.equal(position.tp, 47.5);
});

test("без цены исполнения от брокера остаётся цена решения", async () => {
    const { exec } = build({ orders: { avgPrice: null } });
    await exec.refreshBalance();
    exec.setCurrentCandle(candle("AAA", 50));
    exec.sell({ ticker: "AAA", budget: 5000 });
    await exec.drainOrders();
    assert.equal(exec.getPositionOf("AAA").entryPrice, 50, "выдумывать цену нечем");
});

test("уточнённая цена входа переживает перезапуск", async () => {
    const { exec } = build({ orders: { avgPrice: 49.4 } });
    await exec.refreshBalance();
    exec.setCurrentCandle(candle("AAA", 50));
    exec.sell({ ticker: "AAA", budget: 5000 });
    await exec.drainOrders();
    const saved = exec.slots.get("AAA").store.load();
    assert.equal(saved.entryPrice, 49.4, "в файл состояния записана цена сделки");
});
