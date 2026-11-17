import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { compileFile, checkFile } from "../ts/compile-ts.mjs";
import { readManifest } from "../tools/compat/kn-share-player-check.mjs";
import { prepare } from "./tsstrfix-cases.mjs";
import ts from "typescript";
import { lowerTsMethods } from "../ts/tsfeat-methods.mjs";

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
    's.repeat(-1)', 's.repeat(Infinity)',
    '"😀".charAt(0)', '"x".padStart(2, "😀")', '"x".padEnd(2, "😀")',
  ]) {
    const source = `let s = "x"; let n = 3; let fill = "0";\nconsole.log(${expression});`;
    for (const types of [false, true]) {
      const result = checkFile("strings.ts", { types, host: { readFile: () => source } });
      assert.equal(result.ok, false, expression);
      const diagnostic = result.diagnostics.find(d => d.source === "compat") ?? result.diagnostics[0];
      assert.equal(diagnostic.line, 2, expression);
      assert.match(diagnostic.message, /argument|spread|undefined|string|surrogate|count|fill|UTF-16/i, expression);
    }
    assert.throws(() => compile(source), expression);
  }
});

test("tsstrfix complete emoji boundaries, safe growth and existing negative slice remain accepted", () => {
  compile('console.log("😀".substring(0, 2), "😀".repeat(2), "x".padEnd(3, "😀"));');
  compile('let text = "abcd"; console.log(text.slice(-3, -1), text.substring(-2, 2));');
  compile('function s(): string { return "中😀"; } function n(): number { return 2.5; } console.log(s().repeat(n()));');
  compile('let self = "x"; let n = 3; console.log(self.repeat(n));');
  assert.throws(() => compile('function n() { return 2; } n = () => Infinity; console.log("x".repeat(n()));'), /function/i);
});

test("tsstrfix review: lexical self bindings never bypass bounded growth validation", () => {
  const expressions = ['repeat(-1)', 'repeat(Infinity)'];
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
        assert.ok(checked.diagnostics.some(d => d.line === 2 && /count.*alternative/i.test(d.message)), JSON.stringify(checked));
      }
      assert.throws(() => compile(source), /count.*alternative/i, source);
    }
  }
  compile('sprite("cat", {}, self => { self.onStart(() => { self.repeat(3, () => { self.move(1); }); }); });');
  assert.throws(() => compile('sprite("cat", {}, (self: any) => { self = "x"; console.log(self.repeat(Infinity)); });'), /count/);
});

test("tsstrfix review: unprovable UTF-16 selections compile through a runtime guard", () => {
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
        assert.ok(!checked.diagnostics.some(d => d.source === "compat"), JSON.stringify({source, checked}));
      }
      assert.ok(blocks(compile(source)).some(b => b.type === "text_split"), source);
    }
  }
  compile('function p(s: string) { return s.charAt(0); } console.log(p("abc"));');
  compile('let s = "😀abc"; console.log(s.includes("a"), s.split(",", 1).join("|"));');
  assert.throws(() => compile('let s = "abc"; [s] = ["😀"]; console.log(s.charAt(0));'), /Assignment|assignment/);
});

