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

# backtest one instrument
diviner src/broker/simulated/broker.js data/tinkoff/SBER_2024_1m.parquet \
  --strategy <path-to-strategy> --balance 10000 --commission 0.0005

# backtest every ticker (in parallel, worker_threads)
node scripts/backtest.mjs --strategy <NAME> --year 2026 --intrabar-stops

# live (sandbox) on a set of instruments; a single instrument is --tickers SBER
diviner src/broker/tinkoff/multi-broker.js --strategy <path-to-strategy> \
  --sandbox --account <id> --universe-file data/universe.json --intrabar-stops
```

A strategy works on one instrument or on a set of them at once (a universe): in a backtest the engine
reads a multi-ticker Parquet file, live it subscribes to every instrument of the list. How this looks
from inside a strategy is in [`devs/structure.md`](devs/structure.md).

## Data

The engine reads candles from Parquet files in `data/` (not in git). The tools that prepare them are
not part of the engine; each is described in [`devs/usage.md`](devs/usage.md):

| Tool | What it does |
|---|---|
| `src/broker/tinkoff/fetch.js` | Download MOEX candles into Parquet |
| `src/append.js` | Append a fresh period to a listing (it only grows, never shrinks) |
| `src/bundle.js` | Merge single-ticker listings into one multi-ticker file |
| `src/broker/tinkoff/universe.js` | Build the instrument list for live trading from the broker's instrument flags |
| `src/broker/okx/fetch.js` | Download OKX perpetual-swap candles |

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
│   ├── bundle.js         multi-ticker bundle · append.js — listing append
│   ├── broker/           simulated (backtest) · tinkoff (live MOEX, fetch, universe) · okx (crypto) · common
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
