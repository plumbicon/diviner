import { test } from "node:test";
import assert from "node:assert/strict";
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
