/**
 * Order placement through the T-Invest API: validation, retries on transient errors,
 * and waiting for a market order to actually fill.
 */
import { randomUUID } from "node:crypto";
import { Helpers } from "tinkoff-invest-api";
import {
    OrderDirection,
    OrderExecutionReportStatus,
    OrderIdType,
    OrderType,
    orderExecutionReportStatusToJSON,
} from "tinkoff-invest-api/dist/generated/orders.js";
import { PriceType } from "tinkoff-invest-api/dist/generated/common.js";
import { formatApiError, sleep, toNumber } from "./api-utils.js";

// gRPC codes worth retrying: DEADLINE_EXCEEDED, RESOURCE_EXHAUSTED, ABORTED, INTERNAL, UNAVAILABLE.
const RETRYABLE_CODES = new Set([4, 8, 10, 13, 14]);
const RETRYABLE_MESSAGE = /\b(DEADLINE_EXCEEDED|RESOURCE_EXHAUSTED|ABORTED|INTERNAL|UNAVAILABLE)\b/;

/**
 * Short execution state of an order (PostOrder response or GetOrderState).
 * @param {object} order - Order state from the API.
 * @returns {object} { status, statusName, lotsRequested, lotsExecuted, avgPrice,
 *   isFilled, isPartiallyFilled, isRejectedOrCancelled }.
 */
export function orderExecutionSummary(order) {
    const status = order?.executionReportStatus ?? OrderExecutionReportStatus.EXECUTION_REPORT_STATUS_UNSPECIFIED;
    // Actual average fill price per instrument, when the exchange returns it — to audit
    // real fills (slippage against the model).
    const price = (value) => (value ? toNumber(value) : null);
    return {
        status,
        statusName: orderExecutionReportStatusToJSON(status),
        lotsRequested: Number(order?.lotsRequested) || 0,
        lotsExecuted: Number(order?.lotsExecuted) || 0,
        avgPrice: price(order?.executedOrderPrice) ?? price(order?.averagePositionPrice) ?? null,
        isFilled: status === OrderExecutionReportStatus.EXECUTION_REPORT_STATUS_FILL,
        isPartiallyFilled: status === OrderExecutionReportStatus.EXECUTION_REPORT_STATUS_PARTIALLYFILL,
        isRejectedOrCancelled: status === OrderExecutionReportStatus.EXECUTION_REPORT_STATUS_REJECTED
            || status === OrderExecutionReportStatus.EXECUTION_REPORT_STATUS_CANCELLED,
    };
}

/**
 * Whether an order error is transient and the order may be retried.
 * @param {Error|object} error - Error from the API.
 * @returns {boolean} Retry or not.
 */
export function isRetryableOrderError(error) {
    return RETRYABLE_CODES.has(error?.code) || RETRYABLE_MESSAGE.test(error?.message || "");
}

/** Human-readable order for the log. */
function describeOrder(orderParams) {
    const direction = orderParams.direction === OrderDirection.ORDER_DIRECTION_BUY ? "buy" : "sell";
    const type = orderParams.orderType === OrderType.ORDER_TYPE_LIMIT ? "limit" : "market";
    return `${type} ${direction} ${orderParams.quantity} lots (orderId=${orderParams.orderId})`;
}

export class OrderGateway {
    /**
     * @param {object} client - TinkoffClient: its `account` is used once `init()` has set it.
     * @param {object} [options] - { orderRetries, orderRetryDelayMs, verbose }.
     */
    constructor(client, options = {}) {
        this.client = client;
        this.retries = Number.isInteger(options.orderRetries) ? Math.max(options.orderRetries, 0) : 2;
        this.retryDelayMs = options.orderRetryDelayMs || 1000;
        this.verbose = Boolean(options.verbose);
    }

