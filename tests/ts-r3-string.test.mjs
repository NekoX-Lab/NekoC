import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import fs from "node:fs";
import ts from "typescript";
import { compileFile, checkFile } from "../ts/compile-ts.mjs";
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
