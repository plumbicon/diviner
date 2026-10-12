/**
 * The single stop-loss / take-profit trigger logic.
 *
 * A pure function: from a position and the current price it returns the exit reason or
 * null. Both the backtest and the live paths use it, so the trigger conditions live in
 * one place.
 *
 * @param {{side: string, sl: number|null, tp: number|null}|null} position - Current position.
 * @param {number} price - Current price (close).
 * @returns {'sl'|'tp'|null} Exit reason or null.
 */
export function evaluateStops(position, price) {
    if (!position) {
        return null;
    }

    const { side, sl, tp } = position;

    if (side === "long") {
        if (sl && price <= sl) return "sl";
        if (tp && price >= tp) return "tp";
    } else if (side === "short") {
        if (sl && price >= sl) return "sl";
        if (tp && price <= tp) return "tp";
    }

    return null;
}

/**
 * Intrabar SL/TP check: triggers on the candle range (high/low), not only on the close —
 * a stop counts as hit if the price touched the level within the minute, even if it came
 * back inside by the close. If one candle touches both SL and TP, SL wins (pessimistic: a
 * 1m bar does not keep the tick order, so the worst outcome is assumed).
 *
 * Live, the executors apply it to the high/low of the closed candle that arrived.
 *
 * @param {{side: string, sl: number|null, tp: number|null}|null} position - Position.
 * @param {{high: number, low: number}} candle - Current candle.
 * @returns {'sl'|'tp'|null} Exit reason or null.
 */
export function evaluateIntrabarStop(position, candle) {
    if (!position || !candle) {
        return null;
    }

    const { side, sl, tp } = position;
    const { high, low } = candle;

    if (side === "long") {
        if (sl && low <= sl) return "sl";   // SL-first
        if (tp && high >= tp) return "tp";
    } else if (side === "short") {
        if (sl && high >= sl) return "sl";  // SL-first
        if (tp && low <= tp) return "tp";
    }

    return null;
}

/**
 * Time exit of a position (the third kind of exit besides SL/TP).
 *
 * A pure function: the position carries an absolute deadline `exitDeadline` (epoch ms)
 * set by the strategy at entry. Returns 'time' once `now` reaches the deadline. Unlike
 * SL/TP this is a clock event, not a price event — so live it is applied not only on the
 * engine's per-candle path but also by the broker's wall-clock timer (for when no market
 * candle arrives near the end of the session).
 *
 * @param {{exitDeadline?: number|null}|null} position - Current position.
 * @param {number} now - Current time (epoch ms).
 * @returns {'time'|null} Exit reason or null.
 */
export function evaluateTimeExit(position, now) {
    if (!position || position.exitDeadline == null) {
        return null;
    }
    return now >= position.exitDeadline ? "time" : null;
}

/**
 * Tell a trailing stop from a protective stop-loss.
 *
 * The engine reports `sl` for both — it is the same mechanism, only the level differs.
 * For reporting they are different events: a protective stop means the trade went
 * several percent against us, a trailing stop means the profit was locked by the
 * ratchet. Writing "closed by stop-loss" on a profitable exit misleads the reader.
 *
 * The sign: for a short the protective stop sits ABOVE the entry price, while the
 * trailing stop arms only after a move in our favour and is always BELOW the entry. For a
 * long it is mirrored.
 *
 * @param {{side: string, entryPrice: number, sl: number|null}|null} position - Position.
 * @returns {'trail'|'sl'} Refined reason.
 */
export function classifyStopExit(position) {
    if (!position || position.sl == null || !(position.entryPrice > 0)) return "sl";
    return position.side === "short"
        ? (position.sl < position.entryPrice ? "trail" : "sl")
        : (position.sl > position.entryPrice ? "trail" : "sl");
}
