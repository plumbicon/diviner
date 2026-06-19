# Diviner

**Diviner** — экосистема для бэктестинга и live-трейдинга торговых стратегий на MOEX:
загрузка данных, конвертация в Parquet, бэктесты и торговля в реальном времени через
Tinkoff Investments API.

Архитектура построена вокруг одного принципа: **брокер — единственный носитель различия
между backtest и live**. Движок один и слеп — он тактирует поток свечей, оркеструет SL/TP
по уровням и передаёт сигналы брокеру, ничего не зная про деньги, режим и источник данных.

## Структура проекта

```
diviner/
├── scripts/
│   └── backtest.mjs             # Параллельный батч-бэктест всех тикеров (worker_threads)
├── src/
│   ├── broker/                  # Каждый брокер — своя директория со ВСЕМ своим кодом
│   │   ├── simulated/
│   │   │   └── broker.js        # Брокер бэктеста (data + exec + finalize)
│   │   ├── tinkoff/             # Live T-Invest: брокер + транспорт + загрузка данных
│   │   │   ├── broker.js        # Брокер T-Invest (data + exec + finalize + утилиты)
│   │   │   ├── client.js        # Клиент Tinkoff Invest API
│   │   │   ├── order-manager.js # Постановка/валидация ордеров
│   │   │   ├── sandbox-utils.js # Аккаунт-утилиты sandbox (без стратегии)
│   │   │   └── fetch.js         # Загрузка свечей через Tinkoff API → Parquet
│   │   ├── okx/                 # Крипта (ccxt perp-swap): брокер + загрузка данных
│   │   │   ├── broker.js
│   │   │   ├── client.js
│   │   │   ├── intervals.js
│   │   │   ├── fetch.js / fetch-batch.js / fetch-metrics.js
│   │   │   └── broker.test.js
│   │   └── common/              # Общее live-состояние брокеров
│   │       ├── state-manager.js # Состояние позиции
│   │       └── position-store.js# Персист SL/TP между рестартами
│   ├── core/                    # Общие режим-слепые слои
│   │   ├── engine.js            # Единый движок (run): тик-цикл + оркестрация SL/TP
│   │   ├── strategy.js / strategy-loader.js / temporal-view.js
│   │   ├── stops.js             # evaluateStops / evaluateIntrabarStop — логика SL/TP
│   │   ├── portfolio.js         # Симулируемый портфель (размер, плечо, маржа)
│   │   ├── metrics.js           # Метрики (Return/MaxDD/Sharpe/Calmar)
│   │   ├── market-data.js / market-cache.js / data-loader.js / candle-parquet.js
│   │   └── json-encoder.js / logger.js
│   ├── ml/
│   │   └── lgbm.js              # LightGBM-инференс на чистом JS (+ кэш модели)
│   ├── strategies/              # ← ОТДЕЛЬНЫЙ репозиторий (gitignored): A01..A05, A07
│   ├── diviner.js               # Точка входа (--broker / --fetch / --convert)
│   └── convert.js               # JSON → Parquet
├── ml/                          # Обучение моделей + скрипты данных (Python/shell)
├── data/                        # Parquet-данные (gitignored)
├── reports/                     # Отчёты бэктеста (gitignored)
├── package.json
└── README.md
```

### Слои

```
Strategy        логика + сигналы (buy/sell/close); тактируется извне
Engine          один, слепой: init → for await broker.data.stream() → broker.finalize()
TemporalView    обрезает историю по now (защита от look-ahead)
Cache           декоратор над data source брокера (кэш истории; только live)
Broker {data, exec, finalize}   единственный носитель различия live/backtest
```

Завершение потока — универсальный сигнал остановки: в backtest данные кончаются, в live
брокер по SIGINT встраивает завершение в поток. После этого движок зовёт `broker.finalize()`:
у `simulated` это сборка отчёта (`PerformanceMetrics`), у `tinkoff` — закрытие сессии и сводка.

## Установка

```bash
npm install
```

Для команд, обращающихся к T-Invest API, токен читается только из переменной окружения:

```bash
export T_INVEST_TOKEN=<your-token>
```

## Единая точка входа

```bash
diviner --broker <путь> --strategy <путь> [опции брокера]
diviner --fetch   [опции fetch]
diviner --convert [опции convert]
```

Ровно один из `--broker` / `--fetch` / `--convert` (иначе ошибка). Значение `--broker` — это
**путь к файлу брокера** (как `--strategy` — путь к стратегии). Опции брокера валидируются по
его декларации (`export const options`), поэтому добавить брокера — это добавить файл, не трогая CLI.

