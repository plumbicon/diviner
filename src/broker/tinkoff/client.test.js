import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { TinkoffClient } from "./client.js";

/**
 * Клиент с заглушенным стримом и без сети. Конструктор TinkoffInvestApi ничего
 * не открывает, поэтому его результат просто подменяем.
 */
function makeClient({ startCandleStream }) {
    const client = new TinkoffClient("t.test", { streamReconnectDelayMs: 1 });
    client.api = { stream: { market: { connected: false, options: {}, on() {} } } };
    client.candleSubscription = { onReconnectCatchUp: null };
    client.lastPriceSubscription = null;
    client._startCandleStream = startCandleStream;
    return client;
}

/** Пропустить n тиков очереди микрозадач и таймеров. */
const settle = (ms = 5) => new Promise((r) => setTimeout(r, ms));

test("сторож не запускает второе переподключение поверх идущего", async () => {
    let starts = 0;
    let release;
    const client = makeClient({
        startCandleStream: async () => {
            starts += 1;
            await new Promise((r) => { release = r; });   // «медленная» подписка
        },
    });

    client._scheduleCandleReconnect(new Error("stream error"));
    await settle();                                       // таймер сработал, подписка висит

    assert.equal(starts, 1, "переподключение началось");
    assert.equal(client.streamReconnectTimer, null, "таймер обнулён в начале колбэка");

    // Дословно условие сторожа из _startKeepAlive: стрим не connected, таймера
    // нет. До правки оно проходило и заводило вторую попытку поверх идущей.
    assert.equal(Boolean(client.api.stream?.market?.connected), false,
        "стрим ещё не поднялся");
    if (!client.api.stream?.market?.connected && !client.streamReconnectTimer
        && !client.isReconnecting) {
        client._scheduleCandleReconnect(new Error("stream down, no reconnect pending"));
    }
    await settle();
    assert.equal(starts, 1, "второго переподключения поверх идущего не случилось");
    assert.equal(client.isReconnecting, true, "признак работы держится до конца");

    // Прямой вызов планировщика тоже должен быть отброшен, пока флаг поднят.
    client._scheduleCandleReconnect(new Error("again"));
    await settle();
    assert.equal(starts, 1, "планировщик отбрасывает попытку во время работы");

    release();
    await settle();
    assert.equal(client.isReconnecting, false, "флаг снят по завершении");
    client.isClosing = true;
});

test("упавшее переподключение повторяется, флаг не запирает повтор", async () => {
    let starts = 0;
    const client = makeClient({
        startCandleStream: async () => {
            starts += 1;
            if (starts < 3) throw new Error(`boom ${starts}`);
        },
    });

    client._scheduleCandleReconnect(new Error("stream error"));
    await settle(60);                                     // задержка растёт 1, 2, 4 мс

    assert.equal(starts, 3, "две неудачи и успех на третьей попытке");
    assert.equal(client.isReconnecting, false, "флаг снят");
    assert.equal(client.streamReconnectAttempts, 0, "счётчик сброшен успехом");
    client.isClosing = true;
});

// ── зависший и молчащий стрим ─────────────────────────────────────────────────

/** Market-стрим библиотеки в миниатюре: подписка висит, если hang. @private */
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

/** Клиент с настоящим _startCandleStream поверх очереди подставных стримов. */
function makeStreamClient(markets) {
    const queue = [...markets];
    const client = new TinkoffClient("t.test", {
        streamReconnectDelayMs: 1,
        subscribeTimeoutMs: 20,
        createMarketStream: () => queue.shift(),
    });
    client.api = { streamClients: { market: queue.shift() }, get stream() { return this.streamClients; } };
    client.candleSubscription = {
        instruments: [{ ticker: "AAA", figi: "f", uid: "u" }], tickerByKey: new Map(),
        interval: 1, candleInterval: 1, waitingClose: true, onCandle: null, onReconnectCatchUp: null,
    };
    client._attachMarketStreamErrorHandler();
    return client;
}

test("зависшая подписка не запирает переподключение: стрим брошен, повтор в новом", async () => {
    // 08.10.2026: подписка ждала статуса без таймаута, isReconnecting держался
    // 7 часов, и все следующие ошибки стрима отбрасывались.
    const dead = fakeMarket({ hang: true });
    const fresh = fakeMarket();
    const client = makeStreamClient([dead, fresh]);

    client._scheduleCandleReconnect(new Error("read ECONNRESET"));
    await settle(80);

    assert.equal(dead.subscribes, 1, "первая попытка ушла в молчащий стрим");
    assert.equal(dead.cancelled, true, "брошенный вызов закрыт");
    assert.equal(dead.emitter.listenerCount("data"), 0, "обработчики зависшей подписки сняты");
    assert.equal(client.api.stream.market, fresh, "на месте брошенного — новый стрим");
    assert.equal(fresh.subscribes, 1, "повтор подписался в новом стриме");
    assert.equal(client.isReconnecting, false, "флаг не заперт");
    assert.equal(client.streamReconnectAttempts, 0, "успех сбросил счётчик");
    client.isClosing = true;
});

test("стрим без свечей и пингов дольше порога бросается и переподписывается", async () => {
    const silent = fakeMarket();
    const fresh = fakeMarket();
    const client = makeStreamClient([silent, fresh]);
    client.streamSilenceMs = 1000;

    client._checkStreamHealth(client.lastStreamMessageAt + 500);
    assert.equal(client.api.stream.market, silent, "в пределах порога стрим не трогаем");

    const before = client.lastStreamMessageAt;
    await settle(2);
    silent.emitter.emit("data", { ping: {} });
    assert.ok(client.lastStreamMessageAt > before, "ping брокера — признак жизни");

    client._checkStreamHealth(client.lastStreamMessageAt + 1500);
    assert.equal(client.api.stream.market, fresh, "молчащий стрим заменён");
    await settle(20);
    assert.equal(fresh.subscribes, 1, "подписка восстановлена в новом стриме");
    client.isClosing = true;
});

test("переподписка по сторожу идёт в новый вызов, а не в молчащий", async () => {
    const stale = fakeMarket();
    const fresh = fakeMarket();
    const client = makeStreamClient([stale, fresh]);

    await client.restartMarketStream("candle silence");
    assert.equal(stale.subscribes, 0, "в старый вызов подписка не отправлялась");
    assert.equal(stale.cancelled, true);
    assert.equal(fresh.subscribes, 1);
    assert.equal(client.isReconnecting, false);

    client.isReconnecting = true;
    await assert.rejects(client.restartMarketStream("again"), /already in progress/,
        "поверх идущего переподключения второе не запускается");
    client.isReconnecting = false;
    client.isClosing = true;
});
