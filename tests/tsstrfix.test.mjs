import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { compileFile, checkFile } from "../ts/compile-ts.mjs";
import { readManifest } from "../tools/compat/kn-share-player-check.mjs";
import { prepare } from "./tsstrfix-cases.mjs";

const compile = source => compileFile("strings.ts", { readFile: () => source });
const blocks = report => [report.workspaceData, ...report.procedures.map(p => p.workspaceData)]
  .flatMap(w => Object.values(w.blocks));

test("tsstrfix runtime paths use share-compatible blocks and valid procedure parameters/returns", async () => {
  const { expected, report } = prepare();
  assert.ok(expected.length > 400);
  const manifest = await readManifest();
  for (const b of blocks(report)) {
    assert.ok([...manifest.blocks, ...manifest.metadataBlocks].includes(b.type), b.type);
    if (b.type === "procedures_2_return_value") {
      assert.match(b.mutation, /items="1"/);
      assert.match(b.shadows.VALUE, /type="math_number"/);
    }
  }
  for (const p of report.procedures) {
    const definitions = new Set(Object.values(p.workspaceData.blocks)
      .filter(b => b.type === "procedures_2_stable_parameter").map(b => b.id));
    for (const param of p.params.filter(p => p.type === "String")) assert.ok(definitions.has(param.id));
    for (const b of Object.values(p.workspaceData.blocks).filter(b => b.type === "procedures_2_parameter")) {
      assert.ok(definitions.has(/id="([^"]+)"/.exec(b.mutation)?.[1]));
    }
  }
});

test("tsstrfix rejects discarded arguments, unsupported overloads and unsafe growth with source guidance", () => {
  for (const expression of [
    's.charAt(1, 2)', 's.substring(1, 2, 3)', 's.startsWith("x", 0, 1)',
    's.endsWith(...["x"])', 's.includes("x", undefined)', 's.split(/x/)',
    's.split(",", 1, 2)', 's.trim(1)', 's.padStart(3, "0", 1)',
    's.repeat(-1)', 's.repeat(Infinity)', 's.repeat(70000)', 's.repeat(n)',
    's.padStart(Infinity)', 's.padEnd(n)', 's.padStart(3, fill)',
    '"😀".charAt(0)', '"x".padStart(2, "😀")', '"x".padEnd(2, "😀")',
    '"x".repeat(1e100)',
  ]) {
    const source = `let s = "x"; let n = 3; let fill = "0";\nconsole.log(${expression});`;
    for (const types of [false, true]) {
      const result = checkFile("strings.ts", { types, host: { readFile: () => source } });
      assert.equal(result.ok, false, expression);
      const diagnostic = result.diagnostics.find(d => d.source === "compat") ?? result.diagnostics[0];
      assert.equal(diagnostic.line, 2, expression);
      assert.match(diagnostic.message, /argument|spread|undefined|string|surrogate|bounded|fill|UTF-16/i, expression);
    }
    assert.throws(() => compile(source), expression);
  }
});

test("tsstrfix complete emoji boundaries, safe growth and existing negative slice remain accepted", () => {
  compile('console.log("😀".substring(0, 2), "😀".repeat(2), "x".padEnd(3, "😀"));');
  compile('let text = "abcd"; console.log(text.slice(-3, -1), text.substring(-2, 2));');
  compile('function s(): string { return "中😀"; } function n(): number { return 2.5; } console.log(s().repeat(n()));');
  assert.throws(() => compile('let self = "x"; let n = 3; console.log(self.repeat(n));'), /bounded/);
  assert.throws(() => compile('function n() { return 2; } n = () => Infinity; console.log("x".repeat(n()));'), /bounded/);
});

test("tsstrfix review: lexical self bindings never bypass bounded growth validation", () => {
  const expressions = ['repeat(-1)', 'repeat(Infinity)', 'repeat(65537)', 'padEnd(Infinity)', 'padEnd(2, "😀")'];
  for (const expression of expressions) {
    for (const source of [
      `let self: any = "x";\nconsole.log(self.${expression});`,
      `function p(self: any): string {\nreturn self.${expression}; } console.log(p("x"));`,
      `let self: any = "x";\nconsole.log((self as string).${expression});`,
      `sprite("cat", {}, self => { let other: any = "x";\nconsole.log((other as any).${expression}); });`,
    ]) {
      for (const types of [false, true]) {
        const checked = checkFile("strings.ts", { types, host: { readFile: () => source } });
        assert.equal(checked.ok, false, source);
        assert.ok(checked.diagnostics.some(d => d.line === 2 && /bounded|UTF-16|surrogate/i.test(d.message)), JSON.stringify(checked));
      }
      assert.throws(() => compile(source), /bounded|UTF-16|surrogate/i, source);
    }
  }
  compile('sprite("cat", {}, self => { self.onStart(() => { self.repeat(3, () => { self.move(1); }); }); });');
  assert.throws(() => compile('sprite("cat", {}, (self: any) => { self = "x"; console.log(self.repeat(Infinity)); });'), /bounded/);
});

