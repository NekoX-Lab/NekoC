import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import ts from "typescript";
import { checkFile, compileFile, CompileError } from "../ts/compile-ts.mjs";
import { createExpressionTypes } from "../ts/tsstr-types.mjs";
import { checkProject, readManifest } from "../tools/compat/kn-share-player-check.mjs";

const bin = path.resolve("target/debug", process.platform === "win32" ? "nekoc.exe" : "nekoc");
const run = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
};
test("tsargorder: intersection classification only extends proven numeric domains", () => {
  const file = ts.createSourceFile(path.resolve("tsargorder-types.ts").replaceAll("\\", "/"), `
    type Brand = { readonly brand?: "test" };
    function inspect(n: number & Brand, s: string & Brand, b: boolean & Brand,
      mixed: (number | string) & Brand, o: Brand) { n; s; b; mixed; o; }
  `, ts.ScriptTarget.Latest, true);
  const classify = createExpressionTypes(new Map([[path.resolve(file.fileName), file]]), "", path);
  const reads = file.statements[1].body.statements.map(statement => statement.expression);
  assert.deepEqual(reads.map(classify), ["number", "unknown", "unknown", "unknown", "unknown"]);
});
for (const name of ["defaults", "procedures", "classes", "plain-classes", "modules", "splice", "generic", "unused-arrays"]) {
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
  'function f<T extends string>(n: T) { const a = [1]; a.splice(n, 0); } f("1");',
  'function f<T>(n: T) { const a = [1]; a.splice(0, n); } f(1);',
  'function f<T extends number | string>(n: T) { const a = [1]; a.splice(n, 0); } f(1);',
  'type N = string & { readonly brand?: "text" }; function f(n: N) { const a = [1]; a.splice(n, 0); } f("1");',
  'type N = { readonly brand?: "object" }; function f<T extends N>(n: T) { const a = [1]; a.splice(0, n); } f({});',
  'type N = (number | string) & { readonly brand?: "mixed" }; function f<T extends N>(n: T) { const a = [1]; a.splice(n, 0); } f(1);',
]) test(`tsargorder: unsupported arguments stay located and actionable: ${source}`, () => {
  assert.throws(() => compileFile("tsargorder.ts", { readFile: () => source }), error =>
    error instanceof CompileError && error.location?.line === 1 && /constant|omit|pass|convert/.test(error.message));
});
