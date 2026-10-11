# Архитектура: брокер ↔ движок ↔ стратегия

Главный принцип: **брокер — единственный носитель различия между backtest и live**.
Движок один и «слеп»: он не знает про деньги, режим запуска и источник данных — он лишь
тактирует поток свечей, централизованно проверяет SL/TP и дедлайн выхода и делегирует
исполнение брокеру. Один и тот же файл стратегии без изменений работает и на исторических
данных, и на боевом счёте.

Рабочие примеры обеих разновидностей стратегий — в [`examples/`](../examples/README.md).

## Слои

```
Strategy         логика + сигналы; тактируется извне
   │  this.execution → broker.exec        this.context → TemporalView
Engine           один, слепой: init → for await broker.data.stream() → broker.finalize()
   │
TemporalView     обрезает историю по «now» (защита от look-ahead)
MarketDataCache  декоратор над data source брокера (кэш истории; только live)
Broker {data, exec, finalize}   ← вся разница live/backtest живёт здесь
```

## Два вида прогона: одна бумага и вселенная

Стратегия работает либо на одной бумаге, либо на вселенной — тогда она каждую минуту сравнивает
бумаги между собой (кросс-секционная стратегия). Движок у них общий, различаются
источник данных и исполнитель.

| | Одна бумага | Вселенная |
|---|---|---|
| Бэктест | `simulated/broker.js` + однобумажный листинг | `simulated/broker.js` + мультитикерный бандл (`src/bundle.js`) |
| Live (MOEX) | `tinkoff/broker.js --ticker X` | `tinkoff/multi-broker.js --universe-file …` |
| Поток свечей | одна бумага, по времени | все бумаги вперемешку, по времени; минута — пачкой, последняя свеча пачки помечена `isBatchEnd` |
| `this.data` | история бумаги (в бэктесте — весь листинг сразу) | пустой приёмник: история вселенной объектами в память не влезает |
| Текущая свеча | `this.data.at(this.getDataIndex())` или аргумент `next(candle)` | только аргумент `next(candle)`, у свечи есть `ticker` |
| Заявка | `this.buy/sell({ size?, sl?, tp?, exitDeadline? })` | `this.execution.sell({ ticker, budget?, size?, sl?, tp?, exitDeadline? })` |
| Размер по умолчанию | исполнитель: весь кэш (× плечо), кратно лоту | стратегия задаёт `budget` в деньгах, исполнитель переводит в лоты |
| Позиции | одна: `this.position` | несколько: `getPositions()`, `getPositionOf(ticker)`, `isBusy(ticker)` |

Кросс-секционное решение принимается только на свече с `isBatchEnd`: раньше половина бумаг минуты
ещё не пришла. Тонкая бумага, у которой за минуту не было сделок, в пачке просто отсутствует — в
бэктесте и в live одинаково.

## Контракт брокера

Брокер — модуль, экспортирующий `options` (CLI-флаги) и `createBroker(config)`, который
возвращает объект:

```
broker = {
  data: {
    stream(): AsyncGenerator<candle>   // источник свечей; конец потока = сигнал стоп
    getHistory({ ticker?, from, to, interval, until })   // история (до until — защита от look-ahead)
    getTradingSchedule({ ticker?, from, to })
    getSymbols?(), getInstrument?(ticker)                // вселенная и инструмент (лот, биржа)
    requestStop?()                     // live: встроить завершение в поток (по SIGTERM/SIGINT)
    candles?, series?                  // backtest: предзагруженная история
  },
  exec: {
    init?()                            // live: баланс + сверка позиций со счётом
    setCurrentCandle(candle)
    getPosition()                      // позиция текущей бумаги
    buy({...}) / sell({...}) / closePosition(reason?, ticker?)
    syncStrategyState(strategy)        // позиция и кэш → стратегии
    drainOrders?()                     // live: дождаться сериализованного исполнения
    checkStops?(candle)                // intrabar SL/TP (если intrabarStops)
    intrabarStops                      // флаг режима стопов
    // только вселенная:
    getPositions(), getPositionOf(ticker), getPendingTickers(),
    isBusy(ticker), isBlocked(ticker), getEquity()
  },
  finalize?()                          // backtest → отчёт; live → teardown + сводка
  needsCache?                          // live → обернуть data в MarketDataCache
  metadata                             // инструмент(ы), интервал, таймзона
}
```

