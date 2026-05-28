#!/usr/bin/env node
/**
 * Grid search for release_morning_long parameters: minProfitPct, slPct, tpPct
 * Range 0..2% step 0.1 for each. Loads parquet once, runs all combos in memory.
 *
 * Usage: node src/optimize_long.js --ticker SBER --year 2025 [--top 8]
 */
import path from "path";
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
    const get = (f) => {
        const i = args.indexOf(f);
        return i !== -1 ? args[i + 1] : null;
    };
    return {
        ticker:   get("--ticker")    || "SBER",
        year:     get("--year")      || "2025",
        top:      Number(get("--top") || 8),
        fixedMin: get("--min-drop") !== null ? Number(get("--min-drop")) : null,
        fixedSL:  get("--sl")       !== null ? Number(get("--sl"))       : null,
        fixedTP:  get("--tp")       !== null ? Number(get("--tp"))       : null,
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

/**
 * Pre-compute per-day structures:
 * { dateKey, prevClose, morningSlice: [{idx, price}], exitIdx, allSlice: [{idx, price}] }
 */
function buildDayStructures(candles, schedule) {
    const schByDate = new Map(schedule.map(d => [d.dateKey, d]));

    // daily aggregation for prevClose
    const dailyCandles = aggregateDailyCandles(candles);
    const dailyByDate = new Map(dailyCandles.map(c => [mskDateKey(c.datetime), c]));

    // Build sorted date keys
    const dateKeys = [...new Set(candles.map(c => mskDateKey(c.datetime)))].sort();

    const days = [];
    for (let di = 0; di < dateKeys.length; di++) {
        const dateKey = dateKeys[di];
        const sch = schByDate.get(dateKey);
        if (!sch || !sch.isTradingDay) continue;

        // prev trading day close
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

        // Collect candle indices for this day
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

        // Exit index: penultimate candle of the trading day (relative to schedule close)
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

/**
 * Run one backtest combination. Returns metrics object.
 */
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
        let entryIdx = null, entryPrice = null;
        let sl = null, tp = null;

        // Find first entry candle in morning window
        for (const { idx, price } of morning) {
            if (idx > exitIdx) break;
            const dropPct = ((price - prevClose) / prevClose) * 100;
            if (dropPct < -minPct) {
                entryIdx = idx;
                entryPrice = price;
                const actualSize = Math.floor((cash * 0.95) / price);
                if (actualSize <= 0) break;
                const cost = actualSize * price * (1 + COMMISSION);
                if (cost > cash) break;

                cash -= cost;
                sl = slPct > 0 ? price * (1 - slPct / 100) : null;
                tp = tpPct > 0 ? price * (1 + tpPct / 100) : null;

                // Manage position from next candle onwards
                // SL/TP execute at candle close (same as BacktestExecutionAdapter)
                let closed = false;
                const allIdxKeys = [...allByIdx.keys()].filter(k => k > entryIdx).sort((a, b) => a - b);

                for (const cidx of allIdxKeys) {
                    const closePrice = candles[cidx].close;
                    const hit_sl = sl !== null && closePrice <= sl;
                    const hit_tp = tp !== null && closePrice >= tp;

                    if (hit_sl || hit_tp || cidx >= exitIdx) {
                        const exitPrice = closePrice; // always close at candle price
                        cash += actualSize * exitPrice * (1 - COMMISSION);
                        const pnl = actualSize * (exitPrice - entryPrice)
                            - actualSize * (entryPrice + exitPrice) * COMMISSION;
                        const pnlPct = (pnl / INITIAL_CASH) * 100;
                        pnlPcts.push(pnlPct);
                        totalTrades++;
                        if (pnl > 0) { wins++; totalProfit += pnl; }
                        else { totalLoss += Math.abs(pnl); }
                        equity = cash;
                        if (equity > peakEquity) peakEquity = equity;
                        maxDrawdown = Math.max(maxDrawdown, peakEquity - equity);
                        closed = true;
                        break;
                    }
                }

                if (!closed) {
                    // Force close at exit candle price (no more candles in the day)
                    const exitC = allByIdx.get(exitIdx);
                    const exitPrice = exitC ? exitC.price : entryPrice;
                    cash += actualSize * exitPrice * (1 - COMMISSION);
                    const pnl = actualSize * (exitPrice - entryPrice)
                        - actualSize * (entryPrice + exitPrice) * COMMISSION;
                    const pnlPct = (pnl / INITIAL_CASH) * 100;
                    pnlPcts.push(pnlPct);
                    totalTrades++;
                    if (pnl > 0) { wins++; totalProfit += pnl; }
                    else { totalLoss += Math.abs(pnl); }
                    equity = cash;
                    if (equity > peakEquity) peakEquity = equity;
                    maxDrawdown = Math.max(maxDrawdown, peakEquity - equity);
                }
                break; // one trade per day
            }
        }
    }

    const returnPct = round2(((cash - INITIAL_CASH) / INITIAL_CASH) * 100);
    const winRate   = totalTrades > 0 ? round2((wins / totalTrades) * 100) : 0;
    const pf        = totalLoss > 0 ? round2(totalProfit / totalLoss) : (totalProfit > 0 ? Infinity : 0);
    const maxDDpct  = round2((maxDrawdown / INITIAL_CASH) * 100);
    const avgPct    = pnlPcts.length > 0 ? round2(pnlPcts.reduce((s,x)=>s+x,0) / pnlPcts.length, 3) : 0;

    return { returnPct, winRate, pf, maxDDpct, totalTrades, avgPct };
}

function round(v, d=2) { return Math.round(v * 10**d) / 10**d; }

async function main() {
    const opts = parseArgs();
    const { ticker, year, top } = opts;
    const parquet = path.join(ROOT, "data", `${ticker}_${year}_1m.parquet`);

    process.stderr.write(`Loading ${parquet}...\n`);
    const { candles, metadata } = await loadDataset(parquet);
    process.stderr.write(`Loaded ${candles.length} candles\n`);

    process.stderr.write(`Building schedule...\n`);
    const schedule = await buildCandleDerivedTradingSchedule(candles, {
        exchange: metadata.exchange || "MOEX",
        intervalMinutes: metadata.intervalMinutes || 1,
    });

    process.stderr.write(`Building day structures...\n`);
    const days = buildDayStructures(candles, schedule);
    process.stderr.write(`Trading days: ${days.length}\n`);

    // Grid: 0.0, 0.1, ..., 2.0
    const steps = [];
    for (let i = 0; i <= 20; i++) steps.push(round(i * 0.1));

    const { fixedMin, fixedSL, fixedTP } = opts;
    const minSteps = fixedMin !== null ? [fixedMin] : steps;
    const slSteps  = fixedSL  !== null ? [fixedSL]  : steps;
    const tpSteps  = fixedTP  !== null ? [fixedTP]  : steps;
    const total = minSteps.length * slSteps.length * tpSteps.length;
    process.stderr.write(`Running ${total} combinations...\n`);

    const results = [];
    let done = 0;
    const t0 = Date.now();

    for (const minPct of minSteps) {
        for (const slPct of slSteps) {
            for (const tpPct of tpSteps) {
                const m = runCombo(days, candles, minPct, slPct, tpPct);
                if (m.totalTrades >= 10) { // skip combos with too few trades
                    results.push({ minPct, slPct, tpPct, ...m });
                }
                done++;
                if (done % 1000 === 0) {
                    process.stderr.write(`  ${done}/${total} (${((Date.now()-t0)/1000).toFixed(1)}s)\n`);
                }
            }
        }
    }

    process.stderr.write(`Done in ${((Date.now()-t0)/1000).toFixed(1)}s. Valid combos: ${results.length}\n`);

    // Sort by returnPct desc
    results.sort((a, b) => b.returnPct - a.returnPct);

    const topN = results.slice(0, top);

    // Print markdown table
    console.log(`\n## Оптимизация лонга — ${ticker} ${year} (топ-${top})\n`);
    console.log(`| # | minDrop% | SL% | TP% | Return | WR | PF | MaxDD | E[сд.%] | Сделок |`);
    console.log(`| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |`);
    topN.forEach((r, i) => {
        const pf = r.pf === Infinity ? "∞" : r.pf;
        console.log(`| ${i+1} | ${r.minPct} | ${r.slPct} | ${r.tpPct} | **${r.returnPct}%** | ${r.winRate}% | ${pf} | ${r.maxDDpct}% | ${r.avgPct}% | ${r.totalTrades} |`);
    });

    // Also print sorted by WR, PF for reference
    const topByPF = [...results].sort((a,b) => b.pf - a.pf).slice(0, 5);
    console.log(`\n### Топ-5 по Profit Factor\n`);
    console.log(`| # | minDrop% | SL% | TP% | Return | WR | PF | MaxDD | Сделок |`);
    console.log(`| --- | --- | --- | --- | --- | --- | --- | --- | --- |`);
    topByPF.forEach((r, i) => {
        const pf = r.pf === Infinity ? "∞" : r.pf;
        console.log(`| ${i+1} | ${r.minPct} | ${r.slPct} | ${r.tpPct} | ${r.returnPct}% | ${r.winRate}% | **${pf}** | ${r.maxDDpct}% | ${r.totalTrades} |`);
    });
}

main().catch(e => { console.error(e); process.exit(1); });
