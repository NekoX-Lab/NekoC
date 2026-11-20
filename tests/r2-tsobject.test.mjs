import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { CompileError, checkFile, compileFile } from "../ts/compile-ts.mjs";
import { assertJsLogs } from "./ts-runtime.mjs";

const entry = path.resolve("virtual/r2-tsobject/main.ts");
const fixture = readFileSync(new URL("./fixtures/r2-tsobject.ts", import.meta.url), "utf8");
const hostFor = source => ({ readFile: name => path.resolve(name) === entry ? source : undefined });

test("r2-tsobject: reads, writes, nesting, arguments, returns and array aliases match Node", () => {
  assertJsLogs(fixture);
});

test("r2-tsobject: every workspace uses share-player list/procedure blocks", () => {
  const report = compileFile(entry, hostFor(fixture));
  const types = new Set();
  const visit = value => {
    if (!value || typeof value !== "object") return;
    if (value.blocks) for (const block of Object.values(value.blocks)) {
      assert.doesNotMatch(block.type, /^_object_|^list_(?:new|create)$/);
      types.add(block.type);
    }
    Object.values(value).forEach(visit);
  };
  visit(report);
  for (const type of ["list_item", "list_append", "replace_list_item", "list_length",
    "temporary_list", "procedures_2_callreturn", "procedures_2_return_value", "warp"]) {
    assert.ok(types.has(type), `missing exercised share-player operation: ${type}`);
  }
  assert.ok(!types.has("stop"), "callback return must not stop the object-returning caller");
  const voidReturns = report.procedures.filter(procedure => procedure.type === "NORMAL")
    .flatMap(procedure => Object.values(procedure.workspaceData.blocks))
    .filter(block => block.type === "procedures_2_return_value");
  assert.ok(voidReturns.length > 0, "exercise a void callback return");
  for (const block of voidReturns) {
    assert.match(block.mutation, /type="NORMAL"/);
    assert.match(block.mutation, /items="0"/);
  }
});

function assertRejected(source, message, line) {
  const host = hostFor(source);
  assert.throws(() => compileFile(entry, host), error => {
    assert.ok(error instanceof CompileError);
    assert.match(error.message, message);
    assert.equal(path.resolve(error.location.file), entry);
    assert.equal(error.location.line, line);
    assert.ok(error.location.column >= 1);
    return true;
  });
  const checked = checkFile(entry, { host, types: false });
  assert.equal(checked.ok, false);
  assert.match(checked.diagnostics[0].message, message);
  assert.equal(checked.diagnostics[0].line, line);
}

for (const [name, declaration, value] of [
  ["object", "{value: number}", "{value: 7}"],
  ["object array", "{value: number}[]", "[{value: 7}]"],
  ["nested container", "{child: {value: number}}", "{child: {value: 7}}"],
]) {
  test(`r2-tsobject: early empty ${name} return cannot become a heap handle`, () => {
    assertRejected(`function make(stop: boolean): ${declaration} {
  if (stop) return;
  return ${value};
}
make(true);`, /return.*initialized.*reference/i, 2);
  });
}

for (const [name, head, tail] of [
  ["arrow", "const make = (stop: boolean): {value: number} => {", "};"],
  ["contextually typed arrow", "const make: (stop: boolean) => {value: number} = stop => {", "};"],
]) {
  test(`r2-tsobject: ${name} empty return reports the actual return line`, () => {
    assertRejected(`${head}
  if (stop) return;
  return {value: 7};
${tail}
make(true);`, /return.*initialized.*reference/i, 2);
  });
}

