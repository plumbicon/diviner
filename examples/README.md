# Примеры

Две маленькие стратегии и генератор синтетических свечей: бэктест запускается за минуту, без
токена брокера и без скачанных листингов. Обе стратегии прогоняет `examples.test.js`, так что
пример, разошедшийся с движком, сломает `npm test`.

## Однобумажная стратегия — `strategies/sma-cross`

Лонг на пересечении скользящих средних, выход на обратном пересечении или по стопу.

```bash
node examples/make-data.mjs --out work/examples/demo.parquet --tickers DEMO
```
```bash
node src/diviner.js src/broker/simulated/broker.js work/examples/demo.parquet \
  --strategy examples/strategies/sma-cross/sma-cross.js --balance 10000
```

На что смотреть в коде:
- история — `this.data`, текущая свеча — `this.data.at(this.getDataIndex())`. В бэктесте
  `this.data` содержит весь листинг, поэтому читать можно только до текущего индекса;
- вход — `this.buy({ sl })`, выход — `this.closePosition()`. Стоп проверяет движок;
- параметры — переменные окружения (`SMA_FAST=10 node src/diviner.js …`).

## Кросс-секционная стратегия — `strategies/top-gainer-short`

Раз в день в 11:00 МСК шорт двух бумаг, сильнее всех выросших с открытия; выход по стопу или
по дедлайну в 18:30.

```bash
node examples/make-data.mjs --out work/examples/universe.parquet --tickers AAA,BBB,CCC,DDD,EEE
```
```bash
node src/diviner.js src/broker/simulated/broker.js work/examples/universe.parquet \
  --strategy examples/strategies/top-gainer-short/top-gainer-short.js \
  --balance 100000 --fill-next-open --intrabar-stops
```

На что смотреть в коде:
- свеча приходит аргументом `next(candle)` с полем `ticker`; своей истории у мультитикерного
  прогона нет, за ней ходят в `this.context.getCandles({ ticker, … })`;
- минута отдаётся пачкой по всем бумагам, последняя свеча пачки помечена `isBatchEnd`. Решение
  «какую бумагу выбрать» принимается только на ней — раньше половина бумаг ещё не пришла;
- заявка адресуется бумаге: `this.execution.sell({ ticker, budget, sl, exitDeadline })`. Размер
  в бумагах из `budget` считает исполнитель — с лотом и ценой заливки;
- `exitDeadline` — абсолютное время выхода (epoch ms), его проверяет движок.

## Генератор данных — `make-data.mjs`

| Опция | Что делает | По умолчанию |
|---|---|---|
| `--out <path>` | куда записать parquet | — |
| `--tickers <list>` | тикеры через запятую; один — листинг, несколько — бандл | `DEMO` |
| `--days <n>` | торговых дней (будни, 10:00–18:39 МСК) | `20` |
| `--seed <n>` | зерно случайного блуждания: те же параметры — тот же файл | `1` |
| `--from <date>` | первый календарный день | `2026-01-05` |

Первая бумага печатает свечу каждую минуту, остальные — в 85% минут, как тонкие бумаги на
бирже. Формат файлов тот же, что у настоящих листингов (`src/broker/tinkoff/fetch.js`) и бандлов
(`src/bundle.js`), — см. раздел «Данные» в [`devs/structure.md`](../devs/structure.md).

Свою стратегию удобно начинать с копии одного из примеров. Боевые стратегии живут в
`src/strategies/<ИМЯ>/<ИМЯ>.js` — этот каталог в репозиторий движка не входит.
