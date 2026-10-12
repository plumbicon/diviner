import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
// Strategies are a separate repository with their own rules; dependencies and artifacts are not ours.
const SKIP = new Set(["node_modules", "data", "work", "logs", "reports", "src/strategies"]);

/** All .js/.mjs files of the engine. */
function sources(dir = ROOT) {
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (SKIP.has(relative(ROOT, path)) || entry.name.startsWith(".")) continue;
        if (entry.isDirectory()) out.push(...sources(path));
        else if (/\.(m?js)$/.test(entry.name)) out.push(path);
    }
    return out;
}

const CYRILLIC = /[А-Яа-яЁё]/;
// Regex literals that contain Cyrillic: they match the broker's Russian messages and
// operation types — that is data, the only place Cyrillic is allowed in the code.
const CYRILLIC_REGEX_LITERAL = /\/(?:\\.|[^/\n])*[А-Яа-яЁё](?:\\.|[^/\n])*\/[a-z]*/g;

/**
 * Style violations in a file: tabs and trailing spaces, code indentation not a multiple
 * of 4, no final newline, Cyrillic text (comments, logs, test names must be in English). JSDoc lines (` * …`) and the content of
 * multi-line template literals are not checked for indentation — there it is part of the text.
 */
function violations(path) {
    const text = readFileSync(path, "utf8");
    const found = [];
    let inTemplate = false;
    text.split("\n").forEach((line, i) => {
        const where = `${relative(ROOT, path)}:${i + 1}`;
        if (/\t/.test(line)) found.push(`${where} tab`);
        if (/\s+$/.test(line)) found.push(`${where} trailing spaces`);
        const insideTemplate = inTemplate;
        if ((line.match(/`/g) || []).length % 2 === 1) inTemplate = !inTemplate;
        if (CYRILLIC.test(line.replace(CYRILLIC_REGEX_LITERAL, ""))) found.push(`${where} text is not in English`);
        if (insideTemplate) return;
        const indent = line.match(/^( *)(\S)/);
        if (indent && indent[2] !== "*" && indent[1].length % 4 !== 0) {
            found.push(`${where} indent ${indent[1].length} — not a multiple of 4`);
        }
    });
    if (text.length > 0 && !text.endsWith("\n")) found.push(`${relative(ROOT, path)} no final newline`);
    return found;
}

test("engine code: 4-space indent, no tabs or trailing spaces, text in English", () => {
    const files = sources();
    assert.ok(files.length > 50, "files found");
    const all = files.flatMap(violations);
    assert.deepEqual(all, [], `style violations (see CONTRIBUTING.md):\n${all.slice(0, 20).join("\n")}`);
});
