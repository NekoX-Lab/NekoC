import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import ts from "typescript";
import { CompileError, compileFile } from "../ts/compile-ts.mjs";
import { assertJsLogs } from "./ts-runtime.mjs";

const entry = path.resolve("virtual/r3-class.ts");
const compile = source => compileFile(entry, { readFile: name => name === entry ? source : undefined });

const supported = [
  ["branded numeric getters preserve prefix and postfix updates", `
type N = number & { readonly tag: "n" };
class C { x = 1 as N; get p(): N { return this.x; } set p(v: number) { this.x = v as N; } }
const c = new C(); c.p++; console.log(c.p); ++c.p; console.log(c.p);
c.p--; console.log(c.p); --c.p; console.log(c.p);
`],
  ["inherited branded numeric getters support super updates", `
type N = number & { readonly tag: "n" };
class A { x = 3 as N; get p(): N { return this.x; } set p(v: number) { this.x = v as N; } }
class B extends A { bump() { super.p++; } drop() { --super.p; } }
const b = new B(); b.bump(); console.log(b.p); b.drop(); console.log(b.p);
`],
  ["inherited constructors and super preserve initialization order", `
let trace = "";
function mark(label: string): number { trace += label; return 2; }
class A { x = mark("a"); constructor(n = mark("d")) { this.x += n; trace += "b"; } }
class B extends A { y = mark("c"); constructor(n = mark("p")) { trace += "s"; super(n); trace += "e"; } }
class C extends B {}
const c = new C(); console.log(trace); console.log(c.x); console.log(c.y);
`],
  ["super calls the ancestor implementation with virtual this", `
class A { x = 2; value() { return this.x; } read() { return this.value(); } }
class B extends A { value() { return this.x + 3; } read() { return super.read() + 1; } }
class C extends B { value() { return this.x + 7; } }
function read(a: A) { return a.read(); }
console.log(read(new A())); console.log(read(new B())); console.log(read(new C()));
`],
  ["accessor updates save receiver and getter before RHS effects", `
let trace = "";
class C { x = 3; get p() { trace += "g"; return this.x; } set p(v: number) { trace += "s"; this.x = v; } }
const first = new C(); const second = new C(); let current = first;
function receiver(): C { trace += "r"; return current; }
function rhs() { trace += "v"; current = second; first.x = 20; return 4; }
receiver().p += rhs(); console.log(trace); console.log(first.x); console.log(second.x);
first.p++; --second.p; console.log(first.x); console.log(second.x);
`],
  ["super getters and setters use the derived receiver", `
class A { x = 2; get p() { return this.x; } set p(v: number) { this.x = v; } }
class B extends A { get p() { return super.p + 1; } set p(v: number) { super.p = v * 2; } bump() { super.p += 3; } }
const b = new B(); b.p = 4; b.bump(); console.log(b.p); console.log(b.x);
`],
  ["static members preserve source order and shared state", `
let trace = "";
function mark(label: string): number { trace += label; return 2; }
trace += "a";
class C { static x = mark("b"); static y = C.x + mark("c"); static add(n: number) { C.x += n; return C.x; } }
trace += "d"; console.log(trace); console.log(C.add(3)); console.log(C.y); console.log(C.x);
`],
  ["instanceof narrows descendants and evaluates the instance once", `
class A { value() { return 1; } }
class B extends A { value() { return 2; } extra() { return 5; } }
class C extends A { value() { return 3; } }
class Other {}
let calls = 0;
function receiver(): A { calls++; return new B(); }
function read(a: A) { if (a instanceof B) return a.extra(); return a.value(); }
console.log(receiver() instanceof A); console.log(calls);
console.log(new B() instanceof C); console.log(new B() instanceof Other);
console.log(read(new B())); console.log(read(new C()));
`],
  ["explicit callback wrappers retain the instance", `
class A { x = 2; add(n: number) { return this.x + n; } }
class B extends A { add(n: number) { return super.add(n) + 3; } }
const b: A = new B(); const values = [1, 2].map(n => b.add(n));
console.log(values[0]); console.log(values[1]);
`],
  ["string accessor compound assignment stays concatenation", `
class C { x = "a"; get p() { return this.x; } set p(v: string) { this.x = v; } }
const c = new C(); c.p += "b"; console.log(c.p);
`],
];

for (const [name, source] of supported) test("r3 class matches JavaScript: " + name, () =>
  assertJsLogs(source, { target: ts.ScriptTarget.ES2022 }));

