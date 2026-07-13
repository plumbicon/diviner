# Архитектура: брокер ↔ движок ↔ стратегия

Главный принцип: **брокер — единственный носитель различия между backtest и live**.
Движок один и «слеп»: он не знает про деньги, режим запуска и источник данных — он лишь
тактирует поток свечей, централизованно считает SL/TP и делегирует исполнение брокеру.

## Слои

```
Strategy        логика + сигналы (buy/sell/closePosition); тактируется извне
   │  this.execution → broker.exec      this.context → TemporalView
Engine          один, слепой: init → for await broker.data.stream() → broker.finalize()
   │
TemporalView    обрезает историю по «now» (защита от look-ahead)
MarketDataCache декоратор над data source брокера (кэш истории; только live)
Broker {data, exec, finalize}   ← вся разница live/backtest живёт здесь
```

## Контракт брокера

Брокер — это модуль, экспортирующий `options` (CLI-флаги) и `createBroker(config)`,
который возвращает объект:

```
broker = {
  data: {
    stream(): AsyncGenerator<candle>   // источник свечей; конец потока = сигнал стоп
    requestStop?()                     // live: встроить завершение в поток (по SIGINT)
    candles?, series?                  // backtest: предзагруженная история
  },
  exec: {
    init?()                            // live: refreshBalance + syncWithAccountPosition
    setCurrentCandle(candle)
    getPosition()
    buy(size?, sl?, tp?) / sell(...) / closePosition()
    syncStrategyState(strategy)        // зеркалит позицию стратегии ↔ брокер
    drainOrders?()                     // live: дождаться сериализованного исполнения
    checkStops?(candle)                // intrabar SL/TP (если intrabarStops)
    intrabarStops                      // флаг режима стопов
  },
  finalize?()                          // backtest → отчёт; live → teardown + сводка
  needsCache?                          // live → обернуть data в MarketDataCache
  metadata                             // инструмент, интервал, таймзона
}
```

- `simulated/broker.js` — `data.stream()` отдаёт предзагруженный parquet-листинг; `finalize()`
  собирает `PerformanceMetrics` (Return/MaxDD/Sharpe/Calmar). `needsCache = false`.
- `tinkoff/broker.js` — `data.stream()` превращает push-подписку T-Invest в pull-итератор;
  `exec.init/drainOrders/checkStops` реальны; `finalize()` закрывает сессию. `needsCache = true`.

## Контракт стратегии

Наследует `core/strategy.js`, реализует `init()` и `next()`:

```javascript
import { Strategy } from "../../core/strategy.js";   // из src/strategies/<name>/

export class A0X extends Strategy {
  async init() { /* загрузка модели, прогрев истории */ }
  next() {
    if (/* вход */) this.sell(undefined, slPrice, tpPrice);
    if (/* выход */) this.closePosition();
  }
}
```

Стратегия **не** читает env, **не** знает тикер/биржу/режим. История и расписание — только
через `this.context` (TemporalView); исполнение — через `this.execution` (= `broker.exec`),
но обычно через сахар `this.buy/sell/closePosition`.

| Доступно стратегии | Что это |
|---|---|
| `this.buy/sell/closePosition(size?, sl?, tp?)` | сигналы исполнения (идут в `broker.exec`) |
| `this.context.getCandles({from, to, interval})` | история с защитой от look-ahead |
| `this.context.getTradingSchedule({from, to})` | расписание торгов |
| `this.data` | массив свечей (в live растёт по мере поступления) |
| `this.position` | текущая позиция |

## Цикл `engine.run()` (по шагам)

```
run({ broker, strategy, context, options }):
  strategy.execution = broker.exec
  strategy.setContext(context)
  if broker.exec.init        → await broker.exec.init()      // live: баланс + синк позиции
  await strategy.init()

  for await (candle of broker.data.stream()):                // ← единственный драйвер времени
      strategy.data.push(candle) (если новая)
      context.setNow(candle.datetime)                         // сдвигаем окно видимости
      strategy.setDataIndex(index)
      broker.exec.setCurrentCandle(candle)

      // SL/TP — централизованно в движке:
      if broker.exec.intrabarStops:
          broker.exec.checkStops(candle)        // по high/low; закрытие в момент касания
      else if evaluateStops(getPosition(), candle.close):
          broker.exec.closePosition()           // по close (дефолт)

      await strategy.next()                     // стратегия принимает решение
      broker.exec.syncStrategyState(strategy)   // синхронизируем позицию
      if broker.exec.drainOrders → await broker.exec.drainOrders()   // live: дождаться API

  return broker.finalize?.()                    // backtest → отчёт; live → сводка
```

**Конец потока — универсальный сигнал остановки.** В backtest данные кончаются сами; в live
`requestStop()` (по SIGINT) встраивает завершение в поток. После выхода из цикла —
`broker.finalize()`.

## Поток данных backtest vs live

| | backtest (`simulated`) | live (`tinkoff`) |
|---|---|---|
| Источник `stream()` | предзагруженный parquet | gRPC-подписка на закрытые свечи |
| История для стратегии | весь листинг в памяти | растёт по свече; запросы кэшируются `MarketDataCache` |
| Агрегация интервалов | внутри брокера (из 1m) | нативный fetch провайдера |
| SL/TP | `evaluateStops` / `evaluateIntrabarStop` | то же + закрытие по рынку при касании |
| Размер позиции | `Portfolio`: 95%·cash·leverage / (price·lot) | `_defaultOrderLots`: то же от RUB-баланса |
| Завершение | сборка `PerformanceMetrics` | отписка + сводка сессии |

Стратегия и движок в обоих случаях видят **один и тот же** интерфейс — отсюда «режим-слепота».

## Добавить новый брокер / стратегию

- **Брокер**: создать `src/broker/<name>/broker.js` с `export const options` и
  `export async function createBroker(config)`, вернуть `{data, exec, finalize?}`. CLI трогать
  не нужно — путь к брокеру передаётся первым аргументом `diviner`.
- **Стратегия**: создать `src/strategies/<name>/<name>.js`, наследник `Strategy`. Вспомогательный
  код — в `<name>/src/`, обучение/тюнинг — в `<name>/scripts/`, модель — в `<name>/` (не в git).
