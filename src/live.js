#!/usr/bin/env node
import { Command } from "commander";
import { TinkoffClient } from "./live/tinkoff-client.js";
import { Engine } from "./core/engine.js";
import { createTinkoffBroker } from "./live/tinkoff-broker.js";
import { TemporalView } from "./core/temporal-view.js";
import { MarketDataCache } from "./core/market-cache.js";
import { loadStrategy } from "./core/strategy-loader.js";
import { createLogger } from "./core/logger.js";

const program = new Command();

function getLogPathFromArgv(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--log") {
      return argv[i + 1] || null;
    }
    if (arg.startsWith("--log=")) {
      return arg.slice("--log=".length);
    }
  }

  return null;
}

program
  .name("live")
  .description("Live trading via Tinkoff Invest API")
  .option("--strategy <path>", "Path to the strategy file")
  .option("--ticker <symbol>", "Ticker of the instrument (e.g., SBER)")
  .option("--account <id>", "Account ID for trading and account-specific sandbox commands")
  .option("--sandbox", "Enable sandbox mode (virtual money)", false)
  .option("--list-sandboxes", "List sandbox accounts and exit", false)
  .option("--create-account", "Create a new sandbox account", false)
  .option("--remove-account", "Remove the sandbox account from --account", false)
  .option(
    "--print-balance",
    "Print sandbox cash, long share value, short share liability, and estimated equity",
    false,
  )
  .option(
    "--reset-positions",
    "Reset sandbox share positions while preserving RUB balance",
    false,
  )
  .option("--log <path>", "Append all output to a log file")
  .option(
    "--increase-balance <amount>",
    "Increase sandbox account RUB balance by amount",
  )
  .option(
    "--interval <minutes>",
    "Candle interval in minutes (1, 5, 15, 60, 120, 240, 1440)",
    "1",
  )
  .option("--commission <rate>", "Commission rate", "0.0005")
  .option(
    "--order-retries <count>",
    "Retry count for transient order API errors",
    "2",
  )
  .option("--verbose", "Enable verbose logging", false)
  .option(
    "--dry-run",
    "Dry run: strategy runs, but no real orders are sent",
    false,
  )
  .option(
    "--close-on-exit",
    "Close any open position when the live session stops (default: leave it open)",
    false,
  );

const logger = createLogger({ logPath: getLogPathFromArgv(process.argv) });
logger.installConsole();
program.parse();
const options = program.opts();
const token = getInvestTokenFromEnv();

async function main() {
  validateTokenEnv();

  if (shouldRunSandboxUtility()) {
    validateSandboxUtilityOptions();
    const exitCode = await runSandboxUtility();
    await closeLogAndExit(exitCode);
  }

  validateTradingOptions();

  console.log("--- Diviner Live Trading ---");
  console.log(`Strategy: ${options.strategy}`);
  console.log(`Ticker: ${options.ticker}`);
  console.log(
    `Mode: ${options.sandbox ? "Sandbox" : "Production"}${options.dryRun ? " (Dry Run)" : ""}`,
  );
  console.log("----------------------------");

  let client;
  let broker;
  let engine;
  let isShuttingDown = false;

  const shutdown = async (message) => {
    if (isShuttingDown) {
      return;
    }

    isShuttingDown = true;
    console.log(message);

    // Страховка: гарантированно выйти, даже если сетевое закрытие зависнет.
    const forceExit = setTimeout(() => {
      console.error("[Main] Forced exit: graceful shutdown timed out.");
      process.exit(0);
    }, 5000);
    forceExit.unref();

    // Только просим поток завершиться: движок выйдет из цикла и вызовет
    // broker.finalize() (закрытие сессии/позиции по флагу + сводка + client.close).
    if (broker) {
      await broker.data.requestStop();
    }
  };

  try {
    // 1. Инициализация Tinkoff клиента
    client = new TinkoffClient(token, {
      sandbox: options.sandbox,
      accountId: getAccountId(),
      orderRetries: parseInt(options.orderRetries, 10),
      verbose: options.verbose,
    });

    await client.init();

    if (options.sandbox && options.resetPositions) {
      await client.assertCanResetSandboxSharePositions(client.accountId);
    }

    if (options.sandbox && hasIncreaseBalanceOption()) {
      const result = await client.increaseSandboxBalance(
        client.accountId,
        parseNonNegativeAmount(options.increaseBalance, "--increase-balance"),
      );
      printSandboxBalanceIncrease(result);
    }

    if (options.sandbox && options.resetPositions) {
      const reset = await client.closeSandboxSharePositions(client.accountId);
      printSandboxPositionReset(reset);
    }

    // 2. Получение информации об инструменте
    const instrument = await client.getInstrumentByTicker(options.ticker);
    if (options.verbose) {
      console.log(
        `[Main] Instrument found: ${instrument.name} (FIGI: ${instrument.figi})`,
      );
    }

    // 3. Сборка единого стека: TinkoffBroker { data, exec } + Cache + TemporalView + Engine
    const interval = parseInt(options.interval, 10);
    const StrategyClass = await loadStrategy(options.strategy);

    broker = createTinkoffBroker({
      client,
      instrument,
      interval,
      options: {
        verbose: options.verbose,
        dryRun: options.dryRun,
        closeOnExit: Boolean(options.closeOnExit),
      },
    });

    const context = new TemporalView({
      dataSource: new MarketDataCache(broker.data),
      metadata: {
        source: "tinkoff",
        instrument: broker.instrumentMetadata,
        interval,
        intervalMinutes: interval,
        intervalLabel: `${interval}m`,
        timezone: "Europe/Moscow",
      },
      logger: (message) => console.log(message),
    });

    const strategy = new StrategyClass([], 0, parseFloat(options.commission));
    engine = new Engine();

    // Обработка сигналов завершения (до запуска цикла тактирования)
    process.on("SIGINT", () => shutdown("\n[Main] Shutting down..."));
    process.on("SIGTERM", () => shutdown("\n[Main] Received SIGTERM, shutting down..."));

    console.log("[Main] Live trading started. Waiting for candles...");

    // 4. Запуск единого движка: тактирует поток до requestStop, затем finalize.
    await engine.run({
      broker,
      strategy,
      context,
      options: { verbose: options.verbose },
    });

    // Поток остановлен и finalize отработал (закрытие сессии + сводка).
    await closeLogAndExit(0);
  } catch (error) {
    console.error("[Main] Fatal error:", error.message);
    if (client) {
      await client.close();
    }
    await closeLogAndExit(1);
  }
}

