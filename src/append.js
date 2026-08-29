#!/usr/bin/env node
/**
 * Дописать свежий период к существующему листингу.
 *
 * Листинги в `data/` не удаляются и не перезаписываются укороченной выборкой:
 * скачивание отдаёт файл за указанный интервал целиком, и рефлекс «скачал —
 * положил» молча укорачивает историю. Бэктест после этого продолжает считаться,
 * но уже на другом окне. Эта команда делает единственно верную операцию —
 * объединение по (datetime, interval) с дедупликацией, — и отказывается писать
 * результат, если он получился короче исходного.
 *
 * Свежие свечи выигрывают у старых при совпадении времени: биржа могла
 * пересчитать бар.
 *
 * Usage:
 *   node src/append.js --into data/tinkoff/ALRS_2026_1m.parquet /tmp/ALRS_new.parquet
 *   node src/append.js --into data/tinkoff/ALRS_2026_1m.parquet --dry-run /tmp/ALRS_new.parquet
 */
import { Command } from "commander";
import { rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { loadDataset } from "./core/data-loader.js";
import { writeCandleSeriesAsParquet } from "./core/candle-parquet.js";

/**
 * Объединить листинги одного инструмента.
 * @param {string} intoPath - Файл-приёмник (он же источник истории).
 * @param {Array<string>} sources - Файлы со свежими свечами.
 * @param {object} [options] - { dryRun }.
 * @returns {Promise<object>} Сводка по интервалам.
 */
export async function append(intoPath, sources, options = {}) {
    if (!existsSync(intoPath)) throw new Error(`${intoPath} does not exist`);
    const target = await loadDataset(intoPath);
    if (Array.isArray(target.metadata?.tickers)) {
        throw new Error(
            `${intoPath} is a multi-ticker bundle — append works on single-ticker listings only. `
            + "Rebuild bundles with src/bundle.js after appending to the listings.",
        );
    }
    if (!target.series) throw new Error(`${intoPath} has no candle series`);

    const merged = new Map();
    for (const [minutes, candles] of target.series) {
        const byTime = new Map();
        for (const candle of candles) byTime.set(candle.datetime.getTime(), candle);
        merged.set(minutes, byTime);
    }

    const before = new Map([...merged].map(([m, byTime]) => [m, byTime.size]));
    const targetTicker = target.metadata.ticker || target.metadata.instrument?.ticker || null;

    for (const source of sources) {
        const fresh = await loadDataset(source);
        const freshTicker = fresh.metadata.ticker || fresh.metadata.instrument?.ticker || null;
        // Слить два разных инструмента в один листинг — молчаливая порча данных,
        // которую потом не отличить от рыночного шума.
        if (targetTicker && freshTicker && targetTicker !== freshTicker) {
            throw new Error(`${source} holds ${freshTicker}, but ${intoPath} holds ${targetTicker}`);
        }
        for (const [minutes, candles] of fresh.series || []) {
            if (!merged.has(minutes)) merged.set(minutes, new Map());
            const byTime = merged.get(minutes);
            for (const candle of candles) byTime.set(candle.datetime.getTime(), candle);
        }
    }

    const result = new Map();
    const summary = [];
    for (const [minutes, byTime] of [...merged].sort((a, b) => a[0] - b[0])) {
        const candles = [...byTime.values()].sort(
            (a, b) => a.datetime.getTime() - b.datetime.getTime());
        const was = before.get(minutes) ?? 0;
        if (candles.length < was) {
            throw new Error(
                `interval ${minutes}m would shrink ${was} → ${candles.length} rows — refusing to write`,
            );
        }
        result.set(minutes, candles);
        summary.push({
            minutes, was, now: candles.length, added: candles.length - was,
            from: candles[0]?.datetime.toISOString().slice(0, 10),
            to: candles[candles.length - 1]?.datetime.toISOString().slice(0, 10),
        });
    }

    if (!options.dryRun) {
        const tmpPath = `${intoPath}.tmp${process.pid}`;
        await writeCandleSeriesAsParquet(result, tmpPath, target.metadata);
        await rename(tmpPath, intoPath);
    }
    return { ticker: targetTicker, summary };
}

const program = new Command();
program
    .name("diviner-append")
    .description("Дописать свежий период к существующему листингу (только рост, без укорачивания)")
    .argument("<sources...>", "Файлы со свежими свечами")
    .requiredOption("--into <path>", "Листинг-приёмник")
    .option("--dry-run", "Показать, что получится, ничего не записывая", false);

if (import.meta.url === `file://${process.argv[1]}`) {
    program.parse();
    const opts = program.opts();
    const { ticker, summary } = await append(opts.into, program.args, { dryRun: opts.dryRun });
    const parts = summary.map((s) =>
        `${s.minutes}m: ${s.was} → ${s.now} (+${s.added}), ${s.from}…${s.to}`);
    console.log(`${ticker ?? opts.into}${opts.dryRun ? " [dry-run]" : ""} — ${parts.join("; ")}`);
}