test("r2-tsobject: imported empty return reports the module location", () => {
  const module = path.resolve(path.dirname(entry), "factory.ts");
  const files = new Map([
    [entry, 'import {make} from "./factory"; console.log(make(true).value);'],
    [module, `export function make(stop: boolean): {value: number} {
  if (stop) return;
  return {value: 7};
}`],
  ]);
  const host = { readFile: name => files.get(path.resolve(name)) };
  assert.throws(() => compileFile(entry, host), error => {
    assert.ok(error instanceof CompileError);
    assert.match(error.message, /return.*initialized.*reference/i);
    assert.equal(path.resolve(error.location.file), module);
    assert.equal(error.location.line, 2);
    return true;
  });
  const checked = checkFile(entry, { host, types: false });
  assert.equal(checked.ok, false);
  assert.equal(path.resolve(checked.diagnostics[0].file), module);
  assert.equal(checked.diagnostics[0].line, 2);
});

test("r2-tsobject: nested scalar callback may still return without a value", () => {
  const source = `function make(): {value: number} {
    [1].forEach((value: number) => { if (value > 0) return; console.log(value); });
    return {value: 7};
  }
  console.log(make().value);`;
  assertJsLogs(source);
});

for (const [name, source] of [
  ["assertion", 'const p = {value: 1};\nconst q = p as {value: string}; console.log(q.value + 2);'],
  ["union assertion", 'const p = {value: 1 as number | string};\nconst q = p as {value: string}; console.log(q.value + 2);'],
  ["nested assertion", 'const p = {child: {value: 1}};\nconst q = p as {child: {value: string}}; console.log(q.child.value + 2);'],
  ["array element assertion", 'const p = [{value: 1}];\nconst q = p as {value: string}[]; console.log(q[0].value + 2);'],
  ["parameter", 'function read(p: {value: string}) { return p.value + 2; }\nconsole.log(read({value: 1}));'],
  ["return", 'function make(): {value: string} {\nreturn {value: 1}; } console.log(make().value + 2);'],
  ["mutable union alias", 'const p = {value: 1};\nconst q: {value: number | string} = p; q.value = "x"; console.log(p.value + 2);'],
  ["mutable any alias", 'const p = {value: 1};\nconst q: {value: any} = p; q.value = "x"; console.log(p.value + 2);'],
  ["mutable unknown alias", 'const p = {value: 1};\nconst q: {value: unknown} = p; q.value = "x"; console.log(p.value + 2);'],
  ["nested mutable union alias", 'const p = {value: 1};\nconst q: {child: {value: number | string}} = {child: p}; q.child.value = "x"; console.log(p.value + 2);'],
  ["erased scalar initializer", 'const value: any = 1;\nconst q: {value: string} = {value}; console.log(q.value + 2);'],
]) {
  test(`r2-tsobject: ${name} cannot reinterpret a numeric property as text`, () => {
    assertRejected(source, /shape.*scalar|scalar.*shape/i, 2);
  });
}

test("r2-tsobject: scalar literal widening preserves property operations", () => {
  assertJsLogs(`const original = {value: 1 as const, text: "a" as const, flag: true as const};
    const alias: {value: number, text: string, flag: boolean} = original;
    alias.value += 2; alias.text += 2; alias.flag = false;
    console.log(original.value); console.log(original.text); console.log(original.flag);`);
});

test("r2-tsobject: fresh scalar slots may use explicit union types without creating narrower aliases", () => {
  assertJsLogs(`const object: {value: number | string} = {value: 1};
    object.value = "x";
    console.log(String(object.value) + 2);`);
});

for (const [name, source, message] of [
  ["dynamic read", 'const p = {value: 1}; let key = "value";\nconsole.log(p[key]);', /dynamic object keys/i],
  ["dynamic write", 'const p = {value: 1}; let key = "value";\np[key] = 2;', /dynamic object keys/i],
  ["missing property", 'const p = {value: 1};\nconsole.log(p.missing);', /present.*initialized/i],
  ["object coercion", 'const p = {value: 1};\nconsole.log(String(p));', /coercion/i],
]) {
  test(`r2-tsobject: ${name} reports its user source line`, () => assertRejected(source, message, 2));
}
