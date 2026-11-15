import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { CompileError, compileFile } from "../ts/compile-ts.mjs";
import { lowerTsNullable } from "../ts/tsfeat-nullable.mjs";
import { assertJsLogs } from "./ts-runtime.mjs";

const entry = path.resolve("virtual/ts-nullable/main.ts");
const fixture = readFileSync(new URL("./fixtures/ts-nullable.ts", import.meta.url), "utf8");

function compileSource(source) {
  return compileFile(entry, { readFile: name => (path.resolve(name) === entry ? source : undefined) });
}

function reportBlocks(value, found = []) {
  if (!value || typeof value !== "object") return found;
  if (value.blocks && typeof value.blocks === "object") found.push(...Object.values(value.blocks));
  for (const child of Object.values(value)) reportBlocks(child, found);
  return found;
}

// Only official Kitten N blocks; custom-block parameters and return values in the editor format.
function assertOfficialLowering(report) {
  const blocks = reportBlocks(report);
  assert.ok(blocks.length > 0);
  for (const type of new Set(blocks.map(block => block.type))) {
    assert.ok(!type.startsWith("_object_"), `private ${type} is not supported by the share player`);
    assert.ok(!["logic_ternary", "math_trig_rad"].includes(type), `${type} is not supported by the share player`);
  }
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
    assert.ok(error instanceof CompileError, `expected a CompileError, got ${error}`);
    assert.match(error.message, message);
    assert.match(error.message, /(?:alternative|use|instead|rewrite|replace|narrow|check)/i,
      "diagnostic suggests a supported alternative");
    assert.ok(error.location?.line >= 1);
    assert.ok(error.location?.column >= 1);
    assert.equal(path.resolve(error.location.file), entry);
    return true;
  });
}

