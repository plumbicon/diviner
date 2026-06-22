import { evaluateStops } from "../../core/stops.js";

/**
 * State Manager - управление состоянием позиции
 * Обеспечивает синхронизацию между стратегией и реальным состоянием
 */
export class StateManager {
    constructor(options = {}) {
        this.verbose = options.verbose || false;
        this.position = null;
    }

    /**
     * Открыть позицию
     */
    openPosition(params) {
        const { side, size, entryPrice, entryTime, sl, tp, exitDeadline = null } = params;

        if (this.position) {
            if (this.verbose) {
                console.log(`[StateManager] Cannot open position: position already open (${this.position.side})`);
            }
            return false;
        }

        this.position = {
            side,
            size,
            entryPrice,
            entryTime,
            sl,
            tp,
            exitDeadline,
        };

        if (this.verbose) {
            console.log(`[StateManager] Position opened: ${side} ${size} lots at ${entryPrice}`);
        }
        return true;
    }

    /**
     * Закрыть позицию
     */
    closePosition() {
        if (!this.position) {
            if (this.verbose) {
                console.log(`[StateManager] Cannot close position: no position open`);
            }
            return false;
        }

        const closedPosition = { ...this.position };
        this.position = null;

        if (this.verbose) {
            console.log(`[StateManager] Position closed: ${closedPosition.side} ${closedPosition.size} lots`);
        }
        return closedPosition;
    }

    /**
     * Получить текущую позицию
     */
    getPosition() {
        return this.position;
    }

    /**
     * Установить текущую позицию напрямую.
     */
    setPosition(position) {
        this.position = position ? { ...position } : null;

        if (this.verbose) {
            console.log(`[StateManager] Position set: ${this.position ? `${this.position.side} ${this.position.size} lots` : 'none'}`);
        }
    }

    /**
     * Обновить размер текущей позиции.
     */
    updatePositionSize(size) {
        if (!this.position) {
            return false;
        }

        this.position = {
            ...this.position,
            size
        };

        if (this.verbose) {
            console.log(`[StateManager] Position size updated: ${size} lots`);
        }
        return true;
    }

    /**
     * Проверить, есть ли открытая позиция
     */
    hasPosition() {
        return this.position !== null;
    }

    /**
     * Получить сторону позиции
     */
    getSide() {
        return this.position ? this.position.side : null;
    }

    /**
     * Синхронизировать состояние со стратегией
     * Вызывается для обновления внутреннего состояния стратегии
     */
    syncWithStrategy(strategy) {
        if (strategy._position !== this.position) {
            strategy._position = this.position;
            if (this.verbose) {
                console.log(`[StateManager] Synced strategy position: ${this.position ? this.position.side : 'none'}`);
            }
        }
    }

    /**
     * Проверка SL/TP на основе текущей цены
     * @returns {boolean} - true если сработал SL или TP
     */
    checkStopLossTakeProfit(currentPrice) {
        const reason = evaluateStops(this.position, currentPrice);

        if (reason && this.verbose) {
            const { side, sl, tp } = this.position;
            const label = reason === "sl" ? "Stop Loss" : "Take Profit";
            const level = reason === "sl" ? sl : tp;
            console.log(`[StateManager] ${label} triggered for ${side} at ${currentPrice} (${reason.toUpperCase()}: ${level})`);
        }

        return reason;
    }

    /**
     * Сброс состояния позиции.
     */
    reset() {
        if (this.position) {
            if (this.verbose) {
                console.log(`[StateManager] Resetting state: closing open position`);
            }
            this.position = null;
        }
    }
}
