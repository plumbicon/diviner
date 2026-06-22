/**
 * Единая логика срабатывания stop-loss / take-profit.
 *
 * Чистая функция: по позиции и текущей цене возвращает причину выхода либо null.
 * Используется и backtest-путём (через Strategy), и live-путём (через StateManager),
 * чтобы условия триггера жили в одном месте.
 *
 * @param {{side: string, sl: number|null, tp: number|null}|null} position - Текущая позиция.
 * @param {number} price - Текущая цена (close).
 * @returns {'sl'|'tp'|null} Причина выхода или null.
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
 * Внутрисвечная проверка SL/TP для бэктеста: триггерит по диапазону свечи
 * (high/low), а не только по close — то есть стоп считается сработавшим, если
 * цена коснулась уровня в пределах минуты, даже если к закрытию вернулась в
 * коридор. Если за одну свечу задеты и SL, и TP, приоритет у SL (пессимистично:
 * 1m-бар не хранит порядок тиков, поэтому считаем худший исход).
 *
 * Только backtest-путь: live видит лишь текущую цену тика, будущих high/low у
 * него нет — там остаётся close-проверка через {@link evaluateStops}.
 *
 * @param {{side: string, sl: number|null, tp: number|null}|null} position - Позиция.
 * @param {{high: number, low: number}} candle - Текущая свеча.
 * @returns {'sl'|'tp'|null} Причина выхода или null.
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
 * Выход позиции по времени (третий вид выхода наряду с SL/TP).
 *
 * Чистая функция: позиция несёт абсолютный дедлайн `exitDeadline` (epoch ms),
 * заданный стратегией при открытии. Возвращает 'time', когда `now` достиг
 * дедлайна. В отличие от SL/TP это событие часов, а не цены — поэтому в live его
 * применяет не только потиковый путь движка, но и wall-clock-таймер брокера
 * (на случай, когда рыночная свеча в конце сессии не пришла).
 *
 * @param {{exitDeadline?: number|null}|null} position - Текущая позиция.
 * @param {number} now - Текущее время (epoch ms).
 * @returns {'time'|null} Причина выхода или null.
 */
export function evaluateTimeExit(position, now) {
    if (!position || position.exitDeadline == null) {
        return null;
    }
    return now >= position.exitDeadline ? "time" : null;
}
