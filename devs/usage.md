# CLI: использование

Архитектура — [structure.md](structure.md).

## Установка

```bash
npm install
export T_INVEST_TOKEN=<your-token>   # для команд, обращающихся к T-Invest API
```

## Единая точка входа

```bash
diviner <путь-к-брокеру> --strategy <путь> [опции брокера]
```

`<путь-к-брокеру>` — обязательный позиционный аргумент, путь к файлу брокера (как `--strategy` —
путь к стратегии). Опции брокера валидируются по его `export const options`, поэтому добавить
брокера — это добавить файл, не трогая CLI.

Загрузка данных и конвертация в Parquet — не часть `diviner`, это отдельные скрипты в `scripts/`
(см. [Загрузка данных](#загрузка-данных) и [Конвертация](#конвертация) ниже).

## Бэктест одного инструмента (`simulated`)

```bash
diviner src/broker/simulated/broker.js data/tinkoff/SBER_2024_1m.parquet \
  --strategy <путь-к-стратегии> --balance 10000 --commission 0.0005
```

| Опция | Описание | По умолчанию |
|-------|----------|-------------|
| `--strategy` | Путь к файлу стратегии | — |
| `--balance` | Начальный виртуальный баланс | `10000` |
| `--commission` | Комиссия | `0.0005` |
| `--leverage` | Плечо (размер = 95%·cash·leverage) | `1` |
| `--intrabar-stops` | SL/TP по high/low, исполнение по уровню | выкл |
| `--model-liquidation` | gap-aware филлы + margin-call (с leverage>1) | выкл |
| `--verbose` | Включить `trade_log` в отчёт | выкл |
| `[source]` | Позиционный аргумент — Parquet (или stdin) | — |

Данные можно подать через pipe: `cat data/tinkoff/SBER_2024_1m.parquet | diviner src/broker/simulated/broker.js --strategy …`.
Отчёт печатается в stdout как JSON (`backtest_parameters`, `performance_metrics`, `trade_log`).

**Размер позиции по умолчанию:** `floor(cash·0.95·leverage / (price·lot))·lot`; размер лота —
из метаданных parquet, поэтому бэктест сайзит идентично live-брокеру.

## Бэктест всех тикеров (параллельно)

```bash
node scripts/backtest.mjs --strategy <ИМЯ> --year 2026 --leverage 4 --intrabar-stops [--workers 8] [--top 25]
```

Прогоняет все `data/tinkoff/*_<year>_1m.parquet` на пуле `worker_threads` (переопределяется
`BACKTEST_DATA_DIR`), печатает рейтинг по доходности
(+ MaxDD/Sharpe/Calmar/WinRate) и агрегаты. Резолвит стратегию как `src/strategies/<name>/<name>.js`.

## Live-трейдинг (`tinkoff`)

```bash
T_INVEST_TOKEN=<token> diviner src/broker/tinkoff/broker.js \
  --strategy <путь-к-стратегии> --ticker SBER --sandbox --account <id> \
  --leverage 4 --intrabar-stops --interval 1
```

| Опция | Описание | По умолчанию |
|-------|----------|-------------|
| `--ticker` | Тикер инструмента | — |
| `--account` | ID счёта | — |
| `--sandbox` | Песочница (виртуальные деньги) | выкл |
| `--dry-run` | Стратегия работает, ордера не шлются | выкл |
| `--leverage` | Плечо (>1 шлёт confirmMarginTrade) | `1` |
| `--intrabar-stops` | Проверять SL/TP по high/low live-свечи, закрывать по рынку | выкл |
| `--interval` | Интервал свечей в минутах | `1` |
| `--close-on-exit` | Закрыть позицию при остановке | выкл |
| `--order-retries` | Повторы заявки при временных ошибках | `2` |
| `--order-tag` | Метка в ключе идемпотентности ордера | `div` |
| `--verbose` | Логировать свечи и подробности | выкл |
| `--log <path>` | Дублировать вывод в файл | — |

Режимы: `--sandbox`, `--dry-run`, реальный счёт (без флагов). По SIGINT движок выходит из цикла,
брокер закрывает сессию (отписка, сводка, по `--close-on-exit` — закрытие позиции).

> ⚠️ Без `--verbose` стартовый вывод (подключение, баланс, подписка) печатается безусловно, а
> поминутный heartbeat свечей — только с `--verbose`.

> ⚠️ Макс. плечо шорта ограничено биржей (≈ `1/dShort`): для ликвидных MOEX-имён ~4.5–5×.
> При запросе выше лимита ордер отклоняется («Not enough balance»). На проде используется **4×**.

### Идентификация ордеров

Ключ идемпотентности (`order_id`) детерминированно строится из метки/тикера/действия/времени и
кодируется как UUIDv5 (песочница требует UUID-формат). Формат seed:
`<tag>-<ticker>-<O|C><B|S>-<yyMMddHHmmss>`. Это не «комментарий к сделке» — для богатых метаданных
ведите свой лог по этому ключу.

### Аккаунт-утилиты (без стратегии)

```bash
# Инспекция — работает и на боевом (по умолчанию), и в sandbox (с --sandbox):
diviner src/broker/tinkoff/broker.js --account <id> --print-balance
diviner src/broker/tinkoff/broker.js --account <id> --print-history --history-from 2026-06-01

# Управление тестовыми счетами — только sandbox (требуют --sandbox):
diviner src/broker/tinkoff/broker.js --sandbox --create-account [--increase-balance 10000]
diviner src/broker/tinkoff/broker.js --sandbox --list-sandboxes
```

Инспекция (`--print-balance`, `--print-history`) идёт по **боевому** счёту по умолчанию;
с `--sandbox` — по песочнице. Управление счетами
(`--list-sandboxes` · `--create-account` · `--remove-account` · `--reset-positions` ·
`--increase-balance <amount>`) существует только в sandbox-API и **требует** `--sandbox`.

## Загрузка данных

Не часть `diviner` — самостоятельный скрипт:

```bash
T_INVEST_TOKEN=<token> node scripts/fetch.mjs --security SBER --from-date 2024-01-01 \
  --till-date 2024-12-31 --interval 1 --parquet > data/tinkoff/SBER_2024_1m.parquet
```

| Опция | Описание | По умолчанию |
|-------|----------|-------------|
| `--security` / `--ticker` | Тикер | `SBER` |
| `--class-code` | Код класса | `TQBR` |
| `--from-date` / `--till-date` | Диапазон (YYYY-MM-DD, MSK) | — / сегодня |
| `--interval` | 1=1m, 5=5m, 15=15m, 60=1h, 240=4h, 24=1d, … | `24` |
| `--parquet` | Писать Parquet в stdout | выкл |

Крипта (OKX): `src/broker/okx/fetch.js`, `fetch-batch.js`, `fetch-metrics.js`.

## Конвертация

Не часть `diviner` — самостоятельный скрипт:

```bash
node scripts/convert.mjs --input-json sber.json --output-parquet sber.parquet
```
