import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync } from "node:fs";
import { compileFile, CompileError } from "../ts/compile-ts.mjs";
import ts from "typescript";
import { portablePath } from "../ts/portable-path.mjs";
import { lowerTsFeatures } from "../ts/tsfeat-lowering.mjs";
import { lowerTsMethods } from "../ts/tsfeat-methods.mjs";
import { lowerTsClasses } from "../ts/tsfeat-classes.mjs";
import { lowerTsNullable } from "../ts/tsfeat-nullable.mjs";
import { lowerTsCollections } from "../ts/tsmap.mjs";
import { lowerTsDestructuring } from "../ts/ts-r2-destructure.mjs";

function compileAt(root, source, modules = {}) {
  const entry = path.resolve(root, "src/main.ts");
  const files = new Map([[entry, source], ...Object.entries(modules)
    .map(([name, text]) => [path.resolve(root, name), text])]);
  return compileFile(entry, { readFile: name => files.get(name) });
}

// The report's source is diagnostic provenance, not part of the .bcmkn.
function executableReport(report) {
  const { source, ...output } = report;
  return JSON.stringify(output);
}

const cases = {
  lexical: readFileSync(new URL("../samples/block_let.ts", import.meta.url), "utf8"),
  methods: 'function cut(text: string) { return text.slice(-2); } console.log(cut("abc"));',
  classes: 'class Box { constructor(public value: number) {} read() { return this.value; } } console.log(new Box(7).read());',
  inheritance: 'class Base { value = 1; read() { return this.value; } } class Child extends Base { read() { return super.read() + 2; } } const box: Base = new Child(); console.log(box.read());',
  nullable: 'interface Box { value: number; } let box: Box | null = null; console.log(box?.value ?? 3); box = {value: 4}; console.log(box?.value);',
  collections: 'const map = new Map<string, number>(); map.set("a", 7); console.log(map.get("a"), map.size); const set = new Set(); set.add("a"); console.log(set.has("a"));',
  objectDestructuring: 'const source = {value: 3, label: "cat"}; const {value: n, label} = source; console.log(n, label);',
  arrayDestructuring: 'let left = 1, right = 2; [left, right] = [right, left]; console.log(left, right);',
};

for (const [name, source] of Object.entries(cases)) {
  test(`r2-determinism ${name}: executable graph survives relocation and repeated compilation`, () => {
    const first = executableReport(compileAt("virtual/alice/project", source));
    const moved = executableReport(compileAt("virtual/机器 B/deep/project", source));
    assert.equal(moved, first);
    assert.equal(executableReport(compileAt("virtual/alice/project", source)), first);
  });
}

test("r2-determinism same-basename modules keep separate generated names", () => {
  const source = 'import { left } from "../left/util"; import { right } from "../right/util"; console.log(left(2), right(4));';
  const modules = {
    "left/util.ts": 'export function left(n: number) { let total = 0; for (let i = 0; i < n; i++) total += i; return total; }',
    "right/util.ts": 'export function right(n: number) { let total = 1; for (let i = 0; i < n; i++) total *= 3; return total; }',
  };
  const first = executableReport(compileAt("virtual/first", source, modules));
  assert.equal(executableReport(compileAt("virtual/second/deeper", source, modules)), first);
  const salts = new Set([...first.matchAll(/__nekoc_ts_(\d+)\d{6}_/g)].map(match => match[1]));
  assert.ok(salts.size >= 2, "same-basename imports must retain distinct namespaces");
});

test("r2-determinism diagnostics retain real imported source paths", () => {
  const root = "virtual/diagnostics";
  assert.throws(() => compileAt(root, 'import { invalid } from "../lib"; invalid();', {
    "lib.ts": 'export function invalid() { class Inner {} return new Inner(); }',
  }), error => error instanceof CompileError
    && typeof error.location?.file === "string"
    && path.resolve(error.location.file) === path.resolve(root, "lib.ts")
    && error.location.line > 0);
});

test("r2-determinism imported destructuring preserves separate module namespaces", () => {
  const source = 'import { left } from "../left/util"; import { right } from "../right/util"; console.log(left(2), right(4));';
  const modules = {
    "left/util.ts": 'export function left(n: number) { const {value} = {value: n}; let a = value, b = 1; [a, b] = [b, a]; return a + b; }',
    "right/util.ts": 'export function right(n: number) { const {value} = {value: n}; let a = value, b = 2; [a, b] = [b, a]; return a * b; }',
  };
  const first = executableReport(compileAt("virtual/imports/first", source, modules));
  assert.equal(executableReport(compileAt("virtual/机器 B/deep/imports", source, modules)), first);
  // Later passes can inline these temporaries; inspect the destructuring output
  // itself for namespace separation as well as the final relocated graph.
  const lowered = Object.entries(modules).map(([name, text]) => lowerTsDestructuring(
    ts.createSourceFile(path.resolve("virtual/imports/first", name), text, ts.ScriptTarget.Latest, true),
    `../${name}`).text).join("\n");
  const salts = new Set([...lowered.matchAll(/__nekocDestructure_(\d+)_/g)].map(match => match[1]));
  assert.equal(salts.size, 2, "imported destructuring must keep distinct entry-relative salts");
});

test("r2-determinism browser relative paths match POSIX paths", () => {
  for (const [from, to] of [
    ["/project/src", "/project/src/main.ts"],
    ["/project/src", "/project/lib/util.ts"],
    ["/project/src", "/project/src/deep/util.ts"],
    ["/机器 B/project/src", "/机器 B/project/lib/util.ts"],
    ["/", "/main.ts"], ["/a", "/a"], ["/a/b", "/"],
  ]) assert.equal(portablePath.relative(from, to), path.posix.relative(from, to));
});

test("r2-determinism all lowering salts ignore Windows/POSIX machine paths", () => {
  const passes = { lexical: lowerTsFeatures, methods: lowerTsMethods, classes: lowerTsClasses,
    inheritance: lowerTsClasses, nullable: lowerTsNullable, collections: lowerTsCollections,
    objectDestructuring: lowerTsDestructuring, arrayDestructuring: lowerTsDestructuring };
  for (const [name, lower] of Object.entries(passes)) {
    const emitted = file => ts.createPrinter().printFile(lower(ts.createSourceFile(
      file, cases[name], ts.ScriptTarget.Latest, true, ts.ScriptKind.TS), "src/main.ts"));
    assert.equal(emitted("C:\\Users\\alice\\project\\src\\main.ts"),
      emitted("/home/bob/project/src/main.ts"), name);
  }
});

test("r2-determinism clock and random state cannot change the compiled graph", t => {
  const source = readFileSync(new URL("./fixtures/r2-determinism.ts", import.meta.url), "utf8");
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2001-01-01T00:00:00Z") });
  const random = t.mock.method(Math, "random", () => 0.125);
  const first = executableReport(compileAt("virtual/clock", source));
  t.mock.timers.setTime(new Date("2040-12-31T23:59:59Z").getTime());
  random.mock.mockImplementation(() => 0.875);
  assert.equal(executableReport(compileAt("virtual/clock", source)), first);
});
