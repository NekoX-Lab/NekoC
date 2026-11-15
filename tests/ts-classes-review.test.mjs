import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import ts from "typescript";
import { CompileError, compileFile } from "../ts/compile-ts.mjs";
import { assertJsLogs } from "./ts-runtime.mjs";

const entry = path.resolve("virtual/ts-class-review.ts");

function reject(source, message) {
  assert.throws(() => compileFile(entry, { readFile: name => path.resolve(name) === entry ? source : undefined }), error => {
    assert.ok(error instanceof CompileError);
    assert.match(error.message, message);
    assert.match(error.message, /alternative:|use |instead|rewrite|replace/i);
    assert.equal(path.resolve(error.location.file), entry);
    assert.equal(error.location.line, 1, "diagnostic points to the original one-line program");
    assert.ok(error.location.column >= 1 && error.location.column <= source.length);
    return true;
  });
}

const supported = [
  ["field initializers keep their outer binding when constructor parameters shadow it",
    'let value = 10; class C { field = value; constructor(value: number) {} } console.log(new C(1).field);'],
  ["field initializers keep their outer binding when constructor locals shadow it",
    'let value = 10; class C { field = value; constructor() { let value = 1; console.log(value); } } console.log(new C().field);'],
  ["constructor return without a value preserves the allocated instance",
    'class C { value = 2; constructor(stop: boolean) { if (stop) return; this.value = 3; } } console.log(new C(true).value); console.log(new C(false).value);'],
  ["recursive compound writes capture receiver and old value before the recursive RHS",
    'class C { value = 1; sum(other: C, n: number): number { if (n === 0) { this.value += 2; return this.value; } this.value += other.sum(this, n - 1); return this.value; } } const a = new C(); const b = new C(); console.log(a.sum(b, 3)); console.log(a.value); console.log(b.value);'],
  ["reference fields contain initialized instances and preserve their identity",
    'class Item { value = 1; add(n: number) { this.value += n; } } class Box { item = new Item(); read() { return this.item.value; } } const box = new Box(); const alias = box.item; alias.add(3); console.log(box.read()); console.log(alias === box.item);'],
  ["inferred methods returning this retain their instance type",
    'class C { value = 1; self() { return this; } } const c = new C(); console.log(c.self() === c); console.log(c.self().value);'],
  ["field initialization precedes constructor defaults and constructor body",
    'let trace = ""; function mark(label: string) { trace += label; return 1; } class C { value = mark("f"); constructor(arg = mark("p")) { mark("b"); } } const c = new C(); console.log(trace); console.log(c.value);'],
  ["constructor defaults can read initialized this fields and earlier parameters",
    'class C { value = 4; constructor(public first = this.value, public second = first + 2) {} } const c = new C(); console.log(c.first); console.log(c.second);'],
  ["explicit trailing undefined selects constructor defaults after fields",
    'class C { value = 4; constructor(public first = this.value, public second = first + 2) {} } const c = new C(undefined, undefined); console.log(c.first); console.log(c.second);'],
  ["explicit this return annotations retain the concrete instance type",
    'class C { value = 1; self(): this { return this; } } const c = new C(); console.log(c.self() === c); console.log(c.self().value);'],
];

for (const [name, source] of supported) {
  test("class review matches JavaScript: " + name, () => assertJsLogs(source, { target: ts.ScriptTarget.ES2022 }));
}

const unsupported = [
  ["reading an uninitialized declared field", 'class C { value: number; } console.log(new C().value);', /initializ|undefined|field/i],
  ["reading a later field from an initializer", 'class C { first = this.later; later = 2; } console.log(new C().first);', /initializ|undefined|field/i],
  ["calling a field initializer method that reads a later field", 'class C { first = this.read(); later = 2; read() { return this.later; } } console.log(new C().first);', /initializ|undefined|field/i],
  ["an early constructor return leaves a field uninitialized", 'class C { value: number; constructor(stop: boolean) { if (stop) return; this.value = 1; } } console.log(new C(true).value);', /initializ|undefined|field/i],
  ["passing an incomplete instance exposes reserved slots", 'class C { value: number; constructor() { read(this); this.value = 1; } } function read(c: C) { console.log(c.value); } new C();', /initializ|escape|field/i],
  ["cross-class structural alias changes dispatch", 'class A { m() { return 1; } } class B { m() { return 2; } } const b: B = new A(); console.log(b.m());', /class|identit|receiver/i],
  ["cross-class structural argument changes dispatch", 'class A { m() { return 1; } } class B { m() { return 2; } } function call(b: B) { return b.m(); } console.log(call(new A()));', /class|identit|receiver/i],
  ["cross-class structural assertion changes dispatch", 'class A { m() { return 1; } } class B { m() { return 2; } } const a = new A(); console.log((a as B).m());', /class|identit|receiver/i],
  ["cross-class structural nested container changes dispatch", 'class A { m() { return 1; } } class B { m() { return 2; } } const box: { item: B } = { item: new A() }; console.log(box.item.m());', /class|identit|receiver/i],
  ["cross-class constructor argument changes dispatch", 'class A { m() { return 1; } } class B { m() { return 2; } } class Box { constructor(public item: B) {} } console.log(new Box(new A()).item.m());', /class|identit|receiver/i],
  ["cross-class field initializer changes dispatch", 'class A { m() { return 1; } } class B { m() { return 2; } } class Box { item: B = new A(); } console.log(new Box().item.m());', /class|identit|receiver/i],
  ["cross-class expression arrow return changes dispatch", 'class A { m() { return 1; } } class B { m() { return 2; } } const f = (): B => new A(); console.log(f().m());', /class|identit|receiver/i],
  ["cross-class default parameter changes dispatch", 'class A { m() { return 1; } } class B { m() { return 2; } } class Box { constructor(public item: B = new A()) {} } console.log(new Box().item.m());', /class|identit|receiver/i],
  ["a normal function has a dynamic this binding", 'class C { value = 1; m() { return (function () { return this.value; })(); } } console.log(new C().m());', /this|binding|function/i],
  ["a timer captures an alias of this", 'class C { value = 1; m() { const owner = this; setTimeout(() => { console.log(owner.value); }, 0); } } new C().m();', /this|captur|closure/i],
  ["a constructor parameter decorator", 'function decorate(target: any) {} class C { constructor(@decorate public value: number) {} } console.log(new C(1).value);', /decorator/i],
  ["an instance method parameter decorator", 'function decorate(target: any) {} class C { value = 1; m(@decorate n: number) { return n; } } console.log(new C().m(1));', /decorator/i],
];

for (const [name, source, message] of unsupported) {
  test("class review rejects with original source coordinates: " + name, () => reject(source, message));
}
