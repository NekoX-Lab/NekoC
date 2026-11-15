import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { CompileError, compileFile } from "../ts/compile-ts.mjs";
import { assertJsLogs } from "./ts-runtime.mjs";

const entry = path.resolve("virtual/ts-classes/main.ts");
const fixture = readFileSync(new URL("./fixtures/ts-classes.ts", import.meta.url), "utf8");

function compileSource(source, modules = {}) {
  const files = new Map([[entry, source]]);
  for (const [name, text] of Object.entries(modules)) files.set(path.resolve(path.dirname(entry), name), text);
  return compileFile(entry, { readFile: name => files.get(name) });
}

function reportBlocks(value, found = []) {
  if (!value || typeof value !== "object") return found;
  if (value.blocks && typeof value.blocks === "object") found.push(...Object.values(value.blocks));
  for (const child of Object.values(value)) reportBlocks(child, found);
  return found;
}

function assertOfficialClassLowering(report) {
  const blocks = reportBlocks(report);
  assert.ok(blocks.length > 0, "inspect emitted workspaces including methods and allocation helpers");
  const types = new Set(blocks.map(block => block.type));
  for (const type of types) {
    assert.ok(!type.startsWith("_object_"), `private ${type} is not supported by the share player`);
    assert.ok(!["logic_ternary", "math_trig_rad"].includes(type), `${type} is not supported by the share player`);
  }
  assert.ok(types.has("list_item"), "fields read through the shared list heap");
  assert.ok([...types].some(type => /^(?:list_(?:append|insert|replace|set)|replace_list_item)/.test(type)),
    "fields allocate or update the shared list heap");
  for (const procedure of report.procedures) {
    const procedureBlocks = Object.values(procedure.workspaceData.blocks);
    for (const parameter of procedure.params.filter(parameter => parameter.type === "String")) {
      assert.equal(procedure.workspaceData.blocks[parameter.id]?.type, "procedures_2_stable_parameter");
    }
    for (const block of procedureBlocks) {
      if (block.type === "procedures_2_parameter") {
        assert.ok(procedure.params.some(parameter => block.mutation?.includes(`id="${parameter.id}"`)),
          `parameter reference belongs to its procedure: ${block.id}`);
      }
      if (block.type === "procedures_2_return_value") {
        assert.match(block.mutation, /items="1"/);
        assert.ok(Object.values(block.shadows ?? {}).some(shadow => typeof shadow === "string" && /type="math_number"/.test(shadow)),
          "return values have the official numeric shadow");
      }
    }
  }
  return blocks;
}

function assertRejected(source, message) {
  assert.throws(() => compileSource(source), error => {
    assert.ok(error instanceof CompileError, "unsupported classes must produce a frontend CompileError");
    assert.match(error.message, message);
    assert.match(error.message, /(?:alternative|use|instead|rewrite|replace|step 2|stage 2|temporar|not yet|暂不|改用)/i,
      "diagnostic explains the limitation or suggests a supported alternative");
    assert.ok(error.location?.line >= 1);
    assert.ok(error.location?.column >= 1);
    assert.equal(path.resolve(error.location.file), entry);
    return true;
  });
}

