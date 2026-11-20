import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import fs from "node:fs";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import ts from "typescript";
import { compileFile, checkFile } from "../ts/compile-ts.mjs";
import { lowerTsMethods } from "../ts/tsfeat-methods.mjs";
import { assertJsLogs } from "./ts-runtime.mjs";
import { readManifest } from "../tools/compat/kn-share-player-check.mjs";

const host = source => ({ readFile: name => {
  if (name === path.resolve("r3-string.ts")) return source;
  if (/^lib\..*\.d\.ts$/.test(path.basename(name))) {
    name = path.join(path.dirname(ts.getDefaultLibFilePath({})), path.basename(name));
  }
  try { return fs.readFileSync(name, "utf8"); } catch { return undefined; }
} });
const compile = source => compileFile("r3-string.ts", host(source));

test("r3 strings: literal RegExp tests match Node including anchors, overlap and Unicode", () => {
  const patterns = ["/a/", "/^a/", "/a$/", "/^a$/", "/aba$/", "/aa$/",
    "/^$/", "/^/", "/$/", "/007/", "/^007/", "/007$/", "/^007$/",
    "/😀$/", "/😀😀$/", "/^😀/", "/^😀$/", "/中$/",
    String.raw`/a\.b/`, String.raw`/\^a\$/`, String.raw`/a\/b/`,
    String.raw`/a\\b/`, String.raw`/\n$/`, "/~!/", "/!~$/"];
  const values = ["", "a", "A", "ba", "ab", "ababa", "aaa", "a\n", "a\r\n",
    "0007", "007", "7", "0", "007x", "x007", "😀", "x😀", "😀😀😀", "😀a",
    "😀中", "a.b", "^a$", "a/b", "a\\b", "~!~", "!~"];
  const source = `function check(input: string) {
    console.log(${patterns.map(pattern => `${pattern}.test(input)`).join(",")});
  } for (const input of ${JSON.stringify(values)}) check(input);`;
  assertJsLogs(source);
});

test("r3 strings: regex input runs once, including empty patterns and nested procedures", () => {
  assertJsLogs(`let calls = 0;
    function input(): string { calls++; return "ababa"; }
    function nested(s: string): boolean { return /aba$/.test(s); }
    console.log(/aba$/.test(input()), calls);
    console.log(/^/.test(input()), calls);
    console.log(/^$/.test(input()), calls);
    console.log(nested(input()), calls);
    console.log(/1/.test(String(1)), /true/.test(String(true)));`);
});

test("r3 strings: regex inputs compose with string methods, arrays and for-of in every check mode", () => {
  const sources = [
    'console.log(/a/.test(" a ".trim()));',
    'console.log(/a/.test("abc".substring(0, 1)));',
    'console.log(/a/.test("abc".slice(0, 1)));',
    'console.log(/a/.test("ab".split("b")[0]));',
    'const values: string[] = ["a"]; console.log(/a/.test(values[0]));',
    'const values = ["a"]; console.log(/a/.test(values[0]));',
    'for (const s of ["a"]) console.log(/a/.test(s));',
    'function check(values: string[]) { for (const s of values) console.log(/a/.test(s)); } check(["a"]);',
    'console.log(/a/.test(" a ".trim().substring(0, 1)));',
    'function match(s: string) { console.log(/a/.test(s.trim())); } match(" a ");',
    'console.log(/a/.test(["a", "b"].join("")));',
    'let calls = 0; function input(): string { calls++; return " a "; } console.log(/a/.test(input().trim()), calls);',
  ];
  for (const source of sources) {
    compile(source);
    for (const types of [false, true]) {
      const checked = checkFile("r3-string.ts", { types, host: host(source) });
      assert.equal(checked.ok, true, JSON.stringify({ source, types, checked }));
    }
    assertJsLogs(source);
  }
});

