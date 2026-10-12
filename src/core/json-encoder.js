/**
 * JSON encoder for backtest results.
 */
export function encodeBacktestResult(result) {
    return JSON.stringify(result, (key, value) => {
        if (value instanceof Date) {
            return value.toISOString();
        }
        if (typeof value === "number" && (isNaN(value) || !isFinite(value))) {
            return null;
        }
        return value;
    }, 2);
}
