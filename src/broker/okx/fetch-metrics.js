#!/usr/bin/env node
/**
 * Fetch OKX perpetual-swap market microstructure metrics to CSV.
 *
 * All public endpoints — no API keys required.
 *
 * Output: one CSV row per 1-hour bar:
 *   ts, funding_rate, oi_usd, taker_buy_vol_usd, taker_sell_vol_usd, ls_ratio
 *
 * Data sources (OKX public API v5):
 *   funding_rate     GET /public/funding-rate-history       (8h events, ffill'd to 1H)
 *                    Cursor pagination with `after`; retention is several months.
 *   oi_usd           GET /rubik/stat/contracts/open-interest-volume  (1H bars, USD)
 *   taker_{buy,sell} GET /rubik/stat/taker-volume           (1H bars, USD)
 *   ls_ratio         GET /rubik/stat/contracts/long-short-account-ratio (1H bars)
 *
 * Availability notes:
 *   - Rubik stat endpoints (OI, taker, L/S) return at most 720 1H bars (~30 days)
 *     per call via cursor pagination. Older history is not accessible via the API.
 *   - Funding rate can go further back (~several months) via cursor pagination.
 *   - For longer history, use OKX Data Portal CSV downloads (okx.com/data-download).
 *
 * Usage:
 *   # Last 30 days to stdout
 *   node src/broker/okx/fetch-metrics.js --symbol BTC/USDT:USDT
 *
 *   # Specific range to file (range clamped to API availability)
 *   node src/broker/okx/fetch-metrics.js --symbol BTC/USDT:USDT \
 *     --from-date 2026-05-01 --till-date 2026-06-15 --out data/BTC_metrics.csv
 */

import { writeFile } from "node:fs/promises";
import { Command } from "commander";

const OKX = "https://www.okx.com/api/v5";
const HOUR_MS = 3_600_000;

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

/** BTC/USDT:USDT → { instId: "BTC-USDT-SWAP", ccy: "BTC" } */
function parseSymbol(symbol) {
    const [base, rest] = String(symbol).split("/");
    if (!base || !rest) throw new Error(`Cannot parse symbol: ${symbol}`);
    return { instId: `${base}-${rest.split(":")[0]}-SWAP`, ccy: base };
}

/**
 * Single OKX public GET with retry.
 * @returns {Promise<Array>} body.data (array), or throws with a descriptive message.
 */
async function okxGet(path, params, retries = 3, backoffMs = 500) {
    const url = new URL(`${OKX}${path}`);
    for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const res = await fetch(url.toString(), {
                headers: { "User-Agent": "diviner-metrics/1.0" },
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const body = await res.json();
            // code "50030" = "Illegal time range" — range too old for rubik endpoints
            if (body.code !== "0") {
                const err = new Error(`code=${body.code} ${body.msg}`);
                err.code = body.code;
                throw err;
            }
            return Array.isArray(body.data) ? body.data : [];
        } catch (e) {
            if (e.code === "50030") throw e; // not retryable
            if (attempt === retries) throw new Error(`OKX ${path}: ${e.message}`);
            console.error(`  [retry ${attempt}] ${path}: ${e.message}`);
            await sleep(backoffMs * attempt);
        }
    }
    return [];
}

/**
 * Fetch a rubik stat endpoint that supports cursor-based `after` pagination.
 * Returns rows sorted ascending by ts, within [fromMs, toMs].
 *
 * OKX rubik endpoints (OI, taker, L/S) return at most 720 1H bars (~30 days) per
 * call. Rows are newest-first; `after=<oldest_ts>` fetches the next (older) page.
 * If the requested range extends beyond API retention, only available data is returned.
 *
 * @param {string} path
 * @param {object} baseParams - Fixed params (ccy, period, instType, …).
 * @param {number} fromMs
 * @param {number} toMs
 * @param {number} delayMs
 */
