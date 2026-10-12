/**
 * Account side of the T-Invest client: balances, positions, operations history, and
 * sandbox account management (create, remove, top up, reset share positions).
 */
import { Helpers, RealAccount, SandboxAccount } from "tinkoff-invest-api";
import { InstrumentIdType } from "tinkoff-invest-api/dist/generated/instruments.js";
import { formatApiError, toNumber } from "./api-utils.js";
import { orderExecutionSummary } from "./orders.js";

const HISTORY_DEFAULT_DAYS = 183;

/** Money positions as `{currency, value}`. */
function moneyList(moneyPositions) {
    return moneyPositions.map((money) => ({
        currency: money.currency || "unknown",
        value: Helpers.toNumber(money),
    }));
}

/** RUB amount of a balance report. */
function rubOf(balance) {
    const rub = balance.money.find((money) => money.currency?.toLowerCase() === "rub");
    return rub ? rub.value : 0;
}

/** MoneyValue as `{currency, value}`, or null when not a number. */
function moneyValue(value) {
    const amount = toNumber(value);
    return Number.isFinite(amount) ? { currency: value.currency || "unknown", value: amount } : null;
}

/** Open share positions of a portfolio, longs first, then by ticker. */
function sharePositions(portfolioPositions) {
    return portfolioPositions
        .map((position) => {
            const quantity = toNumber(position.quantity);
            if (position.instrumentType !== "share" || !Number.isFinite(quantity) || quantity === 0) {
                return null;
            }
            const currentPrice = moneyValue(position.currentPrice);
            const averagePrice = moneyValue(position.averagePositionPrice);
            const quantityLots = toNumber(position.quantityLots);
            return {
                figi: position.figi,
                ticker: position.ticker || null,
                name: position.name || null,
                instrumentType: position.instrumentType,
                side: quantity > 0 ? "long" : "short",
                quantity,
                lots: Number.isFinite(quantityLots) ? Math.abs(quantityLots) : null,
                averagePrice: averagePrice?.value ?? null,
                currentPrice: currentPrice?.value ?? null,
                currency: currentPrice?.currency || averagePrice?.currency || "unknown",
                marketValue: currentPrice ? Math.abs(quantity) * currentPrice.value : null,
            };
        })
        .filter(Boolean)
        .sort((a, b) => (a.side !== b.side
            ? a.side.localeCompare(b.side)
            : (a.ticker || a.figi).localeCompare(b.ticker || b.figi)));
}

/**
 * Sum `{currency, value}` items per currency.
 * @param {Array<[Array<{currency: string, value: number}>, number]>} parts - Lists with a sign (+1/-1).
 * @returns {Array<{currency: string, value: number}>} Totals sorted by currency.
 */
function sumByCurrency(parts) {
    const totals = new Map();
    for (const [items, sign] of parts) {
        for (const item of items) {
            if (!Number.isFinite(item.value)) continue;
            const key = item.currency || "unknown";
            totals.set(key, (totals.get(key) || 0) + sign * item.value);
        }
    }
    return [...totals.entries()]
        .map(([currency, value]) => ({ currency, value }))
        .sort((a, b) => a.currency.localeCompare(b.currency));
}

/** Market value of share positions of one side, per currency. */
function sideValues(positions, side) {
    return positions
        .filter((p) => p.side === side && Number.isFinite(p.marketValue))
        .map((p) => ({ currency: p.currency, value: p.marketValue }));
}

/** Balance totals: cash, positions, free cash and estimated equity per currency. */
function balanceTotals({ money, blocked, shares }) {
    const cash = sumByCurrency([[money, 1]]);
    const longShares = sumByCurrency([[sideValues(shares, "long"), 1]]);
    const shortShares = sumByCurrency([[sideValues(shares, "short"), 1]]);
    const estimatedEquity = sumByCurrency([[cash, 1], [longShares, 1], [shortShares, -1]]);
    const positionsValue = sumByCurrency([[longShares, 1], [shortShares, 1]]);
    return {
        cash,
        blockedCash: sumByCurrency([[blocked, 1]]),
        longShares,
        shortShares,
        positionsValue,
        freeCash: sumByCurrency([[estimatedEquity, 1], [positionsValue, -1]]),
        estimatedEquity,
    };
}

export class AccountService {
    /**
     * @param {object} client - TinkoffClient: provides `api`, `sandbox`, `verbose` and the
     *   current `accountId`/`account`, which sandbox management may change.
     */
    constructor(client) {
        this.client = client;
    }

    get api() {
        return this.client.api;
    }

