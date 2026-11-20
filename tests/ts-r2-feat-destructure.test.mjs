import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { compileFile, checkFile, CompileError } from "../ts/compile-ts.mjs";
import { lowerTsDestructuring } from "../ts/ts-r2-destructure.mjs";
import { assertJsLogs } from "./ts-runtime.mjs";
import { frontendFiles } from "../tools/package-release.mjs";

const parse = text => ts.createSourceFile("r2.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const compile = text => compileFile("r2.ts", { readFile: () => text });
const logs = source => {
  const values = [];
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(js, { console: { log: value => values.push(String(value)) }, onStart: fn => fn() });
  return values;
};

const cases = [
  ["core-006 swap", 'onStart(() => { let a = 1, b = 2; [a, b] = [b, a]; console.log(a * 10 + b); });'],
  ["core-179 object binding", 'onStart(() => { const { x, y } = { x: 1, y: 2 }; console.log(x + y); });'],
  ["source and unused array elements once in order", `let calls = 0;
    function next(): number { calls++; return calls; }
    onStart(() => { let a = 0, b = 0; [a, , b] = [next(), next(), next(), next()];
      console.log(a); console.log(b); console.log(calls); [] = [next()]; console.log(calls); });`],
  ["repeated targets and branch scope", 'onStart(() => { let a = 1; if (true) [a,a] = [2,3]; else [a] = [4]; console.log(a); });'],
  ["loop and scalar function frames", `function sum(n: number): number { let a = n, b = 0;
    for (let i = 0; i < 3; i++) [a, b] = [b + 1, a];
    if (n > 0) return sum(n - 1) + a * 10 + b; return a * 10 + b; }
    onStart(() => { console.log(sum(2)); });`],
  ["shallow object identity and aliases", `const source = { x: { n: 2 }, label: "cat" };
    onStart(() => { const { x: alias, label: text } = source; alias.n = 7; console.log(source.x.n); console.log(text); });`],
  ["object initializer and declaration chain once", `let calls = 0;
    function next(): { x: number, y: number } { calls++; return {x: calls, y: calls + 1}; }
    const before = 2, {x, y: second} = next(), after = x + second;
    onStart(() => { console.log(before); console.log(after); console.log(calls); });`],
  ["object binding inside functions", `function total(): number { const { x, y } = {x: 2, y: 3}; return x + y; }
    onStart(() => { console.log(total()); console.log(total()); });`],
  ["literal keys and mutable bindings", `onStart(() => { let {"key-x": x, 2: y} = {"key-x": 3, 2: 4}; x += y; console.log(x); });`],
  ["local shadowing", 'const x = 9; console.log(x); onStart(() => { const { x } = {x: 2}; { const {x} = {x: 3}; console.log(x); } console.log(x); });'],
  ["nullable property", `const source: { x: number | null } = { x: null };
    onStart(() => { const {x} = source; console.log(x ?? 7); source.x = 2; const {x: second} = source; console.log(second ?? 8); });`],
  ["optional property", `const source: { x?: number } = {};
    onStart(() => { const {x} = source; console.log(x ?? 7); });`],
  ["class field", `class Box { x = 3; } const source = new Box();
    onStart(() => { const {x} = source; console.log(x); });`],
  ["object array field", `const source = {values: [1,2]}; onStart(() => { const {values} = source; values.push(3); console.log(source.values.length); });`],
  ["single-statement branches", `let calls = 0; function value(): number { calls++; return calls; }
    onStart(() => { if (false) var {x} = {x: value()}; else console.log(7);
      if (true) var {y} = {y: value()}; console.log(y); console.log(calls); });`],
  ["assigned parameter", 'function f(a: number): number { [a] = [a + 2]; return a; } onStart(() => { console.log(f(3)); });'],
  ["mixed scalar assignments", 'onStart(() => { let a=1, b="b"; [a,b]=[2,"c"]; console.log(a); console.log(b); });'],
  ["object handle exchange", 'onStart(() => { let a={x:1}, b={x:2}; [a,b]=[b,a]; console.log(a.x); console.log(b.x); });'],
  ["length remains a property read", 'onStart(() => { const {length: n}=[1,2]; const {"length": m}="cat"; console.log(n); console.log(m); });'],
];

for (const [name, source] of cases) test(`r2 destructuring: ${name}`, () => {
  const lowered = lowerTsDestructuring(parse(source));
  assert.deepEqual(logs(lowered.text), logs(source));
  assert.ok(compile(source).summary.blocks > 0);
  assertJsLogs(source);
});

test("r2 destructuring: untouched identity, retained lines and shipped module", () => {
  const source = parse("const x = 1; console.log(x);");
  assert.equal(lowerTsDestructuring(source), source);
  const lowered = lowerTsDestructuring(parse("const {x,\n y} = {x: 1, y: 2};\nconsole.log(unknown);"));
  assert.equal(lowered.getLineAndCharacterOfPosition(lowered.text.indexOf("unknown")).line, 2);
  assert.ok(frontendFiles.includes("ts-r2-destructure.mjs"));
});

test("r2 destructuring: generated names avoid user bindings and module collisions", () => {
  const text = 'const {x} = {x: 1};';
  const first = lowerTsDestructuring(parse(text)).text;
  const name = first.match(/const (__nekocDestructure_\d+_\d+)/)[1];
  const collision = lowerTsDestructuring(parse(`const ${name} = 8; ${text}`)).text;
  assert.equal(collision.split(`const ${name} =`).length - 1, 1);
  const other = lowerTsDestructuring(ts.createSourceFile("other.ts", text, ts.ScriptTarget.Latest, true)).text;
  assert.ok(!other.includes(name));
});

test("r2 destructuring: imports and exported bindings retain names", () => {
  const files = new Map([
    [path.resolve("main.ts"), 'import { sum } from "./binding"; console.log(sum());'],
    [path.resolve("binding.ts"), 'export function sum() { const {x,y} = {x: 3, y: 4}; return x+y; }'],
  ]);
  assert.ok(compileFile("main.ts", { readFile: name => files.get(name) }).summary.blocks > 0);
  const exported = lowerTsDestructuring(parse('export const {x, y: z} = {x: 1, y: 2};')).text;
  assert.match(exported, /export const x =/);
  assert.match(exported, /export const z =/);
  assert.doesNotMatch(exported, /export const __nekocDestructure_/);
});

for (const [source, pattern] of [
  ['const {x = 2} = {x: 1};', /defaults.*explicitly/],
  ['const {x, ...rest} = {x: 1, y: 2};', /rest.*explicitly/],
  ['const {x: {y}} = {x: {y: 1}};', /nested.*explicitly/],
  ['const key = "x"; const {[key]: x} = {x: 1};', /literal property names/],
  ['function f({x}: {x: number}) { console.log(x); } f({x: 1});', /standalone variable declaration/],
  ['const {} = {x: 1};', /at least one property/],
  ['let a = 0; const values = [1]; [a] = values;', /dense array literal/],
  ['let a = 0; [a] = [...[1]];', /without spread/],
  ['let a = 0; [a] = [,];', /dense array literal/],
  ['let a = 0, b = 0; [a, b] = [1];', /missing element/],
  ['let a = 0; [a = 2] = [1];', /defaults.*explicit statements/],
  ['let a = 0; [[a]] = [[1]];', /nested.*explicit statements/],
  ['let a = [0]; [...a] = [1];', /rest.*explicit statements/],
  ['const p = {x: 0}; [p.x] = [1];', /property targets/],
  ['let a = 0; console.log(([a] = [1]));', /standalone statements/],
  ['const a = 0; [a] = [1];', /declared mutable variable/],
  ['[missing] = [1];', /declared mutable variable/],
]) test(`r2 destructuring: explicit diagnostic ${source}`, () => {
  assert.throws(() => compile(`\n${source}`), error => {
    assert.ok(error instanceof CompileError);
    assert.match(error.message, pattern);
    assert.equal(error.location.line, 2);
    return true;
  });
  const result = checkFile("r2.ts", { types: false, host: { readFile: () => source } });
  assert.equal(result.ok, false);
  assert.match(result.diagnostics[0].message, pattern);
});

for (const index of ["5", "-1", "0.5", "Infinity", "NaN"]) test(`r2 core-162: reject invalid static array index ${index}`, () => {
  assert.throws(() => compile(`const a = [1]; onStart(() => { console.log(String(a[${index}])); });`),
    /Array index is statically out of bounds.*concrete fallback/);
});

test("r2 object bindings: preserve missing/nullish and erased-shape diagnostics", () => {
  for (const [source, message] of [
    ['const {x} = null; console.log(x);', /null.*undefined/],
    ['const {y} = {x: 1}; console.log(y);', /must be present and initialized/],
    ['const p: any = {x: 1}; const {x} = p; console.log(x);', /any|shape|object/i],
  ]) assert.throws(() => compile(source), message);
});

test("r2 bounds: growing arrays and guarded dynamic reads stay valid", () => {
  assertJsLogs(`onStart(() => { const a = [1]; a.push(2); console.log(a[1]);
    let i = 3; console.log(i < a.length ? a[i] : -1); });`);
});
