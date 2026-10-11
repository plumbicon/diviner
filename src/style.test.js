import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
// Стратегии — отдельный репозиторий со своими правилами; зависимости и артефакты не наши.
const SKIP = new Set(["node_modules", "data", "work", "logs", "reports", "src/strategies"]);

/** Все .js/.mjs движка. */
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

/**
 * Нарушения стиля в файле: табуляция и хвостовые пробелы, отступ кода не кратен 4,
 * нет перевода строки в конце. Строки JSDoc (` * …`) и содержимое многострочных
 * шаблонных строк отступом не проверяются — там он часть текста.
 */
function violations(path) {
    const text = readFileSync(path, "utf8");
    const found = [];
    let inTemplate = false;
    text.split("\n").forEach((line, i) => {
        const where = `${relative(ROOT, path)}:${i + 1}`;
        if (/\t/.test(line)) found.push(`${where} табуляция`);
        if (/\s+$/.test(line)) found.push(`${where} пробелы в конце строки`);
        const insideTemplate = inTemplate;
        if ((line.match(/`/g) || []).length % 2 === 1) inTemplate = !inTemplate;
        if (insideTemplate) return;
        const indent = line.match(/^( *)(\S)/);
        if (indent && indent[2] !== "*" && indent[1].length % 4 !== 0) {
            found.push(`${where} отступ ${indent[1].length} — не кратен 4`);
        }
    });
    if (text.length > 0 && !text.endsWith("\n")) found.push(`${relative(ROOT, path)} нет перевода строки в конце`);
    return found;
}

test("код движка: отступ 4 пробела, без табуляций и хвостовых пробелов", () => {
    const files = sources();
    assert.ok(files.length > 50, "файлы найдены");
    const all = files.flatMap(violations);
    assert.deepEqual(all, [], `нарушения стиля (см. CONTRIBUTING.md):\n${all.slice(0, 20).join("\n")}`);
});
