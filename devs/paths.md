# Структура проекта

Карта того, где что лежит. Программное взаимодействие компонентов — в [structure.md](structure.md);
CLI-справка — в [usage.md](usage.md).

## Дерево

```
diviner/                          репозиторий plumbicon/diviner
├── diviner                       sh-обёртка → node src/diviner.js
├── package.json
├── README.md                     краткое интро + указатель на devs/
├── devs/                         ← документация для разработчиков
│   ├── paths.md                  (этот файл) структура проекта
│   ├── structure.md              взаимодействие брокер/движок/стратегия
│   └── usage.md                  CLI: backtest / live / fetch / convert
│
├── scripts/
│   └── backtest.mjs              параллельный батч-бэктест всех тикеров (worker_threads)
│
├── src/
│   ├── diviner.js                точка входа: --broker / --fetch / --convert
│   ├── convert.js                JSON → Parquet
│   │
│   ├── broker/                   ← каждый брокер = своя директория со ВСЕМ своим кодом
│   │   ├── simulated/
│   │   │   └── broker.js         бэктест (плечо, intrabar-стопы, ликвидация)
│   │   ├── tinkoff/              live T-Invest
│   │   │   ├── broker.js · client.js · order-manager.js · sandbox-utils.js
│   │   │   └── fetch.js          загрузка свечей T-Invest → Parquet
│   │   ├── okx/                  крипта (ccxt perp-swap)
│   │   │   ├── broker.js · client.js · intervals.js
│   │   │   ├── fetch.js · fetch-batch.js · fetch-metrics.js
│   │   │   └── broker.test.js
│   │   └── common/               общее live-состояние
│   │       ├── state-manager.js · position-store.js
│   │
│   ├── core/                     ← режим-слепое ядро
│   │   ├── engine.js             тик-цикл + централизованная оркестрация SL/TP
│   │   ├── stops.js · portfolio.js · metrics.js
│   │   ├── strategy.js · strategy-loader.js · temporal-view.js
│   │   ├── market-data.js · market-cache.js · data-loader.js · candle-parquet.js
│   │   └── json-encoder.js · logger.js
│   │
│   └── strategies/               ← ВЛОЖЕННЫЙ репозиторий plumbicon/strategies (gitignored в diviner)
│       ├── A01/A01.js            простые (наследуют только core/strategy.js)
│       ├── A02/  A02.js + scripts/grid-search.mjs
│       ├── A03/A03.js
│       ├── A04/  A04.js + scripts/grid-search.mjs
│       ├── A05/                  ML (MOEX), самодостаточна
│       │   ├── A05.js            точка входа стратегии
│       │   ├── model.txt         обученная модель (НЕ в git — см. ниже)
│       │   ├── requirements.txt  python-зависимости
│       │   ├── src/lgbm.js       инференс LightGBM (своя копия)
│       │   └── scripts/train.py  обучение
│       ├── A06/                  крипто/OKX — Python-пайплайн, без JS-движка
│       │   ├── model_okx.txt · requirements.txt
│       │   └── scripts/train.py · backtest.py · validate.py
│       ├── A07/                  ML (MOEX) — боевая (как A05 + intrabar, TP=1.5/SL=2.0)
│       │   ├── A07.js · model_a07.txt · requirements.txt
│       │   ├── src/lgbm.js · scripts/train.py
│       └── scripts/              общие для репо стратегий (backtest-report, fetch-candles, generate-report)
│
├── data/                         Parquet 1m-свечи MOEX + data/okx/ (НЕ в git)
└── reports/                      .md отчёты бэктеста (НЕ в git)
```

## Два репозитория

| Репо | Где | Содержит |
|---|---|---|
| **plumbicon/diviner** | корень проекта | движок (`core`), брокеры (`broker`), CLI, `scripts/`, `devs/` |
| **plumbicon/strategies** | `src/strategies/` (gitignored в diviner) | код стратегий A01–A07 |

`src/strategies/` — это вложенный git-репозиторий. В diviner он в `.gitignore`, поэтому код стратегий
никогда не попадает в diviner-историю.

## Что НЕ коммитится в git

Ни в diviner, ни в strategies в git **не** должны попадать:

- **data** — Parquet-свечи (`data/`, `*.parquet`);
- **reports** — отчёты бэктеста (`reports/`, `*.md` отчётов);
- **модели** — `model*.txt` (большие бинарные артефакты, регенерируются обучением);
- в diviner дополнительно — **сам код стратегий** (`src/strategies/`).

Эти артефакты живут на диске и **доставляются на сервер через `rsync`**, а не через git.
Модель воспроизводится из данных скриптом `scripts/train.py` соответствующей стратегии.

## Деплой на сервер

- **diviner** обновляется на сервере через `git pull` (репозиторий доступен).
- **strategies** на сервере приватный без учётки → обновляется **через `rsync`**, не `git pull`:
  ```bash
  rsync -az --delete --exclude='.git' --exclude='node_modules' --exclude='__pycache__' \
    src/strategies/ admin@<host>:/home/admin/trading/src/strategies/
  ```
  rsync копирует и модели (они на диске), поэтому боты получают рабочие модели несмотря на gitignore.