async function closeLogAndExit(code) {
  process.exit(code);
}

function validateTradingOptions() {
  if (!options.strategy) {
    program.error("required option '--strategy <path>' not specified");
  }
  if (!options.ticker) {
    program.error("required option '--ticker <symbol>' not specified");
  }
  if (!options.account) {
    program.error("required option '--account <id>' not specified");
  }
  if (options.createAccount && !options.sandbox) {
    program.error("option '--create-account' can only be used with '--sandbox' when starting a strategy");
  }
  if (options.removeAccount) {
    program.error("option '--remove-account' cannot be used when starting a strategy");
  }
  if (hasIncreaseBalanceOption() && !options.sandbox) {
    program.error("option '--increase-balance' can only be used with '--sandbox' when starting a strategy");
  }
  if (options.resetPositions && !options.sandbox) {
    program.error("option '--reset-positions' can only be used with '--sandbox'");
  }
  if (hasIncreaseBalanceOption()) {
    parseNonNegativeAmount(options.increaseBalance, "--increase-balance");
  }
}

function validateSandboxUtilityOptions() {
  if (hasAccountSpecificSandboxAction() && !options.createAccount && !getAccountId()) {
    program.error("option '--account <id>' is required for account-specific sandbox commands");
  }
  if (
    options.removeAccount
    && (
      options.createAccount
      || options.listSandboxes
      || hasIncreaseBalanceOption()
      || options.resetPositions
      || options.printBalance
    )
  ) {
    program.error("option '--remove-account' cannot be combined with account mutation/inspection flags");
  }
  if (hasIncreaseBalanceOption()) {
    parseNonNegativeAmount(options.increaseBalance, "--increase-balance");
  }
}

function hasAccountSpecificSandboxAction() {
  return options.removeAccount
    || options.printBalance
    || options.resetPositions
    || hasIncreaseBalanceOption();
}

function shouldRunSandboxUtility() {
  return options.listSandboxes
    || options.createAccount
    || options.removeAccount
    || options.printBalance
    || (options.resetPositions && !options.strategy)
    || shouldIncreaseBalanceOnly();
}

function hasIncreaseBalanceOption() {
  return options.increaseBalance !== undefined;
}

function shouldIncreaseBalanceOnly() {
  return hasIncreaseBalanceOption() && !options.strategy;
}

async function runSandboxUtility() {
  const client = new TinkoffClient(token, {
    sandbox: true,
    accountId: getAccountId(),
    orderRetries: parseInt(options.orderRetries, 10),
    verbose: options.verbose,
  });

  try {
    let accountId = getAccountId();

    if (options.removeAccount) {
      const removed = await client.removeSandboxAccount(accountId);
      printSandboxAccountRemoved(removed);
      return 0;
    }

    if (options.createAccount) {
      const created = await client.createSandboxAccount();
      accountId = created.accountId;
      printSandboxAccountCreated(created);
    }

    if (options.listSandboxes) {
      const accounts = await client.listSandboxAccounts();
      printSandboxAccounts(accounts);
    }

    if (options.resetPositions) {
      await client.assertCanResetSandboxSharePositions(accountId);
    }

    if (hasIncreaseBalanceOption()) {
      const increaseAmount = parseNonNegativeAmount(
        options.increaseBalance,
        "--increase-balance",
      );
      const result = await client.increaseSandboxBalance(
        accountId,
        increaseAmount,
      );
      accountId = result.accountId;
      printSandboxBalanceIncrease(result);
    }

    if (options.resetPositions) {
      const result = await client.closeSandboxSharePositions(accountId);
      accountId = result.accountId;
      printSandboxPositionReset(result);
    }

    if (options.printBalance) {
      const balance = await client.getSandboxBalance(accountId);
      printSandboxBalance(balance);
    }
  } catch (error) {
    console.error("[Main] Fatal error:", error.message);
    return 1;
  } finally {
    await client.close();
  }

  return 0;
}

