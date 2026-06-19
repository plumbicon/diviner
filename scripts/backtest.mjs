#!/usr/bin/env node
/**
 * Batch backtest runner — all *_<year>_1m.parquet files, parallelised across
 * a pool of worker_threads (tickers are independent → embarrassingly parallel).
 *
 * Fills orders at the open of the next candle (--fill-next-open mode),
 * which removes the look-ahead bias of filling at the close that triggered
 * the signal.
 *
 * Usage:
 *   node src/strategies/scripts/backtest-2025.mjs [--top N] [--workers K] [--verbose]
 *
 * Options:
 *   --top N      Show top-N tickers ranked by total return (default: 25)
 *   --workers K  Parallel worker threads (default: min(8, #cpus, #tickers))
 *   --year YYYY  Data year suffix (default: 2025)
 *   --strategy S Strategy name/export (default: A05)
 *   --leverage N / --intrabar-stops / --model-liquidation / --params '{...}'
 */

import { readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, "..");
const DATA_DIR  = join(ROOT, "data");
const SELF      = fileURLToPath(import.meta.url);

// ── CLI args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function argValue(flag, fallback) {
    const i = args.indexOf(flag);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}
const topN     = Number(argValue("--top", 25));
const year     = String(argValue("--year", "2025"));
const stratNm  = String(argValue("--strategy", "A05"));
const leverage = String(argValue("--leverage", "1"));
const intrabarStops    = args.includes("--intrabar-stops");
const modelLiquidation = args.includes("--model-liquidation");
const SUFFIX   = `_${year}_1m.parquet`;
const STRATEGY = join(ROOT, "src", "strategies", stratNm, `${stratNm}.js`);

// --params '{"minProfitPct":0.5,"slPct":2.5,"tpPct":1.0}' — inject extra fields
// into the strategy instance after construction.
const rawParams   = argValue("--params", null);
const stratParams = rawParams ? JSON.parse(rawParams) : {};

// Static config shared with every worker.
const JOB = { STRATEGY, stratNm, leverage, intrabarStops, modelLiquidation, stratParams, SUFFIX };

// ── Shared formatting helpers (declared before use; const ≠ hoisted) ──────────
function fmt(value, decimals = 2, fallback = "—") {
    if (value == null || !Number.isFinite(value)) return fallback;
    return value.toFixed(decimals);
}

function pad(str, width, right = false) {
    const s = String(str ?? "—");
    return right ? s.padStart(width) : s.padEnd(width);
}

const W = {
    ticker: 6, trades: 6, ret: 9, annual: 9, maxdd: 8,
    sharpe: 7, calmar: 7, romaxdd: 8, winrate: 8, pf: 6,
};

const SEP = "─".repeat(
    W.ticker + W.trades + W.ret + W.annual + W.maxdd + W.sharpe + W.calmar + W.romaxdd + W.winrate + W.pf + 11,
);

function headerLine() {
    return [
        pad("Ticker", W.ticker),
        pad("Trades", W.trades, true),
        pad("Ret%", W.ret, true),
        pad("Ann%", W.annual, true),
        pad("MaxDD%", W.maxdd, true),
        pad("Sharpe", W.sharpe, true),
        pad("Calmar", W.calmar, true),
        pad("R/MaxDD", W.romaxdd, true),
        pad("WinRate", W.winrate, true),
        pad("PF", W.pf, true),
    ].join("  ");
}

function rowLine(r) {
    return [
        pad(r.ticker, W.ticker),
        pad(r.tradesCount ?? 0, W.trades, true),
        pad(fmt(r.returnPct, 2), W.ret, true),
        pad(fmt(r.annualizedReturnPct, 2), W.annual, true),
        pad(fmt(r.maxDrawdownPct, 2), W.maxdd, true),
        pad(fmt(r.sharpe, 2), W.sharpe, true),
        pad(fmt(r.calmar, 2), W.calmar, true),
        pad(fmt(r.returnOnMaxDD, 2), W.romaxdd, true),
        pad(fmt(r.winRate, 1), W.winrate, true),
        pad(r.profitFactor != null ? fmt(r.profitFactor, 2) : "∞", W.pf, true),
    ].join("  ");
}

