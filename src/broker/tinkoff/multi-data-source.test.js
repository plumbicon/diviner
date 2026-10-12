import { test } from "node:test";
import assert from "node:assert/strict";
import { MultiSymbolTinkoffDataSource } from "./multi-data-source.js";

const MIN = 60_000;
const base = Date.UTC(2026, 7, 31, 4, 0);

/** Client stub: accepts the subscription, never goes to the network. */
function fakeClient() {
    return {
        api: {},
        subscribed: null,
        async subscribeCandles(instruments, interval, onCandle) {
            this.subscribed = { instruments, interval, onCandle };
        },
        async unsubscribeCandles() {},
        restarts: 0,
        async restartMarketStream() { this.restarts += 1; },
    };
}

const instruments = ["AAA", "BBB", "CCC"].map((ticker) => ({
    ticker, figi: `figi_${ticker}`, uid: `uid_${ticker}`, exchange: "MOEX", lot: 1,
}));

const candle = (ticker, minute, close = 100) => ({
    ticker, datetime: new Date(base + minute * MIN),
    open: close, high: close + 1, low: close - 1, close, volume: 10,
});

/** Build a source and take n candles from its stream. @private */
async function drain(src, count, feed) {
    const out = [];
    const iterator = src.stream();
    const first = iterator.next();       // the subscription happens inside stream()
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
        src._accept(candle("CCC", 0, 300));   // everyone arrived — the batch goes out at once
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
        src._accept(candle("BBB", 0));       // CCC is silent — wait for the timer
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
        src._accept(candle("AAA", 0));            // minute 0 incomplete, the timer is far
        src._accept(candle("AAA", 1));
        src._accept(candle("BBB", 1));
        src._accept(candle("CCC", 1));            // minute 1 complete → release 0, then 1
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
        src._accept(candle("AAA", 1, 999));   // duplicate of the same minute
        src._accept(candle("AAA", 0, 888));   // stale
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

// ── silence watchdog ──────────────────────────────────────────────────────────
const MSK = 3 * 3600_000;
/** Source with the watchdog and a stubbed schedule. @private */
function withWatchdog(schedule) {
    const src = new MultiSymbolTinkoffDataSource({
        client: fakeClient(), instruments, stallTimeoutMin: 30, batchGraceMs: 10,
    });
    src.getTradingSchedule = async () => schedule;
    return src;
}
const mskDay = (iso) => new Date(new Date(iso).getTime() - MSK);   // Moscow → UTC

test("вне сессии тишина не вызывает переподписку", async () => {
    // A trading day, session 06:50–23:50 Moscow; checked at 03:00 Moscow.
    const src = withWatchdog([{
        dateKey: "2026-08-31", isTradingDay: true,
        startTime: mskDay("2026-08-31T06:50:00Z").toISOString(),
        endTime: mskDay("2026-08-31T23:50:00Z").toISOString(),
    }]);
    let reconnected = false;
    src._forceReconnect = async () => { reconnected = true; };
    src._lastCandleWall = mskDay("2026-08-31T00:00:00Z").getTime();   // silent for 3 hours
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
    await src._checkStall(mskDay("2026-08-31T08:45:00Z"));            // 45 minutes of silence
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
    const src = withWatchdog([]);          // schedule unavailable
    let reconnected = false;
    src._forceReconnect = async () => { reconnected = true; };
    src._lastCandleWall = mskDay("2026-08-31T00:00:00Z").getTime();
    await src._checkStall(mskDay("2026-08-31T04:00:00Z"));            // before 06:50 — outside the window
    assert.equal(reconnected, false, "отказ расписания не должен включать сторожа ночью");
    src._lastCandleWall = mskDay("2026-08-31T08:00:00Z").getTime();
    await src._checkStall(mskDay("2026-08-31T09:00:00Z"));            // inside the window
    assert.equal(reconnected, true, "и не должен выключать его днём");
    await src.requestStop();
});

test("свеча старше уже отданной минуты отбрасывается, время не идёт назад", async () => {
    const src = new MultiSymbolTinkoffDataSource({
        client: fakeClient(), instruments, batchGraceMs: 10, stallTimeoutMin: 0,
    });
    const got = await drain(src, 2, () => {
        src._accept(candle("AAA", 5));
        src._accept(candle("BBB", 5));          // CCC is silent, the batch goes out by the timer
    });
    assert.equal(got.length, 2);
    // The catch-up after a reconnect feeds an old minute of an instrument that WAS SILENT:
    // per-instrument deduplication does not catch it, only the released-minute boundary does.
    src._accept(candle("CCC", 2));
    assert.equal(src._buckets.size, 0, "пачка за прошедшую минуту не создаётся");
    assert.equal(src._droppedLate, 1);
    await src.requestStop();
});

// ── repeated silence: process restart ─────────────────────────────────────────
const sessionDay = [{
    dateKey: "2026-08-31", isTradingDay: true,
    startTime: mskDay("2026-08-31T06:50:00Z").toISOString(),
    endTime: mskDay("2026-08-31T23:50:00Z").toISOString(),
}];

test("переподписка сторожа идёт через пересоздание стрима", async () => {
    const src = withWatchdog(sessionDay);
    src._lastCandleWall = mskDay("2026-08-31T08:00:00Z").getTime();
    await src._checkStall(mskDay("2026-08-31T08:45:00Z"));
    assert.equal(src.client.restarts, 1, "старый вызов не переиспользуется");
    await src.requestStop();
});

test("тишина после переподписки завершает поток ошибкой", async () => {
    const src = withWatchdog(sessionDay);
    let reconnects = 0;
    src._forceReconnect = async () => { reconnects += 1; };
    const next = src.stream().next();
    await new Promise((r) => setTimeout(r, 0));

    src._lastCandleWall = mskDay("2026-08-31T08:00:00Z").getTime();
    await src._checkStall(mskDay("2026-08-31T08:45:00Z"));
    assert.equal(reconnects, 1, "первая тишина — переподписка");
    await src._checkStall(mskDay("2026-08-31T09:20:00Z"));
    assert.equal(reconnects, 1, "вторая — уже не переподписка");
    await assert.rejects(next, /после переподписки/, "поток завершён ошибкой → выход с кодом 1");
});

test("живая свеча после переподписки снимает признак, догрузка — нет", async () => {
    const src = withWatchdog(sessionDay);
    let reconnects = 0;
    src._forceReconnect = async () => { reconnects += 1; };
    src._lastCandleWall = mskDay("2026-08-31T08:00:00Z").getTime();
    await src._checkStall(mskDay("2026-08-31T08:45:00Z"));
    assert.equal(src._stallReconnected, true);

    const wall = src._lastCandleWall;
    src._accept({ ...candle("AAA", 1), isCatchUp: true });
    assert.equal(src._lastCandleWall, wall, "догрузка по REST не считается живым стримом");
    assert.equal(src._stallReconnected, true);

    src._accept(candle("BBB", 2));
    assert.equal(src._stallReconnected, false, "живая свеча — стрим ожил");
    src._lastCandleWall = mskDay("2026-08-31T10:00:00Z").getTime();
    await src._checkStall(mskDay("2026-08-31T10:45:00Z"));
    assert.equal(reconnects, 2, "новая тишина снова начинается с переподписки");
    assert.equal(src._fatal, null);
    await src.requestStop();
});
