# Diviner

**Diviner** — это экосистема для бэктестинга и live-трейдинга торговых стратегий на MOEX. Проект включает инструменты для загрузки данных, конвертации в Parquet, бэктестов и торговли в реальном времени через Tinkoff Investments API.

## Структура проекта

```
diviner/
├── src/                    # Исходный код
│   ├── core/               # Ядро
│   │   ├── runner.js       # Последовательный runner бэктеста
│   │   ├── portfolio.js    # Симулируемый портфель
│   │   ├── metrics.js      # Метрики доходности
│   │   ├── broker.js       # Broker-интерфейс для исполнения
│   │   ├── execution-adapter.js # Исполнение сигналов стратегии
│   │   ├── engine.js       # Совместимый facade над BacktestRunner
│   │   ├── strategy.js     # Базовый класс стратегии
│   │   ├── data-loader.js  # Загрузка Parquet
│   │   ├── strategy-loader.js # Загрузчик стратегий
│   │   ├── logger.js       # Логирование
│   │   └── json-encoder.js # JSON-энкодер результатов
│   ├── live/               # Live-торговля
│   │   ├── tinkoff-client.js  # Клиент Tinkoff Invest API
│   │   ├── live-engine.js     # Движок live-торговли
│   │   ├── order-manager.js   # Управление ордерами
│   │   └── state-manager.js   # Управление состоянием позиции
│   ├── diviner.js          # Единая точка входа с --mode
│   ├── fetch.js            # Загрузка свечей через Tinkoff API
│   ├── convert.js          # JSON → Parquet
│   ├── backtest.js         # Запуск бэктеста
│   └── live.js             # Live-торговля
├── data/                   # Исторические данные
├── package.json
└── README.md
```

## Установка

```bash
npm install
```

Для команд, которые обращаются к T-Invest API, токен читается только из переменной окружения:

```bash
export T_INVEST_TOKEN=<your-token>
```

## Быстрый старт

### 1. Загрузка данных

```bash
T_INVEST_TOKEN=<your-token> diviner --mode fetch --security SBER --from-date 2024-01-01 --till-date 2024-12-31 --interval 24 --parquet > sber_2024.parquet
```

### 2. Запуск бэктеста

```bash
diviner --mode backtest sber_2024.parquet --strategy path/to/your-strategy.js
```

### JSON-выгрузка с конвертацией

```bash
T_INVEST_TOKEN=<your-token> diviner --mode fetch --security SBER --from-date 2024-01-01 --till-date 2024-12-31 --interval 24 > sber_2024.json
diviner --mode convert --input-json sber_2024.json --output-parquet sber_2024.parquet
```

## Команды

### `diviner` — единая точка входа

```bash
diviner --mode <backtest|live|fetch|convert> [опции выбранного режима]
```

`diviner` читает только `--mode`, а остальные флаги передаёт выбранному режиму без изменений.

| Опция | Описание |
|-------|----------|
| `--mode backtest` | Запустить бэктест |
| `--mode live` | Запустить live-торговлю или sandbox-утилиты |
| `--mode fetch` | Загрузить свечи через Tinkoff API |
| `--mode convert` | Конвертировать JSON → Parquet |

Примеры:

```bash
T_INVEST_TOKEN=<your-token> diviner --mode fetch --security SBER --from-date 2024-01-01
diviner --mode backtest sber_2024.parquet --strategy path/to/your-strategy.js --balance 10000
T_INVEST_TOKEN=<your-token> diviner --mode live --create-account --increase-balance 10000
T_INVEST_TOKEN=<your-token> diviner --mode live --strategy path/to/your-strategy.js --ticker SBER --sandbox --account <sandbox-account-id>
diviner --mode convert --input-json sber_2024.json --output-parquet sber_2024.parquet
```

### `fetch` — Загрузка данных

```bash
T_INVEST_TOKEN=<your-token> diviner --mode fetch --security SBER --from-date 2024-01-01 --till-date 2024-12-31 --interval 24
```