// ════════════════════════════════════════════════════════════════════════════
//  WORKER: backtest a single ticker file and return its performance metrics.
// ════════════════════════════════════════════════════════════════════════════
if (!isMainThread) {
    const { createBroker } = await import("../src/broker/simulated/broker.js");
    const { Engine }       = await import("../src/core/engine.js");
    const { TemporalView } = await import("../src/core/temporal-view.js");
    const { MarketDataCache } = await import("../src/core/market-cache.js");

    const cfg = workerData;
    const stratMod = await import(cfg.STRATEGY);
    const StrategyClass = stratMod[cfg.stratNm] || stratMod.default;
    if (typeof StrategyClass !== "function") {
        throw new Error(`Strategy ${cfg.stratNm} not found as export in ${cfg.STRATEGY}`);
    }

    async function runOne(filePath) {
        const ticker = filePath.split("/").pop().replace(cfg.SUFFIX, "");
        try {
            const broker = await createBroker({
                source:        filePath,
                sourceName:    filePath,
                balance:       "10000",
                commission:    "0.0005",
                leverage:      cfg.leverage,
                fillNextOpen:  true,
                intrabarStops: cfg.intrabarStops,
                modelLiquidation: cfg.modelLiquidation,
                strategy:      cfg.STRATEGY,
            });

            // 1m strategies: require a non-empty 1-minute series.
            const oneMin = broker.data.series?.get(1);
            if (!oneMin || oneMin.length === 0) {
                return { ticker, error: "no 1m candles in parquet" };
            }

            const dataSource = broker.needsCache ? new MarketDataCache(broker.data) : broker.data;
            const context    = new TemporalView({ dataSource, metadata: broker.metadata, logger: () => {} });

            const strategy = new StrategyClass(broker.data.candles, 10000, 0.0005);
            for (const [k, v] of Object.entries(cfg.stratParams)) strategy[k] = v;

            const engine = new Engine();
            const result = await engine.run({ broker, strategy, context, options: { verbose: false } });
            return { ticker, ...result.performance_metrics };
        } catch (err) {
            return { ticker, error: err.message };
        }
    }

    parentPort.on("message", async (msg) => {
        if (msg?.done) { process.exit(0); }
        const result = await runOne(msg.filePath);
        parentPort.postMessage({ type: "result", result });
    });

    // Worker stays alive on the message listener; nothing else to do here.
} else {
    // ════════════════════════════════════════════════════════════════════════
    //  MAIN: discover files, drive a worker pool, aggregate + print the report.
    // ════════════════════════════════════════════════════════════════════════
    const files = (await readdir(DATA_DIR))
        .filter((f) => f.endsWith(SUFFIX))
        .sort()
        .map((f) => join(DATA_DIR, f));

    const NUM_WORKERS = Math.max(1, Math.min(
        Number(argValue("--workers", 8)),
        os.cpus().length,
        files.length,
    ));
    console.error(`Found ${files.length} tickers for ${year} — running on ${NUM_WORKERS} workers\n`);

    const results = [];
    const queue   = [...files];
    let done = 0;
    const t0 = Date.now();

    await new Promise((resolve) => {
        let active = NUM_WORKERS;
        for (let i = 0; i < NUM_WORKERS; i++) {
            const w = new Worker(SELF, { workerData: JOB });
            const next = () => {
                const filePath = queue.shift();
                if (!filePath) { w.postMessage({ done: true }); return; }
                w.postMessage({ filePath });
            };
            w.on("message", (msg) => {
                if (msg?.type !== "result") return;
                const r = msg.result;
                results.push(r);
                done += 1;
                const tag = r.error
                    ? `ERROR: ${r.error}`
                    : `${String(r.tradesCount).padStart(3)} trades  ret=${fmt(r.returnPct, 2).padStart(7)}%  maxDD=${fmt(r.maxDrawdownPct, 2).padStart(6)}%`;
                process.stderr.write(`[${String(done).padStart(2)}/${files.length}] ${r.ticker.padEnd(6)} ${tag}\n`);
                next();
            });
            w.on("error", (err) => {
                results.push({ ticker: "?", error: err.message });
                next();
            });
            w.on("exit", () => { if (--active === 0) resolve(); });
            next();
        }
    });

    console.error(`\nFinished in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

    // ── Filter / sort ─────────────────────────────────────────────────────────
    const valid  = results.filter((r) => !r.error && Number.isFinite(r.returnPct));
    const errors = results.filter((r) => r.error);
    valid.sort((a, b) => b.returnPct - a.returnPct);

    console.log("\n" + "═".repeat(SEP.length));
    const paramSuffix = Object.keys(stratParams).length
        ? "  params: " + Object.entries(stratParams).map(([k, v]) => `${k}=${v}`).join(" ")
        : "";
    const levSuffix = Number(leverage) !== 1 ? `  leverage: ${leverage}×` : "";
    const stopSuffix = intrabarStops ? "  stops: intrabar(high/low)" : "";
    console.log(`  ${stratNm} BACKTEST — ALL ${year} TICKERS  (fill: next-open)${levSuffix}${stopSuffix}${paramSuffix}`);
    console.log("═".repeat(SEP.length));
    console.log(headerLine());
    console.log(SEP);
    for (const r of valid) console.log(rowLine(r));

    if (errors.length > 0) {
        console.log(SEP);
        for (const r of errors) console.log(`${pad(r.ticker, W.ticker)}  ERROR: ${r.error}`);
    }

    // ── Top-N ──────────────────────────────────────────────────────────────────
    const top = valid.slice(0, topN);
    console.log("\n" + "═".repeat(SEP.length));
    console.log(`  TOP-${topN} BY RETURN`);
    console.log("═".repeat(SEP.length));
    console.log(headerLine());
    console.log(SEP);
    top.forEach((r, i) => console.log(`${String(i + 1).padStart(2)}. ${rowLine(r)}`));

    // ── Aggregate ───────────────────────────────────────────────────────────────
    const avgRet    = valid.reduce((s, r) => s + r.returnPct, 0) / (valid.length || 1);
    const sharpes   = valid.filter((r) => Number.isFinite(r.sharpe));
    const avgSharpe = sharpes.reduce((s, r) => s + r.sharpe, 0) / (sharpes.length || 1);
    const profitable = valid.filter((r) => r.returnPct > 0).length;

    console.log(SEP);
    console.log(`\nSummary: ${valid.length} tickers run, ${errors.length} errors`);
    console.log(`  Profitable: ${profitable}/${valid.length} (${(profitable / valid.length * 100).toFixed(1)}%)`);
    console.log(`  Avg return: ${fmt(avgRet)}%   Avg Sharpe: ${fmt(avgSharpe)}`);
    console.log(
        `  Best:  ${valid[0]?.ticker} ${fmt(valid[0]?.returnPct)}%  |  `
        + `Worst: ${valid[valid.length - 1]?.ticker} ${fmt(valid[valid.length - 1]?.returnPct)}%`,
    );
}