test("tsstrfix review: unprovable UTF-16 selections fail at source rather than in the VM", () => {
  for (const method of ['charAt(0)', 'substring(0, 1)', 'split("", 1)', 'includes("a", 0)', 'startsWith("a", 1)', 'endsWith("a")', 'lastIndexOf("a")']) {
    for (const source of [
      `let s = "😀abc";\nconsole.log(s.${method});`,
      `function p(s: string) {\nconsole.log(s.${method}); } p("😀abc");`,
      `let values = ["😀abc"];\nconsole.log(values[0].${method});`,
      `class Text { value = "😀abc"; } const text = new Text();\nconsole.log(text.value.${method});`,
      `let self: any = "😀abc";\nconsole.log((self as any).${method});`,
    ]) {
      for (const types of [false, true]) {
        const checked = checkFile("strings.ts", { types, host: { readFile: () => source } });
        assert.equal(checked.ok, false, source);
        assert.ok(checked.diagnostics.some(d => d.line === 2 && /UTF-16.*alternative/i.test(d.message)), JSON.stringify(checked));
      }
      assert.throws(() => compile(source), /UTF-16.*alternative/i, source);
    }
  }
  compile('function p(s: string) { return s.charAt(0); } console.log(p("abc"));');
  compile('let s = "😀abc"; console.log(s.includes("a"), s.split(",", 1).join("|"));');
  assert.throws(() => compile('let s = "abc"; [s] = ["😀"]; console.log(s.charAt(0));'), /UTF-16|Assignment|assignment/);
});

test("tsstrfix CLI and shared npm/browser wrapper preserve options and compatibility diagnostics", async () => {
  const wrapper = fs.readFileSync("packages/nekoc/api.mjs", "utf8")
    .replace('"./dist/frontend/compile-ts.mjs"', JSON.stringify(new URL("../ts/compile-ts.mjs", import.meta.url).href))
    .replace('import resources from "./dist/resources.mjs";', 'const resources = {};')
    .replace('"./dist/frontend/portable-path.mjs"', JSON.stringify(new URL("../ts/portable-path.mjs", import.meta.url).href));
  const { api } = await import(`data:text/javascript;base64,${Buffer.from(wrapper).toString("base64")}`);
  const sdk = api({ assembleBcmkn: report => report, projectDiagnostics: () => "[]" });
  const source = 'let s = "ababa"; let p = 1; console.log(s.substring(p), s.startsWith("b", p), s.split("b", p).join("|"));';
  const options = { files: { "/main.ts": source }, types: false };
  assert.equal(sdk.check("/main.ts", options).ok, true);
  assert.ok(sdk.compile("/main.ts", options).report.procedures.some(p => p.name === "__str_substring"));
  options.files["/main.ts"] = 'let s = "ababa";\nconsole.log(s.startsWith("b", 1, 2));';
  assert.equal(sdk.check("/main.ts", options).ok, false);
  assert.throws(() => sdk.compile("/main.ts", options), error => error.location.line === 2 && /argument/.test(error.message));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tsstrfix-cli-"));
  try {
    const input = path.join(dir, "main.ts");
    const out = path.join(dir, "report.json");
    const run = args => spawnSync(process.execPath, ["ts/compile-ts.mjs", ...args], { encoding: "utf8" });
    fs.writeFileSync(input, source);
    const built = run([input, out]);
    assert.equal(built.status, 0, built.stderr);
    assert.ok(JSON.parse(fs.readFileSync(out, "utf8")).procedures.some(p => p.name === "__str_split"));
    for (const types of [[], ["--no-types"]]) {
      const checked = run(["--check", "--json", input, ...types]);
      assert.equal(checked.status, 0, checked.stdout + checked.stderr);
    }
    fs.writeFileSync(input, options.files["/main.ts"]);
    const rejected = run(["--check", "--json", input, "--no-types"]);
    assert.equal(rejected.status, 1);
    assert.ok(JSON.parse(rejected.stdout).diagnostics.some(d => d.line === 2 && /argument/.test(d.message)));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
