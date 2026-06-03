#!/usr/bin/env node
// Deprecated thin shim → `diviner --broker simulated`.
// Kept for backwards compatibility (package.json bin, strategies/scripts/backtest-report.mjs).
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const diviner = join(dirname(fileURLToPath(import.meta.url)), "diviner.js");
const child = spawn(
    process.execPath,
    [diviner, "--broker", "simulated", ...process.argv.slice(2)],
    { stdio: "inherit" },
);
child.on("error", (error) => {
    console.error(`Error: failed to start diviner: ${error.message}`);
    process.exit(1);
});
child.on("exit", (code, signal) => {
    if (signal) { process.kill(process.pid, signal); return; }
    process.exit(code ?? 0);
});