    /** Sandbox accounts, without creating a new one. */
    async listSandboxAccounts() {
        try {
            const { accounts } = await this.api.sandbox.getSandboxAccounts({});
            return accounts || [];
        } catch (error) {
            throw new Error(`Failed to list sandbox accounts: ${formatApiError(error)}`);
        }
    }

    /** Open a new sandbox account and make it the client's account. */
    async createSandboxAccount() {
        try {
            const { accountId } = await this.api.sandbox.openSandboxAccount({});
            this.client.accountId = accountId;
            this.client.account = new SandboxAccount(this.api, accountId);
            return { accountId };
        } catch (error) {
            throw new Error(`Failed to create sandbox account: ${formatApiError(error)}`);
        }
    }

    /** Close a sandbox account. */
    async removeSandboxAccount(accountId = this.client.accountId) {
        if (!accountId) {
            throw new Error("Sandbox account ID is required.");
        }
        try {
            await new SandboxAccount(this.api, accountId).close();
            if (this.client.accountId === accountId) {
                this.client.accountId = null;
                this.client.account = null;
            }
            return { accountId };
        } catch (error) {
            throw new Error(`Failed to remove sandbox account: ${formatApiError(error)}`);
        }
    }

    /** Balance of a sandbox account (the first one when no id is given). */
    async getSandboxBalance(accountId = this.client.accountId) {
        const resolvedAccountId = accountId || await this._firstSandboxAccountId();
        return this._balanceReport(new SandboxAccount(this.api, resolvedAccountId), resolvedAccountId, "sandbox");
    }

    /**
     * Balance and positions of a REAL account. The id is required: there is no
     * auto-pick of the first real account.
     * @param {string|null} accountId - Real account id.
     */
    async getRealBalance(accountId = this.client.accountId) {
        if (!accountId) {
            throw new Error("accountId is required to fetch real balance.");
        }
        return this._balanceReport(new RealAccount(this.api, accountId), accountId, "real");
    }

    /**
     * Increase the RUB balance of a sandbox account.
     * @param {string|null} accountId - Sandbox account id; the first one when not given.
     * @param {number|string} amount - Amount to pay in.
     */
    async increaseSandboxBalance(accountId = this.client.accountId, amount) {
        const resolvedAccountId = accountId || await this._firstSandboxAccountId();
        const parsedAmount = Number(amount);
        if (!Number.isFinite(parsedAmount) || parsedAmount < 0) {
            throw new Error(`Invalid sandbox balance increase amount: ${amount}`);
        }

        try {
            const before = await this.getSandboxBalance(resolvedAccountId);
            const beforeRubBalance = rubOf(before);
            if (parsedAmount < 0.01) {
                return { accountId: resolvedAccountId, amount: 0, beforeRubBalance, afterRubBalance: beforeRubBalance, balance: before };
            }
            await new SandboxAccount(this.api, resolvedAccountId).payIn(Helpers.toMoneyValue(parsedAmount, "rub"));
            const after = await this.getSandboxBalance(resolvedAccountId);
            return {
                accountId: resolvedAccountId,
                amount: parsedAmount,
                beforeRubBalance,
                afterRubBalance: rubOf(after),
                balance: after,
            };
        } catch (error) {
            throw new Error(`Failed to increase sandbox balance: ${formatApiError(error)}`);
        }
    }

    /**
     * Operations history of an account over a period, real or sandbox depending on the
     * client mode: a flat list sorted by time, with the ticker resolved from FIGI.
     * @param {string|null} accountId - Account id; in sandbox mode the first account when not given.
     * @param {object} [range] - { from?: Date, to?: Date }; the last 6 months by default.
     * @returns {Promise<{accountId: string, from: Date, to: Date, operations: Array}>} History.
     */
    async getOperationsHistory(accountId = this.client.accountId, { from, to } = {}) {
        const sandbox = this.client.sandbox;
        const resolvedAccountId = sandbox
            ? (accountId || await this._firstSandboxAccountId())
            : (accountId || this.client.accountId);
        if (!resolvedAccountId) {
            throw new Error("accountId is required to fetch operations history.");
        }

        const fromDate = from || new Date(Date.now() - HISTORY_DEFAULT_DAYS * 24 * 60 * 60 * 1000);
        const toDate = to || new Date();
        const request = { accountId: resolvedAccountId, from: fromDate, to: toDate };

        try {
            const { operations } = sandbox
                ? await this.api.sandbox.getSandboxOperations(request)
                : await this.api.operations.getOperations(request);

            const tickerCache = new Map();
            const items = [];
            for (const op of operations) {
                items.push({
                    date: op.date || null,
                    type: op.type,
                    figi: op.figi || null,
                    ticker: op.figi ? await this._tickerByFigi(op.figi, tickerCache) : null,
                    quantity: op.quantity,
                    payment: Helpers.toNumber(op.payment) || 0,
                    currency: (op.currency || "").toUpperCase(),
                });
            }
            items.sort((a, b) => (a.date?.getTime() || 0) - (b.date?.getTime() || 0));
            return { accountId: resolvedAccountId, from: fromDate, to: toDate, operations: items };
        } catch (error) {
            throw new Error(`Failed to get operations history: ${formatApiError(error)}`);
        }
    }

