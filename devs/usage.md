# CLI usage

Architecture — [structure.md](structure.md).

## Installation

```bash
npm install
export T_INVEST_TOKEN=<your-token>   # for commands that call the T-Invest API
```

## Single entry point

```bash
diviner <path-to-broker> --strategy <path> [broker options]
```

`<path-to-broker>` is a required positional argument, the path to the broker file (just as
`--strategy` is the path to the strategy). Broker options are validated against its
`export const options`, so adding a broker means adding a file without touching the CLI.

Data download and conversion to Parquet are not part of `diviner` — they are separate scripts
(see [Data download](#data-download) and [Conversion](#conversion) below).

**A first run without a token or data** — see [`examples/`](../examples/README.md): a synthetic candle
generator and two example strategies, a single-ticker and a cross-sectional one.

## Backtest of one instrument (`simulated`)

```bash
diviner src/broker/simulated/broker.js data/tinkoff/SBER_2024_1m.parquet \
  --strategy <path-to-strategy> --balance 10000 --commission 0.0005
```

| Option | Description | Default |
|--------|-------------|---------|
| `--strategy` | Path to the strategy file | — |
| `--balance` | Starting virtual balance | `10000` |
| `--commission` | Commission | `0.0005` |
| `--leverage` | Short leverage: scales the position size and the margin | `1` |
| `--fill-next-open` | Fill at the next open of the same instrument instead of the current close | off |
| `--intrabar-stops` | SL/TP by high/low, filled at the level | off |
| `--model-liquidation` | gap-aware fills + margin call (with leverage > 1) | off |
| `--risk-rates <file>` | Broker risk rates per instrument: an instrument's leverage is at most `1/dshort` (universe only) | — |
| `--verbose` | Include `trade_log` in the report | off |
| `[source]` | Positional argument — Parquet (or stdin) | — |

Data can be piped: `cat data/tinkoff/SBER_2024_1m.parquet | diviner src/broker/simulated/broker.js --strategy …`.
The report is printed to stdout as JSON (`backtest_parameters`, `performance_metrics`, `trade_log`).

**Default position size:** all the cash, in whole lots —
`floor(cash / (price·1.01·(1/leverage + commission)·lot))·lot`, where 1% is the slippage reserve.
The lot size comes from the parquet metadata, so the backtest sizes positions the way the live
broker does.

**Drawdown** (`maxDrawdownPct`) is measured from the equity peak before the drawdown. Before
2026-10-11 it was divided by the maximum of the whole run and was understated on a rising curve —
drawdown and Calmar of older reports are not comparable with new ones.

## Backtest of a universe (multi-ticker bundle)

A cross-sectional strategy needs one file with the whole universe. `src/bundle.js` builds it from
single-ticker listings:

```bash
node src/bundle.js --out data/tinkoff/UNIVERSE_2026_1m.parquet \
  --tickers ALRS,ROSN,SBER --from 2026-01-01 data/tinkoff/*_2026_1m.parquet
```
```bash
diviner src/broker/simulated/broker.js data/tinkoff/UNIVERSE_2026_1m.parquet \
  --strategy <path-to-strategy> --balance 100000 --fill-next-open --intrabar-stops
```

The options are the same as for a single-ticker backtest. Differences:
- the stream carries every instrument by time, a minute comes as a batch, its last candle is `isBatchEnd`;
- the strategy sets the position size: `this.execution.sell({ ticker, budget, … })`;
- equity is marked once a minute (at the end of the batch) at the prices of all open positions;
- `--risk-rates` caps the short leverage of each instrument by the broker's risk rate.

## Backtest of every ticker (in parallel)

```bash
node scripts/backtest.mjs --strategy <NAME> --year 2026 --leverage 4 --intrabar-stops [--workers 8] [--top 25]
```

Runs every `data/tinkoff/*_<year>_1m.parquet` on a `worker_threads` pool (override with
`BACKTEST_DATA_DIR`), prints a ranking by return (+ MaxDD/Sharpe/Calmar/WinRate) and aggregates.
Resolves the strategy as `src/strategies/<name>/<name>.js`.

## Live (`tinkoff/multi-broker.js`)

The only live path on MOEX: one candle subscription for the whole universe, one strategy, one
account. A single instrument is a one-ticker universe (`--tickers SBER`).

```bash
T_INVEST_TOKEN=<token> diviner src/broker/tinkoff/multi-broker.js \
  --strategy <path-to-strategy> --account <id> \
  --universe-file data/universe.json --intrabar-stops --log logs/bot.log
```

| Option | Description | Default |
|--------|-------------|---------|
| `--tickers <list>` | The universe as a comma-separated list | — |
| `--universe-file <path>` | JSON with the universe and instrument cache (made by `src/broker/tinkoff/universe.js --out`) | — |
| `--account <id>` | Account ID | — |
| `--sandbox`, `--dry-run` | Sandbox / no orders sent | off |
| `--interval <minutes>` | Candle interval | `1` |
| `--batch-grace-ms <ms>` | How long to wait for late instruments of a minute before deciding | `8000` |
| `--stall-timeout <minutes>` | Silence threshold of the whole stream during a session (0 disables), see below | `30` |
| `--intrabar-stops` | SL/TP by the high/low of the arrived candle | off |
| `--leverage <n>` | Leverage; > 1 sends `confirmMarginTrade` | `1` |
| `--close-on-exit` | Close all positions on shutdown | off |
| `--order-retries`, `--order-tag` | Order retries, idempotency key label | `2`, `div` |
| `--state-dir <path>` | Directory of position state files | `.diviner-state` |
| `--print-balance`, `--print-history`, `--history-from` | Account utilities, see below | — |
| `--log <path>` | Duplicate output to a file | — |

The universe file is `{"tickers": [...], "instruments": {...}}`; instrument resolution is cached in
the same file (resolving a hundred tickers through the API takes ~40 s). A minute is handed to the
strategy once every instrument has arrived or `--batch-grace-ms` has passed since the minute's first
candle: a thin instrument without trades in a minute prints no candle, and waiting for it is
pointless. An instrument whose order the broker rejected as unavailable (an instrument test is
required, no shorting) is blocked until restart; on insufficient margin — until the cash grows.

Modes: `--sandbox`, `--dry-run`, a real account (no flags). On SIGINT/SIGTERM the engine leaves its
loop and the broker closes the session (unsubscribe, summary, positions closed with
`--close-on-exit`). After a restart open positions are picked up from the account, SL/TP levels from
the state files in `--state-dir`, and the strategy catches up the holding history and the current
session's minute candles.

> ⚠️ Without `--verbose` the start-up output (connection, balance, subscription) is printed
> unconditionally, while the per-minute candle heartbeat is printed only with `--verbose`.

> ⚠️ The maximum short leverage is capped by the broker (≈ `1/dShort`, per instrument): ~4.5–5× for
> liquid MOEX names, less for volatile ones. The broker rejects an order above the limit ("Not
> enough balance"), so the executor trims the size to the allowed one beforehand.

### Candle stream outages

A connection can die silently: no data and no error. The defences are in `TinkoffClient`
(`candle-stream.js`) and in the data source's silence watchdog:

| Level | What it catches | Reaction |
|-------|-----------------|----------|
| gRPC keepalive (PING every 60 s, answer within 20 s) | a half-open TCP connection | the connection is dropped, the ordinary reconnect follows |
| Broker pings in the stream (every 120 s per the docs, ~60 s in practice, when nothing else is sent) | the stream is alive at the socket level but delivers nothing for more than 5 min | the call is abandoned, the reconnect goes into a new one |
| Subscription timeout (30 s) | a subscription waiting for an answer that will never come | the call is abandoned, retried with growing pauses |
| Silence watchdog, `--stall-timeout` (30 min without live candles during a session) | everything else | resubscription in a new call; if the silence threshold passes again after it, the stream ends with an error, the process exits with code 1 and systemd starts a new one |

The silence watchdog ignores REST catch-up candles: they arrive even with a dead subscription. Client
options: `keepaliveTimeMs`, `keepaliveTimeoutMs`, `streamSilenceMs`, `subscribeTimeoutMs`.

### Order identification

The idempotency key (`order_id`) is built deterministically from the label/ticker/action/time and
encoded as a UUIDv5 (the sandbox requires the UUID format). Seed format:
`<tag>-<ticker>-<O|C><B|S>-<yyMMddHHmmss>`. It is not a "trade comment" — for rich metadata keep your
own log keyed by it.

### Account utilities (no strategy)

```bash
# Inspection — works on a real account (default) and in the sandbox (with --sandbox):
diviner src/broker/tinkoff/multi-broker.js --account <id> --print-balance
diviner src/broker/tinkoff/multi-broker.js --account <id> --print-history --history-from 2026-06-01

# Test account management — sandbox only (requires --sandbox):
diviner src/broker/tinkoff/multi-broker.js --sandbox --create-account [--increase-balance 10000]
diviner src/broker/tinkoff/multi-broker.js --sandbox --list-sandboxes
```

Inspection (`--print-balance`, `--print-history`) targets the **real** account by default; with
`--sandbox`, the sandbox. Account management (`--list-sandboxes` · `--create-account` ·
`--remove-account` · `--reset-positions` · `--increase-balance <amount>`) exists only in the sandbox
API and **requires** `--sandbox`.

## Data download

Not part of `diviner` — a standalone script that belongs to the broker:

```bash
T_INVEST_TOKEN=<token> node src/broker/tinkoff/fetch.js --security SBER --from-date 2024-01-01 \
  --till-date 2024-12-31 --interval 1 --parquet > data/tinkoff/SBER_2024_1m.parquet
```

| Option | Description | Default |
|--------|-------------|---------|
| `--security` / `--ticker` | Ticker | `SBER` |
| `--class-code` | Class code | `TQBR` |
| `--from-date` / `--till-date` | Range (YYYY-MM-DD, Moscow) | — / today |
| `--interval` | 1=1m, 5=5m, 15=15m, 60=1h, 240=4h, 24=1d, … | `24` |
| `--parquet` | Write Parquet to stdout | off |

Crypto (OKX): `src/broker/okx/fetch.js`, `fetch-batch.js`, `fetch-metrics.js`.

A download returns only the requested range, so a fresh period is **appended** to the existing listing
instead of replacing it: a merge by `datetime` + `interval` with deduplication (fresh candles win), and
a result shorter than the original is refused.

```bash
node src/append.js --into data/tinkoff/SBER_2026_1m.parquet [--dry-run] /tmp/SBER_fresh.parquet
```

## Instrument selection (`tinkoff/universe.js`)

Builds the instrument list for `multi-broker.js` (`--universe-file`) from the broker's own instrument
flags, so the list follows the broker instead of living in a hard-coded constant: an instrument that
loses a required flag drops out on the next run.

```bash
T_INVEST_TOKEN=<token> node src/broker/tinkoff/universe.js --table --show-rejected
T_INVEST_TOKEN=<token> node src/broker/tinkoff/universe.js --out data/universe.json
```

An instrument is kept when it carries the exchange's liquidity mark (`liquidityFlag`), can be traded and
sold through the API (`apiTradeAvailableFlag`, `sellAvailableFlag`), is not OTC, blocked or
qualified-investor-only, trades in rubles on MOEX and has enough minute history. The tests the broker
requires for the asset are matched against the tests the account has passed — otherwise a missing test
shows up only as a rejected order.

| Option | Description | Default |
|--------|-------------|---------|
| `--require-short` | Keep only instruments the broker allows to short (`shortEnabledFlag`) | off |
| `--min-history-days <n>` | Minimum depth of minute history, days | `400` |
| `--max-lot-cost <rub>` | Drop instruments whose lot costs more: a lot above the budget of one position cannot be bought | `0` (off) |
| `--allow-qual` | Keep qualified-investor instruments | off |
| `--no-check-tests` | Do not match required tests against the account | — |
| `--table`, `--json` | A table or full records instead of a ticker list | off |
| `--show-rejected` | Who was rejected and why | off |
| `--out <path>` | Write the universe file for `multi-broker.js` | — |

## OKX order book logging

Neither the T-API nor OKX serves L2 order book history — only the current snapshot and (for OKX)
~90 days of trade history. The only way to get order book data for scalping strategies is to record
it yourself, forward in time, through the public WebSocket (no credentials needed — it is public
market data).

```bash
node src/broker/okx/orderbook-logger.js \
  --symbols BTC/USDT:USDT,ETH/USDT:USDT --depth 20 --interval-ms 1000 \
  --rotate-minutes 30 --out-dir data/okx-orderbook
```

| Option | Description | Default |
|--------|-------------|---------|
| `--symbols` | Comma-separated ccxt symbols | top 50 liquid (`TRAIN_SYMBOLS` from `fetch-batch.js`) |
| `--depth` | Levels per side | `20` |
| `--interval-ms` | Snapshot period | `1000` |
| `--rotate-minutes` | How often to close the current file and open a new one | `30` |
| `--out-dir` | Where to write `.parquet` | `data/okx-orderbook` |

While being written, a file is named `ob_okx_<timestamp>.parquet.inprogress` and is renamed to
`ob_okx_<timestamp>.parquet` only after a clean close (rotation or Ctrl-C/SIGTERM) — **only files
without the `.inprogress` suffix are safe to copy from the server**. Rotation bounds the loss on a
hard kill (SIGKILL/OOM/power loss) to a `--rotate-minutes` window.

The routine on a disk-constrained server: start the logger → periodically pull the finished
(`.parquet`, not `.inprogress`) files with `rsync`/`scp` and delete them from the server to free
space → after a full stop (Ctrl-C) the next start opens a new file with a new timestamp, without
colliding with the previous ones.

Merging the downloaded chunks into one archive — on the local machine:

```bash
node scripts/merge-okx-orderbook.mjs data/okx-orderbook-chunks/*.parquet \
  --output data/okx-orderbook-2026-Q3.parquet
```

The chunks must share the same `--depth`; the script streams row by row (does not load everything
into memory) and relies on the chunk names (`ob_okx_<ISO-timestamp>...`) already sorting
chronologically.

## Conversion

Not part of `diviner` — a standalone script:

```bash
node scripts/convert.mjs --input-json sber.json --output-parquet sber.parquet
```