test("r3 strings: composing regex inputs does not admit numeric, unknown or nullable values", () => {
  const sources = [
    'console.log(/a/.test(1));',
    'function match(s: string | null) { return /a/.test(s); } match(null);',
    'function match(s: string | undefined) { return /a/.test(s); } match(undefined);',
    'function match(s: unknown) { return /a/.test(s); } match("a");',
    'function match(s: any) { return /a/.test(s); } match(1);',
    'const values: (string | null)[] = [null]; console.log(/a/.test(values[0]));',
    'for (const s of ["a", 1]) console.log(/a/.test(s));',
    'class Text { trim(): number { return 1; } } console.log(/a/.test(new Text().trim()));',
  ];
  for (const source of sources) {
    assert.throws(() => lowerTsMethods(ts.createSourceFile("r3-string.ts", source, ts.ScriptTarget.Latest, true)), /statically string/, source);
    const message = /statically string|may be null or undefined/;
    assert.throws(() => compile(source), message, source);
    for (const types of [false, true]) {
      const checked = checkFile("r3-string.ts", { types, host: host(source) });
      assert.equal(checked.ok, false, source);
      assert.ok(checked.diagnostics.some(d => message.test(d.message)), JSON.stringify(checked));
    }
  }
});

test("r3 strings: numeric formatting and string indexes compose without host libraries", () => {
  const sources = [
    'console.log(/1/.test((1).toString()));',
    'console.log(/1/.test((1).toFixed(0)));',
    'function match(n: number) { console.log(/1/.test(n.toString())); } match(1);',
    'const s: string = "abc"; console.log(/a/.test(s[0]));',
    'const s = (1).toString(); console.log(/1/.test(s));',
    'const s = (1).toFixed(0); console.log(/1/.test(s));',
    'function match(n: number) { const s = n.toString(10); console.log(/1/.test(s.trim())); } match(1);',
    'console.log(/a/.test(["a", "b"].slice(0, 1).join("")));',
    'console.log(/a/.test("a".concat("b")));',
    'console.log(/a/.test(String.fromCharCode(97)));',
    'console.log(/a/.test(JSON.stringify("a")));',
    'function match(s: string | null) { if (s !== null) console.log(/a/.test(s)); } match("a");',
    'function match(s: "a" | "b") { console.log(/a/.test(s)); } match("a");',
    'let calls = 0; function next(): number { calls++; return 1; } console.log(/1/.test(next().toString()), calls);',
  ];
  for (const source of sources) {
    const memory = { readFile: name => name === path.resolve("r3-string.ts") ? source : undefined };
    compileFile("r3-string.ts", memory);
    assert.equal(checkFile("r3-string.ts", { types: false, host: memory }).ok, true, source);
    for (const types of [false, true]) {
      const checked = checkFile("r3-string.ts", { types, host: host(source) });
      assert.equal(checked.ok, true, JSON.stringify({ source, types, checked }));
    }
    assertJsLogs(source);
  }
});

