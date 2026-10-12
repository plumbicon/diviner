import { evaluateStops } from "../../core/stops.js";

/**
 * State Manager — keeps the intended position state and mirrors it to the strategy.
 */
export class StateManager {
    constructor(options = {}) {
        this.verbose = options.verbose;
        this.position = null;
    }

    /**
     * Open a position.
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
     * Close the position.
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
     * Current position.
     */
    getPosition() {
        return this.position;
    }

    /**
     * Set the current position directly.
     */
    setPosition(position) {
        this.position = position ? { ...position } : null;

        if (this.verbose) {
            console.log(`[StateManager] Position set: ${this.position ? `${this.position.side} ${this.position.size} lots` : "none"}`);
        }
    }

    /**
     * Update the size of the current position.
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
     * Whether a position is open.
     */
    hasPosition() {
        return this.position !== null;
    }

    /**
     * Side of the position.
     */
    getSide() {
        return this.position ? this.position.side : null;
    }

    /**
     * Mirror the state into the strategy's own position field.
     */
    syncWithStrategy(strategy) {
        if (strategy._position !== this.position) {
            strategy._position = this.position;
            if (this.verbose) {
                console.log(`[StateManager] Synced strategy position: ${this.position ? this.position.side : "none"}`);
            }
        }
    }

    /**
     * SL/TP check at the current price.
     * @returns {boolean} - true when SL or TP was hit
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
     * Reset the position state.
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
