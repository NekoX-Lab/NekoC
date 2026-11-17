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
for (const name of ["probe", "receiver", "ranges", "eval", "identity", "shadow-infinity"]) {
  test(`tsarrslice: ${name} matches Node and passes structure/share checks with both optimizations`, async () => {
    const input = `tests/fixtures/tsarrslice-${name}.ts`;
    const expected = JSON.parse(run(process.execPath, ["tests/tsarrayfix-oracle.mjs", input]));
    if (name === "shadow-infinity") {
      assert.deepEqual(expected, ["10,20,30", "20,30", "20,30", "0", "20,30,40", "1 1 10,20,30,40"]);
      // This fixture is also plain JS: independently validate module scope in
      // native Node ESM instead of relying only on our CommonJS oracle adapter.
      const native = spawnSync(process.execPath, ["--input-type=module"], {
        input: readFileSync(input, "utf8"), encoding: "utf8",
      });
      assert.equal(native.status, 0, native.stderr);
      assert.deepEqual(native.stdout.trimEnd().split(/\r?\n/), expected);
    }
    if (name === "probe") assert.deepEqual(expected, ["20,30", "10,20", "20,30", "10,20,30"]);
    if (name === "receiver") assert.deepEqual(expected, ["20,30", "1"]);
    if (name === "eval") {
      assert.deepEqual(expected.slice(0, 4), ["20,30", "1", "1 1 1 rse", "4,5 1,2,3,4,5 9,8"]);
      assert.deepEqual(expected.slice(5), ["1 1,2,3", "1", "1 1", "0 0", "20,30 2", "0 1", "10,20,30 3"]);
    }
    const sourceCheck = checkFile(input);
    assert.equal(sourceCheck.ok, true, JSON.stringify(sourceCheck.diagnostics));
    const manifest = await readManifest();
    mkdirSync("dist/tsarrslice", { recursive: true });
    for (const optimize of [false, true]) {
      const output = `dist/tsarrslice/${name}${optimize ? "-opt" : ""}.bcmkn`;
      run(bin, ["build", input, "-o", output, ...(optimize ? ["--optimize"] : [])]);
      assert.deepEqual(JSON.parse(run(bin, ["run", output, "--ticks", "600"])).logs, expected);
      const check = JSON.parse(run(bin, ["check", output, "--json"]));
      assert.equal(check.ok, true, JSON.stringify(check));
      const share = checkProject(JSON.parse(readFileSync(output, "utf8")), manifest);
      assert.equal(share.ok, true, JSON.stringify(share));
    }
  });
}

for (const boundary of ['"1"', 'null', 'undefined']) {
  test(`tsarrslice: imported array parameter rejects unsupported boundary ${boundary}`, () => {
    const entry = path.resolve("tsarrslice-entry.ts"), module = path.resolve("tsarrslice-module.ts");
    const files = new Map([
      [entry, 'import { copy } from "./tsarrslice-module"; console.log(copy([1, 2]).length);'],
      [module, `export function copy(a: number[]): number[] {\nreturn a.slice(${boundary});\n}`],
    ]);
    assert.throws(() => compileFile(entry, { readFile: name => files.get(path.resolve(name)) }), error =>
      error instanceof CompileError && error.location?.line === 2
      && error.location?.file.replaceAll("\\", "/").endsWith("tsarrslice-module.ts")
      && /omit|convert/.test(error.message));
  });
}

test("tsarrslice: nullable syntax elsewhere does not reject numeric boundaries", () => {
  const source = 'let n: number | null = null; const a = [1, 2]; console.log(a.slice(0, 2).length);';
  assert.doesNotThrow(() => compileFile("tsarrslice.ts", { readFile: () => source }));
});

for (const type of ["null", "undefined"]) {
  test(`tsarrslice: nullable boundary is rejected before sentinel lowering: ${type}`, () => {
    const source = `const a = [1, 2]; function copy(boundary: number | ${type}) {\nreturn a.slice(boundary);\n}`;
    assert.throws(() => compileFile("tsarrslice.ts", { readFile: () => source }), error =>
      error instanceof CompileError && error.location?.line === 2 && /omit.*convert/.test(error.message));
  });
}

for (const args of ['"1"', '0, "2"', 'true', 'null', 'undefined', '0, undefined', '...bounds', '0, 1, 2', 'unknown', 'mixed']) {
  test(`tsarrslice: unsupported boundaries have located actionable errors: ${args}`, () => {
    const source = `const bounds = [0, 1]; const unknown: any = 1; let mixed: number | string = 1;\nconsole.log([1, 2, 3].slice(${args}).length);`;
    assert.throws(() => compileFile("tsarrslice.ts", { readFile: () => source }), error =>
      error instanceof CompileError && error.location?.line === 2 && /omit|convert|pass|remove/.test(error.message));
    const check = checkFile("tsarrslice.ts", { types: false, host: { readFile: () => source } });
    assert.equal(check.ok, false);
    assert.ok(check.diagnostics.some(d => d.line === 2 && d.column > 0 && /omit|convert|pass|remove/.test(d.message)));
  });
}
