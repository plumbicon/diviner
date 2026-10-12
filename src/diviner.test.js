import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFully } from "./diviner.js";

/**
 * A stream that acknowledges a write later: the callback fires only after a manual
 * flush(). This checks that writeFully actually WAITS for the acknowledgement instead of
 * relying on write()'s return value.
 */
function slowStream() {
    const pending = [];
    return {
        chunks: [],
        write(text, cb) {
            this.chunks.push(text);
            pending.push(cb);
            return false;              // backpressure signal, like a full pipe
        },
        flush(error) {
            while (pending.length) pending.shift()(error);
        },
    };
}

test("writeFully ждёт подтверждения записи, а не возврата write()", async () => {
    const s = slowStream();
    let done = false;
    const p = writeFully(s, "отчёт").then(() => { done = true; });

    await new Promise((r) => setImmediate(r));
    assert.equal(s.chunks.join(""), "отчёт", "данные переданы в поток");
    assert.equal(done, false, "но промис ещё не разрешён — подтверждения не было");

    s.flush();
    await p;
    assert.equal(done, true, "разрешается только после подтверждения");
});

test("writeFully отклоняется при ошибке записи", async () => {
    const s = slowStream();
    const p = writeFully(s, "отчёт");
    await new Promise((r) => setImmediate(r));
    s.flush(new Error("канал закрыт"));
    await assert.rejects(p, /канал закрыт/);
});