function getInvestTokenFromEnv() {
  return process.env.T_INVEST_TOKEN || "";
}

function getAccountId() {
  return options.account || null;
}

function validateTokenEnv() {
  if (!token) {
    program.error("T_INVEST_TOKEN environment variable is required");
  }
}

function parseNonNegativeAmount(value, optionName) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) {
    program.error(`option '${optionName}' must be a non-negative number`);
  }
  return amount;
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

function printSandboxAccountCreated(result) {
  console.log(`[Sandbox] Account created: ${result.accountId}`);
}

function printSandboxAccountRemoved(result) {
  console.log(`[Sandbox] Account removed: ${result.accountId}`);
}

function printSandboxBalance(balance) {
  console.log(`[Sandbox] Balance for account: ${balance.accountId}`);

  printCurrencyValues("[Sandbox] Cash", balance.totals?.cash || balance.money);
  printCurrencyValues("[Sandbox] Blocked cash", balance.totals?.blockedCash || []);
  printCurrencyValues("[Sandbox] Long shares value", balance.totals?.longShares || []);
  printCurrencyValues("[Sandbox] Short shares liability", balance.totals?.shortShares || []);
  printCurrencyValues("[Sandbox] Estimated equity", balance.totals?.estimatedEquity || []);

  for (const blocked of balance.blocked) {
    if (blocked.value !== 0) {
      console.log(
        `[Sandbox] Blocked: ${blocked.value.toFixed(2)} ${blocked.currency.toUpperCase()}`,
      );
    }
  }

  if (balance.sharePositions?.length > 0) {
    for (const position of balance.sharePositions) {
      const label = position.side === "short"
        ? "Short share"
        : "Long share";
      const ticker = position.ticker ? ` ticker=${position.ticker}` : "";
      const lots = Number.isFinite(position.lots) ? ` lots=${position.lots}` : "";
      const price = Number.isFinite(position.currentPrice)
        ? ` price=${formatCurrency(position.currentPrice, position.currency)}`
        : " price=n/a";
      const value = Number.isFinite(position.marketValue)
        ? ` value=${formatCurrency(position.marketValue, position.currency)}`
        : " value=n/a";

      console.log(
        `[Sandbox] ${label}:${ticker} figi=${position.figi} quantity=${position.quantity}${lots}${price}${value}`,
      );
    }
  } else {
    console.log("[Sandbox] Open share positions: none");
  }

  const valuedFigis = new Set((balance.sharePositions || []).map((position) => position.figi));
  const rawSecurities = balance.securities.filter((security) => !valuedFigis.has(security.figi));
  if (rawSecurities.length > 0) {
    for (const security of rawSecurities) {
      console.log(
        `[Sandbox] Raw security: figi=${security.figi} balance=${security.balance} blocked=${security.blocked} type=${security.instrumentType}`,
      );
    }
  }
}

function printCurrencyValues(label, values) {
  const printableValues = values.filter((item) => Number.isFinite(item.value));

  if (printableValues.length === 0) {
    console.log(`${label}: empty`);
    return;
  }

  for (const item of printableValues) {
    console.log(`${label}: ${formatCurrency(item.value, item.currency)}`);
  }
}

function formatCurrency(value, currency) {
  return `${value.toFixed(2)} ${String(currency || "unknown").toUpperCase()}`;
}

function printSandboxBalanceIncrease(result) {
  if (result.amount === 0) {
    console.log(
      `[Sandbox] Account ${result.accountId} balance unchanged: ${result.beforeRubBalance.toFixed(2)} RUB`,
    );
  } else {
    console.log(
      `[Sandbox] Account ${result.accountId} balance increased by ${result.amount.toFixed(2)} RUB: ${result.beforeRubBalance.toFixed(2)} -> ${result.afterRubBalance.toFixed(2)} RUB`,
    );
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
    console.log(
      `[Sandbox] Position closed: figi=${position.figi} direction=${position.direction} lots=${position.lotsExecuted}/${position.lots} status=${position.status} orderId=${position.orderId}`,
    );
  }
  console.log(
    `[Sandbox] RUB balance preserved: ${result.beforeRubBalance.toFixed(2)} -> ${result.afterRubBalance.toFixed(2)} RUB`,
  );
}

main();