Стратегия запускается тогда и только тогда, когда переданы `--strategy` и источник данных
(parquet для `simulated`, `--ticker` для `tinkoff`). Без стратегии `tinkoff` выполняет
аккаунт-утилиту, если она запрошена.

## Бэктест (`--broker src/broker/simulated/broker.js`)

```bash
diviner --broker src/broker/simulated/broker.js data/sber_2024.parquet --strategy path/to/strategy.js --balance 10000 --commission 0.0005
```

| Опция | Описание | По умолчанию |
|-------|----------|-------------|
| `--strategy` | Путь к файлу стратегии | — |
| `--balance` | Начальный виртуальный баланс | `10000` |
| `--commission` | Комиссия | `0.0005` |
| `--verbose` | Включить полную историю сделок (`trade_log`) в отчёт | выкл |
| `[source]` | Позиционный аргумент — путь к Parquet (или stdin) | — |

Данные можно передать через pipe:

```bash
cat data/sber_2024.parquet | diviner --broker src/broker/simulated/broker.js --strategy path/to/strategy.js
```

Расписание торгов в backtest восстанавливается из самих свечей; дневные свечи (`interval: "1d"`)
агрегируются внутри `simulated`-брокера из минутных. Отчёт печатается в stdout как JSON
(`backtest_parameters`, `performance_metrics`, `trade_log`).

**Размер позиции по умолчанию** (когда стратегия не задаёт `size`): 95% доступного кэша,
округлённые вниз до целого числа **лотов** инструмента (`floor(cash·0.95 / (price·lot))·lot`).
Размер лота берётся из метаданных parquet (`instrument.lot`), поэтому бэктест сайзит так же,
как живой брокер (например, ALRS с lot=10 — кратно 10 акциям). Это совпадает с
`_defaultOrderLots` в live-брокере.

## Live-трейдинг (`--broker src/broker/tinkoff/broker.js`)

```bash
T_INVEST_TOKEN=<token> diviner --broker src/broker/tinkoff/broker.js --strategy path/to/strategy.js --ticker SBER --sandbox --account <id> --interval 1
```

| Опция | Описание | По умолчанию |
|-------|----------|-------------|
| `--strategy` | Путь к файлу стратегии | — |
| `--ticker` | Тикер инструмента | — |
| `--account` | ID счёта | — |
| `--sandbox` | Режим песочницы (виртуальные деньги) | выкл |
| `--dry-run` | Стратегия работает, ордера не отправляются | выкл |
| `--interval` | Интервал свечей в минутах (1, 5, 15, 60, 120, 240, 1440) | `1` |
| `--close-on-exit` | Закрыть позицию при остановке сессии (по умолчанию — оставить) | выкл |
| `--order-retries` | Повторы заявки при временных ошибках API | `2` |
| `--order-tag` | Короткая метка в ключе идемпотентности ордера для сопоставления с логами (см. ниже) | `div` |
| `--verbose` | Логировать свечи и подробности | выкл |
| `--log` | Дублировать вывод в файл | — |

**Режимы:** `--sandbox` (виртуальные деньги), `--dry-run` (без отправки ордеров),
реальный счёт (без флагов). По SIGINT движок выходит из цикла, брокер закрывает сессию
(отписка, сводка по сделкам, по флагу `--close-on-exit` — закрытие позиции) и завершает работу.

Особенности live: расчёт размера заявки от фактического RUB-баланса с учётом лотности;
синхронизация позиции стратегии с фактической позицией на счёте; обработка только закрытых
свечей с отбрасыванием дублей; авто-переподписка после сетевого разрыва с догрузкой
пропущенных свечей; проверка SL/TP в реальном времени; кэш истории.

### Идентификация ордеров

Каждому ордеру присваивается осмысленный **ключ идемпотентности** (поле API `order_id`),
чтобы потом сопоставлять сделки с логами стратегии. Формат (очищается до `[A-Za-z0-9_-]`,
жёстко обрезается до лимита API в **36 символов**):

```
<tag>-<ticker>-<O|C><B|S>-<yyMMddHHmmss>
напр. a05-ALRS-OS-260613040100  = открытие шорта по ALRS на свече 2026-06-13 04:01:00 (UTC)
```

`O`/`C` — открытие/закрытие, `B`/`S` — buy/sell, метка задаётся через `--order-tag`.
Время берётся из текущей свечи; хвост-таймстамп держит ключ уникальным (брокер дедуплицирует
ключи идемпотентности ~1 месяц).

