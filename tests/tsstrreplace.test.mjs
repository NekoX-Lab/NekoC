import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { compileFile, checkFile } from "../ts/compile-ts.mjs";
import { readManifest } from "../tools/compat/kn-share-player-check.mjs";
import { diagnosticCases } from "./tsstrreplace-diagnostics.mjs";

const entry = path.resolve("tsstrreplace-main.ts");
const fixture = fs.readFileSync(new URL("fixtures/tsstrreplace.ts", import.meta.url), "utf8");
const root = path.resolve(import.meta.dirname, "..");
const invalid = [
  ['"abc".replace(/b/, "X")', /exactly two string arguments/],
  ['"abc".replace("b", () => "X")', /exactly two string arguments/],
  ['"abc".replaceAll(/b/g, "X")', /exactly two string arguments/],
  ['"abc".replaceAll("b", () => "X")', /exactly two string arguments/],
  ['"abc".replace("b")', /exactly two string arguments/],
  ['"abc".replace("b", "X", "ignored")', /exactly two string arguments/],
  ['"abc".replaceAll("b", "X", "ignored")', /exactly two string arguments/],
  ['"abc".replace(1, "X")', /exactly two string arguments/],
  ['"abc".replace("b", 1)', /exactly two string arguments/],
  ['"abc".replaceAll(...["b", "X"])', /exactly two string arguments/],
  ['"😀".replaceAll("", "X")', /UTF-16.*nonempty constant string search/],
  ['(getVar("s") as string).replaceAll("", "X")', /UTF-16.*nonempty constant string search/],
];
const guidance = source => ({ readFile: name => name === entry ? source : undefined });

test("tsstrreplace fixture compiles using only share-player blocks and valid return/parameter metadata", async () => {
  const report = compileFile(entry, guidance(fixture));
  const manifest = await readManifest();
  const workspaces = [report.workspaceData, ...report.procedures.map(p => p.workspaceData)];
  for (const workspace of workspaces) for (const block of Object.values(workspace.blocks)) {
    assert.ok(manifest.blocks.includes(block.type) || block.type === "procedures_2_stable_parameter", block.type);
    if (block.type === "procedures_2_return_value") {
      assert.match(block.mutation, /items="1"/);
      assert.match(block.shadows.VALUE, /math_number/);
    }
  }
  for (const procedure of report.procedures) {
    const blocks = Object.values(procedure.workspaceData.blocks);
    const parameters = new Set(procedure.params.filter(p => p.type !== "Label").map(p => p.id));
    for (const block of blocks) {
      if (block.type === "procedures_2_stable_parameter") assert.ok(parameters.has(block.id));
      if (block.type === "procedures_2_parameter") assert.ok(parameters.has(/\bid="([^"]+)"/.exec(block.mutation)?.[1]));
    }
  }
});

test("tsstrreplace unsupported overloads and UTF-16 empty-search boundaries have located diagnostics", () => {
  for (const [expression, message] of invalid) {
    const source = `// original\nconsole.log(${expression});`;
    assert.throws(() => compileFile(entry, guidance(source)), error => {
      assert.match(error.message, message);
      assert.equal(path.resolve(error.location.file), entry);
      assert.equal(error.location.line, 2);
      assert.equal(error.location.column, 13);
      return true;
    });
    const result = checkFile(entry, { types: false, host: guidance(source) });
    assert.equal(result.ok, false);
    assert.equal(result.report, null);
    assert.match(result.diagnostics[0].message, message);
    assert.equal(result.diagnostics[0].line, 2);
  }
  for (const source of [
    'let s: any = "abc"; console.log(s.replace("b", "X"));',
    'let s: any = "b"; console.log("abc".replace(s, "X"));',
    'let s: any = "X"; console.log("abc".replace("b", s));',
    'let s = ""; console.log("😀".replaceAll(s, "X"));',
    'function f(s: string) { return s.replaceAll("", "X"); } console.log(f("abc"));',
    'function unused() { return "abc".replace(/b/, "X"); }',
  ]) assert.throws(() => compileFile(entry, guidance(source)), /String.replace/);
  assert.throws(() => compileFile(entry, guidance('let a: string | null = null; console.log("abc".replace("a", a as string));')), /narrow it first/);
  for (const source of [
    'console.log("😀".replace("\\uD83D", "x"));',
    'console.log("abc".replace("a", "\\uDE00"));',
    'console.log("\\uD83D".replace("a", "x"));',
  ]) assert.throws(() => compileFile(entry, guidance(source)), /isolated UTF-16 surrogates.*complete Unicode/);
});

test("tsstrreplace imported functions preserve the same argument validation", () => {
  const library = path.resolve("tsstrreplace-lib.ts");
  const files = new Map([[entry, 'import { f } from "./tsstrreplace-lib"; console.log(f());'],
    [library, 'export function f(): string { return "abc".replace("b", () => "X"); }']]);
  assert.throws(() => compileFile(entry, { readFile: name => files.get(name) }), error => {
    assert.equal(path.resolve(error.location.file), library);
    assert.match(error.message, /exactly two string arguments/);
    return true;
  });
});

