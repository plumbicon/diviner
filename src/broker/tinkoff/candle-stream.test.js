import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { CandleStream, formatCandle } from "./candle-stream.js";

/** Let pending timers and microtasks run. */
const settle = (ms = 5) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait until a condition holds (polling), so timer-driven tests do not depend on how
 * loaded the machine is. Fails after `timeoutMs`.
 */
async function waitFor(condition, timeoutMs = 2000) {
    const until = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > until) throw new Error("condition not met in time");
        await settle(5);
    }
}

/**
 * Stream over a market stream that is not connected, with the subscription call stubbed:
 * enough to drive the reconnect logic without the library.
 */
function stubbedStream(subscribeCandles) {
    const stream = new CandleStream(
        { stream: { market: { connected: false, options: {}, on() {} } } },
        { streamReconnectDelayMs: 1 },
    );
    stream.subscription = { onReconnectCatchUp: null };
    stream._subscribeCandles = subscribeCandles;
    return stream;
}

test("сторож не запускает второе переподключение поверх идущего", async () => {
    let starts = 0;
    let release;
    const stream = stubbedStream(async () => {
        starts += 1;
        await new Promise((r) => { release = r; });   // a slow subscription
    });

    stream._scheduleReconnect(new Error("stream error"));
    await settle();                                       // timer fired, subscription hangs

    assert.equal(starts, 1, "переподключение началось");
    assert.equal(stream.reconnectTimer, null, "таймер обнулён в начале колбэка");

    // The health check sees a stream that is not connected and no timer pending. Before
    // the fix it started a second reconnect on top of the running one.
    assert.equal(Boolean(stream.api.stream?.market?.connected), false, "стрим ещё не поднялся");
    stream._checkHealth();
    await settle();
    assert.equal(starts, 1, "второго переподключения поверх идущего не случилось");
    assert.equal(stream.isReconnecting, true, "признак работы держится до конца");

    // A direct call of the scheduler is dropped as well while the flag is up.
    stream._scheduleReconnect(new Error("again"));
    await settle();
    assert.equal(starts, 1, "планировщик отбрасывает попытку во время работы");

    release();
    await settle();
    assert.equal(stream.isReconnecting, false, "флаг снят по завершении");
    stream.isClosing = true;
});

test("упавшее переподключение повторяется, флаг не запирает повтор", async () => {
    let starts = 0;
    const stream = stubbedStream(async () => {
        starts += 1;
        if (starts < 3) throw new Error(`boom ${starts}`);
    });

    stream._scheduleReconnect(new Error("stream error"));
    await waitFor(() => starts === 3 && !stream.isReconnecting);   // delays grow 1, 2, 4 ms

    assert.equal(starts, 3, "две неудачи и успех на третьей попытке");
    assert.equal(stream.isReconnecting, false, "флаг снят");
    assert.equal(stream.reconnectAttempts, 0, "счётчик сброшен успехом");
    stream.isClosing = true;
});

// ── hung and silent streams ──────────────────────────────────────────────────

/** The library's market stream in miniature: the subscription hangs when `hang` is set. */
function fakeMarket({ hang = false } = {}) {
    const emitter = new EventEmitter();
    return {
        connected: true, options: {}, emitter, cancelled: false, subscribes: 0,
        on(event, handler) { emitter.on(event, handler); return () => emitter.off(event, handler); },
        off(event, handler) { emitter.off(event, handler); },
        async cancel() { this.cancelled = true; },
        async candles(_req, handler) {
            this.subscribes += 1;
            emitter.on("data", handler);
            return hang ? new Promise(() => {}) : async () => {};
        },
    };
}

