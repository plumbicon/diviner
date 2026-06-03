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
├── src/
│   ├── engine/
│   │   └── engine.js            # Единый режим-слепой движок (run)
│   ├── broker/
│   │   ├── simulated-broker.js  # Брокер бэктеста (data + exec + finalize)
│   │   ├── tinkoff-broker.js    # Брокер T-Invest (data + exec + finalize + утилиты)
│   │   ├── tinkoff-client.js    # Клиент Tinkoff Invest API
│   │   ├── order-manager.js     # Постановка/валидация ордеров
│   │   ├── state-manager.js     # Состояние позиции
│   │   └── sandbox-utils.js     # Аккаунт-утилиты sandbox (без стратегии)
│   ├── core/                    # Общие слои и утилиты
│   │   ├── strategy.js          # Базовый класс стратегии
│   │   ├── strategy-loader.js   # Загрузчик стратегий по пути
│   │   ├── temporal-view.js     # Окно видимости (clamp по now, защита от look-ahead)
│   │   ├── market-cache.js      # Кэш истории (декоратор над data source)
│   │   ├── stops.js             # evaluateStops — единая логика SL/TP
│   │   ├── portfolio.js         # Симулируемый портфель
│   │   ├── metrics.js           # Метрики доходности
│   │   ├── market-data.js       # Провайдер свечей/расписания T-Invest
│   │   ├── data-loader.js       # Загрузка Parquet
│   │   ├── candle-parquet.js    # Чтение/запись Parquet свечей
│   │   ├── json-encoder.js      # JSON-энкодер отчёта
│   │   └── logger.js            # Логирование
│   ├── diviner.js               # Единая точка входа (--broker/--fetch/--convert)
│   ├── fetch.js                 # Загрузка свечей через Tinkoff API
│   ├── convert.js               # JSON → Parquet
│   ├── backtest.js              # Тонкий шим → diviner --broker src/broker/simulated-broker.js
│   └── live.js                  # Тонкий шим → diviner --broker src/broker/tinkoff-broker.js
├── data/                        # Исторические данные
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

## Бэктест (`--broker src/broker/simulated-broker.js`)

```bash
diviner --broker src/broker/simulated-broker.js data/sber_2024.parquet --strategy path/to/strategy.js --balance 10000 --commission 0.0005
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
cat data/sber_2024.parquet | diviner --broker src/broker/simulated-broker.js --strategy path/to/strategy.js
```

Расписание торгов в backtest восстанавливается из самих свечей; дневные свечи (`interval: "1d"`)
агрегируются внутри `simulated`-брокера из минутных. Отчёт печатается в stdout как JSON
(`backtest_parameters`, `performance_metrics`, `trade_log`).

## Live-трейдинг (`--broker src/broker/tinkoff-broker.js`)

```bash
T_INVEST_TOKEN=<token> diviner --broker src/broker/tinkoff-broker.js --strategy path/to/strategy.js --ticker SBER --sandbox --account <id> --interval 1
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
| `--verbose` | Логировать свечи и подробности | выкл |
| `--log` | Дублировать вывод в файл | — |

**Режимы:** `--sandbox` (виртуальные деньги), `--dry-run` (без отправки ордеров),
реальный счёт (без флагов). По SIGINT движок выходит из цикла, брокер закрывает сессию
(отписка, сводка по сделкам, по флагу `--close-on-exit` — закрытие позиции) и завершает работу.

Особенности live: расчёт размера заявки от фактического RUB-баланса с учётом лотности;
синхронизация позиции стратегии с фактической позицией на счёте; обработка только закрытых
свечей с отбрасыванием дублей; авто-переподписка после сетевого разрыва с догрузкой
пропущенных свечей; проверка SL/TP в реальном времени; кэш истории.

### Аккаунт-утилиты (без стратегии)

```bash
T_INVEST_TOKEN=<token> diviner --broker src/broker/tinkoff-broker.js --sandbox --account <id> --print-balance
T_INVEST_TOKEN=<token> diviner --broker src/broker/tinkoff-broker.js --sandbox --create-account
T_INVEST_TOKEN=<token> diviner --broker src/broker/tinkoff-broker.js --sandbox --account <id> --increase-balance 100000
T_INVEST_TOKEN=<token> diviner --broker src/broker/tinkoff-broker.js --sandbox --list-sandboxes
```

| Опция | Описание |
|-------|----------|
| `--list-sandboxes` | Список sandbox-счетов |
| `--create-account` | Создать sandbox-счёт |
| `--remove-account` | Удалить sandbox-счёт из `--account` |
| `--print-balance` | Cash, стоимость long, обязательства short, оценочная equity |
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
