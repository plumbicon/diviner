/**
 * Минимальный LightGBM-инференс на чистом JS.
 * Загружает model.txt и выполняет predict(features) → probability [0..1].
 *
 * Поддерживает: binary classification (objective=binary sigmoid:N),
 * непрерывные фичи, decision_type <= (тип 0 или 2).
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

// Parsed-model cache keyed by absolute path. Batch backtests construct one
// strategy per ticker, each calling loadModel for the same file; without this
// the 1 MB model would be re-read and re-parsed dozens of times per process.
const modelCache = new Map();

// Быстрый sigmoid
function sigmoid(x) {
    return 1 / (1 + Math.exp(-x));
}

/**
 * Парсит model.txt и возвращает объект с деревьями.
 * @param {string} text — содержимое model.txt
 */
function parseModel(text) {
    const lines = text.split("\n");

    // Читаем objective
    let sigmoidScale = 1;
    let objective    = "binary";
    for (const ln of lines) {
        const m = ln.match(/^objective=binary sigmoid:(\S+)/);
        if (m) { sigmoidScale = parseFloat(m[1]); break; }
    }

    const trees = [];
    let i = 0;

    while (i < lines.length) {
        if (!/^Tree=\d+/.test(lines[i])) { i++; continue; }

        // Считываем блок дерева до следующей пустой строки / Tree=
        const block = {};
        i++;
        while (i < lines.length && lines[i].trim() !== "" && !/^Tree=/.test(lines[i])) {
            const eq = lines[i].indexOf("=");
            if (eq > 0) {
                const key = lines[i].slice(0, eq).trim();
                const val = lines[i].slice(eq + 1).trim();
                block[key] = val;
            }
            i++;
        }

        const splitFeature = block.split_feature.split(" ").map(Number);
        const threshold    = block.threshold.split(" ").map(Number);
        const leftChild    = block.left_child.split(" ").map(Number);
        const rightChild   = block.right_child.split(" ").map(Number);
        const leafValue    = block.leaf_value.split(" ").map(Number);
        const shrinkage    = parseFloat(block.shrinkage ?? "1");

        trees.push({ splitFeature, threshold, leftChild, rightChild, leafValue, shrinkage });
    }

    return { trees, sigmoidScale };
}

/**
 * Прогоняет одно дерево и возвращает leaf value.
 * @param {object} tree
 * @param {number[]|Float32Array} features
 */
function predictTree(tree, features) {
    const { splitFeature, threshold, leftChild, rightChild, leafValue } = tree;
    let node = 0;
    while (true) {
        const feat  = splitFeature[node];
        const child = features[feat] <= threshold[node] ? leftChild[node] : rightChild[node];
        if (child < 0) return leafValue[-child - 1];
        node = child;
    }
}

/**
 * Выполняет инференс.
 * leaf_value в model.txt уже хранится с учётом learning rate —
 * shrinkage применять повторно не нужно.
 * @param {{trees, sigmoidScale}} model
 * @param {number[]|Float32Array} features  — 40 признаков в том же порядке, что при обучении
 * @returns {number} вероятность класса 1 (0..1)
 */
export function lgbmPredict(model, features) {
    let score = 0;
    for (const tree of model.trees) {
        score += predictTree(tree, features);
    }
    return sigmoid(score * model.sigmoidScale);
}

/**
 * Загружает модель из файла.
 * @param {string} modelPath
 * @returns {Promise<{trees, sigmoidScale}>}
 */
export async function loadModel(modelPath) {
    const key = resolve(modelPath);
    const cached = modelCache.get(key);
    if (cached) {
        return cached;
    }
    const text  = await readFile(modelPath, "utf8");
    const model = parseModel(text);
    modelCache.set(key, model);
    return model;
}