| Опция | Описание | По умолчанию |
|-------|----------|-------------|
| `--security` | Тикер бумаги | `SBER` |
| `--ticker` | Alias для `--security` | — |
| `--class-code` | Код класса инструмента | `TQBR` |
| `--from-date` | Дата начала (YYYY-MM-DD) | — |
| `--till-date` | Дата окончания (YYYY-MM-DD) | сегодня |
| `--interval` | Интервал: 1=1m, 2=2m, 3=3m, 5=5m, 10=10m, 15=15m, 30=30m, 60=1h, 120=2h, 240=4h, 24=1d, 7=1w, 31=1M | `24` |
| `--parquet` | Писать Parquet в stdout вместо JSON | выкл |
| `--request-delay-ms` | Пауза между API-запросами при длинной загрузке | `100` |

Даты интерпретируются как календарные дни в московском времени. Команда не фильтрует свечи по выходным и не задаёт источник свечей: выгружаются данные, которые Tinkoff API отдаёт по умолчанию. Без `--parquet` команда печатает JSON в формате, совместимом с `convert`.

**Пример — сразу скачать Parquet:**

```bash
T_INVEST_TOKEN=<your-token> diviner --mode fetch --security SBER --from-date 2024-01-01 --till-date 2024-12-31 --interval 1 --parquet > data/sber_2024.parquet
```

Parquet-файл содержит metadata инструмента (`ticker`, `classCode`, `figi`, `instrumentUid`, `exchange`, `lot`) и сами свечи. Историческое расписание рядом с данными не записывается: backtest восстанавливает календарь торгов только из свечей текущего файла.

### `convert` — Конвертация

```bash
diviner --mode convert --input-json sber_2024.json --output-parquet sber_2024.parquet
```

| Опция | Описание |
|-------|----------|
| `--input-json` | Путь к JSON (или stdin) |
| `--output-parquet` | Путь к Parquet (или stdout) |

### `backtest` — Бэктест

```bash
diviner --mode backtest sber_2024.parquet --strategy path/to/your-strategy.js
```

| Опция | Описание | По умолчанию |
|-------|----------|-------------|
| `--strategy` | Путь к файлу стратегии | — |
| `--balance` | Начальный баланс | `10000` |
| `--commission` | Комиссия | `0.0001` |
| `--verbose` | Выводить полную историю сделок | выкл |

`--balance` относится только к бэктесту и задаёт стартовый виртуальный баланс стратегии.

Данные можно передать через pipe:

```bash
cat sber_2024.parquet | diviner --mode backtest --strategy path/to/your-strategy.js
```

**Пример с --verbose:**

```bash
diviner --mode backtest sber_2024.parquet --strategy path/to/your-strategy.js --verbose
```

Без флага `--verbose` история сделок (`trade_log`) будет пустым массивом, что уменьшает размер вывода.

В backtest расписание не читается из Parquet metadata и не запрашивается через T-Invest API: backtest-движок без предупреждений восстанавливает его из самих свечей. Календарь отдаёт стратегии только факт торгового дня, время открытия и время закрытия.

Стратегии получают свечи и расписание через `StrategyContext`: сама стратегия не читает переменные окружения, не знает тикер, инструмент, биржу и режим запуска.

Внутри backtest разделён на несколько слоёв: `BacktestRunner` прогоняет свечи, `Portfolio` хранит cash/позицию/сделки, `BacktestBroker` исполняет операции портфеля, `ExecutionAdapter` подключает broker к API стратегии, а `PerformanceMetrics` собирает отчёт.

### `live` — Live-трейдинг

Торговля в реальном времени через Tinkoff Investments API. Поддерживается sandbox и реальный счёт.

**Архитектура:**
- `tinkoff-client.js` - клиент Tinkoff API с валидацией параметров
- `live-engine.js` - движок live-торговли с синхронизацией состояния
- `order-manager.js` - управление ордерами с проверкой параметров
- `state-manager.js` - управление состоянием позиции

