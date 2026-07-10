# Diviner

**Diviner** — экосистема для бэктестинга и live-трейдинга торговых стратегий на MOEX (и крипты
через OKX): загрузка данных, конвертация в Parquet, бэктесты и торговля в реальном времени
через Tinkoff Investments API.

Архитектура построена вокруг одного принципа: **брокер — единственный носитель различия между
backtest и live**. Движок один и слеп — он тактирует поток свечей, централизованно оркеструет
SL/TP и передаёт сигналы брокеру, ничего не зная про деньги, режим и источник данных. Один и тот
же файл стратегии без изменений гоняется и на исторических Parquet-данных, и на боевом счёте.

## Быстрый старт

```bash
npm install
export T_INVEST_TOKEN=<your-token>

# бэктест всех тикеров (параллельно, worker_threads)
node scripts/backtest.mjs --strategy <ИМЯ> --year 2026 --leverage 4 --intrabar-stops

# бэктест одного инструмента
diviner --broker src/broker/simulated/broker.js data/SBER_2024_1m.parquet \
  --strategy <путь-к-стратегии> --balance 10000 --commission 0.0005

# live (sandbox)
diviner --broker src/broker/tinkoff/broker.js --strategy <путь-к-стратегии> \
  --ticker SBER --sandbox --account <id> --leverage 4 --intrabar-stops

# загрузка свечей MOEX → Parquet
T_INVEST_TOKEN=<token> diviner --fetch --security SBER --from-date 2024-01-01 \
  --till-date 2024-12-31 --interval 1 --parquet > data/SBER_2024_1m.parquet
```

Полная CLI-справка (все опции backtest/live/fetch/convert) — [`devs/usage.md`](devs/usage.md).

Код торговых стратегий (`--strategy <путь>`) в этот репозиторий не входит — см.
[`devs/paths.md`](devs/paths.md) про то, как проект работает с внешним источником стратегий.

## Тесты

```bash
npm test
```

## Структура проекта

```
diviner/
├── diviner              sh-обёртка → node src/diviner.js
├── scripts/backtest.mjs параллельный батч-бэктест всех тикеров
├── src/
│   ├── diviner.js        точка входа: --broker / --fetch / --convert
│   ├── broker/           simulated (бэктест) · tinkoff (live MOEX) · okx (крипта)
│   └── core/             режим-слепое ядро: engine, stops, portfolio, strategy
├── data/                 Parquet 1m-свечи (не в git)
└── devs/                 документация для разработчиков
```

Полная карта с описанием каждого файла — [`devs/paths.md`](devs/paths.md).

## Документация для разработчиков → [`devs/`](devs/)

- [`devs/paths.md`](devs/paths.md) — структура проекта: где что лежит, что не коммитится в git.
- [`devs/structure.md`](devs/structure.md) — архитектура: как взаимодействуют брокер, движок и стратегия на программном уровне.
- [`devs/usage.md`](devs/usage.md) — CLI-справка: backtest / live / fetch / convert / аккаунт-утилиты, цикл разработки.
