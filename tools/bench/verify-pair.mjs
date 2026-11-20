import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const digest = value => createHash("sha256").update(value).digest("hex");
const fileHash = file => digest(readFileSync(file));
const json = file => JSON.parse(readFileSync(file, "utf8"));
const sum = values => values.reduce((a, b) => a + b, 0);
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const close = (actual, expected, message) => {
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected)), message);
};

function semantic(sample) {
  const { import_ms, start_ms, frame_ms, warmup_ms, peak_rss_bytes, ...state } = sample;
  return state;
}

// Expected identities come from a separately audited source/build record.
// This verifies retained evidence; it does not infer source identity from a hash.
export function verifyPair(directory, { beforeSha256, afterSha256, frames = 60, warmup = 10, seed = 1, repeats = 5 }) {
  for (const hash of [beforeSha256, afterSha256]) {
    assert.match(hash ?? "", /^[0-9a-f]{64}$/, "Expected binary SHA-256 is required");
  }
  assert.notEqual(beforeSha256, afterSha256, "Identical binaries are not an optimization A/B");
  for (const count of [frames, repeats]) assert.ok(Number.isSafeInteger(count) && count > 0);
  assert.ok(Number.isSafeInteger(warmup) && warmup >= 0);
  const report = json(path.join(directory, "results.json"));
  assert.equal(report.mode, "pair");
  assert.equal(report.binary_sha256, beforeSha256, "Unexpected before binary identity");
  assert.equal(report.after_sha256, afterSha256, "Unexpected after binary identity");
  assert.equal(fileHash(report.binary), beforeSha256, "Before binary changed");
  assert.equal(fileHash(report.after), afterSha256, "After binary changed");
  assert.ok(Array.isArray(report.results) && report.results.length > 0, "Empty pair report");
  const rawNames = new Set();
  const results = [];
  for (const item of report.results) {
    assert.equal(typeof item.interpreter, "boolean");
    assert.equal(fileHash(item.input), item.sha256, "Input changed");
    assert.equal(item.pairs.length, repeats, "Incomplete pair count");
    const times = { before: [], after: [] };
    for (let repeat = 0; repeat < repeats; repeat++) {
      const states = {};
      for (const side of ["before", "after"]) {
        const name = `${path.basename(item.input)}-${item.interpreter ? "interp" : "jit"}-${repeat}-${side}.json`;
        assert.ok(!rawNames.has(name), "Duplicate or colliding raw sample name");
        rawNames.add(name);
        const raw = json(path.join(directory, name));
        const args = [item.input, "--frames", String(frames), "--warmup", String(warmup), "--seed", String(seed), "--deterministic"];
        if (item.interpreter) args.push("--interpreter");
        assert.deepEqual(raw.args, args, "Unexpected execution arguments or mode");
        assert.equal(raw.status, 0, "Failed raw sample");
        assert.ok(!raw.error, "Raw sample process error");
        const sample = raw.sample;
        assert.equal(sample.schema, "nekoc-performance-v1");
        assert.equal(sample.runtime, "nekoc");
        assert.equal(sample.input, item.input);
        assert.equal(sample.frames, frames);
        assert.equal(sample.warmup, warmup);
        assert.equal(sample.seed, seed);
        assert.equal(sample.deterministic, true);
        assert.equal(sample.frame_ms.length, frames);
        assert.equal(sample.warmup_ms.length, warmup);
        assert.ok([...sample.frame_ms, ...sample.warmup_ms].every(n => Number.isFinite(n) && n >= 0), "Invalid raw timings");
        assert.ok(sample.final_state && typeof sample.final_state === "object", "Missing final state");
        for (const field of ["instructions", "pen_lines", "active_frames"]) {
          assert.ok(Number.isSafeInteger(sample[field]) && sample[field] >= 0, `Invalid ${field}`);
        }
        states[side] = semantic(sample);
        const cached = item.pairs[repeat][side];
        assert.equal(cached.semantic, digest(JSON.stringify(states[side])), "Stale semantic digest");
        close(cached.ms, sum(sample.frame_ms), "Stale frame-time sum");
        close(cached.warmup_ms, sum(sample.warmup_ms), "Stale warmup-time sum");
        times[side].push(sum(sample.frame_ms));
      }
      assert.deepEqual(states.before, states.after, "Raw paired semantics differ");
      assert.equal(item.pairs[repeat].equal, true);
    }
    const before = median(times.before);
    const after = median(times.after);
    assert.ok(before > 0, "Cannot compute a relative change from zero baseline");
    const percent = (after / before - 1) * 100;
    close(item.before_ms, before, "Stale before median");
    close(item.after_ms, after, "Stale after median");
    close(item.percent, percent, "Stale percentage");
    assert.equal(item.equal, true);
    results.push({ input: item.input, interpreter: item.interpreter, sha256: item.sha256, before_ms: before, after_ms: after, percent });
  }
  return { cases: results.length, pairs: results.length * repeats, results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [directory, beforeSha256, afterSha256, ...extra] = process.argv.slice(2);
  assert.ok(directory && !extra.length, "Usage: node tools/bench/verify-pair.mjs <directory> <before-sha256> <after-sha256>");
  console.log(JSON.stringify(verifyPair(directory, { beforeSha256, afterSha256 }), null, 2));
}