/** Stream with the real subscription code over a queue of fake market streams. */
function queuedStream(markets) {
    const queue = [...markets];
    const api = { streamClients: { market: queue.shift() }, get stream() { return this.streamClients; } };
    const stream = new CandleStream(api, {
        streamReconnectDelayMs: 1,
        subscribeTimeoutMs: 20,
        createMarketStream: () => queue.shift(),
    });
    stream.subscription = {
        instruments: [{ ticker: "AAA", figi: "f", uid: "u" }], tickerByKey: new Map(),
        interval: 1, candleInterval: 1, waitingClose: true, onCandle: null, onReconnectCatchUp: null,
    };
    stream._attachHandlers();
    return stream;
}

test("зависшая подписка не запирает переподключение: стрим брошен, повтор в новом", async () => {
    // 2026-10-08: the subscription awaited its status with no timeout, isReconnecting
    // stayed up for 7 hours, and every later stream error was dropped.
    const dead = fakeMarket({ hang: true });
    const fresh = fakeMarket();
    const stream = queuedStream([dead, fresh]);

    stream._scheduleReconnect(new Error("read ECONNRESET"));
    await waitFor(() => fresh.subscribes === 1 && !stream.isReconnecting);

    assert.equal(dead.subscribes, 1, "первая попытка ушла в молчащий стрим");
    assert.equal(dead.cancelled, true, "брошенный вызов закрыт");
    assert.equal(dead.emitter.listenerCount("data"), 0, "обработчики зависшей подписки сняты");
    assert.equal(stream.api.stream.market, fresh, "на месте брошенного — новый стрим");
    assert.equal(fresh.subscribes, 1, "повтор подписался в новом стриме");
    assert.equal(stream.isReconnecting, false, "флаг не заперт");
    assert.equal(stream.reconnectAttempts, 0, "успех сбросил счётчик");
    stream.isClosing = true;
});

test("стрим без свечей и пингов дольше порога бросается и переподписывается", async () => {
    const silent = fakeMarket();
    const fresh = fakeMarket();
    const stream = queuedStream([silent, fresh]);
    stream.silenceMs = 1000;

    stream._checkHealth(stream.lastMessageAt + 500);
    assert.equal(stream.api.stream.market, silent, "в пределах порога стрим не трогаем");

    const before = stream.lastMessageAt;
    await settle(2);
    silent.emitter.emit("data", { ping: {} });
    assert.ok(stream.lastMessageAt > before, "ping брокера — признак жизни");

    stream._checkHealth(stream.lastMessageAt + 1500);
    assert.equal(stream.api.stream.market, fresh, "молчащий стрим заменён");
    await waitFor(() => fresh.subscribes === 1);
    assert.equal(fresh.subscribes, 1, "подписка восстановлена в новом стриме");
    stream.isClosing = true;
});

test("переподписка по сторожу идёт в новый вызов, а не в молчащий", async () => {
    const stale = fakeMarket();
    const fresh = fakeMarket();
    const stream = queuedStream([stale, fresh]);

    await stream.restart("candle silence");
    assert.equal(stale.subscribes, 0, "в старый вызов подписка не отправлялась");
    assert.equal(stale.cancelled, true);
    assert.equal(fresh.subscribes, 1);
    assert.equal(stream.isReconnecting, false);

    stream.isReconnecting = true;
    await assert.rejects(stream.restart("again"), /already in progress/,
        "поверх идущего переподключения второе не запускается");
    stream.isReconnecting = false;
    stream.isClosing = true;
});

test("свеча стрима переводится в форму движка", () => {
    const candle = formatCandle({
        candle: {
            figi: "F", instrumentUid: "U", time: new Date("2026-10-08T04:00:00Z"),
            open: { units: 10, nano: 500000000 }, high: { units: 11, nano: 0 },
            low: { units: 9, nano: 0 }, close: { units: 10, nano: 0 }, volume: "42", isComplete: true,
        },
    });
    assert.deepEqual(candle, {
        figi: "F", instrumentUid: "U", datetime: new Date("2026-10-08T04:00:00Z"),
        open: 10.5, high: 11, low: 9, close: 10, volume: 42, isComplete: true,
    });
});