test("r3 strings: trusted string DSL producers compose with regex and match the Node adapter", () => {
  const sources = [
    'console.log(/a/.test(join("a", "b")));',
    'const s = join("a", "b"); console.log(/a/.test(s));',
    'console.log(/a/.test(selectText("abc", 1, 1)));',
    'console.log(/a/.test(String(splitText("ab", "b")[0])));',
    'console.log(/1/.test(toString(1)));',
    'console.log(/a/.test(join(" a", " " ).trim()));',
    'let calls = 0; function input(): string { calls++; return "a"; } console.log(/a/.test(join(input(), "b")), calls);',
    'setVar("text", "a"); console.log(/a/.test(getVar<string>("text")));',
    'setVar("text", "a"); const text = getVar<string>("text"); console.log(/a/.test(text));',
  ];
  for (const source of sources) {
    compile(source);
    for (const types of [false, true]) {
      const checked = checkFile("r3-string.ts", { types, host: host(source) });
      assert.equal(checked.ok, true, JSON.stringify({ source, types, checked }));
    }
  }
  const source = sources.join("\n");
  const expected = [];
  const variables = new Map();
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, {
    join: (...values) => values.join(""),
    selectText: (text, start, end) => text.slice(start - 1, end),
    splitText: (text, separator) => text.split(separator), toString: String,
    setVar: (name, value) => variables.set(name, value), getVar: name => variables.get(name),
    console: { log: (...args) => expected.push(args.map(String).join(" ")) },
  }, { timeout: 5000 });
  const dir = fs.mkdtempSync(path.resolve("target/r3-string-dsl-"));
  try {
    const input = path.join(dir, "main.ts"), output = path.join(dir, "main.bcmkn");
    fs.writeFileSync(input, source);
    const bin = path.resolve("target/debug", process.platform === "win32" ? "nekoc.exe" : "nekoc");
    for (const args of [["build", input, "-o", output], ["run", output, "--ticks", "120"]]) {
      const result = spawnSync(bin, args, { encoding: "utf8", env: { ...process.env, NEKOC_FRONTEND: path.resolve("ts") } });
      assert.equal(result.status, 0, result.stderr);
      if (args[0] === "run") assert.deepEqual(JSON.parse(result.stdout).logs, expected);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("r3 strings: shared ambient facts do not trust user producers or erase nullable results", () => {
  for (const source of [
    'class Text { toString(): number { return 1; } } console.log(/1/.test(new Text().toString()));',
    'class Text { toFixed(n: number): number { return n; } } console.log(/1/.test(new Text().toFixed(1)));',
    'console.log(/a/.test(splitText("ab", "b")[0]));',
    'console.log(/a/.test(getVar("text")));',
    'console.log(/a/.test(getVar<string | null>("text")));',
    'function value(): string | null { return null; } console.log(/a/.test(value()));',
    'function value(): string | undefined { return undefined; } console.log(/a/.test(value()));',
    'function value(): any { return 1; } console.log(/a/.test(value()));',
    'function value(): unknown { return 1; } console.log(/a/.test(value()));',
    'function value(): string | number { return 1; } console.log(/a/.test(value()));',
  ]) {
    assert.throws(() => lowerTsMethods(ts.createSourceFile("r3-string.ts", source, ts.ScriptTarget.Latest, true), fs.readFileSync("ts/nekoc.d.ts", "utf8")), /statically string/, source);
    assert.throws(() => compile(source), /statically string|may be null or undefined/, source);
    for (const types of [false, true]) assert.equal(checkFile("r3-string.ts", { types, host: host(source) }).ok, false, source);
  }
  for (const source of [
    'function join(a: string, b: string): number { return 1; } console.log(/1/.test(join("a", "b")));',
    'function join(a: string, b: string): string { return a + b; } console.log(/a/.test(join("a", "b")));',
    'function f(join: any) { return /a/.test("a"); }',
    'function f(String: any, n: number) { return /1/.test(n.toString()); }',
  ]) {
    assert.throws(() => compile(source), /shadowed/, source);
    for (const types of [false, true]) {
      const checked = checkFile("r3-string.ts", { types, host: host(source) });
      assert.ok(checked.diagnostics.some(d => /shadowed/.test(d.message)), JSON.stringify(checked));
    }
  }
});

test("r3 strings: pad, uint32 split limits, replaceAll and templates match Node", () => {
  assertJsLogs(`let text = "ababa"; let count = 4; let fill = "01";
    console.log(text.padStart(count, fill), text.padEnd(count, fill));
    count = 8; console.log(text.padStart(count, fill), text.padEnd(count, fill));
    for (const limit of [0, 1, 2.9, -1, 4294967296, 4294967297, NaN, Infinity]) {
      console.log(text.split("b", limit).join("|"), text.split("", limit).join("|"));
    }
    console.log(text.split().join("|"), text.split("z", 1).join("|"));
    console.log(text.replaceAll("aba", "[$&]$$"), text.replaceAll("b", ""));
    let calls = 0; function next(): number { calls++; return calls; }
    console.log(\`值=\${next()}|\${next()}|\${true}|\${text}\`, calls);
    console.log(\`多行\n\${\`内层:\${3}\`}\`);
    let absent: string | null = null;
    console.log(\`\${absent}|\${undefined}|\${[1, 2]}\`);
    console.log("abc".at(-1), "abc".at(1.9), "abc".at(NaN));`);
});

test("r3 strings: unsupported regex, locale and at boundaries produce located diagnostics", () => {
  const cases = [
    ['/a/g.test(s)', /flag-free/], ['/a/i.test(s)', /flag-free/], ['/a/y.test(s)', /flag-free/],
    ['/a/m.test(s)', /flag-free/], ['/a/u.test(s)', /flag-free/],
    ['/a+/.test(s)', /plain text/], ['/a|b/.test(s)', /plain text/],
    ['/a.b/.test(s)', /plain text/], ['/[ab]/.test(s)', /plain text/],
    [String.raw`/\d/.test(s)`, /plain text/], ['/(a)/.test(s)', /plain text/],
    ['/a/.test(1)', /statically string/], ['/a/.test(s, s)', /argument/],
    ['s.localeCompare("a")', /locale\/ICU.*ordering/],
    ['s.at(-1)', /Dynamic string at.*undefined/], ['"".at(0)', /undefined/],
    ['"😀".at(0)', /surrogate/], ['s.split(/a/, 2)', /regular.expression/],
    ['s.replaceAll(/a/g, "b")', /string/],
    ['/a/.source', /RegExp values/], ['/a/ ? "yes" : "no"', /RegExp values/],
    ['String.raw`a\\nb`', /Tagged templates/], ['Number`123`', /Tagged templates/],
    ['missing`abc`', /Tagged templates/],
  ];
  for (const [expression, message] of cases) {
    const source = `let s = "aba";\nconsole.log(${expression});`;
    assert.throws(() => compile(source), error => message.test(error.message) && error.location?.line === 2, expression);
    for (const types of [false, true]) {
      const checked = checkFile("r3-string.ts", { types, host: host(source) });
      assert.equal(checked.ok, false, expression);
      assert.ok(checked.diagnostics.some(d => d.line === 2 && message.test(d.message)), JSON.stringify(checked));
    }
  }
});

test("r3 strings: regex helpers reject shadowed builtins and do not intercept user test methods", () => {
  for (const builtin of ["length", "String", "splitText", "join", "selectText"]) {
    assert.throws(() => compile(`function f(${builtin}: any) { return /a/.test("a"); }`), /shadowed/);
  }
  compile('class Matcher { test(s: string): boolean { return s === "a"; } } const m = new Matcher(); console.log(m.test("a"));');
  compile('class Ordering { localeCompare(s: string): number { return 1; } } const o = new Ordering(); console.log(o.localeCompare("a"));');
  compile('console.log((/a/).test("a"));');
  assert.throws(() => compile('const regex = /a/; console.log(regex.test("a"));'), /RegExp values/);
  assert.throws(() => compile('function unused() { return String.raw`a\\nb`; }'), /Tagged templates/);
  assert.throws(() => compile('console.log(new RegExp("a").test("a"));'), /not supported/);
  const checked = checkFile("r3-string.ts", { types: true, host: host('console.log("abc".at(-1));') });
  assert.equal(checked.ok, true, JSON.stringify(checked));
});

test("r3 strings: regex procedure blocks retain share-player sockets and parameter ids", async () => {
  const manifest = await readManifest();
  const report = compile('let s = "ababa"; console.log(/aba$/.test(s), /^a/.test(s), /^$/.test(s));');
  for (const workspace of [report.workspaceData, ...report.procedures.map(p => p.workspaceData)]) {
    for (const block of Object.values(workspace.blocks)) {
      assert.ok(manifest.blocks.includes(block.type) || manifest.metadataBlocks.includes(block.type), block.type);
      if (block.type === "procedures_2_return_value") {
        assert.match(block.mutation, /items="1"/);
        assert.match(block.shadows.VALUE, /math_number/);
      }
    }
  }
  for (const procedure of report.procedures) {
    const blocks = Object.values(procedure.workspaceData.blocks);
    const ids = new Set(procedure.params.filter(p => p.type !== "Label").map(p => p.id));
    for (const block of blocks) {
      if (block.type === "procedures_2_stable_parameter") assert.ok(ids.has(block.id));
      if (block.type === "procedures_2_parameter") assert.ok(ids.has(/\bid="([^"]+)"/.exec(block.mutation)?.[1]));
    }
  }
});