const unsupported = [
  ["getter cannot hide an inherited method with a callable result", 'class A { p() { return 3; } } class B extends A { get p() { return () => 7; } } console.log(new B().p());', /accessors cannot replace inherited methods/i],
  ["setter cannot hide an inherited method", 'class A { p() { return 3; } } class B extends A { set p(v: number) {} } const b = new B(); b.p = 7;', /accessors cannot replace inherited methods/i],
  ["accessor cannot hide a grandparent method", 'class A { p() { return 3; } } class B extends A {} class C extends B { get p() { return () => 7; } } console.log(new C().p());', /accessors cannot replace inherited methods/i],
  ["branded string getter remains nonnumeric", 'type S = string & { readonly tag: "s" }; class C { x = "1" as S; get p(): S { return this.x; } set p(v: string) { this.x = v as S; } } const c = new C(); c.p++;', /accessor updates.*numeric/i],
  ["string getter increment cannot become concatenation", 'class C { x = "1"; get p() { return this.x; } set p(v: string) { this.x = v; } } const c = new C(); c.p++;', /accessor updates.*numeric/i],
  ["string getter decrement requires numeric conversion", 'class C { x = "3"; get p() { return this.x; } set p(v: string) { this.x = v; } } const c = new C(); --c.p;', /accessor updates.*numeric/i],
  ["boolean getter increment requires numeric conversion", 'class C { x = true; get p() { return this.x; } set p(v: boolean) { this.x = v; } } const c = new C(); ++c.p;', /accessor updates.*numeric/i],
  ["any getter cannot bypass numeric update checks", 'class C { x = 1; get p(): any { return this.x; } set p(v: any) { this.x = v; } } const c = new C(); c.p++;', /accessor updates.*numeric/i],
  ["string super getter increment cannot become concatenation", 'class A { x = "1"; get p() { return this.x; } set p(v: string) { this.x = v; } } class B extends A { bump() { super.p++; } } new B().bump();', /accessor updates.*numeric/i],
  ["instance methods cannot be detached into array callbacks", 'class C { x = 2; add(n: number) { return this.x + n; } } const c = new C(); [1, 2].map(c.add);', /method.*callback|method values/i],
  ["inherited methods cannot be detached into callbacks", 'class A { x = 2; add(n: number) { return this.x + n; } } class B extends A {} const b = new B(); [1, 2].map(b.add);', /method.*callback|method values/i],
  ["method bind cannot silently capture the wrong this", 'class A { x = 2; m() { return this.x; } } class B extends A {} const b = new B(); const f = b.m.bind(b); console.log(f());', /method.*bind|method values/i],
  ["static inherited fields require the declaring class", 'class A { static x = 2; } class B extends A {} console.log(B.x);', /static inheritance/i],
  ["static this requires an explicit declaring class", 'class C { static x = 2; static m() { return this.x; } } console.log(C.m());', /this in static/i],
  ["static accessors are diagnosed", 'class C { static get x() { return 2; } } console.log(C.x);', /static accessors/i],
  ["static blocks are diagnosed", 'class C { static x = 1; static { C.x++; } } console.log(C.x);', /static blocks/i],
  ["static ||= must not evaluate a skipped RHS", 'class C { static x = 2; } let hits = 0; function rhs() { hits++; return 3; } C.x ||= rhs(); console.log(hits);', /Logical assignment \|\|= \/ &&= is not supported.*short-circuit/],
  ["static &&= must not evaluate a skipped RHS", 'class C { static x = 0; } let hits = 0; function rhs() { hits++; return 3; } C.x &&= rhs(); console.log(hits);', /Logical assignment \|\|= \/ &&= is not supported.*short-circuit/],
  ["static ??= must not evaluate a skipped RHS", 'class C { static x = 2; } let hits = 0; function rhs() { hits++; return 3; } C.x ??= rhs(); console.log(hits);', /logical class field assignments/i],
  ["instance ||= must not evaluate a skipped RHS", 'class C { x = 2; } const c = new C(); let hits = 0; function rhs() { hits++; return 3; } c.x ||= rhs();', /Logical assignment \|\|= \/ &&= is not supported.*short-circuit/],
  ["inherited instance &&= must not evaluate a skipped RHS", 'class A { x = 0; } class B extends A {} const b = new B(); let hits = 0; function rhs() { hits++; return 3; } b["x"] &&= rhs();', /Logical assignment \|\|= \/ &&= is not supported.*short-circuit/],
  ["instance ??= must not evaluate a skipped RHS", 'class C { x = 2; } const c = new C(); let hits = 0; function rhs() { hits++; return 3; } c.x ??= rhs();', /logical class field assignments/i],
  ["missing super path is diagnosed", 'class A { x = 1; } class B extends A { constructor(flag: boolean) { if (flag) super(); } } new B(false);', /super.*every constructor path/i],
  ["duplicate super calls are diagnosed", 'class A { x = 1; } class B extends A { constructor() { super(); super(); } } new B();', /super.*twice/i],
  ["built-in instanceof cannot compare a synthetic class tag", 'const a = [1]; console.log(a instanceof Array);', /instanceof.*statically known class/i],
  ["dynamic instanceof constructor is diagnosed", 'class A { x = 1; } const C = A; console.log(new A() instanceof C);', /instanceof.*statically known class|class.*value/i],
];

for (const [name, source, message] of unsupported) test("r3 class rejects: " + name, () => {
  assert.throws(() => compile(source), error => {
    assert.ok(error instanceof CompileError);
    assert.match(error.message, message);
    assert.match(error.message, /alternative:|instead/i);
    assert.equal(path.resolve(error.location.file), entry);
    assert.equal(error.location.line, 1);
    assert.ok(error.location.column > 0 && error.location.column <= source.length);
    return true;
  });
});
