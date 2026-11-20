import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { compileFile, checkFile } from "../ts/compile-ts.mjs";
import { checkProject, readManifest } from "../tools/compat/kn-share-player-check.mjs";
import { source, importedSource, moduleSource, barrierSource, concurrentSource, equalitySource, expectedFor, hostFor, prepare } from "./tsnonfiniteinit-cases.mjs";

const compile = body => compileFile("tsnonfiniteinit.ts", hostFor(body));
const blocks = report => [report.workspaceData, ...report.procedures.map(p => p.workspaceData)]
  .flatMap(w => Object.values(w.blocks));

test("tsnonfiniteinit keeps non-finite constants out of JSON initial values", () => {
  const report = compile(source);
  for (const name of ["nan", "inf", "neg", "best", "overflow", "underflow", "remainder", "invalid", "literal", "negativeLiteral"]) {
    assert.ok(!Object.hasOwn(report.initialValues, name), name);
    assert.ok(blocks(report).some(b => b.type === "variables_set" && b.fields.variable === name), name);
  }
  assert.equal(report.initialValues.finite, 3.5);
  assert.equal(report.initialValues.text, "Infinity");
  assert.equal(report.initialValues.truth, true);
  assert.equal(report.initialValues.falsity, false);
  assert.ok(blocks(report).filter(b => b.type === "math_number").every(b => Number.isFinite(Number(b.fields.NUM))));
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
  assert.equal(checkFile("tsnonfiniteinit.ts", { host: hostFor(source), types: false }).ok, true);
});

test("tsnonfiniteinit finite constants retain the table-only path and independent starts", () => {
  const report = compile('let n = 7/2; let s = "Infinity"; let b = true; let f = false;');
  assert.deepEqual(report.initialValues, { n: 3.5, s: "Infinity", b: true, f: false });
  assert.equal(blocks(report).length, 0);
  const folded = compile("let n = (1/0) | 0; let b = (0/0) & 7;");
  assert.deepEqual(folded.initialValues, { n: 0, b: 0 });
  assert.equal(blocks(folded).length, 0);
  const starts = compile('let n = 7/2; onStart(() => { console.log(n); }); onStart(() => { console.log(n); });');
  assert.ok(!Object.hasOwn(starts.initialValues, "__nekoc_ready"));
  assert.equal(blocks(starts).filter(b => b.type === "on_running_group_activated").length, 2);
});

test("tsnonfiniteinit arithmetic initialization uses the existing explicit-start barrier", () => {
  const report = compile(barrierSource);
  assert.equal(report.initialValues.__nekoc_ready, 0);
  assert.equal(blocks(report).filter(b => b.type === "on_running_group_activated").length, 3);
  assert.equal(blocks(report).filter(b => b.type === "wait_until").length, 2);
});

test("tsnonfiniteinit frontend CLI and in-memory package host serialize the same report", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nekoc-tsnonfiniteinit-"));
  try {
    const entry = path.join(dir, "case.ts");
    const output = path.join(dir, "report.json");
    await fs.writeFile(entry, source);
    const result = spawnSync(process.execPath, ["ts/compile-ts.mjs", entry, output], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const memory = compileFile(entry, { readFile: () => source });
    assert.deepEqual(JSON.parse(await fs.readFile(output, "utf8")), memory);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("tsnonfiniteinit real CLI check/build/run matches Node with optimization on and off", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nekoc-tsnonfiniteinit-cli-"));
  try {
    await fs.writeFile(path.join(dir, "values.ts"), moduleSource);
    const binary = path.resolve("target/debug", process.platform === "win32" ? "nekoc.exe" : "nekoc");
    const manifest = await readManifest();
    const run = args => {
      const result = spawnSync(binary, args, { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr || result.error?.message);
      return result.stdout;
    };
    for (const [index, body] of [source, importedSource, barrierSource, concurrentSource, equalitySource].entries()) {
      const input = path.join(dir, `case-${index}.ts`);
      const output = path.join(dir, `case-${index}.bcmkn`);
      await fs.writeFile(input, body);
      assert.equal(JSON.parse(run(["check", input, "--json"])).ok, true);
      for (const optimize of [false, true]) {
        run(["build", input, "-o", output, ...(optimize ? ["--optimize"] : [])]);
        const project = JSON.parse(await fs.readFile(output, "utf8"));
        assert.equal(checkProject(project, manifest).ok, true);
        assert.deepEqual(JSON.parse(run(["run", output, "--ticks", "2000"])).logs,
          body === concurrentSource ? ["ready NaN 3 -Infinity", "resumed 3"] : expectedFor(body));
      }
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("tsnonfiniteinit generated paths are share-compatible with valid procedure parameter ids", async () => {
  const manifest = await readManifest();
  for (const { report } of prepare()) {
    for (const b of blocks(report)) {
      assert.ok([...manifest.blocks, ...manifest.metadataBlocks].includes(b.type), b.type);
      if (b.type === "procedures_2_return_value") {
        assert.match(b.mutation, /items="1"/);
        assert.match(b.shadows.VALUE, /type="math_number"/);
      }
    }
    for (const p of report.procedures) {
      const definitions = new Set(Object.values(p.workspaceData.blocks)
        .filter(b => b.type === "procedures_2_stable_parameter").map(b => b.id));
      for (const param of p.params.filter(p => p.type === "String")) assert.ok(definitions.has(param.id));
      for (const b of Object.values(p.workspaceData.blocks).filter(b => b.type === "procedures_2_parameter")) {
        assert.ok(definitions.has(/id="([^"]+)"/.exec(b.mutation)?.[1]));
      }
    }
  }
});
