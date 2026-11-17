import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fixtures, assertSemantic, assertCloneSemantic } from "../tools/knactortarget-probe.mjs";
import { checkProject, readManifest } from "../tools/compat/kn-share-player-check.mjs";

test("knactortarget generated self/name/ID/procedure paths use share-player blocks", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "knactortarget-"));
  try {
    const manifest = await readManifest();
    const binary = path.resolve("target/debug", process.platform === "win32" ? "nekoc.exe" : "nekoc");
    for (const [name, source] of Object.entries(fixtures)) {
      const input = path.join(dir, `${name}.ts`), output = path.join(dir, `${name}.bcmkn`);
      await writeFile(input, source);
      execFileSync(binary, ["build", input, "-o", output], { encoding: "utf8" });
      const project = JSON.parse(await readFile(output, "utf8"));
      assert.equal(checkProject(project, manifest).ok, true, name);
      const targets = [];
      let turns = 0;
      const visit = v => {
        if (!v || typeof v !== "object") return;
        if (["self_rotate_around", "on_bump_actor"].includes(v.type)) targets.push(v.fields.sprite);
        if (v.type === "self_rotate") turns++;
        Object.values(v).forEach(visit);
      };
      visit(project);
      assert.ok(targets.length || turns);
      assert.ok(targets.every(id => project.actors.actorsDict[id]), name);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("knactortarget clone assertion checks current instance, prototype and single angle evaluation", () => {
  const result = { status: "ok", errors: [], page_errors: [], variables: { "kn-var-angleCalls": 1 },
    instances: [{ clone: false, x: 100, y: 100, rotation: 0 }, { clone: true, x: 200, y: 100, rotation: Math.PI / 2 }] };
  assertCloneSemantic(result);
  assert.throws(() => assertCloneSemantic({ ...result, variables: { "kn-var-angleCalls": 2 } }), /Unexpected/);
  assert.throws(() => assertCloneSemantic({ ...result, instances: [{ ...result.instances[1], x: 100, y: 200 }] }), /Unexpected/);
});

test("knactortarget official semantic assertion needs observed pivot and collision identity", () => {
  const result = { status: "ok", errors: [], page_errors: [], positions: [{ x: 0, y: 0 }],
    variables: { "kn-var-hits": 1, "kn-var-hitX": 100, "kn-var-decoyHits": 0, "kn-var-done": 1 } };
  assertSemantic(result);
  assert.throws(() => assertSemantic({ ...result, positions: [{ x: -300, y: 300 }] }), /Unexpected/);
  assert.throws(() => assertSemantic({ ...result, variables: { ...result.variables, "kn-var-decoyHits": 1 } }), /Unexpected/);
  assert.throws(() => assertSemantic({ ...result, variables: { ...result.variables, "kn-var-hitX": -200 } }), /Unexpected/);
});
