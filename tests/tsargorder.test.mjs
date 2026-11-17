import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { checkFile, compileFile, CompileError } from "../ts/compile-ts.mjs";
import { checkProject, readManifest } from "../tools/compat/kn-share-player-check.mjs";

const bin = path.resolve("target/debug", process.platform === "win32" ? "nekoc.exe" : "nekoc");
const run = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
};
for (const name of ["defaults", "procedures", "classes", "plain-classes", "modules", "splice"]) {
  test(`tsargorder: ${name} matches Node and passes structural/share checks`, async () => {
    const input = `tests/fixtures/tsargorder-${name}.ts`;
    const checked = checkFile(input);
    assert.equal(checked.ok, true, JSON.stringify(checked));
    const expected = JSON.parse(run(process.execPath, ["tests/tsarrayfix-oracle.mjs", input]));
    const manifest = await readManifest();
    mkdirSync("dist/tsargorder", { recursive: true });
    for (const optimize of [false, true]) {
      const output = `dist/tsargorder/${name}${optimize ? "-opt" : ""}.bcmkn`;
      run(bin, ["build", input, "-o", output, ...(optimize ? ["--optimize"] : [])]);
      assert.deepEqual(JSON.parse(run(bin, ["run", output, "--ticks", "2000"])).logs, expected);
      const check = JSON.parse(run(bin, ["check", output, "--json"]));
      assert.equal(check.ok, true, JSON.stringify(check));
      const share = checkProject(JSON.parse(readFileSync(output, "utf8")), manifest);
      assert.equal(share.ok, true, JSON.stringify(share));
    }
  });
}

for (const source of [
  'let n = 1; function f(a: number, b = a + 1) { return b; } console.log(f(n));',
  'let a = [1]; a.splice("1", 0);',
  'let a = [1]; a.splice(1, undefined);',
  'let a = [1]; a.splice(...[1, 0]);',
]) test(`tsargorder: unsupported arguments stay located and actionable: ${source}`, () => {
  assert.throws(() => compileFile("tsargorder.ts", { readFile: () => source }), error =>
    error instanceof CompileError && error.location?.line === 1 && /constant|omit|pass|convert/.test(error.message));
});
