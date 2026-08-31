import { test } from "node:test";
import assert from "node:assert/strict";
import { MultiSymbolTinkoffDataSource } from "./multi-data-source.js";

const MIN = 60_000;
const base = Date.UTC(2026, 7, 31, 4, 0);

/** Клиент-заглушка: подписку принимает, наружу ничего не ходит. */
function fakeClient() {
    return {
        api: {},
        subscribed: null,
        async subscribeCandles(instruments, interval, onCandle) {
            this.subscribed = { instruments, interval, onCandle };
        },
        async unsubscribeCandles() {},
        async _startCandleStream() {},
    };
}

const instruments = ["AAA", "BBB", "CCC"].map((ticker) => ({
    ticker, figi: `figi_${ticker}`, uid: `uid_${ticker}`, exchange: "MOEX", lot: 1,
}));

const candle = (ticker, minute, close = 100) => ({
    ticker, datetime: new Date(base + minute * MIN),
    open: close, high: close + 1, low: close - 1, close, volume: 10,
});

/** Собрать источник и выдать n свечей из потока. @private */
async function drain(src, count, feed) {
    const out = [];
    const iterator = src.stream();
    const first = iterator.next();       // подписка выполняется внутри stream()
    await new Promise((r) => setTimeout(r, 0));
    feed();
    out.push((await first).value);
    while (out.length < count) out.push((await iterator.next()).value);
    return out;
}

test("минута выдаётся пачкой, последняя свеча помечена isBatchEnd", async () => {
    const src = new MultiSymbolTinkoffDataSource({
        client: fakeClient(), instruments, batchGraceMs: 50, stallTimeoutMin: 0,
    });
    const got = await drain(src, 3, () => {
        src._accept(candle("BBB", 0, 200));
        src._accept(candle("AAA", 0, 100));
        src._accept(candle("CCC", 0, 300));   // пришли все — пачка уходит сразу
    });
    assert.deepEqual(got.map((c) => c.ticker), ["AAA", "BBB", "CCC"], "порядок по тикеру");
    assert.deepEqual(got.map((c) => Boolean(c.isBatchEnd)), [false, false, true]);
    await src.requestStop();
});

test("неполная минута выдаётся по льготному окну", async () => {
    const src = new MultiSymbolTinkoffDataSource({
        client: fakeClient(), instruments, batchGraceMs: 30, stallTimeoutMin: 0,
    });
    const got = await drain(src, 2, () => {
        src._accept(candle("AAA", 0));
        src._accept(candle("BBB", 0));       // CCC молчит — ждём таймер
    });
    assert.deepEqual(got.map((c) => c.ticker), ["AAA", "BBB"]);
    assert.equal(got[1].isBatchEnd, true, "последняя из пришедших закрывает пачку");
    await src.requestStop();
});

test("опоздавшая минута не уходит после более свежей", async () => {
    const src = new MultiSymbolTinkoffDataSource({
        client: fakeClient(), instruments, batchGraceMs: 10_000, stallTimeoutMin: 0,
    });
    const got = await drain(src, 4, () => {
        src._accept(candle("AAA", 0));            // минута 0 неполная, таймер далеко
        src._accept(candle("AAA", 1));
        src._accept(candle("BBB", 1));
        src._accept(candle("CCC", 1));            // минута 1 полная → выдаём 0, потом 1
    });
    const times = got.map((c) => c.datetime.getTime());
    assert.ok(times.every((t, i) => i === 0 || times[i - 1] <= t), "время не идёт назад");
    assert.equal(got[0].datetime.getTime(), base, "сначала опоздавшая минута");
    assert.equal(got[0].isBatchEnd, true, "она закрывается сама по себе");
    assert.equal(got.at(-1).ticker, "CCC");
    await src.requestStop();
});

test("дубль и устаревшая свеча по бумаге отбрасываются", async () => {
    const src = new MultiSymbolTinkoffDataSource({
        client: fakeClient(), instruments, batchGraceMs: 30, stallTimeoutMin: 0,
    });
    const got = await drain(src, 3, () => {
        src._accept(candle("AAA", 1, 111));
        src._accept(candle("AAA", 1, 999));   // дубль той же минуты
        src._accept(candle("AAA", 0, 888));   // устаревшая
        src._accept(candle("BBB", 1));
        src._accept(candle("CCC", 1));
    });
    assert.equal(got.length, 3);
    assert.equal(got.find((c) => c.ticker === "AAA").close, 111, "первая свеча выигрывает");
    assert.ok(got.every((c) => c.datetime.getTime() === base + MIN), "устаревшая не прошла");
    await src.requestStop();
});

