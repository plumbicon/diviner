import { createHash } from "node:crypto";

/**
 * Order Manager — validates order parameters before they go to the API.
 */
export class OrderManager {
    constructor(client, options = {}) {
        this.client = client;
        this.verbose = options.verbose || false;
        this.dryRun = options.dryRun || false;
    }

    /**
     * Validate order parameters.
     * @private
     */
    _validateOrderParams(params) {
        const { figi, instrumentId, quantity, price, direction, orderId } = params;
        const resolvedInstrumentId = instrumentId || figi;

        if (!resolvedInstrumentId || typeof resolvedInstrumentId !== "string") {
            throw new Error(`Invalid instrumentId: ${resolvedInstrumentId}`);
        }

        // Validate quantity
        if (!quantity || isNaN(quantity) || quantity <= 0) {
            throw new Error(`Invalid order quantity: ${quantity}`);
        }

        const validatedQuantity = Math.round(quantity);

        // Validate price (limit orders)
        if (price !== undefined && price !== null) {
            if (isNaN(price) || price <= 0) {
                throw new Error(`Invalid order price: ${price}`);
            }
        }

        // Validate direction
        if (direction !== "buy" && direction !== "sell") {
            throw new Error(`Invalid order direction: ${direction}`);
        }

        return {
            figi,
            instrumentId: resolvedInstrumentId,
            quantity: validatedQuantity,
            price: price !== undefined && price !== null ? price : null,
            direction,
            // Idempotency key (API order_id). Optional; client.postOrder falls back to
            // a random UUID when absent. See buildOrderId below.
            orderId: orderId || undefined,
        };
    }

    /**
     * Send a market order.
     * @param {object} params - { figi, quantity, direction }
     */
    async postMarketOrder(params) {
        const validated = this._validateOrderParams(params);

        if (this.dryRun) {
            if (this.verbose) {
                console.log(
                    `[OrderManager] DRY RUN: Market ${validated.direction} order for ${validated.quantity} lots`,
                );
            }
            return { orderId: "dry-run", status: "dry-run" };
        }

        if (this.verbose) {
            console.log(
                `[OrderManager] Posting market ${validated.direction} order: ${validated.quantity} lots`,
            );
        }

        try {
            const result = await this.client.postOrder({
                figi: validated.figi,
                instrumentId: validated.instrumentId,
                quantity: validated.quantity,
                direction: validated.direction,
                orderType: "market",
                orderId: validated.orderId,
                // Consent to an order that may open an uncovered (margin) position —
                // required for shorts/leverage; ignored by covered orders.
                confirmMarginTrade: Boolean(params.confirmMarginTrade),
            });
            return result;
        } catch (error) {
            throw new Error(`Failed to post market order: ${error.message}`);
        }
    }

    /**
     * Send a limit order.
     * @param {object} params - { figi, quantity, direction, price }
     */
    async postLimitOrder(params) {
        const validated = this._validateOrderParams(params);

        if (!validated.price) {
            throw new Error("Price is required for limit orders");
        }

        if (this.dryRun) {
            if (this.verbose) {
                console.log(
                    `[OrderManager] DRY RUN: Limit ${validated.direction} order for ${validated.quantity} lots at ${validated.price}`,
                );
            }
            return { orderId: "dry-run", status: "dry-run" };
        }

        if (this.verbose) {
            console.log(
                `[OrderManager] Posting limit ${validated.direction} order: ${validated.quantity} lots at ${validated.price}`,
            );
        }

        try {
            const result = await this.client.postOrder({
                figi: validated.figi,
                instrumentId: validated.instrumentId,
                quantity: validated.quantity,
                direction: validated.direction,
                price: validated.price,
                orderType: "limit",
                orderId: validated.orderId,
            });
            return result;
        } catch (error) {
            throw new Error(`Failed to post limit order: ${error.message}`);
        }
    }

    /**
     * Close a position (an opposite market order).
     * @param {object} params - { figi, quantity, currentSide }
     */
    async closePosition(params) {
        const { figi, instrumentId, quantity, currentSide, orderId } = params;
        const closeDirection = currentSide === "long" ? "sell" : "buy";

        if (this.verbose) {
            console.log(
                `[OrderManager] Closing ${currentSide} position with ${closeDirection} order: ${quantity} lots`,
            );
        }

        return this.postMarketOrder({
            figi,
            instrumentId,
            quantity,
            direction: closeDirection,
            orderId,
        });
    }
}

/**
 * Build a human-meaningful idempotency key for an order, so it can later be
 * correlated with strategy logs.
 *
 * Layout (sanitised to [A-Za-z0-9_-], hard-capped at the API's 36-char limit):
 *   <tag>-<ticker>-<O|C><B|S>-<yyMMddHHmmss>   (timestamp in UTC)
 * e.g. `div-ALRS-OS-260613040100` = open short on ALRS for the 2026-06-13
 * 04:01:00 candle.
 *
 * IMPORTANT — what this id is and isn't:
 *  - It is the API's `order_id` / `order_request_id` (idempotency key). It is
 *    echoed back by PostOrder and visible via getOrderState / getOrders / the
 *    order-state stream, so you can match an order to the candle that triggered
 *    it.
 *  - It is NOT a free-text comment and does NOT appear in the operations
 *    history (getOperations) or broker report — those carry only the exchange
 *    order id. The T-Invest API has no per-operation comment field.
 *  - The broker dedups idempotency keys for ~1 month, so the trailing timestamp
 *    keeps each order unique; same-second retries intentionally reuse the key.
 *
 * The API (and the sandbox especially) validates order_id as a UUID, so the
 * human-readable key above is used only as the *seed* for a deterministic
 * UUIDv5. Same seed → same UUID, which preserves the idempotency property
 * (same-second retries reuse the id, broker dedups for ~1 month) while
 * satisfying the strict UUID format requirement.
 *
 * @param {object} params - { tag, ticker, action: 'open'|'close', direction:
 *                            'buy'|'sell', at?: Date }
 * @returns {string} Deterministic UUIDv5 idempotency key.
 */
export function buildOrderId({ tag, ticker, action, direction, at = new Date() }) {
    const iso = (at instanceof Date && !Number.isNaN(at.getTime()) ? at : new Date()).toISOString();
    const ts = iso.slice(2, 4) + iso.slice(5, 7) + iso.slice(8, 10)
        + iso.slice(11, 13) + iso.slice(14, 16) + iso.slice(17, 19);
    const a = action === "close" ? "C" : "O";
    const d = direction === "sell" ? "S" : "B";
    const raw = `${tag || "div"}-${ticker || "x"}-${a}${d}-${ts}`;
    const h = createHash("sha1").update(raw).digest("hex");
    const variant = ((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, "0");
    return [
        h.slice(0, 8),
        h.slice(8, 12),
        `5${h.slice(13, 16)}`,
        `${variant}${h.slice(18, 20)}`,
        h.slice(20, 32),
    ].join("-");
}
