import assert from "node:assert/strict";
import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { compileFile, checkFile } from "../ts/compile-ts.mjs";
import { checkProject, readManifest } from "../tools/compat/kn-share-player-check.mjs";

const compile = source => compileFile("event.ts", { readFile: name => name.endsWith("event.ts") ? source : undefined });

test("tseventframes: hats use suspendable statement procedures with per-call list frames", () => {
  for (const event of ['onMessage("go",', 'onClick(', 'onKey("space",', 'when(true,', 'onBumpActor("enter", "cat", "hit",']) {
    const report = compile(`let serial = 0; ${event} () => { serial++; const local = serial; wait(0.1); console.log(local); return local; });`);
    const implementation = report.procedures.find(p => p.name.startsWith("__event") && p.name.endsWith("(implementation)"));
    assert.equal(implementation.type, "NORMAL");
    const blocks = Object.values(implementation.workspaceData.blocks);
    assert.ok(blocks.some(b => b.type === "wait"));
    assert.ok(blocks.some(b => b.type === "replace_list_item"));
    assert.ok(blocks.some(b => b.type === "procedures_2_return_value" && /type="NORMAL"/.test(b.mutation)));
    assert.ok(!blocks.some(b => b.type === "procedures_2_return_value" && /items="1"/.test(b.mutation)));
    assert.ok(!blocks.some(b => b.type === "variables_get" && b.fields.variable.endsWith("_local")));
    assert.ok(Object.values(report.workspaceData.blocks).some(b => b.type === "procedures_2_callnoreturn"));
  }
});

test("tseventframes: cross-scheduling local captures have actionable source diagnostics", () => {
  for (const source of [
    'onMessage("go", () => {\n const local = 1;\n setTimeout(() => console.log(local), 0);\n});',
    'function schedule() {\n const local = [1];\n setTimeout(() => console.log(local[0]), 0);\n}\nschedule();',
    'onStart(() => {\n const local = 1;\n setInterval(() => console.log(local), 0);\n});',
  ]) {
    const result = checkFile("event.ts", { host: { readFile: name => name.endsWith("event.ts") ? source : undefined }, types: false });
    assert.equal(result.ok, false);
    const error = result.diagnostics.find(d => d.message.includes("across scheduling"));
    assert.ok(error, JSON.stringify(result.diagnostics));
    assert.equal(error.line, 3);
    assert.match(error.message, /top-level variable/);
  }
});

test("tseventframes: synchronous warp locals keep the compact graph, yielding warp locals get frames", () => {
  for (const yielding of [false, true]) {
    const report = compile(`onMessage("go", () => { warp(() => { const local = 1; ${yielding ? "wait(0);" : ""} console.log(local); }); });`);
    assert.equal(report.procedures.some(p => p.name.startsWith("__event")), yielding);
  }
});

test("tseventframes: generated broadcast/timer/clone paths pass structure, parameter ids and share registry", async () => {
  const manifest = await readManifest();
  const dir = path.resolve("dist/tseventframes");
  mkdirSync(dir, { recursive: true });
  const bin = path.resolve("target/debug", process.platform === "win32" ? "nekoc.exe" : "nekoc");
  for (const name of ["broadcast", "complex", "timers", "intervals", "inline", "clones", "stop", "flow", "nested", "return-loops"]) {
    for (const optimize of [false, true]) {
      const input = `tests/fixtures/tseventframes-${name}.ts`;
      const output = path.join(dir, `${name}-${optimize}.bcmkn`);
      const build = spawnSync(bin, ["build", input, "-o", output, ...(optimize ? ["--optimize"] : [])], { encoding: "utf8" });
      assert.equal(build.status, 0, build.stderr);
      const check = spawnSync(bin, ["check", output, "--json"], { encoding: "utf8" });
      assert.equal(check.status, 0, check.stdout + check.stderr);
      const project = JSON.parse(readFileSync(output, "utf8"));
      assert.deepEqual(checkProject(project, manifest).unsupported, []);
      for (const procedure of Object.values(project.procedures.proceduresDict)) {
        const params = new Set(procedure.params.map(p => p.id));
        const walk = node => {
          if (!node || typeof node !== "object") return;
          if (node.type === "procedures_2_parameter") assert.ok(params.has(/id="([^"]+)"/.exec(node.mutation)?.[1]));
          if (node.type === "procedures_2_stable_parameter") assert.ok(params.has(node.id));
          if (node.type === "procedures_2_return_value") assert.ok(!node.next, `return has next: ${node.id}`);
          Object.values(node).forEach(walk);
        };
        walk(procedure.nekoBlockJsonList);
      }
    }
  }
});
