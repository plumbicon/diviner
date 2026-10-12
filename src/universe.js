#!/usr/bin/env node
/**
 * Select the tradeable universe from the T-Invest API.
 *
 * A cross-sectional strategy needs not "a list someone made a year and a half ago" but
 * the current set of instruments that can be shorted through the API RIGHT NOW. An
 * instrument whose short was disabled must drop out of the universe by itself, not live
 * in a hard-coded constant until someone notices.
 *
 * Selection is by instrument flags (all checked against the SDK):
 *   shortEnabledFlag       shorting allowed — without it the strategy does not apply;
 *   liquidityFlag          liquidity mark from the exchange;
 *   apiTradeAvailableFlag  tradeable through the API, not only in the app;
 *   sellAvailableFlag      selling available;
 *   otcFlag / blockedTcaFlag       OTC and blocked — excluded;
 *   forQualInvestorFlag    qualified-investor status required — excluded (--allow-qual brings it back);
 *   first1minCandleDate    whether minute history is deep enough.
 *
 * Tests are checked separately. "Pass a test in the Profile section" is not a property
 * of the instrument but of the "instrument × account" pair, and Share flags do not carry
 * it at all: the required tests are on the asset (`getAssetBy` → `requiredTests`), the
 * passed ones on the user (`users.getInfo` → `qualifiedForWorkWith`). Without this check a
 * missing test is only discovered when a real order is rejected live.
 *
 * Lot cost (last price × lot) is computed separately: on a 10,000 ₽ account with four
 * slots an instrument whose lot costs more than 2,500 ₽ cannot physically be bought, no
 * matter how well it scores. That is a property of the deposit, not of the instrument,
 * so the filter is separate and off by default.
 *
 * Usage:
 *   T_INVEST_TOKEN=<token> node src/universe.js
 *   T_INVEST_TOKEN=<token> node src/universe.js --table --min-history-days 400
 *   T_INVEST_TOKEN=<token> node src/universe.js --max-lot-cost 2500 --json
 */
import { Command } from "commander";
import { TinkoffInvestApi } from "tinkoff-invest-api";
import { InstrumentStatus, InstrumentType } from "tinkoff-invest-api/dist/generated/common.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// How many asset cards to fetch in parallel. getAssetBy is one call per asset — fewer
// than a hundred requests for our universe; four in flight stay within the limits and
// do not drag the run out.
const ASSET_CONCURRENCY = 4;

/** Quotation → number. @private */
function quotationToNumber(q) {
    if (!q) return null;
    return Number(q.units || 0) + Number(q.nano || 0) / 1e9;
}

/**
 * Reasons an instrument fails the selection. An empty list means it passes. A list rather
 * than a boolean: when an instrument drops out unexpectedly you need to see why, otherwise
 * debugging turns into guesswork.
 * @param {object} share - Instrument from instruments.shares().
 * @param {object} options - Selection parameters.
 * @returns {Array<string>} Rejection reasons.
 */
export function rejectionReasons(share, options = {}) {
    const {
        exchangePattern = /MOEX/i,
        currency = "rub",
        minHistoryDays = 400,
        allowQual = false,
        now = Date.now(),
    } = options;

    const out = [];
    if (!share.shortEnabledFlag) out.push("short disabled");
    if (!share.liquidityFlag) out.push("illiquid");
    if (!share.apiTradeAvailableFlag) out.push("no API trading");
    if (!share.sellAvailableFlag) out.push("selling unavailable");
    if (share.otcFlag) out.push("OTC");
    if (share.blockedTcaFlag) out.push("TCA block");
    if (share.forQualInvestorFlag && !allowQual) out.push("qualified investors only");
    if (currency && String(share.currency).toLowerCase() !== currency) out.push(`currency ${share.currency}`);
    if (exchangePattern && !exchangePattern.test(share.exchange || "")) out.push(`exchange ${share.exchange}`);

    const first = share.first1minCandleDate ? new Date(share.first1minCandleDate).getTime() : null;
    if (!first) out.push("no minute history");
    else if ((now - first) / DAY_MS < minHistoryDays) {
        out.push(`history ${Math.round((now - first) / DAY_MS)} days < ${minHistoryDays}`);
    }
    return out;
}

/**
 * Which tests an instrument needs and whether the account has passed them.
 *
 * A separate pure function: comparing the lists is the one place where it is easy to get
 * wrong, and checking it needs no live API.
 *
 * @param {Array<string>} requiredTests - Tests the asset requires.
 * @param {Array<string>} passedTests - Tests the account owner has passed.
 * @returns {Array<string>} Missing tests; an empty list means the instrument is available.
 */
export function missingTests(requiredTests = [], passedTests = []) {
    if (!requiredTests?.length) return [];
    const passed = new Set(passedTests || []);
    return requiredTests.filter((t) => !passed.has(t));
}

/**
 * Retry transient gRPC failures with growing pauses.
 * @param {Function} call - Call returning a promise.
 * @param {string} label - Method name for the log.
 * @param {number} [attempts] - How many times to try.
 * @returns {Promise<*>} Call result.
 * @private
 */