test("tsstrfix re-review: loop and destructuring writes select runtime guards instead of unsafe BMP fast paths", () => {
  const guarded = (source, expression) => {
    const offset = source.lastIndexOf(expression);
    const prefix = source.slice(0, offset).split("\n");
    const line = prefix.length, column = prefix.at(-1).length + 1;
    assert.ok(offset >= 0);
    assert.ok(line > 0 && column > 0);
    const lowered = lowerTsMethods(ts.createSourceFile("strings.ts", source, ts.ScriptTarget.Latest, true));
    assert.match(lowered.text, /splitText\(/, source);
  };
  const methods = ['includes("a", 0)', 'charAt(0)', 'substring(0, 1)', 'split("", 1)'];
  for (const method of methods) {
    // The four reviewer paths, including proof propagation through a return.
    guarded(`let s = "abc";\nfor (s of ["😀abc"]) {\nconsole.log(s.${method});\n}`, `s.${method}`);
    guarded(`function p(s: string) {\nfor (s of ["😀abc"]) {}\nconsole.log(s.${method});\n} p("abc");`, `s.${method}`);
    guarded(`function p(): string { let s = "abc";\nfor (s of ["😀abc"]) {}\nreturn s; }\nconsole.log(p().${method});`, `p().${method}`);
  }
  const targets = ["s", "(s)", "(s as string)", "(<string>s)", "s!", "(s satisfies string)",
    "[s]", "[...s]", '[s = "abc"]', "({s})", "({value: s})", "({...s})",
    "({value: [s]})", '({value: s = "abc"})', "[(s as string)]"];
  for (const target of targets) {
    for (const loop of ["of", "in"]) {
      for (const scope of ["variable", "parameter"]) {
        const setup = scope === "variable" ? 'let s = "abc";' : 'function p(s: string) {';
        const end = scope === "variable" ? "" : '} p("abc");';
        guarded(`${setup}\nfor (${target} ${loop} ["😀abc"]) {}\nconsole.log(s.charAt(0));\n${end}`, "s.charAt(0)");
      }
    }
  }
  for (const write of ['s = "😀"', 's += "😀"', 's ||= "😀"', 's++', '--(s as any)',
    '[s] = ["😀"]', '({s} = {s: "😀"})', '({v: [s]} = {v: ["😀"]})',
    '([...s] = ["😀"])', '({v: s = "abc"} = {v: "😀"})']) {
    guarded(`let s = "abc";\n${write};\nconsole.log(s.charAt(0));`, "s.charAt(0)");
    guarded(`function p(s: string) {\n${write};\nconsole.log(s.charAt(0)); } p("abc");`, "s.charAt(0)");
  }
  // Writes anywhere invalidate the proof, even if selection appears first.
  guarded('let s = "abc";\nconsole.log(s.charAt(0));\nfor (s of ["😀"]) {}', "s.charAt(0)");
  guarded('const s = "abc";\nfor (s of ["😀"]) {}\nconsole.log(s.charAt(0));', "s.charAt(0)");
  // Safe simple assignments and lexical shadowing remain distinct from unknown
  // loop/destructuring writes. Unary reads are not ++/-- writes.
  compile('let s = "abc"; s = "xyz"; s += "中"; console.log(!s, s.charAt(0));');
  compile('let s = "abc"; function p() { let s = "x"; for (s of ["😀"]) {} } console.log(s.charAt(0));');
});

test("tsstrfix re-review: shared write facts also invalidate bounded producers and DSL exemptions", () => {
  for (const write of ['for (n of [bad]) {}', '[n] = [bad]', '({n} = {n: bad})', 'n++']) {
    const source = `function n(): number { return 2; } function bad(): number { return Infinity; }\n${write};\nconsole.log("x".repeat(n()));`;
    for (const types of [false, true]) {
      const checked = checkFile("strings.ts", { types, host: { readFile: () => source } });
      assert.equal(checked.ok, false, source);
      assert.ok(checked.diagnostics.some(d => /function|assignment|update/i.test(d.message)), JSON.stringify(checked));
    }
    assert.throws(() => compile(source), /function|assignment|update/i);
  }
  for (const write of ['for (self of ["x"]) {}', '[self] = ["x"]', '({self} = {self: "x"})', 'self++']) {
    const body = `${write};\nconsole.log(self.repeat(Infinity));`;
    const source = `sprite("cat", {}, (self: any) => { ${body} });`;
    for (const types of [false, true]) {
      const checked = checkFile("strings.ts", { types, host: { readFile: () => source } });
      assert.ok(checked.diagnostics.some(d => d.line === 2 && /count.*alternative/i.test(d.message)), JSON.stringify(checked));
    }
    assert.throws(() => compile(source), /count.*alternative/i);
    // Unbound implicit self also needs invalidation in no-types mode.
    const checked = checkFile("strings.ts", { types: false, host: { readFile: () => body } });
    assert.ok(checked.diagnostics.some(d => d.line === 2 && /count.*alternative/i.test(d.message)), JSON.stringify(checked));
    assert.throws(() => compile(body), /count.*alternative/i);
  }
});

test("tsstrfix third review: merged declarations select runtime guards and keep invalid-count diagnostics", () => {
  const reject = (source, expression, message = /UTF-16.*alternative/i) => {
    const prefix = source.slice(0, source.lastIndexOf(expression)).split("\n");
    const line = prefix.length, column = prefix.at(-1).length + 1;
    assert.ok(line > 0 && column > 0);
    if (/UTF-16/.test(message.source)) {
      const lowered = lowerTsMethods(ts.createSourceFile("strings.ts", source, ts.ScriptTarget.Latest, true));
      assert.match(lowered.text, /splitText\(/, source);
    } else {
      for (const types of [false, true]) {
        const checked = checkFile("strings.ts", { types, host: { readFile: () => source } });
        assert.ok(checked.diagnostics.some(d => d.line === line && d.column === column
          && message.test(d.message)), JSON.stringify({source, checked}));
      }
      assert.throws(() => compile(source), error => message.test(error.message));
    }
  };
  for (const method of ['includes("a", 0)', 'charAt(0)', 'substring(0, 1)', 'split("", 1)']) {
    const expression = `s.${method}`;
    // C-style for redeclarations are accepted by later lowering, unlike some
    // other duplicate declarations. Require the safety diagnostic in all forms.
    for (const write of ['for (var s = "😀abc"; s.length > 0;) {',
      'for (var s = "😀abc";;) {', 'for (var s = "abc", s = "😀abc";;) {']) {
      reject(`var s = "abc";\n${write}\nconsole.log(${expression}); break; }`, expression);
    }
    reject(`var s = "abc";\nfor (var s = "😀abc"; false;) {}\nconsole.log(${expression});`, expression);
    reject(`function p(s: string) {\nfor (var s = "😀abc";;) {\nconsole.log(${expression}); break; } } p("abc");`, expression);
    reject(`function p(): string { var s = "abc";\nfor (var s = "😀abc";;) { break; } return s; }\nconsole.log(p().${method});`, `p().${method}`);
  }
  for (const write of ['var s = "😀abc";', 'var s;', 'var s = "abc";',
    'var {value: s} = {value: "😀abc"};', 'var [s] = ["😀abc"];',
    'for (var s of ["😀abc"]) {}', 'for (var s in {a: 1}) {}',
    'for (var [s] of [["😀abc"]]) {}', 'for (var {value: s} of [{value: "😀abc"}]) {}']) {
    reject(`var s = "abc";\n${write}\nconsole.log(s.charAt(0));`, "s.charAt(0)");
    reject(`function p(s: string) {\n${write}\nconsole.log(s.charAt(0)); } p("abc");`, "s.charAt(0)");
  }
  // Even a fresh declaration-loop target is unknown, not its (absent or
  // syntactically supplied) initializer. Ordinary first declarations stay safe.
  reject('for (var s of ["😀abc"]) {\nconsole.log(s.charAt(0)); }', "s.charAt(0)");
  reject('for (var s = "abc" in {a: 1}) {\nconsole.log(s.charAt(0)); }', "s.charAt(0)");
  // Bounded-producer and DSL proofs must consume the same declaration writes.
  reject('sprite("cat", {}, (self: any) => {\nfor (var self = "x";;) {\nconsole.log(self.repeat(Infinity)); break; } });',
    'Infinity', /count.*alternative/i);
  compile('for (let s = "abc"; s.length > 0;) { console.log(s.charAt(0)); break; }');
  compile('var s = "abc"; function p() { var s = "😀"; } console.log(s.charAt(0));');
  compile('function p(s: string) { console.log(s.charAt(0)); } p("abc");');
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