test("tsstrreplace diagnostics retain original class/nullable/literal coordinates in all frontend entrypoints", () => {
  const parent = path.join(root, "dist/tsstrreplace-revision");
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, "diagnostics-"));
  try {
    for (const item of diagnosticCases) {
      const file = path.join(dir, `${item.name}.ts`);
      fs.writeFileSync(file, item.source);
      const assertLocation = error => {
        assert.match(error.message, item.message);
        assert.equal(path.resolve(error.location.file), file);
        assert.equal(error.location.line, item.line);
        assert.equal(error.location.column, item.column);
        return true;
      };
      assert.throws(() => compileFile(file), assertLocation);
      for (const types of [false, true]) {
        const checked = checkFile(file, { types });
        assert.equal(checked.ok, false);
        const diagnostic = checked.diagnostics.find(d => d.source === "compat");
        assertLocation({ message: diagnostic.message, location: diagnostic });
        const result = spawnSync(process.execPath, ["ts/compile-ts.mjs", "--check", "--json", ...(types ? [] : ["--no-types"]), file], { encoding: "utf8" });
        assert.equal(result.status, 1, result.stderr);
        const cli = JSON.parse(result.stdout).diagnostics.find(d => d.source === "compat");
        assertLocation({ message: cli.message, location: cli });
      }
      // Imports retain their own untouched file, not just the entry's text.
      const main = path.join(dir, "main.ts");
      fs.appendFileSync(file, '\nexport function value() { return 1; }');
      fs.writeFileSync(main, `import { value } from "./${item.name}"; console.log(value());`);
      assert.throws(() => compileFile(main), assertLocation);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("tsstrreplace string validation leaves the typed named-list replace API available", () => {
  const report = compileFile(path.resolve("samples/typed_self_api.ts"));
  assert.ok(report.resources.sprites.length > 0);
  assert.doesNotThrow(() => compileFile(entry, guidance('onStart(() => { self.list("items").replace("index", 1, 2); });')));
  for (const source of [
    'let s: string | null = null; console.log(s?.replace("a", "X") ?? "NULL");',
    'let s: string | null = "abc"; if (s !== null) console.log(s.replace("b", "X"));',
    'class A { replace(n: number): number { return n + 1; } } console.log(new A().replace(2));',
    'class A { s: string = "abc"; f(): string { return this.s.replace("b", "X"); } } console.log(new A().f());',
  ]) assert.doesNotThrow(() => compileFile(entry, guidance(source)));
  const nullable = fs.readFileSync(new URL("fixtures/tsstrreplace-nullable.ts", import.meta.url), "utf8");
  assert.doesNotThrow(() => compileFile(entry, guidance(nullable)));
});

test("tsstrreplace check/build and npm/browser accept the same string overloads", async () => {
  const parent = path.join(root, "dist/tsstrreplace");
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, "package-"));
  try {
    fs.mkdirSync(path.join(dir, "dist/frontend"), { recursive: true });
    fs.copyFileSync(path.join(root, "packages/nekoc/api.mjs"), path.join(dir, "api.mjs"));
    for (const file of ["compile-ts.mjs", "portable-path.mjs"]) {
      fs.writeFileSync(path.join(dir, "dist/frontend", file), `export * from ${JSON.stringify(pathToFileURL(path.join(root, "ts", file)).href)};`);
    }
    const lib = path.join(root, "node_modules/typescript/lib");
    const resources = Object.fromEntries(fs.readdirSync(lib).filter(name => /^lib\..*\.d\.ts$/.test(name))
      .map(name => [name, fs.readFileSync(path.join(lib, name), "utf8")]));
    resources["nekoc.d.ts"] = fs.readFileSync(path.join(root, "ts/nekoc.d.ts"), "utf8");
    fs.writeFileSync(path.join(dir, "dist/resources.mjs"), `export default ${JSON.stringify(resources)};`);
    const { api } = await import(pathToFileURL(path.join(dir, "api.mjs")).href);
    let assemblies = 0;
    const frontend = api({ assembleBcmkn: report => { assemblies++; return report; }, projectDiagnostics: () => "[]" });
    const files = { "/main.ts": fixture };
    assert.equal(frontend.check("/main.ts", { files }).ok, true);
    const compiled = frontend.compile("/main.ts", { files });
    assert.ok(compiled.report.procedures.length > 0);
    assert.equal(assemblies, 2);
    const nullableFiles = { "/main.ts": fs.readFileSync(new URL("fixtures/tsstrreplace-nullable.ts", import.meta.url), "utf8") };
    assert.equal(frontend.check("/main.ts", { files: nullableFiles }).ok, true);
    assert.doesNotThrow(() => frontend.compile("/main.ts", { files: nullableFiles }));
    for (const [expression, message] of invalid) {
      const files = { "/main.ts": `console.log(${expression});` };
      assert.equal(frontend.check("/main.ts", { files }).ok, false, expression);
      assert.throws(() => frontend.compile("/main.ts", { files }), message);
    }
    for (const item of diagnosticCases) {
      const files = { "/main.ts": item.source };
      for (const types of [false, true]) {
        const checked = frontend.check("/main.ts", { files, types });
        assert.equal(checked.ok, false);
        const diagnostic = checked.diagnostics.find(d => d.source === "compat");
        assert.match(diagnostic.message, item.message);
        assert.equal(diagnostic.line, item.line);
        assert.equal(diagnostic.column, item.column);
      }
      assert.throws(() => frontend.compile("/main.ts", { files }), error => {
        assert.equal(error.location.line, item.line);
        assert.equal(error.location.column, item.column);
        return true;
      });
    }
    const browser = spawnSync(process.execPath, ["--experimental-vm-modules", "tests/tsstrreplace-browser.mjs", dir], { encoding: "utf8" });
    assert.equal(browser.status, 0, browser.stdout + browser.stderr);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
