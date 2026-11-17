import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { compileFile, checkFile } from "../ts/compile-ts.mjs";
import { checkProject, readManifest } from "../tools/compat/kn-share-player-check.mjs";

const bin = path.resolve("target/debug", process.platform === "win32" ? "nekoc.exe" : "nekoc");
const run = (command, args, env = process.env) => {
  const result = spawnSync(command, args, { encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
};

// No absolute epsilon: it would hide the original 1e-200 -> 0 regression.
// This is not V8's compensated summation algorithm; allow relative rounding
// error, but insist on finite/nonzero results whenever Node produces them.
function assertRelative(actual, expected, label) {
  assert.ok(Number.isFinite(actual), label);
  if (expected === 0) assert.equal(actual, 0, label);
  else {
    assert.ok(actual > 0, label);
    assert.ok(Math.abs(actual / expected - 1) <= 2e-14, `${label}: ${actual} vs ${expected}`);
  }
}

for (const name of ["mathhypotlarge", "hypotstable", "vectors", "evaluation"]) {
  test(`tshypotstable: ${name} agrees with Node in both VM modes and optimization settings`, async () => {
    const input = `tests/fixtures/tshypotstable-${name}.ts`;
    const expected = JSON.parse(run(process.execPath, ["tests/tsarrayfix-oracle.mjs", input]));
    if (name === "hypotstable") assert.deepEqual(expected, ["false", "true"]);
    if (name === "evaluation") assert.deepEqual(expected, [
      "true", "3", "3412", "true", "12", "true", "true", "true", "true",
      "true", "true", "true", "14", "3412680501244444",
    ]);
    const checked = checkFile(input);
    assert.equal(checked.ok, true, JSON.stringify(checked));
    const manifest = await readManifest();
    mkdirSync("dist/tshypotstable", { recursive: true });
    for (const optimize of [false, true]) {
      const output = `dist/tshypotstable/${name}${optimize ? "-opt" : ""}.bcmkn`;
      run(bin, ["build", input, "-o", output, ...(optimize ? ["--optimize"] : [])]);
      const check = JSON.parse(run(bin, ["check", output, "--json"]));
      assert.equal(check.ok, true, JSON.stringify(check));
      const share = checkProject(JSON.parse(readFileSync(output, "utf8")), manifest);
      assert.equal(share.ok, true, JSON.stringify(share));
      for (const jit of ["0", "1"]) {
        const { logs } = JSON.parse(run(bin, ["run", output, "--ticks", "600"], { ...process.env, NEKOC_JIT: jit }));
        assert.equal(logs.length, expected.length, `${name}: all statements completed`);
        if (name === "hypotstable" || name === "evaluation") assert.deepEqual(logs, expected);
        else logs.forEach((value, i) => {
          if (["true", "false"].includes(expected[i])) assert.equal(value, expected[i]);
          else assertRelative(Number(value), Number(expected[i]), `${name}[${i}], optimize=${optimize}, jit=${jit}`);
        });
      }
    }
  });
}

test("tshypotstable: nested helpers preserve editor parameter/return structure and share whitelist", async () => {
  const report = compileFile("tests/fixtures/tshypotstable-evaluation.ts");
  const manifest = await readManifest();
  for (const proc of report.procedures) {
    const blocks = Object.values(proc.workspaceData.blocks);
    for (const param of proc.params.filter(param => param.type === "String")) {
      assert.equal(proc.workspaceData.blocks[param.id].type, "procedures_2_stable_parameter");
    }
    for (const block of blocks.filter(block => block.type === "procedures_2_parameter")) {
      assert.ok(proc.params.some(param => block.mutation.includes(`id="${param.id}"`)));
    }
    for (const block of blocks.filter(block => block.type === "procedures_2_return_value")) {
      assert.match(block.mutation, /items="1"/);
      assert.match(block.shadows.VALUE, /type="math_number"/);
    }
  }
  const blocks = [report.workspaceData, ...report.procedures.map(proc => proc.workspaceData)]
    .flatMap(workspace => Object.values(workspace.blocks));
  for (const block of blocks) assert.ok([...manifest.blocks, ...manifest.metadataBlocks].includes(block.type), block.type);
  assert.ok(!blocks.some(block => ["_object_literal", "_object_get", "_object_set", "logic_ternary", "math_trig_rad"].includes(block.type)));
});
