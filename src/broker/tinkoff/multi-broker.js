#!/usr/bin/env node
/**
 * Живой брокер T-Invest — единственный live-путь на MOEX. Вселенная из одного тикера
 * работает так же, как из сотни. Здесь только сборка и утилиты счёта — вся логика в
 * {@link MultiSymbolTinkoffDataSource} и {@link MultiSymbolTinkoffExecutor}.
 *
 * Вселенная задаётся списком (`--tickers`) либо файлом (`--universe-file`),
 * который делает `src/universe.js`. Резолв инструментов кэшируется на диск:
 * 97 тикеров через `getInstrumentByTicker` занимают ~40 секунд, и платить их
 * при каждом старте незачем.
 *
 * Usage:
 *   T_INVEST_TOKEN=<t> diviner src/broker/tinkoff/multi-broker.js \
 *     --strategy <путь-к-стратегии> --account <id> \
 *     --universe-file data/universe.json --intrabar-stops
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { TinkoffClient } from "./client.js";
import { MultiSymbolTinkoffDataSource } from "./multi-data-source.js";
import { MultiSymbolTinkoffExecutor } from "./multi-executor.js";
import { runUtility, isUtilityRequest } from "./sandbox-utils.js";

export { runUtility, isUtilityRequest };

export const options = [
    { flags: "--tickers <list>", description: "Инструменты вселенной через запятую" },
    { flags: "--universe-file <path>", description: "JSON со списком тикеров и кэшем инструментов (см. src/universe.js)" },
    { flags: "--account <id>", description: "Account ID" },
    { flags: "--sandbox", description: "Песочница (виртуальные деньги)", default: false },
    { flags: "--dry-run", description: "Стратегия работает, заявки не отправляются", default: false },
    { flags: "--interval <minutes>", description: "Интервал свечей, минут", default: "1" },
    { flags: "--close-on-exit", description: "Закрыть открытые позиции при остановке", default: false },
    { flags: "--order-retries <count>", description: "Повторы при транзиентных ошибках заявки", default: "2" },
    { flags: "--order-tag <tag>", description: "Метка в ключе идемпотентности заявки", default: "div" },
    { flags: "--stall-timeout <minutes>", description: "Порог тишины ВСЕГО стрима до переподписки (0 — выключить)", default: "30" },
    { flags: "--batch-grace-ms <ms>", description: "Окно сбора минуты: сколько ждать отставших бумаг перед решением", default: "8000" },
    { flags: "--state-dir <path>", description: "Каталог файлов состояния позиций (по умолчанию .diviner-state)" },
    { flags: "--intrabar-stops", description: "Проверять SL/TP по high/low пришедшей свечи, а не только по close", default: false },
    { flags: "--leverage <n>", description: "Плечо. >1 шлёт confirmMarginTrade=true", default: "1" },
    { flags: "--print-balance", description: "Показать баланс и позиции и выйти", default: false },
    { flags: "--print-history", description: "Показать историю операций и выйти", default: false },
    { flags: "--history-from <date>", description: "Начало периода для --print-history" },
    // Управление счетами песочницы (без стратегии, только с --sandbox):
    { flags: "--list-sandboxes", description: "Список счетов песочницы и выход", default: false },
    { flags: "--create-account", description: "Создать счёт в песочнице", default: false },
    { flags: "--remove-account", description: "Удалить счёт песочницы из --account", default: false },
    { flags: "--reset-positions", description: "Обнулить позиции в бумагах на счёте песочницы (рубли остаются)", default: false },
    { flags: "--increase-balance <amount>", description: "Пополнить рублёвый баланс счёта песочницы" },
    { flags: "--log <path>", description: "Дублировать вывод в файл" },
];

/**
 * Прочитать состав вселенной: явный список важнее файла.
 * @param {object} config - Конфиг CLI.
 * @returns {Promise<{tickers: Array<string>, cache: object|null, path: string|null}>} Вселенная.
 */
async function readUniverse(config) {
    if (config.tickers) {
        return { tickers: config.tickers.split(",").map((t) => t.trim()).filter(Boolean), cache: null, path: null };
    }
    if (!config.universeFile) {
        throw new Error("provide --tickers <list> or --universe-file <path>");
    }
    const raw = JSON.parse(await readFile(config.universeFile, "utf8"));
    const tickers = Array.isArray(raw) ? raw : (raw.tickers || []);
    if (!tickers.length) throw new Error(`${config.universeFile} holds no tickers`);
    return { tickers, cache: Array.isArray(raw) ? null : (raw.instruments || null), path: config.universeFile };
}

/**
 * Резолв инструментов с кэшем на диске.
 *
 * `getInstrumentByTicker` ходит по одному инструменту: на 97 тикерах это ~40
 * секунд перед подпиской. Кэш снимает эту паузу, но лот и ставка риска со
 * временем меняются, поэтому он живёт ограниченный срок.
 *
 * @param {object} client - TinkoffClient.
 * @param {object} universe - Результат readUniverse.
 * @param {number} maxAgeMs - Срок годности кэша.
 * @returns {Promise<Array<object>>} Инструменты.
 */