async function withRetry(call, label, attempts = 4) {
    let lastError;
    for (let i = 0; i < attempts; i += 1) {
        try {
            return await call();
        } catch (error) {
            lastError = error;
            const delay = 1000 * 2 ** i;
            console.error(`[universe] ${label}: ${error.message?.split("\n")[0]} — retry in ${delay} ms`);
            await new Promise((resolve) => { setTimeout(resolve, delay); });
        }
    }
    throw lastError;
}

/**
 * Drop instruments for which the account has not passed the required tests.
 *
 * Works on the already selected list: the asset card is fetched per instrument, and there
 * is no point doing it for the whole exchange. Any API error here is a reason to warn, not
 * to discard the universe: better to return the composition without this check than to
 * return nothing.
 *
 * @param {object} api - TinkoffInvestApi.
 * @param {Array<object>} selected - Instruments that passed the flag selection (edited in place).
 * @param {Array<object>} rejected - Rejected instruments (appended to).
 * @returns {Promise<{passedTests: Array<string>|null, checked: number}>} Check summary.
 * @private
 */
async function filterByRequiredTests(api, selected, rejected) {
    let passedTests;
    try {
        ({ qualifiedForWorkWith: passedTests } = await withRetry(
            () => api.users.getInfo({}), "users.getInfo",
        ));
    } catch (error) {
        console.error(
            `[universe] account tests unavailable (${error.message?.split("\n")[0]}) — `
            + "check skipped, a missing test will show up as an order rejection.",
        );
        return { passedTests: null, checked: 0 };
    }

    let assetByInstrument;
    try {
        const { assets } = await withRetry(() => api.instruments.getAssets({
            instrumentType: InstrumentType.INSTRUMENT_TYPE_SHARE,
            instrumentStatus: InstrumentStatus.INSTRUMENT_STATUS_BASE,
        }), "instruments.getAssets");
        assetByInstrument = new Map();
        for (const asset of assets) {
            for (const instrument of asset.instruments || []) {
                assetByInstrument.set(instrument.uid, asset.uid);
            }
        }
    } catch (error) {
        console.error(`[universe] asset list unavailable (${error.message?.split("\n")[0]}) — check skipped.`);
        return { passedTests, checked: 0 };
    }

    // Asset cards go in batches: sequentially it takes minutes, and without a cap on
    // concurrent calls we hit the request limit.
    const queue = [...selected];
    let checked = 0;
    const worker = async () => {
        for (let item = queue.shift(); item; item = queue.shift()) {
            const assetUid = assetByInstrument.get(item.uid);
            if (!assetUid) continue;
            try {
                const { asset } = await withRetry(
                    () => api.instruments.getAssetBy({ id: assetUid }), `getAssetBy ${item.ticker}`, 2,
                );
                item.requiredTests = asset?.requiredTests ?? [];
                checked += 1;
            } catch {
                // The card did not arrive — leave the instrument alone. Dropping a working
                // name over a network glitch is worse than leaving it unchecked.
                item.requiredTests = null;
            }
        }
    };
    await Promise.all(Array.from({ length: ASSET_CONCURRENCY }, worker));

    for (let i = selected.length - 1; i >= 0; i -= 1) {
        const item = selected[i];
        const missing = missingTests(item.requiredTests, passedTests);
        if (missing.length > 0) {
            item.reasons = [`test not passed: ${missing.join(", ")}`];
            rejected.push(...selected.splice(i, 1));
        }
    }
    return { passedTests, checked };
}

/**
 * Fetch and select the universe.
 * @param {object} options - Selection parameters (see rejectionReasons) + maxLotCost.
 * @returns {Promise<{selected: Array<object>, rejected: Array<object>}>} Result.
 */
