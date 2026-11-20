import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { projects, precisionProjects } from "../tools/compat/kn-r3-sched.mjs";

test("r3 scheduler observations belong to the exact original fixtures", async () => {
  const report = JSON.parse(await fs.readFile("docs/kn-r3-scheduling-official.json", "utf8"));
  assert.equal(report.ok, true);
  assert.equal(report.editorCompat.ok, true);
  const cases = await projects();
  assert.deepEqual(Object.keys(report.cases), Object.keys(cases));
  for (const [name, project] of Object.entries(cases)) {
    const bytes = await fs.readFile(`tests/fixtures/kn-r3-sched/${name}.bcmkn`);
    assert.deepEqual(JSON.parse(bytes), project);
    const observed = report.cases[name];
    assert.equal(observed.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(observed.ok, true);
    assert.deepEqual(observed.pageErrors, []);
    assert.deepEqual(observed.runtimeErrors, []);
    assert.equal(observed.frames.length, 8);
    assert.equal(observed.bundles.length, 2);
    const editor = report.editorCompat.projects.find(p => p.input === `tests/fixtures/kn-r3-sched/${name}.bcmkn`);
    assert.equal(editor.ok, true);
    assert.equal(editor.sha256, observed.sha256);
    assert.deepEqual(editor.issues, []);
    assert.deepEqual(editor.pageErrors, []);
    observed.bundles.forEach(b => assert.match(b.sha256, /^[a-f0-9]{64}$/));
    observed.frames.forEach((f, i) => assert.equal(f.elapsedFrames, i + 1));
  }
});

test("continuous wait precision observations bind 1200 updates and editor-checked bytes", async () => {
  const report = JSON.parse(await fs.readFile("docs/kn-r3-wait-precision.json", "utf8"));
  assert.equal(report.ok, true);
  assert.equal(report.editorCompat.ok, true);
  const cases = await precisionProjects();
  assert.deepEqual(Object.keys(report.cases), Object.keys(cases));
  for (const [name, project] of Object.entries(cases)) {
    const input = `tests/fixtures/kn-r3-sched/precision/${name}.bcmkn`;
    const bytes = await fs.readFile(input);
    assert.deepEqual(JSON.parse(bytes), project);
    const observed = report.cases[name];
    assert.equal(observed.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(observed.ok, true);
    assert.deepEqual(observed.pageErrors, []);
    assert.deepEqual(observed.runtimeErrors, []);
    assert.equal(observed.ready.length, 1200);
    const editor = report.editorCompat.projects.find(p => p.input === input);
    assert.equal(editor.sha256, observed.sha256);
    assert.equal(editor.ok, true);
    assert.deepEqual(editor.issues, []);
    assert.deepEqual(editor.pageErrors, []);
  }
  assert.equal(report.cases.long.ready[1004], 252);
  assert.notDeepEqual(report.cases.below.ready, report.cases.above.ready);
  assert.equal(report.cases.tiny.ready[3], 1);
  assert.equal(report.cases.tiny.ready[4], 1);
  assert.equal(report.cases.tiny.ready[5], 2);
});
