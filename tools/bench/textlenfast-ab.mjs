#!/usr/bin/env node
// The binaries are copies of the *same* ignored release test harness, linked
// before/after the runtime change. No cargo invocation or source edits here.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function parseSample(stdout) {
  const lines = stdout.split(/\r?\n/).filter(line => line.startsWith("TEXTLENFAST "));
  if (lines.length !== 1) throw new Error("Expected exactly one complete benchmark sample");
  const sample = JSON.parse(lines[0].slice("TEXTLENFAST ".length));
  if (sample.frames?.length !== 16 || !sample.state || !sample.compile) throw new Error("Incomplete sample");
  for (const stats of [sample.compile, ...sample.frames]) {
    if (![stats.ms, stats.allocations, stats.allocated_bytes].every(n => Number.isFinite(n) && n >= 0)) {
      throw new Error("Invalid measurement");
    }
  }
  return sample;
}
const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
export function summarize(samples) {
  return Object.fromEntries(["ms", "allocations", "allocated_bytes"].map(key => [key, {
    compile: median(samples.map(s => s.compile[key])),
    cold_frames: median(samples.map(s => s.frames.slice(0, 6).reduce((a, f) => a + f[key], 0))),
    warm_frames: median(samples.map(s => s.frames.slice(6).reduce((a, f) => a + f[key], 0))),
  }]));
}
export function validateState(sample) {
  const { s, out } = sample.state.variables ?? {};
  const expected = {
    fixed: ["x😀é".repeat(16_384), 16 * 2000 * 5 * 16_384],
    growing: ["x😀é".repeat(2000), 16 * 5 * 2000 * 2001 / 2],
    numeric: ["", 32_000],
    concat: ["abcdefgh".repeat(2000), 0],
    "short-concat": ["abcd", 0],
  }[sample.case];
  if (!expected || s !== expected[0] || out !== expected[1]) {
    throw new Error(`${sample.case} does not match JavaScript reference terminal state`);
  }
}
async function main() {
  const [before, after, out, ...extra] = process.argv.slice(2);
  if (!before || !after || !out || extra.length) throw new Error("Usage: textlenfast-ab.mjs before.exe after.exe dist/.../results.json");
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const output = path.resolve(root, out);
  if (!output.startsWith(path.resolve(root, "dist") + path.sep)) throw new Error("Output must be inside this worktree's dist/");
  const binaries = await Promise.all([before, after].map(async file => ({
    path: path.resolve(file), sha256: createHash("sha256").update(await readFile(file)).digest("hex"),
  })));
  const report = { schema: "textlenfast-ab-v1", host: { platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model },
    binaries, options: { pairs: 6, order: "AB/BA alternating", frames: 16, coldFrames: 6, warmFrames: 10,
      allocator: "thread-local System wrapper; requested bytes including realloc; not retained/peak bytes", virtualClock: true }, results: [] };
  await mkdir(path.dirname(output), { recursive: true });
  for (const interpreter of [false, true]) for (const name of ["fixed", "growing", "numeric", "concat", "short-concat"]) {
    const result = { name, interpreter, pairs: [] };
    report.results.push(result);
    for (let pair = 0; pair < 6; pair++) {
      const samples = [];
      const order = pair % 2 ? [1, 0] : [0, 1];
      for (const index of order) {
        const env = { ...process.env, TEXTLENFAST_CASE: name };
        delete env.NEKOC_JIT;
        delete env.NEKOC_JIT_TIMING;
        delete env.TEXTLENFAST_INTERPRETER;
        if (interpreter) env.TEXTLENFAST_INTERPRETER = "1";
        samples[index] = parseSample(execFileSync(binaries[index].path,
          ["--ignored", "--exact", "textlenfast_local_benchmark", "--nocapture"],
          { cwd: root, env, encoding: "utf8", timeout: 120000, maxBuffer: 32 * 1024 * 1024 }));
        if (samples[index].case !== name) throw new Error("Benchmark case identity mismatch");
        validateState(samples[index]);
      }
      if (!isDeepStrictEqual(samples[0].state, samples[1].state)) throw new Error(`${name} terminal state differs`);
      if (!isDeepStrictEqual(samples[0].state, result.pairs[0]?.before.state ?? samples[0].state)) {
        throw new Error(`${name} terminal state changed between independent runs`);
      }
      result.pairs.push({ pair, order, equal: true, before: samples[0], after: samples[1] });
      await writeFile(output, JSON.stringify(report, null, 2) + "\n");
    }
    result.before = summarize(result.pairs.map(p => p.before));
    result.after = summarize(result.pairs.map(p => p.after));
    await writeFile(output, JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify({ name, interpreter, before: result.before, after: result.after }));
  }
  for (const binary of binaries) {
    if (createHash("sha256").update(await readFile(binary.path)).digest("hex") !== binary.sha256) {
      throw new Error("Benchmark binary changed during measurement");
    }
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
