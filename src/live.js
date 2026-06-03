#!/usr/bin/env node
// Deprecated thin shim → `diviner --broker <tinkoff-broker>`.
// Kept for backwards compatibility (scripts).
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const diviner = join(scriptDir, "diviner.js");
const broker = join(scriptDir, "broker", "tinkoff-broker.js");
const child = spawn(
    process.execPath,
    [diviner, "--broker", broker, ...process.argv.slice(2)],
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
