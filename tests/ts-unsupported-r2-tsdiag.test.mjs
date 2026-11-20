import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { compileFile, checkFile, CompileError, formatDiagnostic } from "../ts/compile-ts.mjs";
import { assertJsLogs } from "./ts-runtime.mjs";

const entry = path.resolve("virtual/r2-tsdiag/main.ts");
const normalized = file => file.replaceAll(String.fromCharCode(92), "/");
const nl = String.fromCharCode(10);
const advice = /alternative:|use |instead|rename|remove |pass |initialize |add |rewrite |split |convert |narrow |move |copy |return an array/i;
function diagnostic(source, files = new Map(), file = entry) {
  files.set(file, source);
  const host = { readFile: name => files.get(name) };
  const result = checkFile(file, { types: false, host });
  assert.equal(result.ok, false, `unexpected acceptance: ${source}`);
  assert.equal(result.report, null, "must not return a partial work");
  assert.equal(result.diagnostics.length, 1);
  const [d] = result.diagnostics;
  assert.equal(d.severity, "error");
  assert.equal(d.source, "compat");
  assert.notEqual(d.code, "NEKOC_INTERNAL");
  assert.ok(d.file && d.line > 0 && d.column > 0, JSON.stringify(d));
  assert.match(d.message, advice);
  assert.doesNotMatch(d.message, /Internal compiler error|TypeError|at offset/);
  assert.ok(formatDiagnostic(d).startsWith(`${d.file}:${d.line}:${d.column}: error `));
  assert.throws(() => compileFile(file, host), error => {
    assert.ok(error instanceof CompileError);
    assert.equal(error.message, d.message);
    assert.deepEqual(error.location, { file: d.file, line: d.line, column: d.column });
    return true;
  });
  return d;
}

const rawCases = [
  ["using", "/*error*/using resource = 1;", /using.*disposal/],
  ["bigint", "const value = /*error*/9007199254740993n;", /BigInt.*arbitrary-precision/],
  ["tagged-template", "const value = /*error*/tag`hello`;", /Tagged templates.*tag invocation/],
  ["import-meta", "const value = /*error*/import.meta;", /metadata/],
  ["new-target", "const value = /*error*/new.target;", /metadata/],
  ["dynamic-import", 'const value = /*error*/import("./lib");', /Dynamic import.*Promises/],
  ["call-spread", "const values = [1, 2]; console.log(/*error*/...values);", /Spread arguments.*explicit argument list/],
  ["constructor-spread", "const values = [1, 2]; new Array(/*error*/...values);", /Spread arguments/],
  ["array-spread", "const values = [1, 2]; const copy = [/*error*/...values];", /Array spread/],
  ["destructuring-rest-target", "let values = [0]; [/*error*/...values] = [1];", /rest.*explicit statements/],
  ["destructuring-spread-source", "let value = 0; [value] = /*error*/[...[1]];", /dense array literal without spread/],
  ["void-value", "const value = /*error*/void 7;", /void expressions.*effects/],
  ["debugger", "/*error*/debugger;", /debugger.*breakpoint/],
  ["with", "/*error*/with (value) { console.log(x); }", /with statements.*statically/],
  ["generator-callback", "[1].forEach(function/*error*/* () { console.log(1); });", /Generator.*iterator/],
  ["logical-or-assignment", "let n = 1; n /*error*/||= 2;", /Logical assignment.*short-circuit/],
  ["logical-and-assignment", "let n = 0; n /*error*/&&= 2;", /Logical assignment.*short-circuit/],
];
for (const [name, marked, reason] of rawCases) {
  test(`r2-tsdiag original syntax: ${name}, including dead bodies and imports`, () => {
    for (const wrapper of [text => text, text => ["function unused() {", `  ${text}`, "}", "console.log(1);"].join(nl)]) {
      const text = ["// original file", wrapper(marked)].join(nl);
      const offset = text.indexOf("/*error*/");
      const source = text.replace("/*error*/", "");
      const prefix = text.slice(0, offset).split(nl);
      const expected = { line: prefix.length, column: prefix.at(-1).length + 1 };
      const d = diagnostic(source);
      assert.match(d.message, reason);
      assert.deepEqual({ file: d.file, line: d.line, column: d.column }, { file: normalized(entry), ...expected });
      const lib = path.resolve(path.dirname(entry), "lib.ts");
      const files = new Map([[lib, [source, "export function value() { return 1; }"].join(nl)]]);
      const imported = diagnostic('import { value } from "./lib"; console.log(value());', files);
      assert.match(imported.message, reason);
      assert.deepEqual({ file: imported.file, line: imported.line, column: imported.column }, { file: normalized(lib), ...expected });
    }
  });
}

