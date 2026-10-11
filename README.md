# Diviner

**Diviner** — экосистема для бэктестинга и live-трейдинга торговых стратегий: загрузка данных,
конвертация в Parquet, бэктесты и торговля в реальном времени через биржевых брокеров — Tinkoff
Investments API (MOEX) и OKX (крипта).

Архитектура построена вокруг одного принципа: **брокер — единственный носитель различия между
backtest и live**. Движок один и слеп — он тактирует поток свечей, централизованно оркеструет
SL/TP и передаёт сигналы брокеру, ничего не зная про деньги, режим и источник данных. Один и тот
же файл стратегии без изменений гоняется и на исторических Parquet-данных, и на боевом счёте.

## Быстрый старт

Без токена и без данных — на синтетических свечах ([`examples/`](examples/README.md)):

```bash
npm install
node examples/make-data.mjs --out work/examples/demo.parquet --tickers DEMO
node src/diviner.js src/broker/simulated/broker.js work/examples/demo.parquet \
  --strategy examples/strategies/sma-cross/sma-cross.js --balance 10000
```

С данными MOEX и брокером:

```bash
export T_INVEST_TOKEN=<your-token>

# бэктест всех тикеров (параллельно, worker_threads)
node scripts/backtest.mjs --strategy <ИМЯ> --year 2026 --leverage 4 --intrabar-stops

# бэктест одного инструмента
diviner src/broker/simulated/broker.js data/tinkoff/SBER_2024_1m.parquet \
  --strategy <путь-к-стратегии> --balance 10000 --commission 0.0005

# live (sandbox) на вселенной бумаг; одна бумага — --tickers SBER
diviner src/broker/tinkoff/multi-broker.js --strategy <путь-к-стратегии> \
  --sandbox --account <id> --universe-file data/universe.json --intrabar-stops

# загрузка свечей MOEX → Parquet
T_INVEST_TOKEN=<token> node src/broker/tinkoff/fetch.js --security SBER --from-date 2024-01-01 \
  --till-date 2024-12-31 --interval 1 --parquet > data/tinkoff/SBER_2024_1m.parquet

# отобрать шортируемые ликвидные бумаги через API (список тикеров в stdout)
T_INVEST_TOKEN=<token> node src/universe.js --table

# дописать свежий период к существующему листингу (только рост, без укорачивания)
node src/append.js --into data/tinkoff/ALRS_2026_1m.parquet /tmp/ALRS_fresh.parquet

# сборка вселенной в один мультитикерный Parquet (для кросс-секционных стратегий)
node src/bundle.js --out data/tinkoff/CORE62_2026_1m.parquet \
  --tickers ALRS,ROSN,SBER --from 2026-01-01 --to 2026-06-08 data/tinkoff/*_2026_1m.parquet
```

### Состав вселенной

`src/universe.js` спрашивает у брокера все акции и отбирает пригодные к торговле
по флагам инструмента: `shortEnabledFlag` (шорт разрешён), `liquidityFlag`
(ликвидность), `apiTradeAvailableFlag` и `sellAvailableFlag`, за вычетом
внебиржи, блокировок и бумаг только для квалов; плюс порог по глубине минутной
истории (`--min-history-days`). Отдельно считается стоимость лота — на счёте в
10 000 ₽ с четырьмя слотами бумага с лотом дороже 2 500 ₽ не покупается физически
(`--max-lot-cost`).

Смысл в том, чтобы состав вселенной обновлялся сам: бумага, которой отключили
шорт, выпадает из списка на следующем запуске, а не живёт в захардкоженной
константе, пока кто-то не заметит. `--show-rejected` показывает, кого и почему
отсеяли — без этого неожиданное исчезновение бумаги превращается в гадание.

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
├── scripts/             backtest.mjs (батч-бэктест) · convert.mjs · merge-okx-orderbook.mjs
├── src/
│   ├── diviner.js        точка входа: diviner <broker-path> [опции]
│   ├── universe.js       отбор вселенной через API · bundle.js — бандл · append.js — дозапись листинга
│   ├── broker/           simulated (бэктест) · tinkoff (live MOEX) · okx (крипта) · common
│   ├── core/             режим-слепое ядро: engine, stops, portfolio, strategy, данные, метрики
│   └── strategies/       стратегии — отдельный репозиторий, в git движка не входит
├── examples/             стратегии-примеры и генератор синтетических свечей
├── data/                 Parquet-свечи (не в git): tinkoff/ (MOEX) · okx/ (крипта)
├── work/                 артефакты замеров (не в git)
└── devs/                 документация для разработчиков
```

## Документация для разработчиков → [`devs/`](devs/)

- [`devs/structure.md`](devs/structure.md) — архитектура: как взаимодействуют брокер, движок и стратегия на программном уровне.
- [`devs/usage.md`](devs/usage.md) — CLI-справка: backtest / live / fetch / convert / аккаунт-утилиты, цикл разработки.
- [`examples/`](examples/README.md) — две стратегии-примера и синтетические данные: с чего начать свою стратегию.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — правила разработки: стиль, тесты, документация, данные.
