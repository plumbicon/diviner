# Examples

Two small strategies and a synthetic candle generator: a backtest runs in a minute, without a broker
token and without downloaded listings. `examples.test.js` runs both strategies, so an example that
drifts away from the engine breaks `npm test`.

## Single-ticker strategy — `strategies/sma-cross`

Long on a moving average crossover, exit on the opposite cross or by the stop.

```bash
node examples/make-data.mjs --out work/examples/demo.parquet --tickers DEMO
```
```bash
node src/diviner.js src/broker/simulated/broker.js work/examples/demo.parquet \
  --strategy examples/strategies/sma-cross/sma-cross.js --balance 10000
```

What to look at in the code:
- history is `this.data`, the current candle is `this.data.at(this.getDataIndex())`. In a backtest
  `this.data` holds the whole listing, so only read up to the current index;
- entry is `this.buy({ sl })`, exit is `this.closePosition()`. The engine checks the stop;
- parameters are environment variables (`SMA_FAST=10 node src/diviner.js …`).

## Cross-sectional strategy — `strategies/top-gainer-short`

Once a day at 11:00 Moscow time, short the two instruments that rose the most since the open; exit by
the stop or by the deadline at 18:30.

```bash
node examples/make-data.mjs --out work/examples/universe.parquet --tickers AAA,BBB,CCC,DDD,EEE
```
```bash
node src/diviner.js src/broker/simulated/broker.js work/examples/universe.parquet \
  --strategy examples/strategies/top-gainer-short/top-gainer-short.js \
  --balance 100000 --fill-next-open --intrabar-stops
```

What to look at in the code:
- the candle comes as the `next(candle)` argument with a `ticker` field; a multi-ticker run has no
  history of its own, it is read through `this.context.getCandles({ ticker, … })`;
- a minute is released as a batch over all instruments, its last candle is marked `isBatchEnd`. The
  "which instrument to pick" decision is made only on it — before it, half of the instruments have
  not arrived;
- an order is addressed to an instrument: `this.execution.sell({ ticker, budget, sl, exitDeadline })`.
  The executor converts `budget` into shares — with the lot and the fill price;
- `exitDeadline` is an absolute exit time (epoch ms), checked by the engine.

## Data generator — `make-data.mjs`

| Option | What it does | Default |
|---|---|---|
| `--out <path>` | where to write the parquet | — |
| `--tickers <list>` | comma-separated tickers; one gives a listing, several a bundle | `DEMO` |
| `--days <n>` | trading days (weekdays, 10:00–18:39 Moscow) | `20` |
| `--seed <n>` | random walk seed: the same parameters give the same file | `1` |
| `--from <date>` | first calendar day | `2026-01-05` |

The first instrument prints a candle every minute, the others in 85% of minutes, like thin names on
the exchange. The file format is the same as real listings (`src/broker/tinkoff/fetch.js`) and
bundles (`src/bundle.js`) — see "Data" in [`devs/structure.md`](../devs/structure.md).

It is convenient to start your own strategy from a copy of one of the examples. Production strategies
live in `src/strategies/<NAME>/<NAME>.js` — that directory is not part of the engine repository.
