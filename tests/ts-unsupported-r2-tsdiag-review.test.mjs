import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { checkFile, compileFile, CompileError, formatDiagnostic } from "../ts/compile-ts.mjs";

const modules = [
  ["function-expression", "export const f = function(n: number) { return n + 1; };"],
  ["parenthesized-arrow", "export const f = ((n: number) => n + 1);"],
  ["multiple-declarations", "export const f = (n: number) => n + 1, g = () => 9;"],
  ["static-alias", "function original(n: number) { return n + 1; } const helper = original; export function f(n: number) { return helper(n); }"],
  ["wrapped-alias-chain", "const original = function(n: number) { return n + 1; }; const first = (original), helper = (first); export function f(n: number) { return helper(n); }"],
];
for (const [id, library] of modules) {
  test(`r2-tsdiag review module registration: ${id}`, () => {
    const parent = path.resolve(process.env.NEKOC_SEMANTIC_ARTIFACT_DIR ?? "dist/r2-tsdiag-review");
    fs.mkdirSync(parent, { recursive: true });
    const dir = fs.mkdtempSync(path.join(parent, `${id}-`));
    try {
      const entry = path.join(dir, "main.ts"), output = path.join(dir, "main.bcmkn");
      fs.writeFileSync(entry, 'import { f } from "./lib"; console.log(f(2));');
      fs.writeFileSync(path.join(dir, "lib.ts"), library);
      const checked = checkFile(entry);
      assert.equal(checked.ok, true, JSON.stringify(checked.diagnostics));
      assert.doesNotThrow(() => compileFile(entry));
      const bin = path.resolve("target/debug", process.platform === "win32" ? "nekoc.exe" : "nekoc");
      for (const args of [["build", entry, "-o", output], ["run", output, "--ticks", "120"]]) {
        const result = spawnSync(bin, args, { encoding: "utf8", env: { ...process.env, NEKOC_FRONTEND: path.resolve("ts") } });
        assert.equal(result.status, 0, result.stderr);
        if (args[0] === "run") assert.deepEqual(JSON.parse(result.stdout).logs, ["3"]);
      }
    } finally {
      if (!process.env.NEKOC_SEMANTIC_ARTIFACT_DIR) fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("r2-tsdiag review module guard retains mixed declarations and side effects", () => {
  const entry = path.resolve("virtual/r2-tsdiag-review/main.ts"), lib = path.join(path.dirname(entry), "lib.ts");
  for (const source of [
    'export const f = (n: number) => n + 1, value = 99;',
    'const helper = function() { return 1; }, value = console.log(99); export function f() { return helper(); }',
    'export const f = ((n: number) => n + 1); console.log(99);',
  ]) {
    const result = checkFile(entry, { types: false, host: { readFile: name => name === entry
      ? 'import { f } from "./lib"; console.log(f(2));' : name === lib ? source : undefined } });
    assert.equal(result.ok, false);
    assert.equal(result.report, null);
    assert.match(result.diagnostics[0].message, /top-level values or side effects|Only exported functions are supported/);
    assert.equal(result.diagnostics[0].file, lib.replaceAll("\\", "/"));
  }
});

test("r2-tsdiag review preflight retains supported class and nullable sequences", () => {
  for (const source of [
    'let n=0; class C { f(){ return (n=2,n+1); } } console.log(new C().f());',
    'let n=0; let x:number|null=null; x ??= 2; const y=(n=3,n+1); console.log(x,y);',
    'let n=0; for(let i=0,j=0;i<2;i++,j++) n+=j; console.log(n);',
  ]) {
    const result = checkFile("sequence-positive.ts", { types: false, host: { readFile: () => source } });
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  }
});

const sequences = [
  ["class-condition", 'let n=0; class C { f(){ if ((/*error*/n++, n<2)) return 1; return 2; } } console.log(new C().f());', /Comma expressions here/],
  ["nullable-assignment", 'let n=0; let x:number|null=null; x ??= (/*error*/n++,2); console.log(x);', /Comma expressions here/],
  ["class-update-value", 'let n=0; class C { f(){ const x=(/*error*/n++,2); return x; } } console.log(new C().f());', /Update values inside comma/],
  ["class-property-assignment", 'const p={x:1}; class C { f(){ return (/*error*/p.x=2,3); } } console.log(new C().f());', /Assignment values require/],
  ["multiline-class-nullable", 'let n=0;\r\nclass C {\r\n f(){ let x:number|null=null; x ??= (/*error*/n++,2); return x; }\r\n}\r\nconsole.log(new C().f());', /Comma expressions here/],
];
for (const [id, marked, reason] of sequences) {
  for (const imported of [false, true]) {
    test(`r2-tsdiag review original sequence location: ${id}, imported=${imported}`, () => {
      const entry = path.resolve("virtual/r2-tsdiag-review/main.ts"), lib = path.join(path.dirname(entry), "lib.ts");
      const offset = marked.indexOf("/*error*/");
      const prefix = marked.slice(0, offset).split("\n");
      const source = marked.replace("/*error*/", "");
      const file = imported ? lib : entry;
      const expected = { file: file.replaceAll("\\", "/"), line: prefix.length, column: prefix.at(-1).length + 1 };
      const host = { readFile: name => name === file ? source + (imported ? '\nexport function f(){ return 1; }' : '')
        : imported && name === entry ? 'import { f } from "./lib"; console.log(f());' : undefined };
      const checked = checkFile(entry, { types: false, host });
      assert.equal(checked.ok, false);
      assert.equal(checked.report, null);
      assert.equal(checked.diagnostics.length, 1);
      const [d] = checked.diagnostics;
      assert.match(d.message, reason);
      assert.notEqual(d.code, "NEKOC_INTERNAL");
      assert.deepEqual({ file: d.file, line: d.line, column: d.column }, expected);
      assert.ok(formatDiagnostic(d).startsWith(`${expected.file}:${expected.line}:${expected.column}: error `));
      assert.throws(() => compileFile(entry, host), error => {
        assert.ok(error instanceof CompileError);
        assert.equal(error.message, d.message);
        assert.deepEqual(error.location, expected);
        return true;
      });
    });
  }
}

test("r2-tsdiag review CLI preserves exact rewritten and imported coordinates", () => {
  const parent = path.resolve("dist/r2-tsdiag-review");
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, "cli-locations-"));
  try {
    for (const [id, marked, reason] of sequences.slice(0, 2)) {
      for (const imported of [false, true]) {
        const entry = path.join(dir, "main.ts"), lib = path.join(dir, "lib.ts");
        const file = imported ? lib : entry;
        const offset = marked.indexOf("/*error*/");
        fs.writeFileSync(file, marked.replace("/*error*/", "") + (imported ? '\nexport function f(){ return 1; }' : ''));
        if (imported) fs.writeFileSync(entry, 'import { f } from "./lib"; console.log(f());');
        const result = spawnSync(process.execPath, ["ts/compile-ts.mjs", "--check", "--no-types", "--json", entry], { encoding: "utf8" });
        assert.equal(result.status, 1, `${id}: ${result.stderr}`);
        const checked = JSON.parse(result.stdout);
        assert.equal(checked.ok, false);
        const [d] = checked.diagnostics;
        assert.match(d.message, reason);
        assert.deepEqual({ file: d.file, line: d.line, column: d.column },
          { file: file.replaceAll("\\", "/"), line: 1, column: offset + 1 });
      }
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
