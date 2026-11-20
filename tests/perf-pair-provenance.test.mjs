import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyPair } from "../tools/bench/verify-pair.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const write = (file, value) => writeFileSync(file, JSON.stringify(value));
function fixture(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "nekoc-pair-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const binary = path.join(directory, "before.bin");
  const after = path.join(directory, "after.bin");
  const input = path.join(directory, "input.bcm");
  for (const file of [binary, after, input]) writeFileSync(file, path.basename(file));
  const options = { beforeSha256: hash(readFileSync(binary)), afterSha256: hash(readFileSync(after)), frames: 2, warmup: 1, repeats: 1 };
  const item = { input, sha256: hash(readFileSync(input)), interpreter: false, pairs: [], before_ms: 2, after_ms: 2, percent: 0, equal: true };
  const pair = { equal: true };
  for (const side of ["before", "after"]) {
    const sample = { schema: "nekoc-performance-v1", runtime: "nekoc", input, seed: 1, frames: 2, warmup: 1, deterministic: true, instructions: 3, pen_lines: 0, active_frames: 2, final_state: { variables: { value: "-0" } } };
    pair[side] = { ms: 2, warmup_ms: 1, semantic: hash(JSON.stringify(sample)) };
    write(path.join(directory, `input.bcm-jit-0-${side}.json`), { args: [input, "--frames", "2", "--warmup", "1", "--seed", "1", "--deterministic"], status: 0, sample: { ...sample, frame_ms: [1, 1], warmup_ms: [1] } });
  }
  item.pairs.push(pair);
  const report = { mode: "pair", binary, after, binary_sha256: options.beforeSha256, after_sha256: options.afterSha256, results: [item] };
  const save = () => write(path.join(directory, "results.json"), report);
  save();
  const mutateRaw = mutate => {
    const file = path.join(directory, "input.bcm-jit-0-after.json");
    const raw = JSON.parse(readFileSync(file, "utf8"));
    mutate(raw);
    write(file, raw);
  };
  return { directory, options, report, save, mutateRaw };
}

test("retained pair verifier recomputes summaries without running a benchmark", t => {
  const f = fixture(t);
  const result = verifyPair(f.directory, f.options);
  assert.equal(result.cases, 1);
  assert.equal(result.pairs, 1);
});

test("an internally consistent wrong after binary is rejected by audited identity", t => {
  const f = fixture(t);
  writeFileSync(f.report.after, "unoptimized stale build");
  f.report.after_sha256 = hash(readFileSync(f.report.after));
  f.save();
  assert.throws(() => verifyPair(f.directory, f.options), /Unexpected after binary identity/);
});

for (const side of ["before", "after"]) {
  test(`changed ${side} binary is rejected`, t => {
    const f = fixture(t);
    writeFileSync(f.report[side === "before" ? "binary" : "after"], "changed");
    assert.throws(() => verifyPair(f.directory, f.options), /binary changed/);
  });
}

test("missing identity, identical binaries, and changed input are rejected", t => {
  const f = fixture(t);
  assert.throws(() => verifyPair(f.directory, {}), /SHA-256 is required/);
  assert.throws(() => verifyPair(f.directory, { ...f.options, afterSha256: f.options.beforeSha256 }), /Identical binaries/);
  writeFileSync(f.report.results[0].input, "changed input");
  assert.throws(() => verifyPair(f.directory, f.options), /Input changed/);
});

for (const [name, mutate, message] of [
  ["semantic digest", f => f.mutateRaw(raw => { raw.sample.final_state.variables.value = "Infinity"; }), /Stale semantic digest/],
  ["frame sum", f => f.mutateRaw(raw => { raw.sample.frame_ms[0] = 2; }), /Stale frame-time sum/],
  ["warmup sum", f => f.mutateRaw(raw => { raw.sample.warmup_ms[0] = 2; }), /Stale warmup-time sum/],
  ["execution mode", f => f.mutateRaw(raw => { raw.args.push("--interpreter"); }), /execution arguments or mode/],
  ["failed process", f => f.mutateRaw(raw => { raw.status = 1; }), /Failed raw sample/],
  ["incomplete frames", f => f.mutateRaw(raw => { raw.sample.frame_ms.pop(); }), /Expected values/],
  ["missing pair", f => { f.report.results[0].pairs.pop(); f.save(); }, /Incomplete pair count/],
  ["cached median", f => { f.report.results[0].before_ms = 3; f.save(); }, /Stale before median/],
  ["cached percentage", f => { f.report.results[0].percent = 1; f.save(); }, /Stale percentage/],
]) {
  test(`stale or invalid ${name} is rejected`, t => {
    const f = fixture(t);
    mutate(f);
    assert.throws(() => verifyPair(f.directory, f.options), message);
  });
}

test("matching cached equality flags cannot hide different raw final states", t => {
  const f = fixture(t);
  f.mutateRaw(raw => {
    raw.sample.final_state.variables.value = "Infinity";
    const { frame_ms, warmup_ms, ...state } = raw.sample;
    f.report.results[0].pairs[0].after.semantic = hash(JSON.stringify(state));
  });
  f.save();
  assert.throws(() => verifyPair(f.directory, f.options), /Raw paired semantics differ/);
});