async function resolveInstruments(client, universe, maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
    const fresh = universe.cache?.resolvedAt
        && Date.now() - Date.parse(universe.cache.resolvedAt) < maxAgeMs;
    if (fresh) {
        const cached = universe.tickers.map((t) => universe.cache.byTicker?.[t]).filter(Boolean);
        if (cached.length === universe.tickers.length) {
            console.log(`[MultiBroker] Инструменты из кэша: ${cached.length}.`);
            return cached;
        }
    }

    const started = Date.now();
    const instruments = [];
    const missing = [];
    for (const ticker of universe.tickers) {
        try {
            instruments.push(await client.getInstrumentByTicker(ticker));
        } catch (error) {
            missing.push(`${ticker} (${error.message})`);
        }
    }
    if (missing.length) console.warn(`[MultiBroker] Не резолвятся: ${missing.join(", ")}`);
    if (!instruments.length) throw new Error("no instruments resolved");
    console.log(`[MultiBroker] Резолв ${instruments.length} инструментов за ${((Date.now() - started) / 1000).toFixed(1)}с.`);

    if (universe.path) {
        const byTicker = Object.fromEntries(instruments.map((i) => [i.ticker, i]));
        try {
            await mkdir(dirname(universe.path), { recursive: true });
            await writeFile(universe.path, JSON.stringify({
                tickers: universe.tickers,
                instruments: { resolvedAt: new Date().toISOString(), byTicker },
            }, null, 2));
        } catch (error) {
            console.warn(`[MultiBroker] Кэш инструментов не сохранён: ${error.message}`);
        }
    }
    return instruments;
}

/**
 * Точка входа плагина: собрать живой мультиинструментный брокер.
 * @param {object} config - Разобранные опции CLI.
 * @returns {Promise<object>} Брокер { data, exec, finalize, metadata, needsCache }.
 */
export async function createBroker(config = {}) {
    const token = process.env.T_INVEST_TOKEN || "";
    if (!token) throw new Error("T_INVEST_TOKEN environment variable is required");

    const client = new TinkoffClient(token, {
        sandbox: Boolean(config.sandbox),
        accountId: config.account || null,
        orderRetries: parseInt(config.orderRetries ?? "2", 10),
        verbose: Boolean(config.verbose),
    });
    console.log(`[MultiBroker] Подключение к T-Invest (${config.sandbox ? "SANDBOX" : "REAL"})…`);
    await client.init();

    const universe = await readUniverse(config);
    const instruments = await resolveInstruments(client, universe);
    const interval = parseInt(config.interval ?? "1", 10);

    const data = new MultiSymbolTinkoffDataSource({
        client, instruments, interval,
        verbose: Boolean(config.verbose),
        stallTimeoutMin: parseInt(config.stallTimeout ?? "30", 10),
        batchGraceMs: parseInt(config.batchGraceMs ?? "8000", 10),
    });
    const exec = new MultiSymbolTinkoffExecutor({
        client, instruments, interval,
        options: {
            verbose: Boolean(config.verbose),
            dryRun: Boolean(config.dryRun),
            orderTag: config.orderTag || "div",
            intrabarStops: Boolean(config.intrabarStops),
            leverage: parseFloat(config.leverage ?? "1"),
            stateDir: config.stateDir || join(process.cwd(), ".diviner-state"),
        },
    });

    return {
        data,
        exec,
        client,
        needsCache: true,
        metadata: {
            source: "tinkoff",
            interval,
            intervalMinutes: interval,
            intervalLabel: `${interval}m`,
            timezone: "Europe/Moscow",
            tickers: instruments.map((i) => i.ticker),
            instruments: Object.fromEntries(instruments.map((i) => [i.ticker, i])),
        },
        /** Свернуть сессию: по требованию закрыть позиции, снять подписку, отчитаться. */
        async finalize() {
            if (config.closeOnExit) {
                for (const position of exec.getPositions()) {
                    console.log(`[MultiBroker] Закрываю ${position.ticker} на выходе (--close-on-exit).`);
                    exec.closePosition("shutdown", position.ticker);
                }
                await exec.drainOrders();
            }
            await data.requestStop();
            const opens = exec.sessionTrades.filter((t) => t.kind === "open").length;
            const closes = exec.sessionTrades.filter((t) => t.kind === "close").length;
            const held = exec.getPositions().map((p) => `${p.ticker} ${p.side} ${p.size}`);
            console.log(`[MultiBroker] За сессию: ${opens} входов / ${closes} выходов. Кэш ${exec.getBalance().toFixed(2)} ₽.`);
            console.log(`[MultiBroker] Открыто на выходе: ${held.length ? held.join(", ") : "нет"}.`);
            const blocked = exec.getBlocked?.() ?? [];
            if (blocked.length) {
                console.log(
                    "[MultiBroker] Отклонены биржей: "
                    + blocked.map((b) => `${b.ticker} (${b.permanent ? "постоянно" : "нет залога"})`).join(", "),
                );
            }
            await client.close();
        },
    };
}
