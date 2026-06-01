#!/usr/bin/env node
import { Command } from "commander";
import { loadDataset } from "./core/data-loader.js";
import { loadStrategy } from "./core/strategy-loader.js";
import { BacktestRunner } from "./core/runner.js";
import { encodeBacktestResult } from "./core/json-encoder.js";
import { BacktestStrategyContext } from "./core/strategy-context.js";

const program = new Command();

program
  .name("backtest")
  .description("Run a backtest of a trading strategy")
  .argument("[history-parquet]", "Path to Parquet file with historical data")
  .requiredOption("--strategy <path>", "Path to the strategy file")
  .option("--balance <amount>", "Initial balance", "10000")
  .option("--commission <rate>", "Commission rate", "0.0005")
  .option("--verbose", "Output full trade log");

program.parse();
const options = program.opts();
const args = program.args;

const historyParquet = args[0];

async function main() {
  let data;
  let metadata;
  let historyFileName;

  if (historyParquet) {
    const dataset = await loadDataset(historyParquet);
    data = dataset.candles;
    metadata = dataset.metadata;
    historyFileName = historyParquet;
  } else {
    const chunks = [];

    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }

    if (chunks.length === 0) {
      console.error(
        "Error: No Parquet file provided and no data piped from stdin.",
      );
      process.exit(1);
    }

    const buffer = Buffer.concat(chunks);
    const dataset = await loadDataset(buffer);
    data = dataset.candles;
    metadata = dataset.metadata;
    historyFileName = "stdin";
  }

  const StrategyClass = await loadStrategy(options.strategy);

  const balance = parseNonNegativeAmount(options.balance, "--balance");
  const commission = parseFloat(options.commission);

  const context = new BacktestStrategyContext({
    data,
    metadata,
    logger: (message) => process.stderr.write(`${message}\n`),
  });
  const runner = new BacktestRunner({
    data,
    StrategyClass,
    initialCash: balance,
    commission,
    context,
  });
  let result = await runner.run();

  result.backtest_parameters.history_file = historyFileName;
  result.backtest_parameters.strategy_file = options.strategy;

  // Если не указан --verbose, не выводим историю сделок
  if (!options.verbose) {
    result.trade_log = [];
  }

  console.log(encodeBacktestResult(result));
}

function parseNonNegativeAmount(value, optionName) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) {
    program.error(`option '${optionName}' must be a non-negative number`);
  }
  return amount;
}

main().catch((error) => {
  console.error(`Error: ${error.message || error}`);
  process.exit(1);
});