export async function selectUniverse(options = {}) {
    const token = process.env.T_INVEST_TOKEN;
    if (!token) throw new Error("T_INVEST_TOKEN is required");
    const api = new TinkoffInvestApi({ token });

    // Shares regularly answers RST_STREAM without a gRPC status when the token carries
    // other load in parallel (a listings download, for example). The error is transient,
    // so it is retried with growing pauses instead of failing.
    const { instruments } = await withRetry(
        () => api.instruments.shares({ instrumentStatus: InstrumentStatus.INSTRUMENT_STATUS_BASE }),
        "instruments.shares",
    );

    const selected = [];
    const rejected = [];
    for (const share of instruments) {
        const reasons = rejectionReasons(share, options);
        const record = {
            ticker: share.ticker,
            name: share.name,
            figi: share.figi,
            uid: share.uid,
            classCode: share.classCode,
            exchange: share.exchange,
            lot: share.lot,
            dshortClient: quotationToNumber(share.dshortClient) ?? quotationToNumber(share.dshort),
            first1minCandleDate: share.first1minCandleDate
                ? new Date(share.first1minCandleDate).toISOString().slice(0, 10) : null,
            reasons,
        };
        (reasons.length === 0 ? selected : rejected).push(record);
    }

    // Tests before prices: no point asking quotes for instruments that will drop out anyway.
    if (selected.length > 0 && options.checkTests !== false) {
        const { passedTests, checked } = await filterByRequiredTests(api, selected, rejected);
        if (passedTests) {
            console.error(
                `[universe] assets checked: ${checked}; tests passed by the account: `
                + `${passedTests.length ? passedTests.join(", ") : "none"}.`,
            );
        }
    }

    // Lot cost — one request for the whole selected set.
    if (selected.length > 0) {
        try {
            // figi[] in the request is marked deprecated but required: the SDK serializer
            // walks every field and fails on a missing array.
            const { lastPrices } = await api.marketdata.getLastPrices({
                figi: [],
                instrumentId: selected.map((s) => s.uid),
                lastPriceType: 0,
            });
            const priceByUid = new Map(
                lastPrices.map((p) => [p.instrumentUid, quotationToNumber(p.price)]),
            );
            for (const item of selected) {
                const price = priceByUid.get(item.uid) ?? null;
                item.price = price;
                item.lotCost = price != null ? price * item.lot : null;
            }
        } catch (error) {
            console.error(`[universe] last prices unavailable: ${error.message}`);
        }
    }

    const maxLotCost = Number(options.maxLotCost) || 0;
    if (maxLotCost > 0) {
        for (let i = selected.length - 1; i >= 0; i -= 1) {
            const item = selected[i];
            if (item.lotCost != null && item.lotCost > maxLotCost) {
                item.reasons = [`lot ${item.lotCost.toFixed(0)} ₽ > ${maxLotCost} ₽`];
                rejected.push(...selected.splice(i, 1));
            }
        }
    }

    selected.sort((a, b) => (a.ticker < b.ticker ? -1 : 1));
    rejected.sort((a, b) => (a.ticker < b.ticker ? -1 : 1));
    return { selected, rejected };
}

const program = new Command();
program
    .name("diviner-universe")
    .description("Select shortable liquid shares through the T-Invest API")
    .option("--min-history-days <n>", "Minimum depth of minute history, days", "400")
    .option("--max-lot-cost <rub>", "Drop instruments whose lot costs more (0 = no filter)", "0")
    .option("--allow-qual", "Keep instruments for qualified investors", false)
    .option("--no-check-tests", "Do not match instruments' required tests against the account's passed tests")
    .option("--table", "Human-readable table instead of a ticker list", false)
    .option("--json", "Full records as JSON", false)
    .option("--show-rejected", "Show rejected instruments and the reasons", false)
    .option("--out <path>", "Write the universe file for multi-broker (--universe-file)");

if (import.meta.url === `file://${process.argv[1]}`) {
    program.parse();
    const opts = program.opts();
    const { selected, rejected } = await selectUniverse({
        minHistoryDays: Number(opts.minHistoryDays),
        maxLotCost: Number(opts.maxLotCost),
        allowQual: Boolean(opts.allowQual),
        checkTests: opts.checkTests !== false,
    });

    if (opts.out) {
        // The format src/broker/tinkoff/multi-broker.js reads. It fills the instrument
        // cache itself on the first resolve — only the composition is written here.
        const { writeFile, mkdir } = await import("node:fs/promises");
        const { dirname } = await import("node:path");
        await mkdir(dirname(opts.out), { recursive: true });
        await writeFile(opts.out, JSON.stringify({
            tickers: selected.map((s) => s.ticker),
            selectedAt: new Date().toISOString(),
            filters: {
                minHistoryDays: Number(opts.minHistoryDays),
                maxLotCost: Number(opts.maxLotCost) || null,
                allowQual: Boolean(opts.allowQual),
                checkTests: opts.checkTests !== false,
            },
        }, null, 2));
        console.error(`[universe] ${selected.length} tickers → ${opts.out}`);
    }

    if (opts.json) {
        console.log(JSON.stringify({ selected, rejected }, null, 2));
    } else if (opts.table) {
        console.log(`Selected ${selected.length} of ${selected.length + rejected.length} instruments\n`);
        console.log("  Ticker    Lot  Price ₽   Lot ₽   dshort  History from");
        for (const s of selected) {
            console.log(
                `  ${s.ticker.padEnd(8)} ${String(s.lot).padStart(4)} `
                + `${(s.price ?? 0).toFixed(2).padStart(9)} ${(s.lotCost ?? 0).toFixed(0).padStart(7)} `
                + `${(s.dshortClient ?? 0).toFixed(3).padStart(7)}  ${s.first1minCandleDate ?? "—"}`,
            );
        }
    } else {
        console.log(selected.map((s) => s.ticker).join(","));
    }

    if (opts.showRejected) {
        const byReason = new Map();
        for (const r of rejected) {
            for (const reason of r.reasons) {
                if (!byReason.has(reason)) byReason.set(reason, []);
                byReason.get(reason).push(r.ticker);
            }
        }
        console.error(`\nRejected ${rejected.length}:`);
        for (const [reason, tickers] of [...byReason].sort((a, b) => b[1].length - a[1].length)) {
            console.error(`  ${reason} — ${tickers.length}: ${tickers.slice(0, 12).join(" ")}${tickers.length > 12 ? " …" : ""}`);
        }
    }
}
