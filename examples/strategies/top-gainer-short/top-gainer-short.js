/**
 * Пример кросс-секционной стратегии: раз в день шорт бумаг, сильнее всех выросших с открытия.
 *
 * Показывает всё, что нужно стратегии на вселенную бумаг:
 *   - свеча приходит аргументом `next(candle)` с полем `ticker` — истории в `this.data`
 *     у мультитикерного прогона нет;
 *   - минута отдаётся пачкой по всем бумагам, последняя свеча пачки помечена
 *     `isBatchEnd` — сравнивать бумаги можно только на ней;
 *   - заявка адресуется бумаге: `this.execution.sell({ ticker, budget, sl, exitDeadline })`;
 *   - занятость слотов — `getPositions()` и `isBusy(ticker)`, капитал — `getEquity()`;
 *   - выход по времени — `exitDeadline`, его проверяет движок.
 *
 * Параметры (переменные окружения):
 *   TGS_ENTRY  — минута входа, «ЧЧ:ММ» МСК (11:00);
 *   TGS_EXIT   — дедлайн выхода, «ЧЧ:ММ» МСК (18:30);
 *   TGS_SLOTS  — сколько бумаг шортить одновременно (2);
 *   TGS_STOP_PCT — защитный стоп, % от цены входа (3).
 *
 * Запуск:
 *   node examples/make-data.mjs --out work/examples/universe.parquet --tickers AAA,BBB,CCC,DDD,EEE
 *   node src/diviner.js src/broker/simulated/broker.js work/examples/universe.parquet \
 *     --strategy examples/strategies/top-gainer-short/top-gainer-short.js \
 *     --balance 100000 --fill-next-open --intrabar-stops
 */
import { Strategy } from "../../../src/core/strategy.js";

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;
const toMinutes = (hhmm) => {
    const [h, m] = hhmm.split(":").map(Number);
    return h * 60 + m;
};
const ENTRY_MIN = toMinutes(process.env.TGS_ENTRY ?? "11:00");
const EXIT_MIN = toMinutes(process.env.TGS_EXIT ?? "18:30");
const SLOTS = Number(process.env.TGS_SLOTS ?? 2);
const STOP_PCT = Number(process.env.TGS_STOP_PCT ?? 3);

/** Дата и минута дня по Москве. */
function msk(datetime) {
    const shifted = new Date(datetime.getTime() + MSK_OFFSET_MS);
    return {
        day: shifted.toISOString().slice(0, 10),
        minute: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
    };
}

export class TopGainerShort extends Strategy {
    init() {
        /** Тикер → { day, open, close } за текущий день. */
        this.today = new Map();
        this.enteredOn = null;
    }

    next(candle) {
        const { day, minute } = msk(candle.datetime);
        const seen = this.today.get(candle.ticker);
        if (!seen || seen.day !== day) {
            this.today.set(candle.ticker, { day, open: candle.open, close: candle.close });
        } else {
            seen.close = candle.close;
        }

        // Решение — раз в день, на последней свече пачки минуты входа или первой после неё.
        if (!candle.isBatchEnd || minute < ENTRY_MIN || this.enteredOn === day) return;
        this.enteredOn = day;

        const free = SLOTS - this.execution.getPositions().length;
        if (free <= 0) return;
        const candidates = [...this.today]
            .filter(([ticker, s]) => s.day === day && !this.execution.isBusy(ticker))
            .map(([ticker, s]) => ({ ticker, price: s.close, gain: s.close / s.open - 1 }))
            .sort((a, b) => b.gain - a.gain)
            .slice(0, free);

        const dayStartUtc = new Date(`${day}T00:00:00.000Z`).getTime() - MSK_OFFSET_MS;
        const budget = this.execution.getEquity() / SLOTS;
        for (const { ticker, price } of candidates) {
            this.execution.sell({
                ticker,
                budget,
                sl: price * (1 + STOP_PCT / 100),
                exitDeadline: dayStartUtc + EXIT_MIN * 60 * 1000,
            });
        }
    }
}
