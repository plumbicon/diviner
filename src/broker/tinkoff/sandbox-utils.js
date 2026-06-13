import { TinkoffClient } from "./client.js";

/**
 * Run sandbox account utilities that do not require a strategy:
 * list / create / remove accounts, increase balance, reset positions,
 * print balance. Driven entirely by a flat config object.
 *
 * @param {object} config - Parsed CLI options.
 * @returns {Promise<number>} Process exit code.
 */
export async function runUtility(config = {}) {
    const token = process.env.T_INVEST_TOKEN || "";
    if (!token) {
        throw new Error("T_INVEST_TOKEN environment variable is required");
    }

    validateUtilityOptions(config);

    const client = new TinkoffClient(token, {
        sandbox: true,
        accountId: config.account || null,
        orderRetries: parseInt(config.orderRetries ?? "2", 10),
        verbose: config.verbose,
    });

    try {
        let accountId = config.account || null;

        if (config.removeAccount) {
            const removed = await client.removeSandboxAccount(accountId);
            console.log(`[Sandbox] Account removed: ${removed.accountId}`);
            return 0;
        }

        if (config.createAccount) {
            const created = await client.createSandboxAccount();
            accountId = created.accountId;
            console.log(`[Sandbox] Account created: ${created.accountId}`);
        }

        if (config.listSandboxes) {
            printSandboxAccounts(await client.listSandboxAccounts());
        }

        if (config.resetPositions) {
            await client.assertCanResetSandboxSharePositions(accountId);
        }

        if (hasIncreaseBalance(config)) {
            const amount = parseNonNegativeAmount(config.increaseBalance, "--increase-balance");
            const result = await client.increaseSandboxBalance(accountId, amount);
            accountId = result.accountId;
            printSandboxBalanceIncrease(result);
        }

        if (config.resetPositions) {
            const result = await client.closeSandboxSharePositions(accountId);
            accountId = result.accountId;
            printSandboxPositionReset(result);
        }

        if (config.printBalance) {
            printSandboxBalance(await client.getSandboxBalance(accountId));
        }

        if (config.printHistory) {
            printOperationsHistory(await client.getOperationsHistory(accountId, parseHistoryRange(config)));
        }
    } catch (error) {
        console.error("[Main] Fatal error:", error.message);
        return 1;
    } finally {
        await client.close();
    }

    return 0;
}

/**
 * Whether the given config requests a sandbox utility (no strategy run).
 * @param {object} config - Parsed CLI options.
 * @returns {boolean} True if a utility action is requested.
 */
export function isUtilityRequest(config = {}) {
    return Boolean(
        config.listSandboxes
        || config.createAccount
        || config.removeAccount
        || config.printBalance
        || config.printHistory
        || (config.resetPositions && !config.strategy)
        || (hasIncreaseBalance(config) && !config.strategy),
    );
}

function hasIncreaseBalance(config) {
    return config.increaseBalance !== undefined;
}

function validateUtilityOptions(config) {
    const accountSpecific = config.removeAccount
        || config.printBalance
        || config.printHistory
        || config.resetPositions
        || hasIncreaseBalance(config);

    if (accountSpecific && !config.createAccount && !config.account) {
        throw new Error("option '--account <id>' is required for account-specific sandbox commands");
    }
    if (config.printHistory && config.historyFrom && !/^\d{4}-\d{2}-\d{2}$/.test(config.historyFrom)) {
        throw new Error("option '--history-from' must be a date in YYYY-MM-DD format");
    }
    if (
        config.removeAccount
        && (config.createAccount || config.listSandboxes || hasIncreaseBalance(config)
            || config.resetPositions || config.printBalance)
    ) {
        throw new Error("option '--remove-account' cannot be combined with account mutation/inspection flags");
    }
    if (hasIncreaseBalance(config)) {
        parseNonNegativeAmount(config.increaseBalance, "--increase-balance");
    }
}

function parseNonNegativeAmount(value, optionName) {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount < 0) {
        throw new Error(`option '${optionName}' must be a non-negative number`);
    }
    return amount;
}

function parseHistoryRange(config) {
    if (!config.historyFrom) {
        return {};
    }
    return { from: new Date(`${config.historyFrom}T00:00:00Z`) };
}

function printOperationsHistory({ accountId, from, to, operations }) {
    const day = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : "?");
    console.log(`[History] Account ${accountId}  (${day(from)} .. ${day(to)})`);
    if (operations.length === 0) {
        console.log("[History] No operations in the selected window.");
        return;
    }

    let net = 0;
    let fees = 0;
    for (const op of operations) {
        net += op.payment;
        if (/комисси|fee|commission/i.test(op.type)) {
            fees += op.payment;
        }
        const when = op.date ? op.date.toISOString() : "?";
        const instr = op.ticker || op.figi || "-";
        const qty = op.quantity ? ` qty=${op.quantity}` : "";
        const amount = `${op.payment >= 0 ? "+" : ""}${op.payment.toFixed(2)} ${op.currency}`;
        console.log(`[History] ${when}  ${String(op.type).padEnd(34)} ${amount.padStart(16)}  ${instr}${qty}`);
    }
    console.log(`[History] Operations: ${operations.length}  | fees: ${fees.toFixed(2)}  | net flow: ${net.toFixed(2)}`);
}