    /**
     * Post an order. A market order is awaited until it fills (or partially fills).
     * @param {object} params - { figi, instrumentId, quantity (lots), direction ('buy'|'sell'),
     *   price?, orderType? ('market'|'limit'), confirmMarginTrade?, orderId? }.
     * @returns {Promise<object>} Final order state.
     */
    async postOrder(params) {
        const account = this.client.account;
        if (!account) {
            throw new Error("Account not initialized. Call init() first.");
        }

        const {
            figi,
            instrumentId,
            quantity,
            direction,
            price,
            orderType = "market",
            confirmMarginTrade = false,
        } = params;

        try {
            const resolvedInstrumentId = instrumentId || figi;
            if (!resolvedInstrumentId || typeof resolvedInstrumentId !== "string") {
                throw new Error(`Invalid instrumentId: ${resolvedInstrumentId}`);
            }
            if (!quantity || isNaN(quantity) || quantity <= 0) {
                throw new Error(`Invalid order quantity: ${quantity}`);
            }
            const lots = Math.round(quantity);
            if (orderType === "limit" && (!price || isNaN(price) || price <= 0)) {
                throw new Error(`Invalid order price for limit order: ${price}`);
            }

            const orderId = params.orderId || randomUUID();
            const orderParams = {
                figi,
                instrumentId: resolvedInstrumentId,
                quantity: lots,
                direction: direction === "buy" ? OrderDirection.ORDER_DIRECTION_BUY : OrderDirection.ORDER_DIRECTION_SELL,
                orderType: orderType === "limit" ? OrderType.ORDER_TYPE_LIMIT : OrderType.ORDER_TYPE_MARKET,
                orderId: String(orderId),
            };
            // Allow opening an uncovered (margin/leveraged) position — e.g. shorts or
            // leverage > 1. Only set when requested so default (covered) orders are
            // unchanged. The API rejects uncovered orders unless this is true.
            if (confirmMarginTrade) {
                orderParams.confirmMarginTrade = true;
            }
            if (orderType === "limit" && price) {
                orderParams.price = Helpers.toQuotation(price);
            }

            if (this.verbose) {
                console.log(`[TinkoffClient] Posting order: ${direction} ${lots} lots at ${price || "market"} (orderId=${orderId})`);
            }

            const result = await this._postWithRetry(account, orderParams);
            if (orderType !== "market") {
                return result;
            }
            return this._waitForExecution(account, result, lots, orderId);
        } catch (error) {
            throw new Error(`Failed to post order: ${formatApiError(error)}`, { cause: error });
        }
    }

    /** @private */
    async _postWithRetry(account, orderParams) {
        for (let attempt = 0; attempt <= this.retries; attempt += 1) {
            try {
                const result = await account.postOrder(orderParams);
                if (attempt > 0) {
                    console.log(
                        `[TinkoffClient] Order retry succeeded: ${describeOrder(orderParams)} (${result.orderId || result.status || "accepted"})`,
                    );
                }
                return result;
            } catch (error) {
                if (attempt >= this.retries || !isRetryableOrderError(error)) {
                    throw error;
                }
                const delay = this.retryDelayMs * 2 ** attempt;
                console.warn(
                    `[TinkoffClient] Transient order error for ${describeOrder(orderParams)}: ${formatApiError(error)}. `
                    + `Retry ${attempt + 1}/${this.retries} in ${delay}ms...`,
                );
                await sleep(delay);
            }
        }
        throw new Error("Unexpected post order retry state");
    }

    /**
     * Wait until a market order actually executes: poll its state with growing pauses.
     * @private
     */
    async _waitForExecution(account, order, expectedLots, requestOrderId) {
        const first = orderExecutionSummary(order);
        if (first.isRejectedOrCancelled) {
            throw new Error(`Order ${order.orderId || requestOrderId} ${first.statusName}: ${order.message || "no details"}`);
        }
        if (first.lotsExecuted >= expectedLots || first.isFilled) {
            return order;
        }

        const orderId = order.orderId || requestOrderId;
        const orderIdType = order.orderId ? OrderIdType.ORDER_ID_TYPE_EXCHANGE : OrderIdType.ORDER_ID_TYPE_REQUEST;

        let lastState = order;
        for (let attempt = 0; attempt < 6; attempt += 1) {
            await sleep(250 * 2 ** attempt);
            try {
                lastState = await account.getOrderState({
                    orderId,
                    orderIdType,
                    priceType: PriceType.PRICE_TYPE_CURRENCY,
                });
            } catch (error) {
                if (this.verbose) {
                    console.warn(`[TinkoffClient] Failed to poll order state for ${orderId}: ${formatApiError(error)}`);
                }
                continue;
            }

            const summary = orderExecutionSummary(lastState);
            if (summary.isRejectedOrCancelled) {
                throw new Error(`Order ${orderId} ${summary.statusName}: ${lastState.message || "no details"}`);
            }
            if (summary.lotsExecuted >= expectedLots || summary.isFilled) {
                return lastState;
            }
        }

        const final = orderExecutionSummary(lastState);
        if (final.lotsExecuted > 0) {
            return lastState;
        }
        throw new Error(
            `Order ${orderId} was not executed: ${final.statusName}, lotsExecuted=${final.lotsExecuted}/${expectedLots}`,
        );
    }
}
