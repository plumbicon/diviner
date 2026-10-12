import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generate } from "./make-data.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * Run a backtest through the CLI the way a user does and return the report. The examples
 * are documentation, and this test keeps them from silently drifting away from the engine.
 */
function backtest(dataPath, strategy, extra = []) {
    const run = spawnSync(process.execPath, [
        "src/diviner.js", "src/broker/simulated/broker.js", dataPath,
        "--strategy", strategy, "--verbose", ...extra,
    ], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(run.stdout);
}

test("the single-ticker example trades on a synthetic listing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "diviner-examples-"));
    try {
        const data = join(dir, "demo.parquet");
        await generate({ out: data, tickers: ["DEMO"], days: 5 });
        const report = backtest(data, "examples/strategies/sma-cross/sma-cross.js", ["--balance", "10000"]);
        assert.ok(report.performance_metrics.tradesCount > 0, "there are trades");
        assert.ok(report.trade_log.every((t) => t.side === "long"));
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("the cross-sectional example shorts by slots and exits by the deadline", async () => {
    const dir = await mkdtemp(join(tmpdir(), "diviner-examples-"));
    try {
        const data = join(dir, "universe.parquet");
        await generate({ out: data, tickers: ["AAA", "BBB", "CCC", "DDD"], days: 5 });
        const report = backtest(data, "examples/strategies/top-gainer-short/top-gainer-short.js", [
            "--balance", "100000", "--fill-next-open", "--intrabar-stops",
        ]);
        const trades = report.trade_log;
        assert.equal(trades.length, 10, "2 slots × 5 days");
        assert.ok(trades.every((t) => t.side === "short"));
        assert.ok(trades.every((t) => ["time", "sl"].includes(t.reason)), "exit by the deadline or the stop");
        assert.ok(trades.every((t) => t.entryTime.slice(0, 10) === t.exitTime.slice(0, 10)), "no position is held overnight");
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