function printSandboxAccounts(accounts) {
    if (accounts.length === 0) {
        console.log("[Sandbox] No sandbox accounts found.");
        return;
    }
    console.log(`[Sandbox] Accounts: ${accounts.length}`);
    for (const account of accounts) {
        const name = account.name ? ` name="${account.name}"` : "";
        const status = account.status !== undefined ? ` status=${account.status}` : "";
        console.log(`[Sandbox] id=${account.id}${name}${status}`);
    }
}

function printSandboxBalance(balance) {
    console.log(`[Sandbox] Balance for account: ${balance.accountId}`);
    printCurrencyValues("[Sandbox] Equity", balance.totals?.estimatedEquity || []);
    printCurrencyValues("[Sandbox]   Free cash", balance.totals?.freeCash || []);
    printNonZeroCurrencyValues("[Sandbox] Blocked cash", balance.totals?.blockedCash || []);
    printNonZeroCurrencyValues("[Sandbox] Long positions", balance.totals?.longShares || []);
    printNonZeroCurrencyValues("[Sandbox] Short debt", balance.totals?.shortShares || []);

    for (const blocked of balance.blocked) {
        if (blocked.value !== 0) {
            console.log(`[Sandbox] Blocked: ${blocked.value.toFixed(2)} ${blocked.currency.toUpperCase()}`);
        }
    }

    if (balance.sharePositions?.length > 0) {
        for (const position of balance.sharePositions) {
            const label = position.side === "short" ? "Short share" : "Long share";
            const ticker = position.ticker ? ` ticker=${position.ticker}` : "";
            const lots = Number.isFinite(position.lots) ? ` lots=${position.lots}` : "";
            const price = Number.isFinite(position.currentPrice)
                ? ` price=${formatCurrency(position.currentPrice, position.currency)}` : " price=n/a";
            const value = Number.isFinite(position.marketValue)
                ? ` value=${formatCurrency(position.marketValue, position.currency)}` : " value=n/a";
            console.log(`[Sandbox] ${label}:${ticker} figi=${position.figi} quantity=${position.quantity}${lots}${price}${value}`);
        }
    } else {
        console.log("[Sandbox] Open share positions: none");
    }

    const valuedFigis = new Set((balance.sharePositions || []).map((p) => p.figi));
    for (const security of balance.securities.filter((s) => !valuedFigis.has(s.figi))) {
        console.log(`[Sandbox] Raw security: figi=${security.figi} balance=${security.balance} blocked=${security.blocked} type=${security.instrumentType}`);
    }
}

function printCurrencyValues(label, values) {
    const printable = values.filter((item) => Number.isFinite(item.value));
    if (printable.length === 0) {
        console.log(`${label}: empty`);
        return;
    }
    for (const item of printable) {
        console.log(`${label}: ${formatCurrency(item.value, item.currency)}`);
    }
}

function printNonZeroCurrencyValues(label, values) {
    const printable = values.filter((item) => Number.isFinite(item.value) && item.value !== 0);
    for (const item of printable) {
        console.log(`${label}: ${formatCurrency(item.value, item.currency)}`);
    }
}

function formatCurrency(value, currency) {
    return `${value.toFixed(2)} ${String(currency || "unknown").toUpperCase()}`;
}

function printSandboxBalanceIncrease(result) {
    if (result.amount === 0) {
        console.log(`[Sandbox] Account ${result.accountId} balance unchanged: ${result.beforeRubBalance.toFixed(2)} RUB`);
    } else {
        console.log(`[Sandbox] Account ${result.accountId} balance increased by ${result.amount.toFixed(2)} RUB: ${result.beforeRubBalance.toFixed(2)} -> ${result.afterRubBalance.toFixed(2)} RUB`);
    }
    printSandboxBalance(result.balance);
}

function printSandboxPositionReset(result) {
    if (result.closed.length === 0) {
        console.log(`[Sandbox] No share positions to close for account: ${result.accountId}`);
        return;
    }
    console.log(`[Sandbox] Closed share positions for account: ${result.accountId}`);
    for (const position of result.closed) {
        console.log(`[Sandbox] Position closed: figi=${position.figi} direction=${position.direction} lots=${position.lotsExecuted}/${position.lots} status=${position.status} orderId=${position.orderId}`);
    }
    console.log(`[Sandbox] RUB balance preserved: ${result.beforeRubBalance.toFixed(2)} -> ${result.afterRubBalance.toFixed(2)} RUB`);
}
