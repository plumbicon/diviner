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