test("nullable fixture has an independent JavaScript oracle", () => {
  const javascript = ts.transpileModule(fixture, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const logs = [];
  vm.runInNewContext(javascript, { console: { log: (...args) => {
    for (const value of args) {
      assert.ok(value === null || ["undefined", "number", "string", "boolean"].includes(typeof value), "log scalars, never handles");
    }
    logs.push(args.map(String).join(" "));
  } } }, { timeout: 5000 });
  assert.equal(logs.length, 42);
  assert.ok(logs.includes("null undefined null undefined undefined"));
});

test("nullable fixture emits share-player-supported blocks", () => {
  assertOfficialLowering(compileSource(fixture));
});

test("nullable fixture matches Node logs through the real compiler and VM", () => {
  assertJsLogs(fixture);
});

const positives = [
  ["console.log prints null and undefined", `let a: number | null = null; let b: string | undefined; console.log(null, undefined, a, b, void 0);`],
  ["string concatenation and templates print null and undefined", `let a: number | null = null; let s: string | undefined; console.log("a=" + a, "s=" + s, \`\${a}/\${s}\`, String(s));`],
  ["string sentinels never collide with numbers", `let s: string | null = "-1"; let t: string | null = null; console.log(s === null, t === null, s, t, s.length);`],
  ["number sentinels never collide with numeric text", `let n: number | null = -1; let m: number | undefined = -2; console.log(n === null, m === undefined, n + m);`],
  ["null and undefined stay distinct but loosely equal", `let a: number | null = null; let b: number | undefined = undefined; console.log(a === null, b === undefined, a == b, a == undefined, b == null, a != null);`],
  ["omitted optional properties read undefined", `interface P { a: number; b?: string; c?: number } const p: P = { a: 1 }; console.log(p.b, p.c, p.b === undefined, p.c ?? 5); p.b = "x"; console.log(p.b, p.b?.length);`],
  ["nullable object fields", `const o: { v: number | null; w: string | null } = { v: null, w: "w" }; console.log(o.v, o.w); o.v = 3; o.w = null; console.log(o.v, o.w);`],
  ["class optional and nullable fields", `class N { next: N | null = null; tag?: string; size?: number; constructor(public v: number) {} } const n = new N(1); console.log(n.next === null, n.tag, n.size ?? 0); n.next = new N(2); n.tag = "t"; console.log(n.next?.v, n.tag);`],
  ["a?.b short-circuits on null", `class C { constructor(public v: number) {} } let c: C | null = null; console.log(c?.v); c = new C(4); console.log(c?.v);`],
  ["a?.b.c reads through a non-null link", `class In { constructor(public v: number) {} } class Out { inner = new In(9); } let o: Out | undefined; console.log(o?.inner.v); o = new Out(); console.log(o?.inner.v);`],
  ["a?.m() skips the call and its arguments", `let calls = 0; function arg(): number { calls++; return calls; } class C { total = 0; add(n: number): number { this.total += n; return this.total; } } let c: C | null = null; console.log(c?.add(arg()), calls); c = new C(); console.log(c?.add(arg()), calls);`],
  ["a?.m() as a statement", `class C { constructor(public v: number) {} show(): void { console.log("v", this.v); } } let c: C | null = null; c?.show(); c = new C(3); c?.show();`],
  ["?? evaluates the left side once and the right side lazily", `let calls = 0; function left(v: number): number | null { calls += 10; return v > 0 ? v : null; } function right(): number { calls++; return -1; } console.log(left(2) ?? right(), calls); console.log(left(0) ?? right(), calls);`],
  ["?? keeps 0, false and empty text", `let n: number | null = 0; let b: boolean | undefined = false; let s: string | null = ""; console.log(n ?? 9, b ?? true, (s ?? "x").length);`],
  ["??= assigns only when null or undefined", `let calls = 0; function value(): number { calls++; return 7; } let x: number | null = null; x ??= value(); x ??= value(); console.log(x, calls);`],
  ["??= on object properties", `interface O { n?: number } const o: O = {}; o.n ??= 2; o.n ??= 3; console.log(o.n);`],
  ["=== null, !== undefined and == null narrow", `function f(x: number | null | undefined): string { if (x == null) return "none"; return "n" + (x + 1); } function g(x: number | undefined): number { if (x !== undefined) return x * 2; return -1; } console.log(f(null), f(undefined), f(2), g(4), g(undefined));`],
  ["if (x) truthiness on nullable references", `class C { constructor(public v: number) {} } function f(c: C | null): number { if (c) return c.v; return -1; } console.log(f(null), f(new C(5)));`],
  ["truthiness of nullable scalars follows JavaScript", `const xs: (number | null)[] = [0, 1, null]; for (const x of xs) console.log(x ? "t" : "f"); let s: string | undefined = ""; console.log(!s);`],
  ["narrowed branches compile as the non-null type", `class C { constructor(public v: number) {} } let c: C | null = new C(3); if (c !== null) { c.v += 1; console.log(c.v * 2); }`],
  ["functions return null or undefined", `function find(xs: number[], v: number): number | undefined { for (let i = 0; i < xs.length; i++) if (xs[i] === v) return i; return undefined; } function none(): string | null { return null; } console.log(find([3, 4], 4), find([3], 9), none());`],
  ["bare return in a nullable function returns undefined", `function f(x: number): number | undefined { if (x > 0) return x; return; } console.log(f(1), f(0));`],
  ["nullable values in arrays", `const xs: (string | null)[] = ["a", null]; xs.push(null); console.log(xs.length, xs.indexOf(null), xs.includes(null), xs.map(x => x ?? "-").join(""));`],
  ["switch on null", `let x: number | null = null; switch (x) { case null: console.log("null"); break; default: console.log("value"); }`],
  ["linked list", `class L { constructor(public v: number, public next: L | null = null) {} } let head: L | null = null; for (let i = 0; i < 3; i++) head = new L(i, head); let s = ""; for (let c = head; c !== null; c = c.next) s += c.v; console.log(s, head?.next?.next?.next?.v);`],
  ["binary tree", `class T { left: T | null = null; right: T | null = null; constructor(public k: number) {} add(k: number): void { if (k < this.k) { if (this.left) this.left.add(k); else this.left = new T(k); } else { if (this.right) this.right.add(k); else this.right = new T(k); } } sum(): number { return this.k + (this.left?.sum() ?? 0) + (this.right?.sum() ?? 0); } } const t = new T(5); for (const k of [2, 8, 1]) t.add(k); console.log(t.sum(), t.left?.left?.k, t.right?.right?.k);`],
  ["optional config objects", `interface Opts { size?: number; name?: string; on?: boolean } function show(o: Opts): string { return (o.name ?? "anon") + ":" + (o.size ?? 1) + ":" + (o.on ?? false); } console.log(show({})); console.log(show({ size: 0, name: "", on: true }));`],
];
for (const [name, source] of positives) {
  test(`nullable compiles: ${name}`, () => assertOfficialLowering(compileSource(source)));
  test(`nullable matches JavaScript: ${name}`, () => assertJsLogs(source));
}

const rejected = [
  ["null in arithmetic", `const x = null + 1; console.log(x);`, /arithmetic/i],
  ["undefined in relational comparison", `console.log(undefined < 1);`, /arithmetic|relational/i],
  ["unnarrowed nullable arithmetic", `function f(x: number | null): number { return x + 1; } console.log(f(1));`, /null or undefined/i],
  ["unnarrowed nullable relational comparison", `function f(x: number | undefined): boolean { return x > 1; } console.log(f(2));`, /null or undefined/i],
  ["unnarrowed nullable property read", `class C { v = 1; } function f(c: C | null): number { return c.v; } console.log(f(new C()));`, /null or undefined/i],
  ["unnarrowed nullable method call", `class C { m(): number { return 1; } } function f(c: C | undefined): number { return c.m(); } console.log(f(new C()));`, /null or undefined/i],
  ["non-null assertion on a nullable value", `function f(x: number | null): number { return x! * 2; } console.log(f(1));`, /non-null/i],
  ["optional chain on a call result", `class C { v = 1; } function g(): C | null { return new C(); } console.log(g()?.v);`, /optional chaining/i],
  ["optional function call", `class C { v = 1; } let c: C | null = null; console.log(c?.v?.toFixed?.());`, /optional function/i],
  ["pop result used as undefined", `const xs = [1]; const v: number | undefined = xs.pop(); console.log(v ?? 0);`, /pop\/shift\/find/i],
  ["find result used as undefined", `const xs = [1, 2]; console.log(xs.find(x => x > 5) ?? 0);`, /pop\/shift\/find/i],
  ["??= used as an expression", `let x: number | null = null; console.log(x ??= 3);`, /separate statement/i],
  ["?? with different value types", `let x: number | null = null; console.log(x ?? "none");`, /same value type/i],
  ["nullable union of mixed value types", `let x: string | number | null = null; console.log(x);`, /cannot hold null/i],
  ["loose equality between different nullable types", `let a: number | null = null; let b: string | null = null; console.log(a == b);`, /loose equality/i],
  ["value || on a nullable call result", `function f(): number | null { return null; } console.log(f() || 3);`, /variable or property path/i],
  ["nullable value of a non-top-level type", `function f() { interface In { v: number } let x: In | null = null; console.log(x === null); } f();`, /top-level/i],
  ["object printed through a nullable reference", `class C { v = 1; } let c: C | null = new C(); console.log("c=" + c);`, /converted to text|coercion/i],
  ["reserved helper names", `const __nekocNilNull_R_1 = 1; let x: number | null = null; console.log(x, __nekocNilNull_R_1);`, /reserved/i],
];
for (const [name, source, message] of rejected) {
  test(`nullable rejects: ${name}`, () => assertRejected(source, message));
}

test("nullable rejects any/unknown nulls and delete with the existing diagnostics", () => {
  assert.throws(() => compileSource(`let v: any = null; console.log(v);`), CompileError);
  assert.throws(() => compileSource(`interface O { x?: number } const o: O = { x: 1 }; delete o.x; console.log(o.x);`), CompileError);
});

const unchanged = [
  ["class fixture", "./fixtures/ts-classes.ts"],
  ["inheritance fixture", "./fixtures/ts-classes-inherit.ts"],
  ["shared object fixture", "./fixtures/ts-share-objects.ts"],
];
for (const [name, file] of unchanged) {
  test(`programs without null/undefined keep their source: ${name}`, () => {
    const text = readFileSync(new URL(file, import.meta.url), "utf8");
    const sourceFile = ts.createSourceFile(entry, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    assert.equal(lowerTsNullable(sourceFile), sourceFile);
  });
}

test("legacy optional parameters and non-nullable ?? keep their source", () => {
  for (const text of [
    `function f(x?: number) { return x; } console.log(f(1));`,
    `function g(x: number) { return x ?? 3; } console.log(g(1));`,
  ]) {
    const sourceFile = ts.createSourceFile(entry, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    assert.equal(lowerTsNullable(sourceFile), sourceFile);
  }
});