async function fetchRubikPaginated(path, baseParams, fromMs, toMs, delayMs) {
    const rows = [];
    // Start cursor just past toMs so first page covers the end of the range.
    let after = toMs + HOUR_MS;

    while (true) {
        let batch;
        try {
            batch = await okxGet(path, { ...baseParams, after, limit: 100 });
        } catch (e) {
            if (e.code === "50030") {
                // Range is beyond API retention; stop here with what we have.
                console.error(`  [info] ${path}: ${e.message} — using available data only`);
                break;
            }
            throw e;
        }
        if (!batch.length) break;

        let minTs = Infinity;
        for (const row of batch) {
            const ts = Number(row[0]);
            if (ts >= fromMs && ts <= toMs) rows.push(row);
            if (ts < minTs) minTs = ts;
        }

        // Stop if we've gone past the start of the range or got a short page.
        if (minTs <= fromMs || batch.length < 100) break;
        after = minTs;
        await sleep(delayMs);
    }

    return rows.sort((a, b) => Number(a[0]) - Number(b[0]));
}

/**
 * Fetch funding rate history via backward cursor pagination.
 * Returns [{ts, rate}] sorted ascending.
 *
 * `after=<fundingTime>` returns the next page of OLDER records (newest-first stream).
 * OKX retains several months of funding history this way.
 */
async function fetchFundingRates(instId, fromMs, toMs, delayMs) {
    const rows = [];
    // Fetch slightly before fromMs so the very first bar can be forward-filled.
    const targetFrom = fromMs - 8 * HOUR_MS;
    let after = toMs + HOUR_MS;

    while (true) {
        let batch;
        try {
            batch = await okxGet("/public/funding-rate-history", {
                instId,
                after,
                limit: 100,
            });
        } catch (e) {
            console.error(`  [warn] funding-rate-history: ${e.message} — stopping early`);
            break;
        }
        if (!batch.length) break;

        let minTs = Infinity;
        for (const row of batch) {
            const ts = Number(row.fundingTime);
            if (ts >= targetFrom && ts <= toMs) {
                rows.push({ ts, rate: Number(row.fundingRate) });
            }
            if (ts < minTs) minTs = ts;
        }

        if (minTs <= targetFrom || batch.length < 100) break;
        after = minTs;
        await sleep(delayMs);
    }

    return rows.sort((a, b) => a.ts - b.ts);
}

/**
 * Forward-fill 8H funding events onto a 1H grid.
 * Each hour gets the rate from the last event at or before that bar's open time.
 */
function forwardFillFunding(events, grid) {
    const result = new Map();
    let idx = 0;
    let cur = null;
    for (const ts of grid) {
        while (idx < events.length && events[idx].ts <= ts) {
            cur = events[idx].rate;
            idx++;
        }
        result.set(ts, cur);
    }
    return result;
}

