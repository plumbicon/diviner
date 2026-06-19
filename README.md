# Diviner

**Diviner** — экосистема для бэктестинга и live-трейдинга торговых стратегий на MOEX (и крипты
через OKX): загрузка данных, конвертация в Parquet, бэктесты и торговля в реальном времени
через Tinkoff Investments API.

Архитектура построена вокруг одного принципа: **брокер — единственный носитель различия между
backtest и live**. Движок один и слеп — он тактирует поток свечей, централизованно оркеструет
SL/TP и передаёт сигналы брокеру, ничего не зная про деньги, режим и источник данных.

```bash
npm install
export T_INVEST_TOKEN=<your-token>

# бэктест всех тикеров
node scripts/backtest.mjs --strategy A07 --year 2026 --leverage 4 --intrabar-stops

# live (sandbox)
diviner --broker src/broker/tinkoff/broker.js --strategy src/strategies/A07/A07.js \
  --ticker SBER --sandbox --account <id> --leverage 4 --intrabar-stops
```

## Документация для разработчиков → [`devs/`](devs/)

Вся техническая документация по проекту живёт в каталоге **`devs/`**:

- [`devs/paths.md`](devs/paths.md) — структура проекта: где что лежит, два репозитория, что не коммитится в git.
- [`devs/structure.md`](devs/structure.md) — архитектура: как взаимодействуют брокер, движок и стратегия на программном уровне.
- [`devs/usage.md`](devs/usage.md) — CLI-справка: backtest / live / fetch / convert / аккаунт-утилиты, цикл разработки.

---
*Проект спроектирован в соответствии с принципами UNIX-way и KISS.*