- `simulated/broker.js` — `stream()` отдаёт предзагруженный parquet: один листинг или слияние
  бандла по времени. `finalize()` собирает `PerformanceMetrics` (доходность, просадка, Sharpe,
  Calmar, WR). Заливка по close текущей свечи или, с `--fill-next-open`, по open следующей свечи
  той же бумаги. `needsCache = false`.
- `tinkoff/broker.js`, `tinkoff/multi-broker.js` — `stream()` превращает push-подписку T-Invest
  на закрытые свечи в pull-итератор; `init/drainOrders/checkStops` реальны; `finalize()`
  закрывает сессию. `needsCache = true`.
- `okx/broker.js` — однобумажный live для perpetual-свопов OKX через ccxt.

## Контракт стратегии

Наследует [`src/core/strategy.js`](../src/core/strategy.js), реализует `init()` и `next(candle)`:

```javascript
import { Strategy } from "../../core/strategy.js";   // из src/strategies/<ИМЯ>/

export class MyStrategy extends Strategy {
    async init() { /* загрузка модели, прогрев истории */ }
    next(candle) {
        if (/* вход */) this.sell({ sl: candle.close * 1.02 });
        if (/* выход */) this.closePosition();
    }
}
```

Стратегия **не** знает режим (backtest/live), брокера и источник данных. История и расписание —
только через `this.context`, исполнение — через `this.execution` (= `broker.exec`) или сахар
`this.buy/sell/closePosition`.

| Доступно стратегии | Что это |
|---|---|
| `this.buy/sell({ size?, sl?, tp?, exitDeadline? })`, `this.closePosition()` | сигналы исполнения; без `size` — размер по умолчанию исполнителя; `exitDeadline` — абсолютный дедлайн выхода (epoch ms), проверяет движок |
| `this.execution.*` | весь исполнитель, для вселенной — заявки с `ticker`/`budget` и занятость слотов |
| `this.context.getCandles({ ticker?, from, to, interval })` | история, обрезанная по текущему моменту |
| `this.context.getTradingSchedule({ ticker?, from, to })` | расписание торгов |
| `this.context.getSymbols()`, `getInstrumentMetadata(ticker?)` | вселенная и инструмент (лот, биржа) |
| `this.context.getNow()` | текущее время прогона |
| `this.logInfo(message)` | сообщение в лог независимо от `--verbose` |
| `this.data`, `this.getDataIndex()` | история одной бумаги и индекс текущей свечи |
| `this.position`, `this.cash` | позиция текущей бумаги и свободный кэш (обновляет исполнитель) |

**Параметры стратегии — переменные окружения.** CLI передаёт стратегии только историю и стартовый
капитал, поэтому пороги, окна и пути к моделям задаются через env с префиксом имени стратегии
(`SMA_FAST=10`, `TGS_SLOTS=3`). Значения по умолчанию задаются в коде стратегии.

**Look-ahead.** `context.getCandles` не отдаст свечу позже текущего момента; свеча старшего
интервала (час, день) появляется только после закрытия своего периода. В однобумажном бэктесте
`this.data` — весь листинг сразу: читать его дальше `getDataIndex()` нельзя.

## Цикл `engine.run()` (по шагам)

```
run({ broker, strategy, context, options }):
  strategy.execution = broker.exec
  strategy.setContext(context)
  if broker.exec.init        → await broker.exec.init()      // live: баланс + сверка позиций
  await strategy.init()

  for await (candle of broker.data.stream()):                // ← единственный драйвер времени
      strategy.data.push(candle) (если новая)
      context.setNow(candle.datetime)                         // сдвигаем окно видимости
      strategy.setDataIndex(index)
      broker.exec.setCurrentCandle(candle)

      // SL/TP — централизованно в движке:
      if broker.exec.intrabarStops:
          broker.exec.checkStops(candle)        // по high/low; закрытие на уровне стопа
      else if evaluateStops(getPosition(), candle.close):
          broker.exec.closePosition(reason)     // по close (дефолт)
      if evaluateTimeExit(getPosition(), candle.datetime):
          broker.exec.closePosition("time")     // дедлайн выхода

      await strategy.next(candle)               // стратегия принимает решение
      broker.exec.syncStrategyState(strategy)   // позиция и кэш → стратегии
      if broker.exec.drainOrders → await broker.exec.drainOrders()   // live: дождаться API

  return broker.finalize?.()                    // backtest → отчёт; live → сводка
```

