# Architecture: broker ↔ engine ↔ strategy

The main principle: **the broker is the only thing that differs between backtest and live**. There
is a single, "blind" engine: it knows nothing about money, the run mode or the data source — it only
clocks the candle stream, checks SL/TP and the exit deadline centrally, and delegates execution to
the broker. The same strategy file runs unchanged on historical data and on a live account.

Working examples of both kinds of strategies are in [`examples/`](../examples/README.md).

## Layers

```
Strategy         logic + signals; clocked from outside
   │  this.execution → broker.exec        this.context → TemporalView
Engine           single, blind: init → for await broker.data.stream() → broker.finalize()
   │
TemporalView     clips history at "now" (look-ahead guard)
MarketDataCache  decorator over the broker's data source (history cache; live only)
Broker {data, exec, finalize}   ← all the live/backtest difference lives here
```

## Two kinds of runs: one instrument and a universe

A strategy works either on one instrument or on a universe — then every minute it compares
instruments with each other (a cross-sectional strategy). The engine is shared; the data source and
the executor differ.

| | One instrument | Universe |
|---|---|---|
| Backtest | `simulated/broker.js` + a single-ticker listing | `simulated/broker.js` + a multi-ticker bundle (`src/bundle.js`) |
| Live | `okx/broker.js` (crypto) | `tinkoff/multi-broker.js` (MOEX; one instrument is a one-ticker universe) |
| Candle stream | one instrument, by time | all instruments mixed, by time; a minute comes as a batch, its last candle is marked `isBatchEnd` |
| `this.data` | the instrument's history (in a backtest — the whole listing at once) | an empty sink: the universe's history does not fit in memory as objects |
| Current candle | `this.data.at(this.getDataIndex())` or the `next(candle)` argument | only the `next(candle)` argument; the candle has a `ticker` |
| Order | `this.buy/sell({ size?, sl?, tp?, exitDeadline? })` | `this.execution.sell({ ticker, budget?, size?, sl?, tp?, exitDeadline? })` |
| Default size | the executor: all the cash (× leverage), in whole lots | the strategy sets `budget` in money, the executor converts it to lots |
| Positions | one: `this.position` | several: `getPositions()`, `getPositionOf(ticker)`, `isBusy(ticker)` |

A cross-sectional decision is made only on the candle with `isBatchEnd`: before it, half of the
minute's instruments have not arrived. A thin instrument without trades in a minute is simply absent
from the batch — the same in backtest and live.

## Broker contract

A broker is a module exporting `options` (CLI flags) and `createBroker(config)`, which returns an
object:

```
broker = {
  data: {
    stream(): AsyncGenerator<candle>   // candle source; the end of the stream = stop signal
    getHistory({ ticker?, from, to, interval, until })   // history (up to until — look-ahead guard)
    getTradingSchedule({ ticker?, from, to })
    getSymbols?(), getInstrument?(ticker)                // universe and instrument (lot, exchange)
    requestStop?()                     // live: build the shutdown into the stream (on SIGTERM/SIGINT)
    candles?, series?                  // backtest: preloaded history
  },
  exec: {
    init?()                            // live: balance + reconciliation with the account
    setCurrentCandle(candle)
    getPosition()                      // position of the current instrument
    buy({...}) / sell({...}) / closePosition(reason?, ticker?)
    syncStrategyState(strategy)        // position and cash → the strategy
    drainOrders?()                     // live: wait for serialized execution
    checkStops?(candle)                // intrabar SL/TP (when intrabarStops)
    intrabarStops                      // stop mode flag
    // universe only:
    getPositions(), getPositionOf(ticker), getPendingTickers(),
    isBusy(ticker), isBlocked(ticker), getEquity()
  },
  finalize?()                          // backtest → report; live → teardown + summary
  needsCache?                          // live → wrap data in MarketDataCache
  metadata                             // instrument(s), interval, time zone
}
```

- `simulated/broker.js` — `stream()` serves the preloaded parquet: one listing or the bundle merged
  by time. `finalize()` builds `PerformanceMetrics` (return, drawdown, Sharpe, Calmar, win rate).
  Fills happen at the current candle's close or, with `--fill-next-open`, at the open of the next
  candle of the same instrument. `needsCache = false`.
- `tinkoff/multi-broker.js` — `stream()` turns the T-Invest push subscription to closed candles into
  a pull iterator; `init/drainOrders/checkStops` are real; `finalize()` closes the session.
  `needsCache = true`.
- `okx/broker.js` — single-instrument live trading of OKX perpetual swaps through ccxt.

## Strategy contract

Extends [`src/core/strategy.js`](../src/core/strategy.js) and implements `init()` and `next(candle)`:

```javascript
import { Strategy } from "../../core/strategy.js";   // from src/strategies/<NAME>/

export class MyStrategy extends Strategy {
    async init() { /* load a model, warm up history */ }
    next(candle) {
        if (/* entry */) this.sell({ sl: candle.close * 1.02 });
        if (/* exit */) this.closePosition();
    }
}
```

The strategy does **not** know the mode (backtest/live), the broker or the data source. History and
the schedule come only through `this.context`; execution goes through `this.execution`
(= `broker.exec`) or the `this.buy/sell/closePosition` sugar.