> **Важно:** это **не комментарий к сделке**. T-Invest API не имеет поля для произвольного
> текста у операции. Ключ возвращается как `order_request_id` и виден через
> `getOrderState` / `getOrders` / стрим статусов, но **не попадает** в историю операций
> (`getOperations`) и брокерский отчёт — там только биржевой `order_id`. Для богатых
> метаданных (сигнал, gap, вероятность модели) ведите собственный лог по этому ключу.

### Аккаунт-утилиты (без стратегии)

```bash
T_INVEST_TOKEN=<token> diviner --broker src/broker/tinkoff/broker.js --sandbox --account <id> --print-balance
T_INVEST_TOKEN=<token> diviner --broker src/broker/tinkoff/broker.js --sandbox --account <id> --print-history --history-from 2026-06-01
T_INVEST_TOKEN=<token> diviner --broker src/broker/tinkoff/broker.js --sandbox --create-account
T_INVEST_TOKEN=<token> diviner --broker src/broker/tinkoff/broker.js --sandbox --account <id> --increase-balance 100000
T_INVEST_TOKEN=<token> diviner --broker src/broker/tinkoff/broker.js --sandbox --list-sandboxes
```

| Опция | Описание |
|-------|----------|
| `--list-sandboxes` | Список sandbox-счетов |
| `--create-account` | Создать sandbox-счёт |
| `--remove-account` | Удалить sandbox-счёт из `--account` |
| `--print-balance` | Cash, стоимость long, обязательства short, оценочная equity |
| `--print-history` | История операций счёта (FIGI→тикер, сводка комиссий и чистого потока) |
| `--history-from <date>` | Дата начала (YYYY-MM-DD) для `--print-history` (по умолчанию — 6 месяцев назад) |
| `--reset-positions` | Обнулить sandbox-позиции по акциям, сохранив RUB-баланс |
| `--increase-balance <amount>` | Пополнить RUB-баланс sandbox-счёта |

## Загрузка данных (`--fetch`)

```bash
T_INVEST_TOKEN=<token> diviner --fetch --security SBER --from-date 2024-01-01 --till-date 2024-12-31 --interval 1 --parquet > data/sber_2024.parquet
```

| Опция | Описание | По умолчанию |
|-------|----------|-------------|
| `--security` / `--ticker` | Тикер бумаги | `SBER` |
| `--class-code` | Код класса инструмента | `TQBR` |
| `--from-date` | Дата начала (YYYY-MM-DD) | — |
| `--till-date` | Дата окончания (YYYY-MM-DD) | сегодня |
| `--interval` | 1=1m, 5=5m, 15=15m, 60=1h, 240=4h, 24=1d, 7=1w, 31=1M, … | `24` |
| `--parquet` | Писать Parquet в stdout вместо JSON | выкл |
| `--request-delay-ms` | Пауза между API-запросами | `100` |

Даты — календарные дни в московском времени. Parquet хранит metadata инструмента и свечи.

## Конвертация (`--convert`)

```bash
diviner --convert --input-json sber_2024.json --output-parquet sber_2024.parquet
```

| Опция | Описание |
|-------|----------|
| `--input-json` | Путь к JSON (или stdin) |
| `--output-parquet` | Путь к Parquet (или stdout) |

## Стратегии

Стратегия наследуется от `Strategy` и реализует `init()` и `next()`:

```javascript
import { Strategy } from '../core/strategy.js';

export class MyStrategy extends Strategy {
  init() {
    // Инициализация
  }

  next() {
    // Логика на каждом баре
    if (/* условие входа */) this.sell(undefined, slPrice, tpPrice);
    if (/* условие выхода */) this.closePosition();
  }
}
```

Стратегия не читает переменные окружения, не знает тикер, биржу и режим запуска — историю
и расписание она получает через контекст (`this.context.getCandles` / `getTradingSchedule`),
а исполнение делегирует брокеру. SL/TP считаются движком централизованно (`evaluateStops`).

### Методы и свойства

| Метод | Описание |
|-------|----------|
| `this.buy(size?, sl?, tp?)` | Открыть длинную позицию |
| `this.sell(size?, sl?, tp?)` | Открыть короткую позицию |
| `this.closePosition()` | Закрыть текущую позицию |
| `this.I(calculator, ...args)` | Создать индикатор |
| `this.context.getCandles({ from, to, interval })` | История свечей (с защитой от look-ahead) |
| `this.context.getTradingSchedule({ from, to })` | Расписание торгов |

| Свойство | Описание |
|----------|----------|
| `this.data` | Массив свечей (в live растёт по мере поступления) |
| `this.position` | Текущая позиция |

---
*Проект спроектирован в соответствии с принципами UNIX-way и KISS.*