**Конец потока — универсальный сигнал остановки.** В backtest данные кончаются сами; в live
`requestStop()` (по SIGTERM/SIGINT) встраивает завершение в поток. После выхода из цикла —
`broker.finalize()`. Если поток завершился ошибкой (например, стрим свечей не восстановился),
процесс выходит с кодом 1 и его поднимает systemd.

## Поток данных backtest vs live

| | backtest (`simulated`) | live (`tinkoff`) |
|---|---|---|
| Источник `stream()` | предзагруженный parquet | gRPC-подписка на закрытые свечи |
| Сборка минуты (вселенная) | слияние бандла по времени | ожидание всех бумаг или 8 с от первой свечи минуты (`--batch-grace-ms`) |
| История для стратегии | из файла, только хранящиеся в нём интервалы | запросы к брокеру, settled-диапазоны кэшируются `MarketDataCache` |
| Интервалы | **без агрегации**: запрос интервала, которого нет в файле, — ошибка | нативный запрос интервала у брокера |
| SL/TP | `evaluateStops` / `evaluateIntrabarStop` | то же + закрытие по рынку при касании |
| Размер позиции | весь кэш с поправкой на проскальзывание и комиссию, кратно лоту; во вселенной — `budget` стратегии | то же от рублёвого баланса счёта; плечо шорта ограничено ставкой риска брокера |
| Обрыв данных | — | догрузка пропущенного по REST, переподключение, сторожа тишины — [usage.md](usage.md#обрыв-стрима-свечей) |
| Завершение | сборка `PerformanceMetrics` | отписка + сводка сессии |

## Данные

Свечи хранятся в Parquet ([`src/core/candle-parquet.js`](../src/core/candle-parquet.js)):

| Колонка | Тип | Что это |
|---|---|---|
| `datetime` | timestamp, UTC | начало свечи |
| `open`, `high`, `low`, `close` | double | цены |
| `volume` | double | объём; у листингов T-Invest — **в лотах**, оборот = close × volume × lot |
| `interval` | int, необязательная | длина свечи в минутах (1, 60, 1440); нужна, если в файле несколько интервалов |
| `ticker` | string, необязательная | тикер строки; есть только в мультитикерном бандле |

Метаданные лежат в ключе `diviner.metadata` (JSON). У однобумажного листинга — `ticker`,
`instrument` (лот, figi, биржа), `intervalMinutes`, `intervals`; у бандла — `tickers` и
`instruments` (тикер → инструмент). Бандл читается колонками
([`candle-series.js`](../src/core/candle-series.js)): вселенная за год объектами в кучу V8 не
помещается.

**Листинги только дописываются.** Свежий период добавляется к существующему файлу
(`src/append.js`), а не заменяет его: короче ставший листинг молча сдвигает окно бэктеста, и
результаты перестают быть сопоставимыми.

## Добавить новый брокер / стратегию

- **Брокер**: создать `src/broker/<name>/broker.js` с `export const options` и
  `export async function createBroker(config)`, вернуть `{data, exec, finalize?}`. CLI трогать
  не нужно — путь к брокеру передаётся первым аргументом `diviner`.
- **Стратегия**: начать с копии примера из [`examples/strategies/`](../examples/strategies/).
  Боевые стратегии живут в `src/strategies/<ИМЯ>/<ИМЯ>.js` — отдельный репозиторий, в репозиторий
  движка не входит. Вспомогательный код — в `<ИМЯ>/src/`, обучение — в `<ИМЯ>/scripts/`, модели —
  рядом с файлом стратегии (не в git движка).
