// OKX USDT-settled perp symbol lists, shared by fetch-batch.js and
// orderbook-logger.js. Pure data/helpers only — no side effects on import
// (unlike the CLI scripts, which run their main() unconditionally on load).

// 75 OKX USDT-settled perps with listing date before 2025-01-01,
// sorted by 24 h USD volume (descending). First 50 = training set, last 25 = validation.
export const TRAIN_SYMBOLS = [
    "ETH/USDT:USDT",  "BTC/USDT:USDT",  "SOL/USDT:USDT",  "WLD/USDT:USDT",
    "DOGE/USDT:USDT", "XRP/USDT:USDT",  "UNI/USDT:USDT",  "JTO/USDT:USDT",
    "XLM/USDT:USDT",  "NEAR/USDT:USDT", "PEPE/USDT:USDT", "BNB/USDT:USDT",
    "ADA/USDT:USDT",  "BCH/USDT:USDT",  "SUI/USDT:USDT",  "TAO/USDT:USDT",
    "ONDO/USDT:USDT", "FIL/USDT:USDT",  "AAVE/USDT:USDT", "LINK/USDT:USDT",
    "LTC/USDT:USDT",  "AVAX/USDT:USDT", "DOT/USDT:USDT",  "INJ/USDT:USDT",
    "PENGU/USDT:USDT","CHZ/USDT:USDT",  "ICP/USDT:USDT",  "ORDI/USDT:USDT",
    "HMSTR/USDT:USDT","CRV/USDT:USDT",  "OP/USDT:USDT",   "APT/USDT:USDT",
    "SHIB/USDT:USDT", "ZRO/USDT:USDT",  "GRASS/USDT:USDT","FARTCOIN/USDT:USDT",
    "TRX/USDT:USDT",  "TIA/USDT:USDT",  "ARB/USDT:USDT",  "HBAR/USDT:USDT",
    "VIRTUAL/USDT:USDT","ETC/USDT:USDT","RENDER/USDT:USDT","GALA/USDT:USDT",
    "MEME/USDT:USDT", "MOVE/USDT:USDT", "JUP/USDT:USDT",  "WIF/USDT:USDT",
    "STRK/USDT:USDT", "ETHFI/USDT:USDT",
];

export const VALID_SYMBOLS = [
    "BONK/USDT:USDT", "SUSHI/USDT:USDT","NOT/USDT:USDT",  "LDO/USDT:USDT",
    "ALGO/USDT:USDT", "ATOM/USDT:USDT", "DYDX/USDT:USDT", "AXS/USDT:USDT",
    "ENJ/USDT:USDT",  "UMA/USDT:USDT",  "EIGEN/USDT:USDT","AR/USDT:USDT",
    "POL/USDT:USDT",  "CFX/USDT:USDT",  "MOODENG/USDT:USDT","W/USDT:USDT",
    "PYTH/USDT:USDT", "CORE/USDT:USDT", "TRB/USDT:USDT",  "ATH/USDT:USDT",
    "ARKM/USDT:USDT", "ENS/USDT:USDT",  "PEOPLE/USDT:USDT","PNUT/USDT:USDT",
    "EGLD/USDT:USDT",
];

export const ALL_SYMBOLS = [...TRAIN_SYMBOLS, ...VALID_SYMBOLS];

// OKX lists many USDT-margined perps that are NOT crypto — tokenized equities
// (AAPL, NVDA, …) and commodities/metals (XAU, CL, …) — quoted and settled in
// USDT exactly like crypto perps. Nothing in the generic market metadata
// (type/linear/settle) distinguishes them, but OKX tags each instrument's
// asset class in `info.instCategory`: "1" = crypto, "3" = equities,
// "4" = commodities. Ranking by live volume without this filter lets high-
// volume gold/oil/stock perps crowd out the crypto pairs.
export const CRYPTO_INST_CATEGORY = "1";

/**
 * Convert a unified ccxt swap symbol into an OKX instId.
 * @param {string} symbol - e.g. "BTC/USDT:USDT".
 * @returns {string} e.g. "BTC-USDT-SWAP".
 */
export function symbolToInstId(symbol) {
    const [base, rest] = symbol.split("/");
    return `${base}-${rest.split(":")[0]}-SWAP`;
}

/**
 * Rank USDT-settled perpetual swaps by live 24 h quote volume (descending) and
 * return the most liquid subset as unified ccxt symbols. Pure: operates on
 * already-fetched ccxt markets + tickers, no I/O — the caller does the network
 * calls (loadMarkets/fetchTickers) and passes the results in.
 *
 * Only linear USDT/USDT perps are considered, so the result is always a set of
 * `?/USDT:USDT` symbols — never coin-margined, USDC-settled, spot, or dated
 * futures. Filtering to the most liquid names drops the thin-book noise (torn
 * spreads, stale levels) that dominates illiquid pairs; note it does NOT remove
 * the common crypto-vs-dollar drift shared by every USDT pair.
 *
 * @param {object} markets - ccxt markets map (exchange.markets).
 * @param {object} tickers - ccxt tickers map (exchange.fetchTickers() result).
 * @param {object} [opts]
 * @param {number} [opts.top] - Keep only the top-N by volume (after the threshold).
 * @param {number} [opts.minQuoteVolume=0] - Drop pairs below this 24 h quote volume (USDT notional).
 * @param {boolean} [opts.includeNonCrypto=false] - Include tokenized equity/commodity
 *   perps (AAPL, XAU, CL, …). Off by default so stocks/gold/oil don't crowd out crypto.
 * @returns {Array<string>} Unified ccxt symbols, most liquid first.
 */
export function rankLiquidUsdtPerps(markets, tickers, { top, minQuoteVolume = 0, includeNonCrypto = false } = {}) {
    const rows = [];
    for (const market of Object.values(markets || {})) {
        if (!market || !market.swap || market.active === false) continue;
        // Linear USDT-margined perp: quote and settle are both USDT.
        if (market.quote !== "USDT" || market.settle !== "USDT") continue;
        // Crypto only (instCategory "1"); drop tokenized equities/commodities.
        if (!includeNonCrypto && market.info?.instCategory !== CRYPTO_INST_CATEGORY) continue;
        const ticker = tickers?.[market.symbol];
        if (!ticker) continue;
        // Prefer quoteVolume (USDT notional); fall back to baseVolume × last.
        let vol = Number(ticker.quoteVolume);
        if (!Number.isFinite(vol)) {
            vol = Number(ticker.baseVolume) * Number(ticker.last);
        }
        if (!Number.isFinite(vol) || vol < minQuoteVolume) continue;
        rows.push({ symbol: market.symbol, vol });
    }
    rows.sort((a, b) => b.vol - a.vol);
    const limited = Number.isFinite(top) && top > 0 ? rows.slice(0, top) : rows;
    return limited.map((r) => r.symbol);
}