    /** Current RUB balance of the account. */
    async getRubBalance(accountId = this.client.accountId) {
        if (this.client.sandbox) {
            return rubOf(await this.getSandboxBalance(accountId));
        }
        const account = this.client.account;
        if (!account) {
            throw new Error("Account not initialized. Call init() first.");
        }
        const positions = await account.getPositions();
        const rub = moneyList(positions.money || []).find((money) => money.currency?.toLowerCase() === "rub");
        return rub ? rub.value : 0;
    }

    /** Raw portfolio position by FIGI, or null. */
    async getPosition(figi) {
        try {
            const portfolio = await this.client.account.getPortfolio();
            return portfolio.positions?.find((p) => p.figi === figi) || null;
        } catch (error) {
            throw new Error(`Failed to get position: ${error.message}`);
        }
    }

    /**
     * Actual position of an instrument, quantity in shares and in lots.
     * @param {string} figi - Instrument FIGI.
     * @param {number} [lotSize] - Lot size, used when the API omits the lot count.
     * @returns {Promise<object|null>} { figi, instrumentType, side, quantity, lots,
     *   averagePrice, currentPrice }, or null when flat.
     */
    async getInstrumentPosition(figi, lotSize = 1) {
        const position = await this.getPosition(figi);
        if (!position) {
            return null;
        }
        const quantity = toNumber(position.quantity);
        if (!Number.isFinite(quantity) || quantity === 0) {
            return null;
        }
        const quantityLots = toNumber(position.quantityLots);
        const resolvedLotSize = Number(lotSize) > 0 ? Number(lotSize) : 1;
        return {
            figi: position.figi,
            instrumentType: position.instrumentType,
            side: quantity > 0 ? "long" : "short",
            quantity,
            lots: Number.isFinite(quantityLots) && quantityLots !== 0
                ? Math.abs(quantityLots)
                : Math.ceil(Math.abs(quantity) / resolvedLotSize),
            averagePrice: toNumber(position.averagePositionPrice),
            currentPrice: toNumber(position.currentPrice),
        };
    }

    /**
     * Open share positions of a sandbox account.
     * @param {string|null} accountId - Sandbox account id.
     */
    async getSandboxSharePositions(accountId = this.client.accountId) {
        const resolvedAccountId = accountId || await this._firstSandboxAccountId();
        this.client.accountId = resolvedAccountId;
        const account = new SandboxAccount(this.api, resolvedAccountId);

        try {
            const portfolio = await account.getPortfolio();
            const raw = (portfolio.positions || []).filter((position) => {
                const quantity = toNumber(position.quantity);
                return position.instrumentType === "share" && Number.isFinite(quantity) && quantity !== 0;
            });
            const positions = [];
            for (const position of raw) {
                positions.push({ ...position, quantity: toNumber(position.quantity), lots: await this._positionLots(position) });
            }
            return { accountId: resolvedAccountId, positions };
        } catch (error) {
            throw new Error(`Failed to get sandbox share positions: ${formatApiError(error)}`);
        }
    }

    /**
     * Check that share positions can be reset without changing the RUB balance.
     * @param {string|null} accountId - Sandbox account id.
     */
    async assertCanResetSandboxSharePositions(accountId = this.client.accountId) {
        return this.getSandboxSharePositions(accountId);
    }

