import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { projects } from "../tools/compat/kn-r3-sched.mjs";

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
