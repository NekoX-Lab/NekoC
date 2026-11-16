import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import ts from "typescript";
import { CompileError, compileFile, checkFile } from "../ts/compile-ts.mjs";
import { asyncCases, expectedLocation, syncSource } from "./tsasyncguard-cases.mjs";
import { portablePath } from "../ts/portable-path.mjs";

const root = path.resolve(import.meta.dirname, "..");
const entry = path.resolve("virtual/tsasyncguard/main.ts");
const hostFor = source => ({ readFile: name => name === entry ? source : undefined });
const guidance = /async.*await.*not supported.*Promise.*microtask.*alternative:.*remove async\/await.*ordinary functions.*wait\(seconds\).*event state machine/i;

test("tsasyncguard browser paths distinguish absolute virtual paths from relative entries", () => {
  assert.equal(portablePath.isAbsolute("/main.ts"), true);
  assert.equal(portablePath.isAbsolute("main.ts"), false);
  assert.equal(portablePath.isAbsolute("./main.ts"), false);
  assert.equal(portablePath.isAbsolute("../main.ts"), false);
  assert.equal(portablePath.isAbsolute(""), false);
});

test("tsasyncguard advisor probes return Promises in JavaScript, never the scalar 7", () => {
  for (const [, source] of asyncCases.slice(0, 2)) {
    const logs = [];
    const javascript = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    vm.runInNewContext(javascript, { console: { log(value) { logs.push(String(value)); } } });
    assert.deepEqual(logs, ["[object Promise]"]);
  }
});

function assertDiagnostic(diagnostic, location) {
  assert.equal(diagnostic.code, "NEKOC");
  assert.equal(diagnostic.severity, "error");
  assert.equal(diagnostic.source, "compat");
  assert.match(diagnostic.message, guidance);
  assert.doesNotMatch(diagnostic.message, /Internal compiler error|TypeError|at offset/);
  assert.deepEqual({ file: diagnostic.file, line: diagnostic.line, column: diagnostic.column }, location);
}

for (const [name, body] of asyncCases) {
  test(`tsasyncguard rejects ${name} before lowering, with original keyword coordinates`, () => {
    const source = `// original source\n  ${body}`;
    const host = hostFor(source);
    const location = expectedLocation(source, entry);
    assert.throws(() => compileFile(entry, host), error => {
      assert.ok(error instanceof CompileError);
      assert.match(error.message, guidance);
      assert.deepEqual(error.location, location);
      return true;
    });
    const checked = checkFile(entry, { types: false, host });
    assert.equal(checked.ok, false);
    assert.equal(checked.report, null);
    assert.equal(checked.diagnostics.length, 1);
    assertDiagnostic(checked.diagnostics[0], location);
  });
}

test("tsasyncguard checks all source in transitive imports, not just used exports", () => {
  const library = path.resolve(path.dirname(entry), "lib.ts");
  const dependency = path.resolve(path.dirname(entry), "dependency.ts");
  for (const [, body] of asyncCases) {
    const source = `// dependency\n  ${body}\nexport function value() { return 1; }`;
    const files = new Map([
      [entry, 'import { value } from "./lib"; console.log(value());'],
      [library, 'import { value as inner } from "./dependency"; export function value() { return inner(); }'],
      [dependency, source],
    ]);
    const host = { readFile: name => files.get(name) };
    const checked = checkFile(entry, { types: false, host });
    assert.equal(checked.ok, false);
    assert.equal(checked.report, null);
    assertDiagnostic(checked.diagnostics[0], expectedLocation(source, dependency));
  }
});

test("tsasyncguard leaves synchronous functions, wait, timers and async identifiers compilable", () => {
  const checked = checkFile(entry, { types: false, host: hostFor(syncSource) });
  assert.equal(checked.ok, true, JSON.stringify(checked.diagnostics));
  assert.ok(Object.keys(checked.report.workspaceData.blocks).length > 0);
});

