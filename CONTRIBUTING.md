# Contributing

How the engine is built — [`devs/structure.md`](devs/structure.md); how to use it —
[`devs/usage.md`](devs/usage.md); where to start a strategy — [`examples/`](examples/README.md).

## Language

**Everything in the project is in English:** code comments, log messages, error texts, CLI option
descriptions, test names, documentation and commit messages. The only exception is data — for
example, regular expressions that match the broker's Russian replies. `src/style.test.js` fails
`npm test` on Cyrillic anywhere in the code outside such regex literals.

## Where things live

- `src/core/` — the mode-blind core: engine, stops, portfolio, data, metrics. The core knows neither
  brokers nor the run mode. `src/core/engine.js` is the shared contract of every broker and strategy;
  change it only after a discussion.
- `src/broker/<name>/` — a broker: `broker.js` with `options` and `createBroker()`, plus its clients
  and data loaders. All the difference between backtest and live lives here.
- `src/*.js` — standalone commands (`bundle.js`, `append.js`); broker-specific tools live with the broker
  (`src/broker/tinkoff/fetch.js`, `universe.js`); `scripts/` — helper scripts over the project.
- `examples/` — example strategies and synthetic data.
- `src/strategies/` — strategies, a separate repository. Neither strategy code, nor their parameters,
  nor measurement results get into the engine repository — including comments, documentation and
  commit messages.
- One-off analysis, reports and automation over the project stay outside the repository; measurement
  artifacts go to `work/` (not in git).

## Code

- Node.js ≥ 18, ES modules, `async`/`await`.
- 4-space indentation, double-quoted strings, no tabs and no trailing spaces. `.editorconfig`
  configures the editor, `src/style.test.js` checks indentation and whitespace in `npm test`. Wrapped
  parameter lists also follow the 4-space grid, without aligning under the parenthesis.
- JSDoc on public functions and classes.
- A comment explains **why**: which constraint, which incident, why not the obvious option. What the
  code does is visible from the code.
- Errors are never swallowed silently: either a clear log message and a deliberate continuation, or
  an exception. Silently computing a more profitable result is worse than failing.
- A new dependency only when there is no way around it. `package-lock.json` is committed.
- Secrets (broker tokens) only through environment variables, never in code or logs.

## Tests

- `npm test` — the built-in `node:test`; a test sits next to its module: `foo.js` → `foo.test.js`.
- A bug fix comes with a test that fails without the fix.
- Live code (`src/broker/tinkoff/`) is tested on failure scenarios: a dropped connection, a hung
  answer, a broker rejection. The network is replaced with stubs in tests.
- The example strategies run through the CLI in `examples/examples.test.js` — an example that drifts
  away from the engine breaks `npm test`.

## Documentation

- A new command or option goes into [`README.md`](README.md) and [`devs/usage.md`](devs/usage.md):
  what it does, its parameters, a usage example.
- A change of the broker or strategy contract updates [`devs/structure.md`](devs/structure.md) in the
  same commit.

## Data

- Candles in `data/` (not in git) are **only appended to**: a fresh period is added to the existing
  listing (`src/append.js`) instead of replacing it. A shortened listing silently shifts the backtest
  window, and measurements stop being comparable.
- Before overwriting any file in `data/`, compare the coverage of the old and the new one: if the new
  one is shorter, it is a mistake, not an update.
- The Parquet format changes only with backward compatibility: files already downloaded must stay
  readable.

## Commits

- The message is in English. The first line is `<area>: what changed` (`metrics: …`, `tinkoff: …`);
  the body explains why.
- One commit, one topic: a fix, a cleanup and a reformatting go separately.
- Changes to live brokers are deployed outside the trading session.