test("чужой тикер игнорируется", async () => {
    const src = new MultiSymbolTinkoffDataSource({
        client: fakeClient(), instruments, batchGraceMs: 30, stallTimeoutMin: 0,
    });
    src._accept(candle("ZZZ", 0));
    assert.equal(src._buckets.size, 0);
    await src.requestStop();
});

test("подписка уходит списком инструментов", async () => {
    const client = fakeClient();
    const src = new MultiSymbolTinkoffDataSource({ client, instruments, stallTimeoutMin: 0 });
    const iterator = src.stream();
    iterator.next();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(client.subscribed.instruments.length, 3);
    assert.deepEqual(src.getSymbols(), ["AAA", "BBB", "CCC"]);
    assert.equal(src.getInstrument("BBB").figi, "figi_BBB");
    await src.requestStop();
});

// ── сторож молчания ───────────────────────────────────────────────────────────
const MSK = 3 * 3600_000;
/** Источник со сторожем и подставным расписанием. @private */
function withWatchdog(schedule) {
    const src = new MultiSymbolTinkoffDataSource({
        client: fakeClient(), instruments, stallTimeoutMin: 30, batchGraceMs: 10,
    });
    src.getTradingSchedule = async () => schedule;
    return src;
}
const mskDay = (iso) => new Date(new Date(iso).getTime() - MSK);   // МСК → UTC

test("вне сессии тишина не вызывает переподписку", async () => {
    // Торговый день, сессия 06:50–23:50 МСК; проверяем в 03:00 МСК.
    const src = withWatchdog([{
        dateKey: "2026-08-31", isTradingDay: true,
        startTime: mskDay("2026-08-31T06:50:00Z").toISOString(),
        endTime: mskDay("2026-08-31T23:50:00Z").toISOString(),
    }]);
    let reconnected = false;
    src._forceReconnect = async () => { reconnected = true; };
    src._lastCandleWall = mskDay("2026-08-31T00:00:00Z").getTime();   // молчит 3 часа
    await src._checkStall(mskDay("2026-08-31T03:00:00Z"));
    assert.equal(reconnected, false, "ночью переподписки быть не должно");
    await src.requestStop();
});

test("внутри сессии затяжная тишина вызывает переподписку", async () => {
    const src = withWatchdog([{
        dateKey: "2026-08-31", isTradingDay: true,
        startTime: mskDay("2026-08-31T06:50:00Z").toISOString(),
        endTime: mskDay("2026-08-31T23:50:00Z").toISOString(),
    }]);
    let reconnected = false;
    src._forceReconnect = async () => { reconnected = true; };
    src._lastCandleWall = mskDay("2026-08-31T08:00:00Z").getTime();
    await src._checkStall(mskDay("2026-08-31T08:45:00Z"));            // 45 мин тишины
    assert.equal(reconnected, true);
    await src.requestStop();
});

test("в неторговый день сторож молчит", async () => {
    const src = withWatchdog([{ dateKey: "2026-08-31", isTradingDay: false }]);
    let reconnected = false;
    src._forceReconnect = async () => { reconnected = true; };
    src._lastCandleWall = mskDay("2026-08-31T00:00:00Z").getTime();
    await src._checkStall(mskDay("2026-08-31T12:00:00Z"));
    assert.equal(reconnected, false);
    await src.requestStop();
});

test("без расписания работает запасное московское окно", async () => {
    const src = withWatchdog([]);          // расписание недоступно
    let reconnected = false;
    src._forceReconnect = async () => { reconnected = true; };
    src._lastCandleWall = mskDay("2026-08-31T00:00:00Z").getTime();
    await src._checkStall(mskDay("2026-08-31T04:00:00Z"));            // до 06:50 — вне окна
    assert.equal(reconnected, false, "отказ расписания не должен включать сторожа ночью");
    src._lastCandleWall = mskDay("2026-08-31T08:00:00Z").getTime();
    await src._checkStall(mskDay("2026-08-31T09:00:00Z"));            // внутри окна
    assert.equal(reconnected, true, "и не должен выключать его днём");
    await src.requestStop();
});
