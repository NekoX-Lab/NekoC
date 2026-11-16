import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { compileFile, checkFile, CompileError } from "../ts/compile-ts.mjs";
import { checkProject, readManifest } from "../tools/compat/kn-share-player-check.mjs";

const bin = path.resolve("target/debug", process.platform === "win32" ? "nekoc.exe" : "nekoc");
const run = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
};
for (const name of ["eval", "args", "snapshot", "identity"]) {
  test(`tsarrayfix: ${name} matches Node with and without optimization and uses share blocks`, async () => {
    const input = `tests/fixtures/tsarrayfix-${name}.ts`;
    const expected = JSON.parse(run(process.execPath, ["tests/tsarrayfix-oracle.mjs", input]));
    const manifest = await readManifest();
    mkdirSync("dist/tsarrayfix", { recursive: true });
    for (const optimize of [false, true]) {
      const output = `dist/tsarrayfix/${name}${optimize ? "-opt" : ""}.bcmkn`;
      run(bin, ["build", input, "-o", output, ...(optimize ? ["--optimize"] : [])]);
      assert.deepEqual(JSON.parse(run(bin, ["run", output, "--ticks", "120"])).logs, expected);
      const check = JSON.parse(run(bin, ["check", output, "--json"]));
      assert.equal(check.ok, true, JSON.stringify(check));
      const share = checkProject(JSON.parse(readFileSync(output, "utf8")), manifest);
      assert.equal(share.ok, true, JSON.stringify(share));
    }
  });
}

test("tsarrayfix: yielded reentry keeps invocation-local inputs and share-compatible blocks", async () => {
  const manifest = await readManifest();
  mkdirSync("dist/tsarrayfix", { recursive: true });
  for (const optimize of [false, true]) {
    const output = `dist/tsarrayfix/reentry${optimize ? "-opt" : ""}.bcmkn`;
    run(bin, ["build", "tests/fixtures/tsarrayfix-reentry.ts", "-o", output, ...(optimize ? ["--optimize"] : [])]);
    assert.deepEqual(JSON.parse(run(bin, ["run", output, "--ticks", "120"])).logs, ["1,3,0 2,3,9"]);
    assert.equal(JSON.parse(run(bin, ["check", output, "--json"])).ok, true);
    assert.equal(checkProject(JSON.parse(readFileSync(output, "utf8")), manifest).ok, true);
  }
});

const rejected = [
  'const a = [1]; a.includes(1, 0, 2);',
  'const a = [1]; a.indexOf(1, 0, 2);',
  'const a = [1]; a.lastIndexOf(1, 0, 2);',
  'const a = [1]; a.includes(1, undefined);',
  'const a = [1]; a.indexOf(1, undefined);',
  'const a = [1]; a.lastIndexOf(1, undefined);',
  'const a = [1]; a.pop(1);',
  'const a = [1]; a.shift(1);',
  'const a = [1]; a.reverse(1);',
  'const a = [1]; a.join(",", 1);',
  'const a = [1]; a.slice(0, 1, 2);',
  'const a = [1]; a.map(x => x, 1);',
  'const a = [1]; a.reduce((acc, x) => acc + x, 0, 1);',
  'const a = [1]; a.concat(...[[2], [3]]);',
  'const a = [1]; const value: any = 2; a.concat(value);',
  'const a = [1]; let value: number | number[] = 2; a.concat(value);',
  'const a = [1]; let value: number | number[] = [2]; a.concat(value);',
  'const a = [1]; a.unshift(...[2, 3]);',
  'const a = [1]; a.push(...[2, 3]);',
  'const a = [1]; a.splice(...[0, 1]);',
  'const a = [1, 2]; a.map(x => { a.pop(); return x; });',
  'const a = [1, 2]; const alias = a; a.map(x => { alias.length = 0; return x; });',
  'const a = [1, 2]; function shrink() { a.pop(); } a.map(x => { shrink(); return x; });',
  'const a = [1, 2]; const shrink = () => { const alias = a; alias.length = 0; }; a.find(x => { shrink(); return true; });',
  'const a = [1, 2]; a.findIndex((x, i, arr) => { arr.splice(0, 1); return false; });',
  'const a = [1, 2]; a.find(x => { wait(0.1); return false; });',
  'const a = [1, 2]; function change() { broadcast("shrink"); } a.map(x => { change(); return x; });',
];
for (const source of rejected) test(`tsarrayfix: located actionable diagnostic: ${source}`, () => {
  assert.throws(() => compileFile("tsarrayfix.ts", { readFile: () => source }), error =>
    error instanceof CompileError && error.location?.line > 0 && /omit|pass|remove|move|use|narrow/i.test(error.message));
  const result = checkFile("tsarrayfix.ts", { types: false, host: { readFile: () => source } });
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some(d => d.line > 0 && d.column > 0));
});
