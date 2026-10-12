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

test("writeFully waits for the write acknowledgement, not for write() to return", async () => {
    const s = slowStream();
    let done = false;
    const p = writeFully(s, "report").then(() => { done = true; });

    await new Promise((r) => setImmediate(r));
    assert.equal(s.chunks.join(""), "report", "data was handed to the stream");
    assert.equal(done, false, "but the promise is not resolved yet — no acknowledgement came");

    s.flush();
    await p;
    assert.equal(done, true, "resolves only after the acknowledgement");
});

test("writeFully rejects on a write error", async () => {
    const s = slowStream();
    const p = writeFully(s, "report");
    await new Promise((r) => setImmediate(r));
    s.flush(new Error("pipe closed"));
    await assert.rejects(p, /pipe closed/);
});