| Available to the strategy | What it is |
|---|---|
| `this.buy/sell({ size?, sl?, tp?, exitDeadline? })`, `this.closePosition()` | execution signals; without `size` the executor's default size is used; `exitDeadline` is an absolute exit deadline (epoch ms) checked by the engine |
| `this.execution.*` | the whole executor; for a universe — orders with `ticker`/`budget` and slot occupancy |
| `this.context.getCandles({ ticker?, from, to, interval })` | history clipped at the current moment |
| `this.context.getTradingSchedule({ ticker?, from, to })` | trading schedule |
| `this.context.getSymbols()`, `getInstrumentMetadata(ticker?)` | universe and instrument (lot, exchange) |
| `this.context.getNow()` | current time of the run |
| `this.logInfo(message)` | a log message regardless of `--verbose` |
| `this.data`, `this.getDataIndex()` | history of one instrument and the index of the current candle |
| `this.position`, `this.cash` | position of the current instrument and free cash (kept updated by the executor) |

**Strategy parameters are environment variables.** The CLI gives a strategy only its history and the
starting capital, so thresholds, windows and model paths are set through env variables prefixed with
the strategy name (`SMA_FAST=10`, `TGS_SLOTS=3`). Defaults live in the strategy's code.

**Look-ahead.** `context.getCandles` never returns a candle later than the current moment; a
higher-interval candle (hour, day) appears only after its period has closed. In a single-ticker
backtest `this.data` is the whole listing at once: never read it past `getDataIndex()`.

## The `engine.run()` loop, step by step

```
run({ broker, strategy, context, options }):
  strategy.execution = broker.exec
  strategy.setContext(context)
  if broker.exec.init        → await broker.exec.init()      // live: balance + reconciliation
  await strategy.init()

  for await (candle of broker.data.stream()):                // ← the only driver of time
      strategy.data.push(candle) (if new)
      context.setNow(candle.datetime)                         // move the visibility window
      strategy.setDataIndex(index)
      broker.exec.setCurrentCandle(candle)

      // SL/TP — centrally in the engine:
      if broker.exec.intrabarStops:
          broker.exec.checkStops(candle)        // by high/low; closes at the stop level
      else if evaluateStops(getPosition(), candle.close):
          broker.exec.closePosition(reason)     // by close (default)
      if evaluateTimeExit(getPosition(), candle.datetime):
          broker.exec.closePosition("time")     // exit deadline

      await strategy.next(candle)               // the strategy decides
      broker.exec.syncStrategyState(strategy)   // position and cash → the strategy
      if broker.exec.drainOrders → await broker.exec.drainOrders()   // live: wait for the API

  return broker.finalize?.()                    // backtest → report; live → summary
```

**The end of the stream is the universal stop signal.** In a backtest the data runs out by itself;
live, `requestStop()` (on SIGTERM/SIGINT) builds the shutdown into the stream. After the loop —
`broker.finalize()`. If the stream ends with an error (for example, the candle stream did not
recover), the process exits with code 1 and systemd starts it again.

## Data flow: backtest vs live

| | backtest (`simulated`) | live (`tinkoff`) |
|---|---|---|
| `stream()` source | preloaded parquet | gRPC subscription to closed candles |
| Minute assembly (universe) | bundle merged by time | wait for all instruments or 8 s after the minute's first candle (`--batch-grace-ms`) |
| History for the strategy | from the file, only the intervals stored in it | requests to the broker; settled ranges cached by `MarketDataCache` |
| Intervals | **no aggregation**: requesting an interval missing from the file is an error | the interval is requested natively from the broker |
| SL/TP | `evaluateStops` / `evaluateIntrabarStop` | the same + a market close on touch |
| Position size | all the cash adjusted for slippage and commission, in whole lots; in a universe — the strategy's `budget` | the same from the account's RUB balance; short leverage capped by the broker's risk rate |
| Data outages | — | catch-up of missed candles over REST, reconnects, silence watchdogs — [usage.md](usage.md#candle-stream-outages) |
| Shutdown | builds `PerformanceMetrics` | unsubscribe + session summary |

## Data

Candles are stored in Parquet ([`src/core/candle-parquet.js`](../src/core/candle-parquet.js)):

| Column | Type | What it is |
|---|---|---|
| `datetime` | timestamp, UTC | candle start |
| `open`, `high`, `low`, `close` | double | prices |
| `volume` | double | volume; in T-Invest listings it is **in lots**, turnover = close × volume × lot |
| `interval` | int, optional | candle length in minutes (1, 60, 1440); needed when a file holds several intervals |
| `ticker` | string, optional | the row's ticker; present only in a multi-ticker bundle |

Metadata sits under the `diviner.metadata` key (JSON). A single-ticker listing carries `ticker`,
`instrument` (lot, figi, exchange), `intervalMinutes`, `intervals`; a bundle carries `tickers` and
`instruments` (ticker → instrument). A bundle is read as columns
([`candle-series.js`](../src/core/candle-series.js)): a year of the universe does not fit the V8 heap
as objects.

**Listings are only appended to.** A fresh period is added to the existing file (`src/append.js`)
instead of replacing it: a listing that became shorter silently shifts the backtest window, and the
results stop being comparable.

## Adding a broker or a strategy

- **Broker**: create `src/broker/<name>/broker.js` with `export const options` and
  `export async function createBroker(config)` returning `{data, exec, finalize?}`. The CLI needs no
  changes — the broker path is the first argument of `diviner`.
- **Strategy**: start from a copy of an example in [`examples/strategies/`](../examples/strategies/).
  Production strategies live in `src/strategies/<NAME>/<NAME>.js` — a separate repository, not part of
  the engine's repository. Helper code goes to `<NAME>/src/`, training to `<NAME>/scripts/`, models
  next to the strategy file (not in the engine's git).
