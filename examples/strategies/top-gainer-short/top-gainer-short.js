/**
 * Example cross-sectional strategy: once a day, short the instruments that rose the most
 * since the open.
 *
 * Shows everything a strategy over a universe needs:
 *   - the candle comes as the `next(candle)` argument with a `ticker` field — a
 *     multi-ticker run keeps no history in `this.data`;
 *   - a minute is released as a batch over all instruments, the last candle of the batch
 *     is marked `isBatchEnd` — instruments can only be compared on it;
 *   - an order is addressed to an instrument: `this.execution.sell({ ticker, budget, sl, exitDeadline })`;
 *   - slot occupancy — `getPositions()` and `isBusy(ticker)`, equity — `getEquity()`;
 *   - a time exit is `exitDeadline`, checked by the engine.
 *
 * Parameters (environment variables):
 *   TGS_ENTRY    — entry minute, "HH:MM" Moscow (11:00);
 *   TGS_EXIT     — exit deadline, "HH:MM" Moscow (18:30);
 *   TGS_SLOTS    — how many instruments to short at once (2);
 *   TGS_STOP_PCT — protective stop, % of the entry price (3).
 *
 * Run:
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

/** Moscow date and minute of the day. */
function msk(datetime) {
    const shifted = new Date(datetime.getTime() + MSK_OFFSET_MS);
    return {
        day: shifted.toISOString().slice(0, 10),
        minute: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
    };
}

export class TopGainerShort extends Strategy {
    init() {
        /** Ticker → { day, open, close } for the current day. */
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

        // Decide once a day, on the last candle of the batch at the entry minute or the first one after it.
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