// Every row covers a distinct unsupported family, with types disabled.
const cases = [
  ["async", "async function f() { return 1; }", /async.*Promise/],
  ["await", "const n = await f();", /async.*await/],
  ["generator", "function* f() { yield 1; }", /Generator/],
  ["rest-parameter", "function f(...xs: number[]) { return xs.length; } f(1);", /Rest parameters/],
  ["parameter-pattern", "function f([x]: number[]) { return x; } f([1]);", /parameter/],
  ["object-destructuring-rest", "const p = {x: 1, y: 2}; const {x, ...rest} = p; console.log(rest.y);", /Object destructuring rest/],
  ["object-destructuring-default", "const {x = 1} = {x: 2}; console.log(x);", /Object destructuring rest, defaults/],
  ["object-destructuring-nested", "const {child: {x}} = {child: {x: 1}}; console.log(x);", /nested patterns/],
  ["nested-destructuring", "const [[x]] = [[1]]; console.log(x);", /Nested array destructuring/],
  ["destructuring-default", "const [x = 1] = [2]; console.log(x);", /destructuring defaults/],
  ["delete", "const a = [1]; delete a[0];", /delete.*hole/],
  ["for-in", "for (const k in [1, 2]) console.log(k);", /for.*in.*property keys/],
  ["regexp", 'console.log("a".replace(/a/, "b"));', /Regular expressions|RegExp|must be strings/],
  ["dynamic-typeof", 'let n = 1; n++; console.log(typeof n);', /typeof.*statically/],
  ["dynamic-number", 'let s = "12"; console.log(Number(s));', /Number.*dynamic string/],
  ["dynamic-parse", 'let s = "12px"; console.log(parseInt(s));', /literal primitive/],
  ["negative-zero", 'console.log(Number("-0"));', /Negative zero/],
  ["dynamic-format", 'let n = 2; console.log(n.toFixed(2));', /toFixed.*constant/],
  ["dynamic-json", 'let n = 2; console.log(JSON.stringify(n));', /JSON.stringify.*not supported/],
  ["json-parse", 'console.log(JSON.parse("1"));', /JSON.parse|Unsupported/],
  ["unsupported-math", 'console.log(Math.fround(1));', /Math.fround/],
  ["unsupported-host", 'fetch("data.json");', /fetch/],
  ["eval", 'eval("1 + 1");', /eval/],
  ["symbol", 'const x = Symbol("x"); console.log(x);', /Symbol/],
  ["date", 'const x = new Date(); console.log(x);', /Date/],
  ["promise", 'const x = Promise.resolve(1); console.log(x);', /Promise|Unsupported/],
  ["object-spread", 'const a = {x: 1}; const b = {...a}; console.log(b.x);', /spread/i],
  ["object-method", 'const a = {f() { return 1; }}; console.log(a.f());', /methods|Unsupported/i],
  ["dynamic-key", 'const a = {x: 1}; let k = "x"; console.log(a[k]);', /Dynamic object keys/],
  ["object-coercion", 'const a = {x: 1}; console.log(String(a));', /coercion|String|scalar/],
  ["missing-property", 'const a = {x: 1}; console.log(a.y);', /property|initialized|shape/],
  ["array-holes", 'const a = [1, , 3]; console.log(a.length);', /hole|Unsupported|Missing/i],
  ["array-spread", 'const a = [1]; const b = [...a]; console.log(b.length);', /spread/i],
  ["array-thisarg", 'const a = [1]; console.log(a.map(x => x, 1).length);', /arguments|thisArg/],
  ["array-fill-range", 'const a = [1, 2]; a.fill(3, 1);', /fill|Unsupported/],
  ["array-flat-depth", 'console.log([[1]].flat(2).length);', /depth 1/],
  ["reduce-empty", 'const a: number[] = []; console.log(a.reduce((a, b) => a + b));', /nonempty|initial value/],
  ["string-index", 'let s = "abc"; let i = 0; console.log(s[i]);', /provably in-bounds/],
  ["string-overload", 'console.log("a".includes(1));', /string search|String/],
  ["optional-function-call", 'function f() { return 1; } console.log(f?.());', /Optional function calls/],
  ["nullable-assertion", 'let x: number | null = null; console.log(x! + 1);', /assertion|nullable|null/],
  ["weak-map", 'const m = new WeakMap(); console.log(m);', /WeakMap/],
  ["map-boolean-key", 'const m = new Map<boolean, number>(); m.set(true, 1);', /key|keys|Map/],
  ["escaping-iterator", 'const s = new Set([1]); const i = s.values();', /iterator|for.*of/],
  ["class-private-name", 'class C { #x = 1; } const c = new C();', /private|#|field/i],
  ["class-expression", 'const C = class { x = 1; }; const c = new C();', /class.*expression|top.level/i],
  ["namespace-values", 'namespace N { export const n = 1; }', /Namespaces containing runtime values/],
  ["export-default", 'export default 1;', /Default.*named functions/],
  ["export-list", 'function f() { return 1; } export {f};', /export lists/],
  ["reexport", 'export * from "./other";', /re-exports/],
  ["commonjs-import", 'import f = require("./other");', /import =/],
  ["package-import", 'import {x} from "package";', /relative imports/],
  ["event-default", 'let n = 0; onStart((x = n++) => { console.log(n); });', /callback default parameters/],
  ["nonnull-nullish-assignment", 'let n = 1; n ??= 2; console.log(n);', /Unlowered.*nullable/],
  ["empty-import", 'import {} from "./lib";', /empty imports/],
  ["side-effect-import", 'import "./lib";', /side-effect/],
  ["default-import", 'import value from "./lib";', /default/],
  ["namespace-import", 'import * as lib from "./lib";', /namespace/],
  ["default-function", 'export default function f() { return 1; }', /Default exports/],
];
for (const [name, source, reason] of cases) {
  test(`r2-tsdiag unsupported family: ${name}`, () => {
    const d = diagnostic([`// counterexample: ${name}`, source].join(nl));
    assert.equal(d.file, normalized(entry));
    assert.match(d.message, reason);
  });
}

// Keep main's new capabilities live alongside original-AST rejection guards.
for (const [name, source] of [
  ["shallow object bindings and array swap", 'const p = {x: 1, child: {y: 2}}; const {x: first, child} = p; child.y = 3; let a = first, b = 2; [a,b] = [b,a]; console.log(a,b,p.child.y,child === p.child);'],
  ["class inheritance accessors and static initialization", 'class Base { value = 1; get next(): number { return this.value + 1; } set next(n: number) { this.value = n - 1; } read(): number { return this.value; } } class Derived extends Base { static seed = 3; constructor() { super(); this.value = Derived.seed; } read(): number { return super.read() + 1; } } const d = new Derived(); d.next += 2; const base: Base = d; console.log(base.read(),d.next,base instanceof Derived);'],
  ["object callback return and alias identity", 'function make(): {value: number} { [1].forEach(n => { if (n === 1) return; }); return {value: 7}; } const a = make(), b = a; b.value += 2; console.log(a.value,a === b);'],
  ["nullable equality and primitive coercion", 'let x: number | null = null; console.log(x == undefined,x === undefined); x = 2; console.log(x == 2,0 == false,"2" == 2);'],
]) {
  test(`r2-tsdiag merged main capability: ${name}`, () => {
    const checked = checkFile(entry, { types: false, host: { readFile: () => source } });
    assert.equal(checked.ok, true, JSON.stringify(checked.diagnostics));
    assertJsLogs(source);
  });
}

test("r2-tsdiag type-only syntax and supported lookalikes remain accepted", () => {
  const source = 'type Large = 1n; interface Named { using: number; debugger: string }; declare const ambient: bigint; export type {Large}; const using = 1; console.log(`value=${using}`);';
  assert.doesNotThrow(() => compileFile(entry, { readFile: () => source }));
});

test("r2-tsdiag import aliases cannot select a different export", () => {
  const lib = path.resolve(path.dirname(entry), "lib.ts");
  const d = diagnostic('import {f as g} from "./lib"; console.log(g());', new Map([[lib, 'export function f() { return 7; } export function g() { return 9; }']]));
  assert.match(d.message, /Import aliases.*same name/);
  assert.equal(d.line, 1);
  assert.equal(d.column, 9);
});

test("r2-tsdiag imported initialization is rejected rather than omitted", () => {
  const lib = path.resolve(path.dirname(entry), "lib.ts");
  for (const sideEffect of ['console.log(99);', 'const secret = 99;', 'if (true) console.log(99);']) {
    const d = diagnostic('import {f} from "./lib"; console.log(f());', new Map([[lib, ['// library', sideEffect, 'export function f() { return 7; }'].join(nl)]]));
    assert.match(d.message, /top-level values or side effects.*exported function/);
    assert.equal(d.file, normalized(lib));
    assert.equal(d.line, 2);
    assert.equal(d.column, 1);
  }
});

test("r2-tsdiag sequence diagnostics point at the failing expression", () => {
  const d = diagnostic(['// heading', 'let n = 0;', 'onStart(() => {', '  if ((n++, n < 3)) console.log(n);', '});'].join(nl));
  assert.match(d.message, /Comma expressions.*split/);
  assert.equal(d.line, 4);
  assert.equal(d.column, 8);
});

test("r2-tsdiag CLI rejects before writing output and shares check diagnostics", () => {
  const parent = path.resolve("dist/r2-tsdiag");
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, "cli-"));
  try {
    const input = path.join(dir, "input.ts"), output = path.join(dir, "report.json");
    fs.writeFileSync(input, ['// original', 'const values = [1, 2];', 'console.log(...values);'].join(nl));
    const run = args => spawnSync(process.execPath, ["ts/compile-ts.mjs", ...args], { encoding: "utf8" });
    const compile = run([input, output]);
    const text = run(["--check", "--no-types", input]);
    const json = run(["--check", "--no-types", "--json", input]);
    for (const result of [compile, text, json]) assert.equal(result.status, 1, result.stderr);
    const result = JSON.parse(json.stdout);
    assert.equal(result.ok, false);
    assert.equal(compile.stderr, text.stderr);
    assert.equal(text.stderr.trim(), result.diagnostics.map(formatDiagnostic).join(nl));
    assert.equal(result.diagnostics[0].line, 3);
    assert.equal(result.diagnostics[0].column, 13);
    assert.equal(fs.existsSync(output), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