async function main() {
    const program = new Command();
    program
        .name("fetch-okx-metrics")
        .description("Fetch OKX perp-swap market microstructure metrics to CSV (no keys required)")
        .requiredOption("--symbol <symbol>", "Swap symbol (e.g. BTC/USDT:USDT)")
        .option("--from-date <date>", "Start date YYYY-MM-DD UTC (default: 30 days ago)")
        .option("--till-date <date>", "End date YYYY-MM-DD UTC (default: today)", new Date().toISOString().slice(0, 10))
        .option("--out <path>", "Output CSV file (default: stdout)")
        .option("--request-delay-ms <ms>", "Delay between API requests", "300");

    program.parse();
    const opts = program.opts();

    const toMs = new Date(`${opts.tillDate}T23:59:59.999Z`).getTime();
    const fromMs = opts.fromDate
        ? new Date(`${opts.fromDate}T00:00:00.000Z`).getTime()
        : toMs - 30 * 24 * HOUR_MS;
    const delayMs = Math.max(0, parseInt(opts.requestDelayMs, 10) || 300);

    if (fromMs > toMs) program.error("--from-date must be ≤ --till-date");

    let instId, ccy;
    try {
        ({ instId, ccy } = parseSymbol(opts.symbol));
    } catch (e) {
        program.error(e.message);
    }

    const fromStr = new Date(fromMs).toISOString().slice(0, 10);
    const toStr   = new Date(toMs).toISOString().slice(0, 10);
    console.error(`Fetching metrics for ${instId} (ccy=${ccy})  ${fromStr} → ${toStr}`);

    // Build the 1H timestamp grid (UTC-aligned).
    const firstHour = Math.ceil(fromMs / HOUR_MS) * HOUR_MS;
    const lastHour  = Math.floor(toMs / HOUR_MS) * HOUR_MS;
    const grid = [];
    for (let ts = firstHour; ts <= lastHour; ts += HOUR_MS) grid.push(ts);
    console.error(`  Grid: ${grid.length} hourly bars`);

    // Fetch all four data streams.
    console.error("  [1/4] Funding rate history...");
    const funding = await fetchFundingRates(instId, fromMs, toMs, delayMs);
    console.error(`        ${funding.length} funding events`);

    console.error("  [2/4] Open interest (USD)...");
    // OI response cols: [ts, oi_usd, vol_usd] — all in USDT
    const oiRows = await fetchRubikPaginated(
        "/rubik/stat/contracts/open-interest-volume",
        { ccy, period: "1H" },
        fromMs, toMs, delayMs,
    );
    console.error(`        ${oiRows.length} rows`);

    console.error("  [3/4] Taker buy/sell volume (USD)...");
    // Taker response cols: [ts, sellVol_usd, buyVol_usd] — OKX lists sell before buy
    const takerRows = await fetchRubikPaginated(
        "/rubik/stat/taker-volume",
        { ccy, instType: "CONTRACTS", period: "1H" },
        fromMs, toMs, delayMs,
    );
    console.error(`        ${takerRows.length} rows`);

    console.error("  [4/4] Long/short account ratio...");
    // L/S response cols: [ts, ls_ratio]
    const lsRows = await fetchRubikPaginated(
        "/rubik/stat/contracts/long-short-account-ratio",
        { ccy, period: "1H" },
        fromMs, toMs, delayMs,
    );
    console.error(`        ${lsRows.length} rows`);

    // Index rubik rows by timestamp.
    const oiMap    = new Map(oiRows.map((r)    => [Number(r[0]), Number(r[1])]));
    const takerMap = new Map(takerRows.map((r) => [Number(r[0]), { buy: Number(r[2]), sell: Number(r[1]) }]));
    const lsMap    = new Map(lsRows.map((r)    => [Number(r[0]), Number(r[1])]));

    // Forward-fill funding onto the 1H grid.
    const fundingMap = forwardFillFunding(funding, grid);

    // Build CSV.
    const lines = ["ts,funding_rate,oi_usd,taker_buy_vol_usd,taker_sell_vol_usd,ls_ratio\n"];
    let filled = 0;
    for (const ts of grid) {
        const rate  = fundingMap.get(ts);
        const oi    = oiMap.get(ts);
        const taker = takerMap.get(ts);
        const ls    = lsMap.get(ts);
        if (oi !== undefined || taker !== undefined || ls !== undefined) filled++;
        lines.push(
            `${new Date(ts).toISOString()},`
            + `${rate ?? ""},`
            + `${oi ?? ""},`
            + `${taker?.buy ?? ""},`
            + `${taker?.sell ?? ""},`
            + `${ls ?? ""}\n`,
        );
    }
    console.error(`  Coverage: ${filled}/${grid.length} bars have at least one metric`);

    const csv = lines.join("");
    if (opts.out) {
        await writeFile(opts.out, csv, "utf8");
        console.error(`  Written to ${opts.out}`);
    } else {
        process.stdout.write(csv);
    }
}

main().catch((e) => {
    console.error(e?.message || e);
    process.exit(1);
});
