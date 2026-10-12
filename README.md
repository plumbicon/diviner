# Diviner

**Diviner** is an ecosystem for backtesting and live trading of trading strategies: data download,
conversion to Parquet, backtests and real-time trading through exchange brokers — the Tinkoff
Investments API (MOEX) and OKX (crypto).

The architecture rests on one principle: **the broker is the only thing that differs between
backtest and live**. There is a single, blind engine — it clocks the candle stream, orchestrates
SL/TP centrally and passes signals to the broker, knowing nothing about money, mode or the data
source. The same strategy file runs unchanged on historical Parquet data and on a live account.

## Quick start

No token and no data — on synthetic candles ([`examples/`](examples/README.md)):

```bash
npm install
node examples/make-data.mjs --out work/examples/demo.parquet --tickers DEMO
node src/diviner.js src/broker/simulated/broker.js work/examples/demo.parquet \
  --strategy examples/strategies/sma-cross/sma-cross.js --balance 10000
```

With MOEX data and the broker:

```bash
export T_INVEST_TOKEN=<your-token>

# backtest every ticker (in parallel, worker_threads)
node scripts/backtest.mjs --strategy <NAME> --year 2026 --leverage 4 --intrabar-stops

# backtest one instrument
diviner src/broker/simulated/broker.js data/tinkoff/SBER_2024_1m.parquet \
  --strategy <path-to-strategy> --balance 10000 --commission 0.0005

# live (sandbox) on a universe of instruments; a single instrument is --tickers SBER
diviner src/broker/tinkoff/multi-broker.js --strategy <path-to-strategy> \
  --sandbox --account <id> --universe-file data/universe.json --intrabar-stops

# download MOEX candles → Parquet
T_INVEST_TOKEN=<token> node src/broker/tinkoff/fetch.js --security SBER --from-date 2024-01-01 \
  --till-date 2024-12-31 --interval 1 --parquet > data/tinkoff/SBER_2024_1m.parquet

# select shortable liquid shares through the API (ticker list on stdout)
T_INVEST_TOKEN=<token> node src/universe.js --table

# append a fresh period to an existing listing (growth only, never shortening)
node src/append.js --into data/tinkoff/ALRS_2026_1m.parquet /tmp/ALRS_fresh.parquet

# build a universe into one multi-ticker Parquet (for cross-sectional strategies)
node src/bundle.js --out data/tinkoff/CORE62_2026_1m.parquet \
  --tickers ALRS,ROSN,SBER --from 2026-01-01 --to 2026-06-08 data/tinkoff/*_2026_1m.parquet
```

### Universe composition

`src/universe.js` asks the broker for every share and keeps the tradeable ones by instrument flags:
`shortEnabledFlag` (shorting allowed), `liquidityFlag` (liquidity), `apiTradeAvailableFlag` and
`sellAvailableFlag`, minus OTC, blocked and qualified-investor-only instruments, plus a minimum
depth of minute history (`--min-history-days`). Lot cost is computed separately — on a 10,000 ₽
account with four slots an instrument whose lot costs more than 2,500 ₽ cannot physically be bought
(`--max-lot-cost`).

The point is that the universe updates itself: an instrument whose short was disabled drops out of
the list on the next run instead of living in a hard-coded constant until someone notices.
`--show-rejected` shows who was rejected and why — without it an instrument that unexpectedly
disappears turns debugging into guesswork.

### Multi-ticker datasets

A cross-sectional strategy needs access to any instrument of the universe, not only the one it was
started on. `src/bundle.js` merges single-ticker listings into one Parquet, tagging every row with
its ticker; the sources are only read, and an existing output is not overwritten without `--force`.

`loadDataset` reads such a file **as columns** (`src/core/candle-series.js`): a candle object costs
~259 bytes of V8 heap, so a year of the universe (~40M candles) does not fit the heap limit as
objects at all. Columns take 52 bytes per candle, live outside the heap, and an object is built only
on `at(i)`. Measured on core62 for January–June 2026: 7.5M candles — 370 MB as columns against
1.8 GB as objects, loaded in 6.5 s.

The dataset provides `bySymbol` (ticker → interval → series), `symbols`, `instruments`
(lot/exchange/figi) and `mergeStream(minutes)` — a chronological stream over the whole universe by
merging, without copying data. Single-ticker listings are read the old way, as object arrays: their
behaviour does not change.

The series interface is a subset of `Array` (`length`, `at(i)`, `slice()`, the iterator), so a
consumer does not care whether it got an array or columns. The only requirement: use `at(i)`, not
`[i]`.

The full CLI reference (every backtest/live option) is in [`devs/usage.md`](devs/usage.md).

## Tests

```bash
npm test
```

## Project layout

```
diviner/
├── diviner              sh wrapper → node src/diviner.js
├── scripts/             backtest.mjs (batch backtest) · convert.mjs · merge-okx-orderbook.mjs
├── src/
│   ├── diviner.js        entry point: diviner <broker-path> [options]
│   ├── universe.js       universe selection via the API · bundle.js — bundle · append.js — listing append
│   ├── broker/           simulated (backtest) · tinkoff (live MOEX) · okx (crypto) · common
│   ├── core/             mode-blind core: engine, stops, portfolio, strategy, data, metrics
│   └── strategies/       strategies — a separate repository, not part of the engine's git
├── examples/             example strategies and a synthetic candle generator
├── data/                 Parquet candles (not in git): tinkoff/ (MOEX) · okx/ (crypto)
├── work/                 measurement artifacts (not in git)
└── devs/                 developer documentation
```

## Developer documentation → [`devs/`](devs/)

- [`devs/structure.md`](devs/structure.md) — architecture: how the broker, the engine and the strategy interact in code.
- [`devs/usage.md`](devs/usage.md) — CLI reference: backtest / live / fetch / convert / account utilities.
- [`examples/`](examples/README.md) — two example strategies and synthetic data: where to start your own strategy.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — development rules: style, tests, documentation, data.