```bash
T_INVEST_TOKEN=<your-token> diviner --mode live --strategy path/to/your-strategy.js --ticker AFKS --sandbox --account <sandbox-account-id>
```

| Опция | Описание | По умолчанию |
|-------|----------|-------------|
| `--strategy` | Путь к файлу стратегии | — |
| `--ticker` | Тикер бумаги | — |
| `--account` | ID счёта для live-торговли и команд, работающих с конкретным sandbox-счётом | — |
| `--sandbox` | Режим песочницы | выкл |
| `--list-sandboxes` | Вывести список sandbox-счетов и завершиться | выкл |
| `--create-account` | Создать новый sandbox-счёт и завершиться | выкл |
| `--remove-account` | Удалить sandbox-счёт из `--account` и завершиться | выкл |
| `--print-balance` | Вывести cash, стоимость long-акций, обязательства по short-акциям и оценочную equity sandbox-счёта | выкл |
| `--reset-positions` | Обнулить sandbox-позиции по акциям без изменения RUB-баланса, если это возможно через API | выкл |
| `--log` | Дублировать весь вывод в указанный файл | — |
| `--increase-balance` | Увеличить RUB-баланс sandbox-счёта на указанную сумму | — |
| `--interval` | Интервал свечей: 1, 5, 15, 60, 120, 240, 1440 | `1` |
| `--commission` | Комиссия | `0.0001` |
| `--order-retries` | Количество повторов заявки при временных ошибках API (`INTERNAL`, `RESOURCE_EXHAUSTED`, `UNAVAILABLE`) | `2` |
| `--verbose` | Логировать всю информацию включая свечи | выкл |
| `--dry-run` | Dry run: стратегия работает, ордера не отправляются | выкл |

**Режимы:**

- **Sandbox** (`--sandbox`): виртуальные деньги, безопасно для тестирования
- **Dry-run** (`--dry-run`): стратегия работает, ордера не отправляются
- **Live**: реальные торги (без флагов)

**Особенности новой системы:**
- Валидация всех параметров ордеров перед отправкой в API
- Синхронизация состояния стратегии с фактической позицией по инструменту на счёте перед подпиской на live-свечи
- Стратегии получают историю и расписание через `StrategyContext`; источник данных выбирает backtest/live-движок
- Сигналы стратегии исполняются через общий `ExecutionAdapter`: в backtest он работает с `BacktestBroker`/`Portfolio`, в live — с `LiveBroker`, `OrderManager` и `StateManager`
- Подписка обрабатывает только закрытые свечи и игнорирует дубли/старые свечи
- Market-data stream автоматически переподписывается после сетевого разрыва или `CANCELLED` и догружает закрытые свечи, пропущенные во время разрыва
- Расчёт размера заявки по умолчанию учитывает лотность инструмента
- Live-режим рассчитывает размер заявки от фактического RUB-баланса счёта
- Market-заявки проверяются по статусу исполнения и количеству исполненных лотов
- Увеличение RUB-баланса sandbox-счёта через `--increase-balance`
- Создание и удаление sandbox-счетов через `--create-account` и `--remove-account`
- Обнуление sandbox-позиций по акциям через `--reset-positions` с сохранением RUB-баланса
- Повторная отправка заявки с тем же `orderId` при временных ошибках API
- Проверка SL/TP в реальном времени
- Graceful shutdown с закрытием позиций
- Все сообщения live-команды печатаются с ISO-временем в начале строки
- Логи можно дублировать в файл через `--log`

**Пример — тестирование в sandbox:**

```bash
T_INVEST_TOKEN=<your-token> diviner --mode live --strategy path/to/your-strategy.js --ticker AFKS --sandbox --account <sandbox-account-id> --dry-run
```

**Пример — sandbox с реальными заявками в песочнице:**

```bash
T_INVEST_TOKEN=<your-token> diviner --mode live --create-account --increase-balance 10000 --print-balance
T_INVEST_TOKEN=<your-token> diviner --mode live --strategy path/to/your-strategy.js --ticker SBER --sandbox --account <sandbox-account-id> --verbose
```