    /**
     * Close sandbox share positions while keeping the RUB balance: positions are closed
     * by market orders, then the RUB lost on the way is paid back in.
     * @param {string|null} accountId - Sandbox account id.
     */
    async closeSandboxSharePositions(accountId = this.client.accountId) {
        const resolvedAccountId = accountId || await this._firstSandboxAccountId();
        this.client.accountId = resolvedAccountId;
        this.client.account = new SandboxAccount(this.api, resolvedAccountId);

        try {
            const beforeRubBalance = rubOf(await this.getSandboxBalance(resolvedAccountId));
            const { positions } = await this.assertCanResetSandboxSharePositions(resolvedAccountId);

            const closed = [];
            for (const position of positions) {
                const { quantity, lots } = position;
                if (!Number.isFinite(lots) || lots <= 0) {
                    continue;
                }
                const direction = quantity > 0 ? "sell" : "buy";
                const order = await this.client.postOrder({
                    figi: position.figi,
                    instrumentId: position.instrumentUid || position.figi,
                    quantity: lots,
                    direction,
                    orderType: "market",
                });
                const summary = orderExecutionSummary(order);
                closed.push({
                    figi: position.figi,
                    direction,
                    lots,
                    lotsExecuted: summary.lotsExecuted,
                    status: summary.statusName,
                    orderId: order.orderId,
                });
            }

            const afterClose = await this.getSandboxBalance(resolvedAccountId);
            const restoreAmount = beforeRubBalance - rubOf(afterClose);
            if (restoreAmount < -0.01) {
                console.warn(
                    `[Sandbox] RUB balance increased by ${Math.abs(restoreAmount).toFixed(2)} after closing long positions `
                    + "(sandbox limitation — cannot decrease balance).",
                );
            }
            const balance = restoreAmount > 0.01
                ? (await this.increaseSandboxBalance(resolvedAccountId, restoreAmount)).balance
                : afterClose;

            return { accountId: resolvedAccountId, closed, beforeRubBalance, afterRubBalance: rubOf(balance), balance };
        } catch (error) {
            throw new Error(`Failed to close sandbox share positions: ${formatApiError(error)}`);
        }
    }

    /**
     * Pay in the RUB amount configured for the sandbox before trading.
     * @param {number|string|null} configured - Amount from the options; nothing when absent.
     */
    async increaseConfiguredSandboxBalance(configured) {
        if (configured === null || configured === undefined) {
            return;
        }
        const amount = Number(configured);
        if (!Number.isFinite(amount) || amount < 0) {
            return;
        }
        const result = await this.increaseSandboxBalance(this.client.accountId, amount);
        if (this.client.verbose) {
            console.log(result.amount === 0
                ? "[TinkoffClient] Sandbox RUB balance increase is 0; no adjustment needed."
                : `[TinkoffClient] Sandbox RUB balance increased by ${result.amount} RUB.`);
        }
    }

    /**
     * One balance report for RealAccount and SandboxAccount alike.
     * @param {object} account - RealAccount or SandboxAccount.
     * @param {string} accountId - Account id.
     * @param {string} label - Account kind, for the error message.
     * @private
     */
    async _balanceReport(account, accountId, label) {
        try {
            const positions = await account.getPositions();
            const portfolio = await account.getPortfolio();
            const money = moneyList(positions.money || []);
            const blocked = moneyList(positions.blocked || []);
            const shares = sharePositions(portfolio.positions || []);
            return {
                accountId,
                money,
                blocked,
                securities: (positions.securities || [])
                    .filter((position) => position.balance || position.blocked)
                    .map((position) => ({
                        figi: position.figi,
                        balance: position.balance,
                        blocked: position.blocked,
                        instrumentType: position.instrumentType,
                    })),
                sharePositions: shares,
                totals: balanceTotals({ money, blocked, shares }),
            };
        } catch (error) {
            throw new Error(`Failed to get ${label} balance: ${formatApiError(error)}`);
        }
    }

    /** @private */
    async _firstSandboxAccountId() {
        const accounts = await this.listSandboxAccounts();
        if (accounts.length === 0) {
            throw new Error("No sandbox accounts found.");
        }
        return accounts[0].id;
    }

    /**
     * FIGI → ticker with a cache. Returns null on failure (the bare FIGI is printed then).
     * @private
     */
    async _tickerByFigi(figi, cache) {
        if (cache.has(figi)) {
            return cache.get(figi);
        }
        let ticker = null;
        try {
            const { instrument } = await this.api.instruments.getInstrumentBy({
                idType: InstrumentIdType.INSTRUMENT_ID_TYPE_FIGI,
                id: figi,
            });
            ticker = instrument?.ticker || null;
        } catch {
            ticker = null;
        }
        cache.set(figi, ticker);
        return ticker;
    }

    /** Lots of a position: from the API, or from the quantity and the instrument's lot. @private */
    async _positionLots(position) {
        const quantityLots = toNumber(position.quantityLots);
        if (Number.isFinite(quantityLots) && quantityLots !== 0) {
            return Math.abs(Math.round(quantityLots));
        }
        const quantity = toNumber(position.quantity);
        if (!Number.isFinite(quantity) || quantity === 0) {
            return 0;
        }
        const id = position.instrumentUid || position.figi;
        const idType = position.instrumentUid ? InstrumentIdType.INSTRUMENT_ID_TYPE_UID : InstrumentIdType.INSTRUMENT_ID_TYPE_FIGI;
        const { instrument } = await this.api.instruments.getInstrumentBy({ idType, id });
        return Math.ceil(Math.abs(quantity) / (Number(instrument?.lot) || 1));
    }
}
