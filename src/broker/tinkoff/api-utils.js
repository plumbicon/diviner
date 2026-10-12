/**
 * Small helpers shared by the T-Invest client modules: API error formatting, gRPC
 * status names, numbers out of API messages, and a bounded wait.
 */
import { Helpers } from "tinkoff-invest-api";

const GRPC_CODE_NAMES = {
    1: "CANCELLED",
    2: "UNKNOWN",
    3: "INVALID_ARGUMENT",
    4: "DEADLINE_EXCEEDED",
    5: "NOT_FOUND",
    6: "ALREADY_EXISTS",
    7: "PERMISSION_DENIED",
    8: "RESOURCE_EXHAUSTED",
    9: "FAILED_PRECONDITION",
    10: "ABORTED",
    11: "OUT_OF_RANGE",
    12: "UNIMPLEMENTED",
    13: "INTERNAL",
    14: "UNAVAILABLE",
    15: "DATA_LOSS",
    16: "UNAUTHENTICATED",
};

/**
 * Name of a gRPC status code.
 * @param {number} code - Numeric status code.
 * @returns {string} Status name, "UNKNOWN" for anything unlisted.
 */
export function grpcCodeName(code) {
    return GRPC_CODE_NAMES[code] || "UNKNOWN";
}

/**
 * One-line description of an API error: message, gRPC code, tracking id and rate
 * limit headers when present — everything support asks for.
 * @param {Error|object} error - Error thrown by the API client.
 * @returns {string} Description.
 */
export function formatApiError(error) {
    const code = error?.code !== undefined ? `${grpcCodeName(error.code)}(${error.code})` : null;
    const details = error?.details || error?.message || String(error);
    const trackingId = error?.trackingId ? `trackingId=${error.trackingId}` : null;
    const ratelimitRemaining = error?.ratelimitRemaining ? `ratelimitRemaining=${error.ratelimitRemaining}` : null;
    const ratelimitReset = error?.ratelimitReset ? `ratelimitReset=${error.ratelimitReset}` : null;
    return [details, code, trackingId, ratelimitRemaining, ratelimitReset].filter(Boolean).join(" | ");
}

/**
 * Number out of an API Quotation/MoneyValue.
 * @param {object|null|undefined} value - `{units, nano}`, possibly with currency.
 * @returns {number|null} Finite number, or null when absent or not a number.
 */
export function toNumber(value) {
    if (!value) {
        return null;
    }
    const number = Helpers.toNumber(value);
    return Number.isFinite(number) ? number : null;
}

/**
 * Resolve after `ms` milliseconds.
 * @param {number} ms - Delay.
 * @returns {Promise<void>} Timer promise.
 */
export function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

/**
 * Await a promise for at most `ms`, otherwise reject with the given message.
 * @param {Promise} promise - Promise to await.
 * @param {number} ms - Time limit.
 * @param {() => string} message - Error text on timeout.
 * @returns {Promise<*>} Result of the promise.
 */
export async function withTimeout(promise, ms, message) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(message())), ms);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}