Первая команда создаст sandbox-счёт и пополнит его на `10000` RUB. Вторая запустит стратегию на созданном счёте.

**Пример — запись логов в файл:**

```bash
T_INVEST_TOKEN=<your-token> diviner --mode live --strategy path/to/your-strategy.js --ticker SBER --sandbox --account <sandbox-account-id> --log logs/diviner-live.log
```

**Пример — список sandbox-счетов:**

```bash
T_INVEST_TOKEN=<your-token> diviner --mode live --list-sandboxes
```

**Пример — создать sandbox-счёт:**

```bash
T_INVEST_TOKEN=<your-token> diviner --mode live --create-account
```

**Пример — удалить sandbox-счёт:**

```bash
T_INVEST_TOKEN=<your-token> diviner --mode live --remove-account --account <sandbox-account-id>
```

**Пример — баланс sandbox-счёта:**

```bash
T_INVEST_TOKEN=<your-token> diviner --mode live --print-balance --account <sandbox-account-id>
```

Пример вывода:

```text
[Sandbox] Balance for account: <sandbox-account-id>
[Sandbox] Cash: 19370.43 RUB
[Sandbox] Blocked cash: empty
[Sandbox] Long shares value: empty
[Sandbox] Short shares liability: 9368.50 RUB
[Sandbox] Estimated equity: 10001.93 RUB
[Sandbox] Short share: ticker=SBER figi=BBG004730N88 quantity=-290 lots=29 price=32.31 RUB value=9368.50 RUB
```

`Cash` — реальные деньги на счёте. `Long shares value` — текущая рыночная стоимость акций в long. `Short shares liability` — текущая стоимость акций, которые нужно выкупить для закрытия short. `Estimated equity` считается как `Cash + Long shares value - Short shares liability`.

Если открытых позиций по акциям нет, команда дополнительно выведет `Open share positions: none`.

**Пример — увеличить баланс sandbox-счёта без запуска стратегии:**

```bash
T_INVEST_TOKEN=<your-token> diviner --mode live --increase-balance 10000 --account <sandbox-account-id>
```

Команда увеличит RUB-баланс указанного sandbox-счёта на `10000`. T-Invest sandbox API предоставляет метод `SandboxPayIn` для пополнения счёта, но не метод установки произвольного баланса.

**Пример — обнулить позиции по акциям и отдельно увеличить RUB-баланс:**

```bash
T_INVEST_TOKEN=<your-token> diviner --mode live --account <sandbox-account-id> --reset-positions --increase-balance 10000
```

При совместном использовании `--increase-balance` применяется до `--reset-positions`, а `--reset-positions` сохраняет текущий RUB-баланс. Если на счёте есть long-позиции по акциям, команда откажется выполнять сброс: T-Invest sandbox не предоставляет API для удаления бумаг без сделки, продажа меняет RUB-баланс, а списание лишних RUB через `SandboxPayIn` отклоняется API.

## Стратегии

### Создание своей стратегии

Стратегия наследуется от базового класса `Strategy`:

```javascript
import { Strategy } from '../core/strategy.js';

export class MyStrategy extends Strategy {
  init() {
    // Инициализация индикаторов
  }

  next() {
    // Логика на каждом баре
    if (/* условие для покупки */) {
      this.buy();
    }
    if (/* условие для продажи */) {
      this.sell();
    }
  }
}
```

### Методы стратегии

| Метод | Описание |
|-------|----------|
| `this.buy(size?, sl?, tp?)` | Открыть длинную позицию |
| `this.sell(size?, sl?, tp?)` | Открыть короткую позицию |
| `this.closePosition()` | Закрыть текущую позицию |
| `this.I(calculator, ...args)` | Создать индикатор |

### Свойства стратегии

| Свойство | Описание |
|----------|----------|
| `this.data` | Массив свечей |
| `this.position` | Текущая позиция |
| `this.cash` | Доступные средства |

---
*Проект спроектирован в соответствии с принципами UNIX-way и KISS.*
