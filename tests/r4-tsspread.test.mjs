import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { CompileError, compileFile, checkFile } from "../ts/compile-ts.mjs";
import { frontendFiles } from "../tools/package-release.mjs";
import { assertJsLogs } from "./ts-runtime.mjs";
import { rejectedCases, expectedLocation, supportedCases } from "./r4-tsspread-cases.mjs";
import { originalCases, prepareCases } from "./ts-js-semantics/prepare.mjs";
import ts from "typescript";
import { validateUnsupportedSyntax } from "../ts/js-support.mjs";

const entry = path.resolve("virtual/r4-tsspread/main.ts");
const hostFor = source => ({ readFile: name => name === entry ? source : undefined });

function assertDiagnostic(diagnostic, source, file, context) {
  assert.equal(diagnostic.code, context.startsWith("Array destructuring assignment") ? "NEKOC_TS_DESTRUCTURE" : "NEKOC");
  assert.equal(diagnostic.severity, "error");
  assert.equal(diagnostic.source, "compat");
  assert.ok(diagnostic.message.startsWith(context), diagnostic.message);
  assert.match(diagnostic.message, /not supported|supports only|requires|supports 2 non-spread/);
  assert.match(diagnostic.message, /alternative:|use |pass |read |split /i);
  assert.ok(diagnostic.suggestion.length > 10);
  assert.doesNotMatch(diagnostic.message, /Internal compiler error|TypeError/);
  assert.deepEqual({ file: diagnostic.file, line: diagnostic.line, column: diagnostic.column }, expectedLocation(source, file));
  assert.ok(diagnostic.snippet.includes("..."), JSON.stringify(diagnostic));
}

for (const [name, body, context] of rejectedCases) {
  test(`r4-tsspread: rejects ${name} before lowering with original coordinates`, () => {
    const source = `// original source\n  ${body}`;
    const host = hostFor(source);
    for (const target of ["kitten-n", "kitten4"]) {
      assert.throws(() => compileFile(entry, host, { target }), error => {
        assert.ok(error instanceof CompileError);
        assert.deepEqual(error.location, expectedLocation(source, entry));
        assertDiagnostic(error.diagnostics[0], source, entry, context);
        return true;
      });
      const checked = checkFile(entry, { types: false, host, target });
      assert.equal(checked.ok, false);
      assert.equal(checked.report, null);
      assert.equal(checked.diagnostics.length, 1);
      assertDiagnostic(checked.diagnostics[0], source, entry, context);
    }
  });
}

test("r4-tsspread: transitive imports reject unused syntax before lowering", () => {
  const library = path.resolve(path.dirname(entry), "lib.ts");
  const dependency = path.resolve(path.dirname(entry), "dependency.ts");
  for (const [, body, context] of rejectedCases) {
    const source = `// imported source\n  ${body}\nexport function value() { return 1; }`;
    const files = new Map([
      [entry, 'import { value } from "./lib"; console.log(value());'],
      [library, 'import { value as inner } from "./dependency"; export function value() { return inner(); }'],
      [dependency, source],
    ]);
    const checked = checkFile(entry, { types: false, host: { readFile: name => files.get(name) } });
    assert.equal(checked.ok, false);
    assert.equal(checked.report, null);
    assertDiagnostic(checked.diagnostics[0], source, dependency, context);
  }
});

test("r4-tsspread: release frontend ships only the unified validator", () => {
  assert.equal(frontendFiles.filter(name => name === "js-support.mjs").length, 1);
  assert.ok(!frontendFiles.includes("ts-r4-spread.mjs"));
});

test("r4-tsspread: unified AST visitor never reports a spread node twice", () => {
  for (const source of ['console.log(...[1]);', 'new C(...[1]);', '"a".replaceAll(...["a", "b"]);',
    'const a = [...[1]];', 'const a = {...{x: 1}};', 'function f(...args: number[]) {}']) {
    const diagnostics = [];
    validateUnsupportedSyntax(ts.createSourceFile("one.ts", source, ts.ScriptTarget.Latest, true),
      (node, message) => diagnostics.push({ node, message }));
    assert.equal(diagnostics.length, 1, source);
  }
});

test("r4-tsspread: original JS corpus records deliberate spread/rest rejection", () => {
  const cases = originalCases.filter(item => ["core-030", "core-157"].includes(item.id));
  assert.equal(cases.length, 2);
  for (const item of prepareCases(cases)) {
    assert.equal(item.status, "compile-error");
    assert.ok(item.compileError.includes(item.expectedError), JSON.stringify(item));
    assert.equal(item.report, undefined);
  }
});

test("r4-tsspread: npm browser API rejects before wasm, with and without types", () => {
  const checked = spawnSync(process.execPath, ["--experimental-vm-modules", "tests/r4-tsspread-browser.mjs"], { encoding: "utf8" });
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
});

for (const [name, source] of supportedCases) {
  test(`r4-tsspread: ${name} still matches JavaScript`, () => {
    assert.ok(compileFile(entry, hostFor(source)).summary.blocks > 0);
    assertJsLogs(source);
  });
}

test("r4-tsspread: editor fixture preserves shallow copies and default evaluation order", () => {
  assertJsLogs(readFileSync(new URL("fixtures/r4-tsspread-supported.ts", import.meta.url), "utf8"));
});
