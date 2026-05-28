#!/usr/bin/env node
/**
 * Run backtests for all tickers in data/ for a given year and produce a markdown report.
 * Usage: node src/backtest_report.js --year 2025 --strategy src/strategies/release_morning_short_testing.js
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const LOGS_DIR = path.join(ROOT, "logs");

const SECTOR = {
    AFKS:  "Холдинг",
    BSPB:  "Банк",
    CBOM:  "Банк",
    GAZP:  "Газ",
    GMKN:  "Металлы",
    LKOH:  "Нефть",
    MBNK:  "Банк",
    MOEX:  "Биржа",
    SBER:  "Банк",
    SVCB:  "Банк",
    T:     "Банк",
    VTBR:  "Банк",
    ROSN:  "Нефть",
    TATN:  "Нефть",
    NVTK:  "Газ",
    SNGS:  "Нефть",
    NLMK:  "Сталь",
    CHMF:  "Сталь",
    PLZL:  "Золото",
    ALRS:  "Алмазы",
    MTSS:  "Телеком",
    MGNT:  "Ритейл",
};

function parseArgs() {
    const args = process.argv.slice(2);
    const get = (flag) => {
        const eqIdx = args.findIndex((a) => a.startsWith(`${flag}=`));
        if (eqIdx !== -1) return args[eqIdx].slice(flag.length + 1);
        const idx = args.indexOf(flag);
        return idx !== -1 ? args[idx + 1] : null;
    };
    return {
        year: get("--year") || "2025",
        strategy: get("--strategy") || "src/strategies/release_morning_short_testing.js",
        balance: get("--balance") || "10000",
        commission: get("--commission") || "0.0001",
    };
}

function runBacktest(parquetFile, strategyFile, balance, commission) {
    const result = spawnSync(
        "node",
        [
            "src/backtest.js",
            parquetFile,
            "--strategy", strategyFile,
            "--balance", balance,
            "--commission", commission,
            "--verbose",
        ],
        { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    if (result.status !== 0) {
        throw new Error(result.stderr?.slice(-500) || `exit ${result.status}`);
    }
    return JSON.parse(result.stdout);
}

const MONTH_NAMES_RU = ["Январь","Февраль","Март","Апрель","Май","Июнь","Июль","Август","Сентябрь","Октябрь","Ноябрь","Декабрь"];

function moscowMonth(isoString) {
    // Returns "YYYY-MM" in Moscow time (UTC+3)
    const d = new Date(isoString);
    const msk = new Date(d.getTime() + 3 * 60 * 60 * 1000);
    return `${msk.getUTCFullYear()}-${String(msk.getUTCMonth() + 1).padStart(2, "0")}`;
}

function moscowMonthNum(isoString) {
    // Returns 1-based month number in Moscow time
    const d = new Date(isoString);
    const msk = new Date(d.getTime() + 3 * 60 * 60 * 1000);
    return msk.getUTCMonth() + 1;
}

function r(v, digits = 2) {
    return Number.isFinite(v) ? Number(v.toFixed(digits)) : v;
}

function avg(arr) {
    if (!arr.length) return 0;
    return arr.reduce((s, x) => s + x, 0) / arr.length;
}

// Sharpe-подобный: E[R] / std[R] по сделкам
function sharpelike(trades) {
    if (trades.length < 2) return null;
    const pcts = trades.map((t) => t.pnlPct || 0);
    const mean = avg(pcts);
    const std = Math.sqrt(avg(pcts.map((x) => (x - mean) ** 2)));
    return std > 0 ? r(mean / std, 3) : null;
}

// Calmar = totalReturnPct / maxDrawdownPct
function calmar(returnPct, maxDrawdownPct) {
    return maxDrawdownPct > 0 ? r(returnPct / maxDrawdownPct, 2) : null;
}

// Восстановительный фактор = totalReturn / maxDrawdown
function recoveryFactor(totalReturn, maxDrawdown) {
    return maxDrawdown > 0 ? r(totalReturn / maxDrawdown, 2) : null;
}

function maxConsecLosses(trades) {
    let max = 0, cur = 0;
    for (const t of trades) {
        if ((t.pnl || 0) <= 0) { cur++; max = Math.max(max, cur); }
        else cur = 0;
    }
    return max;
}

function calcMaxDrawdownFromTrades(trades, initialCash) {
    let equity = initialCash, peak = initialCash, maxDD = 0;
    for (const t of trades) {
        equity += (t.pnl || 0);
        if (equity > peak) peak = equity;
        maxDD = Math.max(maxDD, peak - equity);
    }
    return maxDD;
}

async function main() {
    const opts = parseArgs();
    const { year, strategy, balance, commission } = opts;
    const initialCash = Number(balance);

    const parquetFiles = fs.readdirSync(DATA_DIR)
        .filter((f) => f.endsWith(`_${year}_1m.parquet`) && fs.statSync(path.join(DATA_DIR, f)).size > 10000)
        .sort();

    if (!parquetFiles.length) {
        console.error(`No parquet files found for year ${year} in ${DATA_DIR}`);
        process.exit(1);
    }

    console.error(`Found ${parquetFiles.length} files for ${year}: ${parquetFiles.map(f => f.split('_')[0]).join(', ')}`);

    const results = [];
    const allTrades = []; // {ticker, trade}

    for (const file of parquetFiles) {
        const ticker = file.split("_")[0];
        const filePath = path.join(DATA_DIR, file);
        console.error(`Running backtest: ${ticker}...`);

        try {
            const bt = runBacktest(filePath, strategy, balance, commission);
            const m = bt.performance_metrics;
            const trades = bt.trade_log || [];

            const maxDD = m.maxDrawdown || calcMaxDrawdownFromTrades(trades, initialCash);
            const maxDDpct = r((maxDD / initialCash) * 100);

            const row = {
                ticker,
                sector: SECTOR[ticker] || "Прочее",
                returnPct: r(m.returnPct),
                equityFinal: r(m.equityFinal),
                maxDrawdown: r(maxDD),
                maxDrawdownPct: maxDDpct,
                tradesCount: m.tradesCount,
                winRate: r(m.winRate),
                profitFactor: m.profitFactor != null ? r(m.profitFactor) : null,
                avgTradePct: r(m.avgTradePct, 3),    // матожидание % к депо
                avgTrade: r(m.avgTrade),
                avgWin: r(m.avgWin),
                avgLoss: r(m.avgLoss),
                largestWin: r(m.largestWin),
                largestLoss: r(m.largestLoss),
                avgTradeDuration: r(m.avgTradeDuration),
                buyAndHoldReturnPct: r(m.buyAndHoldReturnPct),
                sharpe: sharpelike(trades),
                calmar: calmar(m.returnPct, maxDDpct),
                recoveryFactor: recoveryFactor(m.return, maxDD),
                maxConsecLosses: maxConsecLosses(trades),
                exposureTimePct: r(m.exposureTimePct),
            };
            results.push(row);

            for (const t of trades) {
                allTrades.push({ ticker, trade: t });
            }

            console.error(`  ${ticker}: ${row.returnPct}% | WR ${row.winRate}% | PF ${row.profitFactor} | trades ${row.tradesCount}`);
        } catch (err) {
            console.error(`  ${ticker}: ERROR - ${err.message}`);
            results.push({ ticker, sector: SECTOR[ticker] || "Прочее", error: err.message });
        }
    }

    // Monthly analysis
    // monthlyByTicker: ticker -> "YYYY-MM" -> {pnlPct, trades, wins}  (for heatmap)
    // seasonalAll:     monthNum(1-12) -> {pnlPctByTickerYear, trades, wins}
    //                  pnlPctByTickerYear = Map of "ticker|YYYY" -> accumulated pnlPct
    //                  (to average correctly across tickers × years)
    const monthlyByTicker = new Map();
    const seasonalAll = new Map(); // 1..12 -> { pnlPctSamples: [], trades, wins }

    for (const { ticker, trade } of allTrades) {
        const entryIso = typeof trade.entryTime === "string" ? trade.entryTime : trade.entryTime?.toISOString?.() || "";
        const yyyymm = moscowMonth(entryIso);
        const monthNum = moscowMonthNum(entryIso);
        if (!yyyymm || yyyymm.length < 7) continue;
        const pnlPct = trade.pnlPct || 0;
        const win = (trade.pnl || 0) > 0 ? 1 : 0;
        const yyyy = yyyymm.slice(0, 4);

        // per-ticker heatmap (YYYY-MM)
        if (!monthlyByTicker.has(ticker)) monthlyByTicker.set(ticker, new Map());
        const tm = monthlyByTicker.get(ticker);
        if (!tm.has(yyyymm)) tm.set(yyyymm, { pnlPct: 0, trades: 0, wins: 0 });
        const tm2 = tm.get(yyyymm);
        tm2.pnlPct += pnlPct;
        tm2.trades += 1;
        tm2.wins += win;

        // seasonal aggregation by calendar month (1-12)
        if (!seasonalAll.has(monthNum)) seasonalAll.set(monthNum, { tickerYearPnl: new Map(), trades: 0, wins: 0 });
        const sa = seasonalAll.get(monthNum);
        const key = `${ticker}|${yyyy}`;
        sa.tickerYearPnl.set(key, (sa.tickerYearPnl.get(key) || 0) + pnlPct);
        sa.trades += 1;
        sa.wins += win;
    }

    const okResults = results.filter((r) => !r.error);
    const totalTrades = okResults.reduce((s, r) => s + r.tradesCount, 0);
    const totalWins = allTrades.filter((x) => (x.trade.pnl || 0) > 0).length;
    const totalProfit = allTrades.reduce((s, x) => s + Math.max(0, x.trade.pnl || 0), 0);
    const totalLoss = Math.abs(allTrades.reduce((s, x) => s + Math.min(0, x.trade.pnl || 0), 0));
    const overallWR = totalTrades > 0 ? r((totalWins / totalTrades) * 100) : 0;
    const overallPF = totalLoss > 0 ? r(totalProfit / totalLoss) : null;
    const overallAvgReturn = r(avg(okResults.map((r) => r.returnPct)));
    const medianReturn = r(median(okResults.map((r) => r.returnPct)));

    // Sorted rankings
    const ranked = [...okResults].sort((a, b) => b.returnPct - a.returnPct);

    // Seasonal ranking: average pnlPct per calendar month across all ticker×year samples
    const seasonalSorted = [...seasonalAll.entries()]
        .map(([monthNum, d]) => {
            const samples = [...d.tickerYearPnl.values()]; // one value per ticker×year
            return {
                monthNum,
                monthName: MONTH_NAMES_RU[monthNum - 1],
                avgReturnPct: r(avg(samples)),
                samples: samples.length,
                trades: d.trades,
                winRate: r((d.wins / d.trades) * 100),
            };
        })
        .sort((a, b) => b.avgReturnPct - a.avgReturnPct);

    // For heatmap: unique sorted YYYY-MM keys present in data
    const allYyyyMm = [...new Set(
        [...monthlyByTicker.values()].flatMap(m => [...m.keys()])
    )].sort();

    // Build markdown
    const now = new Date().toISOString();
    const stratName = path.basename(strategy);
    const lines = [];

    lines.push(`# Бектест ${stratName} — ${year}`);
    lines.push(``);
    lines.push(`Сформировано: ${now}`);
    lines.push(`Стратегия: \`${strategy}\``);
    lines.push(`Начальный депозит: ${balance} | Комиссия: ${commission}`);
    lines.push(`Инструментов: ${okResults.length} из ${results.length} (${results.filter(r=>r.error).length} ошибок)`);
    lines.push(``);

    // Summary
    lines.push(`## Сводка`);
    lines.push(``);
    lines.push(`| Показатель | Значение |`);
    lines.push(`| --- | --- |`);
    lines.push(`| Тикеры | ${okResults.map(r=>r.ticker).join(", ")} |`);
    lines.push(`| Всего сделок | ${totalTrades} |`);
    lines.push(`| Общий Win Rate | ${overallWR}% |`);
    lines.push(`| Общий Profit Factor | ${overallPF ?? "N/A"} |`);
    lines.push(`| Средняя доходность (avg) | ${overallAvgReturn}% |`);
    lines.push(`| Медианная доходность | ${medianReturn}% |`);
    lines.push(``);

    // Ticker ranking
    lines.push(`## Рейтинг по доходности`);
    lines.push(``);
    lines.push(`| # | Тикер | Сектор | Доходность | Финал | Max DD | WR | PF | E[сделка %] | Sharpe | Calmar | RF | Серия потерь | Сделки | B&H |`);
    lines.push(`| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |`);
    ranked.forEach((row, i) => {
        lines.push(
            `| ${i + 1} | ${row.ticker} | ${row.sector} ` +
            `| **${row.returnPct}%** | ${row.equityFinal} ` +
            `| ${row.maxDrawdownPct}% (${row.maxDrawdown}) ` +
            `| ${row.winRate}% | ${row.profitFactor ?? "—"} ` +
            `| ${row.avgTradePct}% ` +
            `| ${row.sharpe ?? "—"} | ${row.calmar ?? "—"} | ${row.recoveryFactor ?? "—"} ` +
            `| ${row.maxConsecLosses} | ${row.tradesCount} | ${row.buyAndHoldReturnPct}% |`
        );
    });
    lines.push(``);

    // Seasonal ranking by calendar month
    lines.push(`## Топ месяцев по доходности (средняя по всем акциям)`);
    lines.push(``);
    lines.push(`_Средняя доходность на тикер×год для каждого календарного месяца._`);
    lines.push(``);
    lines.push(`| # | Месяц | Avg доходность | Выборок | Сделок | Win Rate |`);
    lines.push(`| --- | --- | --- | --- | --- | --- |`);
    seasonalSorted.forEach((m, i) => {
        lines.push(`| ${i + 1} | **${m.monthName}** | **${m.avgReturnPct}%** | ${m.samples} | ${m.trades} | ${m.winRate}% |`);
    });
    lines.push(``);

    // Seasonal table ordered Jan→Dec
    lines.push(`## Доходность по календарным месяцам (по порядку)`);
    lines.push(``);
    const seasonalByNum = new Map(seasonalSorted.map(m => [m.monthNum, m]));
    lines.push(`| Месяц | Avg доходность | Сделок | Win Rate |`);
    lines.push(`| --- | --- | --- | --- |`);
    for (let mn = 1; mn <= 12; mn++) {
        const m = seasonalByNum.get(mn);
        if (!m) continue;
        lines.push(`| ${m.monthName} | ${m.avgReturnPct}% | ${m.trades} | ${m.winRate}% |`);
    }
    lines.push(``);

    // Monthly per-ticker heatmap table (YYYY-MM)
    lines.push(`## Доходность по месяцам и тикерам`);
    lines.push(``);
    lines.push(`| Тикер | ${allYyyyMm.join(" | ")} | Итого |`);
    lines.push(`| --- | ${allYyyyMm.map(() => "---").join(" | ")} | --- |`);
    for (const row of ranked) {
        const tm = monthlyByTicker.get(row.ticker);
        const cells = allYyyyMm.map((month) => {
            const d = tm?.get(month);
            if (!d) return "—";
            return `${r(d.pnlPct)}%`;
        });
        lines.push(`| ${row.ticker} | ${cells.join(" | ")} | ${row.returnPct}% |`);
    }
    lines.push(``);

    // Detailed metrics table
    lines.push(`## Детальные метрики по тикерам`);
    lines.push(``);
    lines.push(`| Тикер | Сектор | Сделки | Выигрышных | Проигрышных | WR | PF | E[%] | Avg Win | Avg Loss | Крупн. убыток | Ср. длит. (мин) | Экспозиция |`);
    lines.push(`| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |`);
    for (const row of ranked) {
        lines.push(
            `| ${row.ticker} | ${row.sector} ` +
            `| ${row.tradesCount} ` +
            `| ${row.tradesCount - (row.tradesCount - Math.round(row.winRate / 100 * row.tradesCount))} ` +
            `| ${Math.round((1 - row.winRate / 100) * row.tradesCount)} ` +
            `| ${row.winRate}% | ${row.profitFactor ?? "—"} | ${row.avgTradePct}% ` +
            `| ${row.avgWin} | ${row.avgLoss} | ${row.largestLoss} ` +
            `| ${row.avgTradeDuration} | ${row.exposureTimePct}% |`
        );
    }
    lines.push(``);

    // Top-3 per sector with monthly breakdown
    lines.push(`## Топ-3 тикера по секторам — доходность по месяцам`);
    lines.push(``);

    const sectorGroups = {};
    for (const row of okResults) {
        if (!sectorGroups[row.sector]) sectorGroups[row.sector] = [];
        sectorGroups[row.sector].push(row);
    }

    for (const sector of Object.keys(sectorGroups).sort()) {
        const top3 = [...sectorGroups[sector]].sort((a, b) => b.returnPct - a.returnPct).slice(0, 3);
        lines.push(`### ${sector}`);
        lines.push(``);
        lines.push(`| Тикер | ${MONTH_NAMES_RU.join(" | ")} | Итого |`);
        lines.push(`| --- | ${MONTH_NAMES_RU.map(() => "---").join(" | ")} | --- |`);
        for (const row of top3) {
            const tm = monthlyByTicker.get(row.ticker);
            const cells = MONTH_NAMES_RU.map((_, idx) => {
                const mn = idx + 1;
                // sum pnlPct across all years for this ticker×month
                let total = 0, found = false;
                for (const [yyyymm, d] of (tm || new Map())) {
                    if (Number(yyyymm.slice(5, 7)) === mn) { total += d.pnlPct; found = true; }
                }
                return found ? `${r(total)}%` : "—";
            });
            lines.push(`| ${row.ticker} | ${cells.join(" | ")} | **${row.returnPct}%** |`);
        }
        lines.push(``);
    }

    // Sector summary
    lines.push(`## Доходность по секторам`);
    lines.push(``);
    const bySector = {};
    for (const row of okResults) {
        if (!bySector[row.sector]) bySector[row.sector] = [];
        bySector[row.sector].push(row);
    }
    lines.push(`| Сектор | Тикеры | Avg доходность | Avg WR | Avg PF | Avg E[%] |`);
    lines.push(`| --- | --- | --- | --- | --- | --- |`);
    const sectorRows = Object.entries(bySector)
        .map(([sector, rows]) => ({
            sector,
            tickers: rows.map(r => r.ticker).join(", "),
            avgReturn: r(avg(rows.map(r => r.returnPct))),
            avgWR: r(avg(rows.map(r => r.winRate))),
            avgPF: r(avg(rows.filter(r => r.profitFactor != null).map(r => r.profitFactor))),
            avgE: r(avg(rows.map(r => r.avgTradePct)), 3),
        }))
        .sort((a, b) => b.avgReturn - a.avgReturn);
    for (const s of sectorRows) {
        lines.push(`| ${s.sector} | ${s.tickers} | ${s.avgReturn}% | ${s.avgWR}% | ${s.avgPF} | ${s.avgE}% |`);
    }
    lines.push(``);

    // --- CONCLUSION ---
    const best = ranked[0];
    const worst = ranked[ranked.length - 1];
    const bestMonth = seasonalSorted[0];
    const worstMonth = seasonalSorted[seasonalSorted.length - 1];
    const highPF = ranked.filter(r => (r.profitFactor || 0) >= 2).length;
    const lowPF = ranked.filter(r => (r.profitFactor || 0) < 1).length;
    const avgDD = r(avg(okResults.map(r => r.maxDrawdownPct)));
    const allTradesPcts = allTrades.map(x => x.trade.pnlPct || 0);
    const overallExpected = r(avg(allTradesPcts), 3);

    lines.push(`## Вывод`);
    lines.push(``);
    lines.push(`### Общая картина`);
    lines.push(``);
    lines.push(
        `Стратегия **${stratName}** протестирована на **${okResults.length} инструментах** MOEX за **${year} год**. ` +
        `Общий win rate составил **${overallWR}%**, profit factor — **${overallPF ?? "N/A"}**, ` +
        `матожидание одной сделки — **${overallExpected}% от депозита**. ` +
        `Средняя годовая доходность по портфелю: **${overallAvgReturn}%** (медиана: **${medianReturn}%**). ` +
        `Средняя максимальная просадка — **${avgDD}%** от начального депозита.`
    );
    lines.push(``);
    lines.push(`### Лидеры и аутсайдеры`);
    lines.push(``);
    lines.push(
        `Лучший результат показал **${best.ticker}** (${best.sector}) с доходностью **${best.returnPct}%**, ` +
        `win rate **${best.winRate}%**, PF **${best.profitFactor}** и просадкой **${best.maxDrawdownPct}%**. ` +
        `Худший результат — **${worst.ticker}** (${worst.sector}): **${worst.returnPct}%**.`
    );
    lines.push(``);
    lines.push(
        `Из ${okResults.length} инструментов **${highPF} показали PF ≥ 2** (устойчивая стратегия), ` +
        `**${lowPF} показали PF < 1** (убыточно). ` +
        `${lowPF > 0 ? "Для убыточных инструментов стратегия не рекомендована к применению." : "Убыточных инструментов нет — стратегия применима ко всему набору."}`
    );
    lines.push(``);
    lines.push(`### Сезонность`);
    lines.push(``);
    lines.push(
        `Лучший месяц: **${bestMonth.monthName}** (avg ${bestMonth.avgReturnPct}% по всем акциям, WR ${bestMonth.winRate}%). ` +
        `Худший месяц: **${worstMonth.monthName}** (avg ${worstMonth.avgReturnPct}%, WR ${worstMonth.winRate}%). ` +
        `Стратегия работает на утренних гэпах вниз, поэтому сезонность отражает волатильность рынка.`
    );
    lines.push(``);
    lines.push(`### Рекомендации`);
    lines.push(``);

    const top5 = ranked.slice(0, 5).map(r => `${r.ticker} (${r.returnPct}%, PF ${r.profitFactor})`);
    lines.push(`**Топ-5 инструментов для живой торговли:**`);
    lines.push(``);
    top5.forEach((t, i) => lines.push(`${i + 1}. ${t}`));
    lines.push(``);

    const lowDD = ranked.filter(r => r.maxDrawdownPct < 5 && r.returnPct > 30);
    if (lowDD.length) {
        lines.push(`**Консервативные кандидаты (DD < 5%, доходность > 30%):**`);
        lines.push(``);
        lowDD.forEach(r => lines.push(`- ${r.ticker}: ${r.returnPct}%, DD ${r.maxDrawdownPct}%`));
        lines.push(``);
    }

    lines.push(
        `Стратегия показывает **стабильный положительный результат** на большинстве ликвидных инструментов MOEX. ` +
        `Ключевой риск — **утреннее «ложное» движение** (позиция открывается на ожидании продолжения снижения, ` +
        `но рынок разворачивается), что отражается в убыточных сделках с SL. ` +
        `Инструменты с высокой утренней волатильностью и чётким утренним гэпом дают лучшие результаты.`
    );
    lines.push(``);

    // Errors
    const errored = results.filter(r => r.error);
    if (errored.length) {
        lines.push(`## Ошибки`);
        lines.push(``);
        for (const e of errored) {
            lines.push(`- **${e.ticker}**: ${e.error}`);
        }
        lines.push(``);
    }

    const md = lines.join("\n");

    // Save
    const stratSlug = path.basename(strategy, ".js").replace(/[^a-z0-9_-]/gi, "_");
    const outFile = path.join(LOGS_DIR, `backtest_${year}_${stratSlug}_report.md`);
    fs.writeFileSync(outFile, md, "utf8");
    console.error(`\nReport saved to ${outFile}`);
    console.log(md);
}

function median(arr) {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

main().catch((e) => { console.error(e); process.exit(1); });