test("class fixture has an independent JavaScript scalar oracle", () => {
  const javascript = ts.transpileModule(fixture, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const logs = [];
  vm.runInNewContext(javascript, { console: { log(value) {
    assert.ok(["number", "string", "boolean"].includes(typeof value), "log scalar values, never handles");
    logs.push(String(value));
  } } }, { filename: "ts-classes.js", timeout: 5000 });
  assert.deepEqual(logs, [
    "defaults", "0", "", "false", "2", "3",
    "initialization", "field;constructor;field;constructor;", "3", "5", "3", "7",
    "10", "81", "counter!", "15", "true", "false",
    "identity and containers", "86", "true", "false", "7", "89", "8",
    "true", "91", "9", "true",
    "single evaluation", "22", "1", "1",
  ]);
});

test("classes, fields, constructors and methods emit share-player-supported blocks", () => {
  assertOfficialClassLowering(compileSource(fixture));
});

test("class fixture matches Node logs through the real compiler and VM", () => {
  assertJsLogs(fixture);
});

const positives = [
  ["field defaults and constructor assignments", `class C { x: number; enabled = false; text = "a"; constructor(x: number) { this.x = x; } read() { return this.x; } } console.log(new C(4).read());`],
  ["public, private and readonly parameter properties", `class C { constructor(public x: number, private y: number, readonly z: number) {} total() { return this.x + this.y + this.z; } } console.log(new C(1, 2, 3).total());`],
  ["same method name on distinct statically known classes", `class A { value = 1; read() { return this.value; } } class B { value = 2; read() { return this.value * 3; } } console.log(new A().read()); console.log(new B().read());`],
  ["chained method calls retain the receiver class", `class C { x = 1; self(): C { return this; } add(n: number): C { this.x += n; return this; } } const c = new C(); console.log(c.self().add(3).x);`],
  ["method recursion preserves this and local frames", `class C { value = 7; sum(n: number): number { const saved = n; if (n <= 0) return this.value; const child = this.sum(n - 1); return saved + child; } } console.log(new C().sum(4));`],
  ["mutual method recursion", `class C { x = 1; even(n: number): boolean { if (n === 0) return true; return this.odd(n - 1); } odd(n: number): boolean { if (n === 0) return false; return this.even(n - 1); } } const c = new C(); console.log(c.even(6)); console.log(c.odd(5)); console.log(c.x);`],
  ["instances stored in typed arrays and object properties", `class C { x = 1; add(n: number) { this.x += n; } } const c = new C(); const xs: C[] = [c]; const box = {item: c}; xs[0].add(2); box.item.add(3); console.log(c.x);`],
  ["constructor default arguments and parameter properties", `class C { x = 2; constructor(public step: number = 4) { this.x += step; } read() { return this.x; } } console.log(new C().read()); console.log(new C(7).read());`],
  ["this compound update saves the old value before RHS effects", `class C { x = 3; update() { this.x += rhs(); } } const c = new C(); function rhs(): number { c.x = 100; return 2; } c.update(); console.log(c.x);`],
  ["field initializers call methods before the constructor body", `class C { x = 2; copied = this.read(); constructor() { this.x = 9; } read(): number { return this.x; } } const c = new C(); console.log(c.copied); console.log(c.x);`],
  ["recursive methods on different receivers keep this per call", `class C { constructor(public base: number) {} sum(other: C, n: number): number { const saved = this.base; if (n <= 0) return saved; const child = other.sum(this, n - 1); return saved + child; } } const a = new C(2); const b = new C(5); console.log(a.sum(b, 3)); console.log(a.base); console.log(b.base);`],
  ["new arguments evaluate once before fields and constructor", `let trace = ""; function value(s: string) { trace += s; return 3; } class C { x = value("field;"); constructor(public n: number) { trace += "body;"; } read() { return this.x + this.n; } } const c = new C(value("argument;")); console.log(trace); console.log(c.read());`],
  ["methods allocate and return fresh class instances", `class C { constructor(public x: number) {} copy(): C { return new C(this.x); } add(n: number): C { this.x += n; return this; } } const a = new C(3); const b = a.copy().add(2); console.log(a.x); console.log(b.x); console.log(a === b);`],
  ["empty field layouts retain distinct instance identity", `class C { read(): number { return 7; } } const a = new C(); const b = new C(); console.log(a === b); console.log(a.read());`],
  ["receiver is captured before arguments change its alias", `class C { constructor(public x: number) {} add(n: number): number { this.x += n; return this.x; } } const a = new C(1); const b = new C(10); let current = a; function argument(): number { current = b; return 2; } console.log(current.add(argument())); console.log(a.x); console.log(b.x); console.log(current === b);`],
];
for (const [name, source] of positives) {
  test(`classes compile: ${name}`, () => assertOfficialClassLowering(compileSource(source)));
  test(`classes match JavaScript: ${name}`, () => assertJsLogs(source));
}

const unsupported = [
  ["super", `class C { x = 1; method() { super.method(); } }`, /super/i],
  ["abstract method", `class C { abstract method(): number; }`, /abstract/i],
  ["private identifier field", `class C { #x = 1; read() { return this.#x; } }`, /private|#x/i],
  ["index signature", `class C { [key: string]: number; x = 1; }`, /index signature/i],
  ["method read as a value", `class C { x = 1; m() { return this.x; } } const c = new C(); const f = c.m;`, /method[\s\S]*(?:value|direct|call)|bound/i],
  ["method passed as a callback", `class C { x = 1; m(n: number) { return this.x + n; } } const c = new C(); [1].map(c.m);`, /method[\s\S]*(?:value|direct|call)|bound/i],
  ["method bind", `class C { x = 1; m() { return this.x; } } const c = new C(); const f = c.m.bind(c);`, /bind|method/i],
  ["method call", `class C { x = 1; m() { return this.x; } } const c = new C(); c.m.call(c);`, /\.call|method/i],
  ["arrow captures this in timer", `class C { x = 1; m() { setTimeout(() => { console.log(this.x); }, 0); } } new C().m();`, /this|captur|closure/i],
  ["function closure captures instance alias in timer", `class C { x = 1; m() { const self = this; setTimeout(function () { console.log(self.x); }, 0); } } new C().m();`, /this|captur|closure|parameter/i],
  ["class expression", `const C = class { x = 1; };`, /class expression/i],
  ["class decorator", `function decorate(value: any) { return value; } @decorate class C { x = 1; }`, /decorator/i],
  ["member decorator", `function decorate(value: any) { return value; } class C { @decorate x = 1; }`, /decorator/i],
  ["runtime field addition", `class C { x = 1; } const c = new C(); c.added = 2;`, /field|propert|declared|initializ/i],
  ["any receiver", `class C { x = 1; m() { return this.x; } } function invoke(c: any) { return c.m(); } console.log(invoke(new C()));`, /any|statically|receiver|class/i],
  ["unknown receiver", `class C { x = 1; m() { return this.x; } } function invoke(c: unknown) { return c.m(); } console.log(invoke(new C()));`, /unknown|statically|receiver|class/i],
  ["union receiver", `class A { x = 1; m() { return this.x; } } class B { x = 2; m() { return this.x; } } function invoke(c: A | B) { return c.m(); } console.log(invoke(new A()));`, /union|statically|receiver|class/i],
  ["uninitialized field cannot leak a heap zero", `class C { x: number; } const c = new C(); console.log(c.x);`, /initializ|undefined/i],
  ["later field cannot read an allocation placeholder", `class C { first = this.later; later = 4; } console.log(new C().first);`, /initializ|undefined|order/i],
  ["constructor branches must initialize every field", `class C { x: number; constructor(n: number) { if (n > 0) this.x = n; } } console.log(new C(0).x);`, /initializ|path|undefined/i],
];
for (const [name, source, message] of unsupported) {
  test(`unsupported class operation has an actionable source diagnostic: ${name}`, () => assertRejected(source, message));
}
