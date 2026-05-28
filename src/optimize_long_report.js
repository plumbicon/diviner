#!/usr/bin/env node
/**
 * Run release_morning_long fixed-param backtest for all available tickers of a given year
 * and save a markdown report to logs/
 *
 * Usage: node src/optimize_long_report.js --year 2025 [--min-drop 0.4] [--sl 1.5] [--tp 0.4]
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { loadDataset } from "./core/data-loader.js";
import { buildCandleDerivedTradingSchedule, MOSCOW_OFFSET_MS } from "./core/market-data.js";
import { aggregateDailyCandles } from "./core/strategy-context.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const COMMISSION = 0.0001;
const INITIAL_CASH = 10000;
const ENTRY_START_H = 6, ENTRY_START_M = 50;
const ENTRY_END_H = 9,   ENTRY_END_M   = 49;

function parseArgs() {
    const args = process.argv.slice(2);
    const get = (f) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null; };
    return {
        year:    get("--year")      || "2025",
        minDrop: Number(get("--min-drop") ?? 0.4),
        slPct:   Number(get("--sl")       ?? 1.5),
        tpPct:   Number(get("--tp")       ?? 0.4),
    };
}

function mskDateKey(dt) {
    const m = new Date(dt.getTime() + MOSCOW_OFFSET_MS);
    return `${m.getUTCFullYear()}-${String(m.getUTCMonth()+1).padStart(2,"0")}-${String(m.getUTCDate()).padStart(2,"0")}`;
}
function mskHM(dt) {
    const m = new Date(dt.getTime() + MOSCOW_OFFSET_MS);
    return { h: m.getUTCHours(), min: m.getUTCMinutes() };
}
function round2(v) { return Math.round(v * 100) / 100; }
function round(v, d=2) { return Math.round(v * 10**d) / 10**d; }

function buildDayStructures(candles, schedule) {
    const schByDate = new Map(schedule.map(d => [d.dateKey, d]));
    const dailyCandles = aggregateDailyCandles(candles);
    const dailyByDate = new Map(dailyCandles.map(c => [mskDateKey(c.datetime), c]));
    const dateKeys = [...new Set(candles.map(c => mskDateKey(c.datetime)))].sort();

    const days = [];
    for (let di = 0; di < dateKeys.length; di++) {
        const dateKey = dateKeys[di];
        const sch = schByDate.get(dateKey);
        if (!sch || !sch.isTradingDay) continue;

        let prevClose = null;
        for (let pi = di - 1; pi >= Math.max(0, di - 20); pi--) {
            const pk = dateKeys[pi];
            const ps = schByDate.get(pk);
            if (ps && ps.isTradingDay && dailyByDate.has(pk)) {
                prevClose = dailyByDate.get(pk).close;
                break;
            }
        }
        if (prevClose === null) continue;

        const morning = [], all = [];
        for (let i = 0; i < candles.length; i++) {
            const c = candles[i];
            if (mskDateKey(c.datetime) !== dateKey) continue;
            const { h, min } = mskHM(c.datetime);
            all.push({ idx: i, price: c.close, h, min });

            const afterStart = h > ENTRY_START_H || (h === ENTRY_START_H && min >= ENTRY_START_M);
            const beforeEnd  = h < ENTRY_END_H   || (h === ENTRY_END_H   && min <= ENTRY_END_M);
            if (afterStart && beforeEnd) morning.push({ idx: i, price: c.close });
        }

        if (all.length === 0) continue;

        let exitIdx;
        if (sch.endTime) {
            const closeTs = new Date(sch.endTime).getTime();
            const eligible = all.filter(c => candles[c.idx].datetime.getTime() <= closeTs);
            exitIdx = eligible.length >= 2
                ? eligible[eligible.length - 2].idx
                : eligible.length === 1 ? eligible[0].idx : all[all.length - 2]?.idx ?? all[all.length - 1].idx;
        } else {
            exitIdx = all.length >= 2 ? all[all.length - 2].idx : all[all.length - 1].idx;
        }

        days.push({ dateKey, prevClose, morning, all, exitIdx, allByIdx: new Map(all.map(c => [c.idx, c])) });
    }
    return days;
}

function runCombo(days, candles, minPct, slPct, tpPct) {
    let cash = INITIAL_CASH;
    let equity = INITIAL_CASH;
    let peakEquity = INITIAL_CASH;
    let maxDrawdown = 0;
    let totalTrades = 0, wins = 0;
    let totalProfit = 0, totalLoss = 0;
    const pnlPcts = [];

    for (const day of days) {
        const { prevClose, morning, exitIdx, allByIdx } = day;

        for (const { idx, price } of morning) {
            if (idx > exitIdx) break;
            const dropPct = ((price - prevClose) / prevClose) * 100;
            if (dropPct < -minPct) {
                const actualSize = Math.floor((cash * 0.95) / price);
                if (actualSize <= 0) break;
                const cost = actualSize * price * (1 + COMMISSION);
                if (cost > cash) break;

                cash -= cost;
                const sl = slPct > 0 ? price * (1 - slPct / 100) : null;
                const tp = tpPct > 0 ? price * (1 + tpPct / 100) : null;

                let closed = false;
                const allIdxKeys = [...allByIdx.keys()].filter(k => k > idx).sort((a, b) => a - b);

                for (const cidx of allIdxKeys) {
                    const closePrice = candles[cidx].close;
                    if ((sl !== null && closePrice <= sl) || (tp !== null && closePrice >= tp) || cidx >= exitIdx) {
                        cash += actualSize * closePrice * (1 - COMMISSION);
                        const pnl = actualSize * (closePrice - price) - actualSize * (price + closePrice) * COMMISSION;
                        const pnlPct = (pnl / INITIAL_CASH) * 100;
                        pnlPcts.push(pnlPct);
                        totalTrades++;
                        if (pnl > 0) { wins++; totalProfit += pnl; } else { totalLoss += Math.abs(pnl); }
                        equity = cash;
                        if (equity > peakEquity) peakEquity = equity;
                        maxDrawdown = Math.max(maxDrawdown, peakEquity - equity);
                        closed = true;
                        break;
                    }
                }

                if (!closed) {
                    const exitC = allByIdx.get(exitIdx);
                    const exitPrice = exitC ? exitC.price : price;
                    cash += actualSize * exitPrice * (1 - COMMISSION);
                    const pnl = actualSize * (exitPrice - price) - actualSize * (price + exitPrice) * COMMISSION;
                    const pnlPct = (pnl / INITIAL_CASH) * 100;
                    pnlPcts.push(pnlPct);
                    totalTrades++;
                    if (pnl > 0) { wins++; totalProfit += pnl; } else { totalLoss += Math.abs(pnl); }
                    equity = cash;
                    if (equity > peakEquity) peakEquity = equity;
                    maxDrawdown = Math.max(maxDrawdown, peakEquity - equity);
                }
                break;
            }
        }
    }

    const returnPct = round2(((cash - INITIAL_CASH) / INITIAL_CASH) * 100);
    const winRate   = totalTrades > 0 ? round2((wins / totalTrades) * 100) : 0;
    const pf        = totalLoss > 0 ? round2(totalProfit / totalLoss) : (totalProfit > 0 ? Infinity : 0);
    const maxDDpct  = round2((maxDrawdown / INITIAL_CASH) * 100);
    const avgPct    = pnlPcts.length > 0 ? round2(pnlPcts.reduce((s,x)=>s+x,0) / pnlPcts.length) : 0;

    // Calmar = returnPct / maxDDpct
    const calmar = maxDDpct > 0 ? round2(returnPct / maxDDpct) : (returnPct > 0 ? Infinity : 0);

    return { returnPct, winRate, pf, maxDDpct, totalTrades, avgPct, calmar };
}

async function processTicker(ticker, year, minDrop, slPct, tpPct) {
    const parquet = path.join(ROOT, "data", `${ticker}_${year}_1m.parquet`);
    if (!fs.existsSync(parquet)) return null;

    const { candles, metadata } = await loadDataset(parquet);
    if (candles.length === 0) return null;

    const schedule = await buildCandleDerivedTradingSchedule(candles, {
        exchange: metadata.exchange || "MOEX",
        intervalMinutes: metadata.intervalMinutes || 1,
    });

    const days = buildDayStructures(candles, schedule);
    return { ticker, ...runCombo(days, candles, minDrop, slPct, tpPct) };
}

function medal(i) { return ["🥇","🥈","🥉"][i] || `${i+1}.`; }

async function main() {
    const { year, minDrop, slPct, tpPct } = parseArgs();

    // Discover all tickers for this year (only single-word uppercase ticker names)
    const files = fs.readdirSync(path.join(ROOT, "data"))
        .filter(f => f.endsWith(`_${year}_1m.parquet`))
        .map(f => f.replace(`_${year}_1m.parquet`, ""))
        .filter(t => /^[A-Z]+$/.test(t))
        .sort();

    process.stderr.write(`Year: ${year}, tickers: ${files.join(", ")}\n`);
    process.stderr.write(`Params: minDrop=${minDrop}%, SL=${slPct}%, TP=${tpPct}%\n`);

    const results = [];
    for (const ticker of files) {
        process.stderr.write(`  Processing ${ticker}...\n`);
        const r = await processTicker(ticker, year, minDrop, slPct, tpPct);
        if (r) results.push(r);
    }

    // Sort by returnPct desc
    results.sort((a, b) => b.returnPct - a.returnPct);

    const avgReturn = round2(results.reduce((s,r) => s + r.returnPct, 0) / results.length);
    const avgWR     = round2(results.reduce((s,r) => s + r.winRate, 0) / results.length);
    const avgPF     = round2(results.reduce((s,r) => s + (isFinite(r.pf) ? r.pf : 0), 0) / results.length);
    const avgDD     = round2(results.reduce((s,r) => s + r.maxDDpct, 0) / results.length);
    const profitable = results.filter(r => r.returnPct > 0).length;

    const lines = [];
    lines.push(`# Лонг-стратегия: release_morning_long — ${year}`);
    lines.push(``);
    lines.push(`**Параметры:** minDrop=${minDrop}%, SL=${slPct}%, TP=${tpPct}%`);
    lines.push(`**Комиссия:** 0.01% на сторону | **Начальный депозит:** 10 000 руб.`);
    lines.push(`**Окно входа:** 06:50–09:49 МСК | **Выход:** предпоследняя свеча торгового дня`);
    lines.push(``);
    lines.push(`## Сводка`);
    lines.push(``);
    lines.push(`| Показатель | Значение |`);
    lines.push(`| --- | --- |`);
    lines.push(`| Инструментов | ${results.length} |`);
    lines.push(`| В прибыли | ${profitable} из ${results.length} |`);
    lines.push(`| Средняя доходность | ${avgReturn}% |`);
    lines.push(`| Средний WR | ${avgWR}% |`);
    lines.push(`| Средний PF | ${avgPF} |`);
    lines.push(`| Средняя просадка | ${avgDD}% |`);
    lines.push(``);
    lines.push(`## Рейтинг по доходности`);
    lines.push(``);
    lines.push(`| # | Тикер | Return | WR | PF | MaxDD | Calmar | E[сд.%] | Сделок |`);
    lines.push(`| --- | --- | --- | --- | --- | --- | --- | --- | --- |`);
    results.forEach((r, i) => {
        const pf = isFinite(r.pf) ? r.pf : "∞";
        const calmar = isFinite(r.calmar) ? r.calmar : "∞";
        lines.push(`| ${i+1} | **${r.ticker}** | **${r.returnPct}%** | ${r.winRate}% | ${pf} | ${r.maxDDpct}% | ${calmar} | ${r.avgPct}% | ${r.totalTrades} |`);
    });

    // Top-3 and bottom-3
    lines.push(``);
    lines.push(`## Топ-3 лучших`);
    lines.push(``);
    results.slice(0, 3).forEach((r, i) => {
        const pf = isFinite(r.pf) ? r.pf : "∞";
        lines.push(`${medal(i)} **${r.ticker}** — ${r.returnPct}% доходность, WR ${r.winRate}%, PF ${pf}, просадка ${r.maxDDpct}%`);
    });
    lines.push(``);
    lines.push(`## Топ-3 худших`);
    lines.push(``);
    [...results].reverse().slice(0, 3).forEach((r, i) => {
        const pf = isFinite(r.pf) ? r.pf : "∞";
        lines.push(`${medal(i)} **${r.ticker}** — ${r.returnPct}% доходность, WR ${r.winRate}%, PF ${pf}, просадка ${r.maxDDpct}%`);
    });

    lines.push(``);
    lines.push(`---`);
    lines.push(`*Сгенерировано: ${new Date().toISOString().slice(0,10)}*`);

    const outFile = path.join(ROOT, "logs", `optimize_long_${year}_report.md`);
    fs.writeFileSync(outFile, lines.join("\n") + "\n");
    process.stderr.write(`\nReport saved to: ${outFile}\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
