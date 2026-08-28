# Diviner

**Diviner** — экосистема для бэктестинга и live-трейдинга торговых стратегий: загрузка данных,
конвертация в Parquet, бэктесты и торговля в реальном времени через биржевых брокеров — Tinkoff
Investments API (MOEX) и OKX (крипта).

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
diviner src/broker/simulated/broker.js data/tinkoff/SBER_2024_1m.parquet \
  --strategy <путь-к-стратегии> --balance 10000 --commission 0.0005

# live (sandbox)
diviner src/broker/tinkoff/broker.js --strategy <путь-к-стратегии> \
  --ticker SBER --sandbox --account <id> --leverage 4 --intrabar-stops

# загрузка свечей MOEX → Parquet
T_INVEST_TOKEN=<token> node src/broker/tinkoff/fetch.js --security SBER --from-date 2024-01-01 \
  --till-date 2024-12-31 --interval 1 --parquet > data/tinkoff/SBER_2024_1m.parquet

# сборка вселенной в один мультитикерный Parquet (для кросс-секционных стратегий)
node src/bundle.js --out data/tinkoff/CORE62_2026_1m.parquet \
  --tickers ALRS,ROSN,SBER --from 2026-01-01 --to 2026-06-08 data/tinkoff/*_2026_1m.parquet
```

### Мультитикерные датасеты

Кросс-секционной стратегии нужен доступ к любой бумаге вселенной, а не только к
той, на которой её запустили. `src/bundle.js` сливает однобумажные листинги в
один Parquet, помечая каждую строку тикером; исходники только читаются, а
существующий выход без `--force` не перезаписывается.

Такой файл `loadDataset` читает **колонками** (`src/core/candle-series.js`):
свеча-объект стоит ~259 байт в куче V8, поэтому вселенная за год (~40 млн свечей)
объектами не помещается в лимит кучи вовсе. Колонки — 52 байта на свечу, лежат
вне кучи, и объект собирается только при обращении `at(i)`. Замер на core62 за
январь–июнь 2026: 7.5 млн свечей — 370 МБ колонками против 1.8 ГБ объектами,
загрузка 6.5 с.

Датасет отдаёт `bySymbol` (тикер → интервал → серия), `symbols`, `instruments`
(лот/биржа/figi) и `mergeStream(minutes)` — хронологический поток по всей
вселенной слиянием, без копирования данных. Однобумажные листинги читаются
прежним путём, массивами объектов: их поведение не меняется.

Интерфейс серии — подмножество `Array` (`length`, `at(i)`, `slice()`, итератор),
поэтому потребителю безразлично, массив ему дали или колонки. Единственное
требование: обращаться через `at(i)`, а не `[i]`.

Полная CLI-справка (все опции backtest/live) — [`devs/usage.md`](devs/usage.md).

## Тесты

```bash
npm test
```

## Структура проекта

```
diviner/
├── diviner              sh-обёртка → node src/diviner.js
├── scripts/             backtest.mjs (батч-бэктест) · fetch.mjs · convert.mjs
├── src/
│   ├── diviner.js        точка входа: diviner <broker-path> [опции]
│   ├── broker/           simulated (бэктест) · tinkoff (live MOEX) · okx (крипта)
│   └── core/             режим-слепое ядро: engine, stops, portfolio, strategy
├── data/                 Parquet-свечи (не в git): tinkoff/ (MOEX) · okx/ (крипта)
└── devs/                 документация для разработчиков
```

## Документация для разработчиков → [`devs/`](devs/)

- [`devs/structure.md`](devs/structure.md) — архитектура: как взаимодействуют брокер, движок и стратегия на программном уровне.
- [`devs/usage.md`](devs/usage.md) — CLI-справка: backtest / live / fetch / convert / аккаунт-утилиты, цикл разработки.