test("tsasyncguard npm API/CLI and browser branch reject before wasm assembly", async () => {
  // Package entrypoints with real frontend and type resources, but no wasm:
  // rejection must happen before assembly/validation is ever called.
  const parent = path.join(root, "dist/tsasyncguard");
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, "package-"));
  try {
    fs.mkdirSync(path.join(dir, "dist/frontend"), { recursive: true });
    fs.mkdirSync(path.join(dir, "bin"));
    fs.copyFileSync(path.join(root, "packages/nekoc/api.mjs"), path.join(dir, "api.mjs"));
    fs.copyFileSync(path.join(root, "packages/nekoc/bin/nekoc.mjs"), path.join(dir, "bin/nekoc.mjs"));
    for (const file of ["compile-ts.mjs", "portable-path.mjs"]) {
      fs.writeFileSync(path.join(dir, "dist/frontend", file), `export * from ${JSON.stringify(pathToFileURL(path.join(root, "ts", file)).href)};`);
    }
    const lib = path.join(root, "node_modules/typescript/lib");
    const resources = Object.fromEntries(fs.readdirSync(lib).filter(name => /^lib\..*\.d\.ts$/.test(name))
      .map(name => [name, fs.readFileSync(path.join(lib, name), "utf8")]));
    resources["nekoc.d.ts"] = fs.readFileSync(path.join(root, "ts/nekoc.d.ts"), "utf8");
    fs.writeFileSync(path.join(dir, "dist/resources.mjs"), `export default ${JSON.stringify(resources)};`);
    fs.writeFileSync(path.join(dir, "index.mjs"), 'import { api } from "./api.mjs"; export const { compile, check, createPlayer, importProject } = api({});');
    fs.writeFileSync(path.join(dir, "frame.mjs"), 'export const decodeFrame = () => { throw new Error("unexpected player call"); };');
    const { compile, check } = await import(pathToFileURL(path.join(dir, "index.mjs")).href);
    for (const [i, [, body]] of asyncCases.entries()) {
      const source = `// original\n  ${body}`;
      const file = `/async-${i}.ts`;
      const files = { [file]: source };
      for (const types of [true, false]) {
        const result = check(file, { files, types });
        assert.equal(result.ok, false);
        assertDiagnostic(result.diagnostics.find(d => d.source === "compat"), expectedLocation(source, file));
      }
      assert.throws(() => compile(file, { files }), error => {
        assert.match(error.message, guidance);
        assert.deepEqual(error.location, expectedLocation(source, file));
        return true;
      });
      const input = path.join(dir, `async-${i}.ts`);
      fs.writeFileSync(input, source);
      const cli = (...args) => spawnSync(process.execPath, [path.join(dir, "bin/nekoc.mjs"), ...args], { encoding: "utf8" });
      const built = cli("build", input);
      assert.equal(built.status, 1, built.stderr);
      assert.match(built.stderr, guidance);
      assert.doesNotMatch(built.stderr, /Internal compiler error|TypeError|\n\s+at /);
      assert.ok(!fs.existsSync(input.replace(/\.ts$/, ".bcmkn")));
      const checked = cli("check", input, "--json");
      assert.equal(checked.status, 1, checked.stderr);
      const result = JSON.parse(checked.stdout);
      assert.equal(result.ok, false);
      assertDiagnostic(result.diagnostics.find(d => d.source === "compat"),
        expectedLocation(source, input.replace(/^[A-Za-z]:/, "").replaceAll("\\", "/")));
    }
    // A separate VM context without process exercises the actual browser path
    // (portable paths, no node:fs), not just the frontend's Node branch.
    const browser = spawnSync(process.execPath, ["--experimental-vm-modules", path.join(root, "tests/tsasyncguard-browser.mjs"), dir], { encoding: "utf8" });
    assert.equal(browser.status, 0, browser.stdout + browser.stderr);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
