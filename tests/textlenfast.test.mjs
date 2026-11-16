import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseSample, summarize, validateState } from "../tools/bench/textlenfast-ab.mjs";

test("textlenfast UTF-16 regression corpus matches JavaScript lengths", () => {
  const corpus = JSON.parse(readFileSync(new URL("./fixtures/textlenfast.json", import.meta.url)));
  for (const { text, length } of corpus) {
    assert.equal(text.length, length, JSON.stringify(text));
    for (const other of corpus) {
      assert.equal((text + other.text).length, length + other.length);
      assert.equal((other.text + text + other.text).length, length + 2 * other.length);
    }
  }
});

test("textlenfast local benchmark rejects incomplete measurements and retains controls", () => {
  const stats = { ms: 2, allocations: 3, allocated_bytes: 5 };
  const sample = { compile: stats, frames: Array(16).fill(stats), state: { s: "😀" } };
  assert.deepEqual(parseSample(`TEXTLENFAST ${JSON.stringify(sample)}\n`), sample);
  assert.throws(() => parseSample(""));
  assert.throws(() => parseSample(`TEXTLENFAST ${JSON.stringify({ ...sample, frames: [] })}`));
  assert.deepEqual(summarize([sample]).allocated_bytes, { compile: 5, cold_frames: 30, warm_frames: 50 });
  validateState({ case: "numeric", state: { variables: { s: "", out: 32_000 } } });
  assert.throws(() => validateState({ case: "numeric", state: { variables: { s: "", out: 0 } } }));
  const unit = "x😀é";
  let sum = 0, s = "";
  for (let i = 0; i < 2000; i++) { s += unit; sum += s.length; }
  validateState({ case: "growing", state: { variables: { s, out: sum * 16 } } });
  s = unit.repeat(16_384);
  validateState({ case: "fixed", state: { variables: { s, out: s.length * 2000 * 16 } } });
  validateState({ case: "concat", state: { variables: { s: "abcdefgh".repeat(2000), out: 0 } } });
  validateState({ case: "short-concat", state: { variables: { s: "abcd", out: 0 } } });
});
