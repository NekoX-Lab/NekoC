import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { CompileError, compileFile } from "../ts/compile-ts.mjs";
import { assertJsLogs } from "./ts-runtime.mjs";

const entry = path.resolve("virtual/class-inherit.ts");
const compile = source => compileFile(entry, { readFile: name => name === entry ? source : undefined });
const fixture = readFileSync(new URL("./fixtures/ts-classes-inherit.ts", import.meta.url), "utf8");
const oracle = source => assertJsLogs(source, { target: ts.ScriptTarget.ES2022 });

test("inheritance fixture matches JavaScript scalar logs", () => oracle(fixture));
test("abstract-only declarations may call their abstract members", () => {
  compile('abstract class A{abstract m():number; read(){return this.m();}}');
  compile('abstract class A{abstract copy():A; read():A{return this.copy();}}');
});
test("unoverridden methods stay direct and standalone classes retain their exact report", () => {
  const report = compile('class A{x=1;m(){return this.x;}}class B extends A{}const a:A=new B();console.log(a.m());');
  assert.ok(!report.procedures.some(p => p.name.includes("dispatch")));
  const plain = compile('class A{x=1;m(){return this.x;}}console.log(new A().m());');
  assert.ok(!JSON.stringify(plain).includes("typeId"));
  assert.ok(!plain.procedures.some(p => p.name.includes("dispatch")));
});
test("equal adjacent implementations share one interval branch", () => {
  const report = compile('class A{m(){return 1;}}class B extends A{m(){return 2;}}class C extends B{}class D extends B{}function f(a:A){return a.m();}console.log(f(new C()));');
  const dispatches = report.procedures.filter(p => p.name.includes("dispatch") && p.name.endsWith(" (implementation)"));
  assert.equal(dispatches.length,1);
  const blocks=Object.values(dispatches[0].workspaceData.blocks);
  assert.equal(blocks.filter(b => b.type === "controls_if").length,1);
});
test("inheritance emits official blocks and exact procedure parameter ids", () => {
  const report = compile(fixture);
  const visit = node => {
    if (!node || typeof node !== "object") return;
    if (typeof node.type === "string") {
      assert.ok(!node.type.startsWith("_object_"));
      assert.ok(!["logic_ternary", "math_trig_rad"].includes(node.type));
      if (node.type === "procedures_2_return_value") {
        assert.match(node.mutation, /items="1"/);
        assert.ok(Object.values(node.shadows ?? {}).some(s => typeof s === "string" && s.includes('type="math_number"')));
      }
    }
    Object.values(node).forEach(visit);
  };
  visit(report);
  for (const p of report.procedures) {
    for (const param of p.params.filter(p => p.type === "String")) assert.equal(p.workspaceData.blocks[param.id]?.type, "procedures_2_stable_parameter");
    for (const block of Object.values(p.workspaceData.blocks)) if (block.type === "procedures_2_parameter") assert.ok(p.params.some(param => block.mutation?.includes(`id="${param.id}"`)));
  }
});

const positive = [
  ["multilevel fields and inherited constructor forwarding", 'class A { constructor(public x:number){} } class B extends A { y=2; } class C extends B { z=3; } const c=new C(4); console.log(c.x+c.y+c.z);'],
  ["explicit super initializes fields after base body", 'let log=""; function mark(s:string){log+=s;return 1;} class A { x=mark("a"); constructor(n:number){mark("b");} } class B extends A { y=mark("c"); constructor(n:number){mark("p");super(n);mark("d");} } new B(1);console.log(log);'],
  ["inherited same-name fields overwrite the shared slot", 'class A { x=1; read(){return this.x;} } class B extends A { x=2; } const b=new B();console.log(b.read());console.log(b.x);'],
  ["base arrays dispatch sibling overrides", 'class A { m(){return 1;} } class B extends A { m(){return 2;} } class C extends A { m(){return 3;} } const xs:A[]=[new A(),new B(),new C()];for(const x of xs)console.log(x.m());'],
  ["super calls ancestor implementation directly", 'class A { m(){return 1;} } class B extends A { m(){return super.m()+2;} } class C extends B { m(){return super.m()+4;} } const a:A=new C();console.log(a.m());'],
  ["abstract inherited implementation and virtual recursion", 'abstract class A { abstract m(n:number):number; read(){return this.m(3);} } class B extends A { m(n:number):number{if(n===0)return 2;return this.m(n-1)+1;} } const a:A=new B();console.log(a.read());'],
  ["instanceof narrows a base receiver to a derived method", 'class A { x=1; } class B extends A { special(){return 7;} } function f(a:A){if(a instanceof B)return a.special();return 0;}console.log(f(new B()));console.log(f(new A()));'],
  ["receiver and arguments each evaluate once before dispatch", 'let n=0; class A { m(x:number){return x;} } class B extends A { m(x:number){return x+2;} } const b=new B();function get():A{n+=1;return b;}function arg(){n*=10;return n;}console.log(get().m(arg()));console.log(n);'],
  ["accessor compound assignment gets before evaluating RHS", 'let trace=""; class A { x=1; get p(){trace+="g";return this.x;} set p(v:number){trace+="s";this.x=v;} } class B extends A {}const b=new B(); function rhs(){trace+="r";b.x=10;return 2;} b.p+=rhs();console.log(b.x);console.log(trace);'],
  ["inherited getters and setters dispatch overrides", 'class A { x=1;get p(){return this.x;}set p(v:number){this.x=v;} } class B extends A {get p(){return this.x*2;}set p(v:number){this.x=v/2;}}function f(a:A){a.p+=2;console.log(a.p);}const b=new B();f(b);console.log(b.x);'],
  ["super accessors invoke ancestor get and set", 'class A { x=1;get p(){return this.x;}set p(v:number){this.x=v;} }class B extends A { get p(){return super.p+1;}set p(v:number){super.p=v+1;} } const b=new B();b.p=3;console.log(b.p);'],
  ["accessor updates evaluate receiver only once", 'let n=0;class A{x=1;get p(){return this.x;}set p(v:number){this.x=v;}} const a=new A();function get(){n+=1;return a;}get().p++;console.log(n);console.log(a.x);'],
  ["static initialization occurs between surrounding statements", 'let trace="a";function mark(s:string){trace+=s;return 1;}class C{static x=mark("b");static y=mark("c")+C.x;static m(){return C.y;}}mark("d");console.log(trace);console.log(C.m());'],
  ["static methods can allocate instances", 'class C { x=2;static create():C{return new C();} } console.log(C.create().x);'],
  ["branch super calls initialize on each path", 'class A {constructor(public x:number){}}class B extends A {y=2;constructor(flag:boolean){if(flag){super(3);}else{super(4);}this.y+=1;}}console.log(new B(true).x);console.log(new B(false).y);'],
  ["derived defaults evaluate before base fields and own fields", 'let log="";function mark(s:string){log+=s;return 2;}class A{x=mark("a");constructor(public n=mark("b")){}}class B extends A{y=mark("c");constructor(n=mark("p")){super(n);mark("d");}}new B();console.log(log);'],
  ["derived parameter properties initialize after own fields", 'class A{x=1;}class B extends A{y=2;constructor(public n:number){super();this.y+=n;}}const b=new B(3);console.log(b.n);console.log(b.y);'],
  ["class references survive inherited nested fields and arrays", 'class Item{x=1;}class A{item=new Item();m(){return this.item.x;}}class B extends A{m(){return this.item.x+2;}}const xs:A[]=[new B()];const box={item:xs[0]};box.item.item.x=4;console.log(box.item.m());'],
  ["accessor recursion keeps state per invocation", 'class A{x=1;get p(){return this.x;}set p(v:number){this.x=v;}m(n:number):number{if(n===0)return this.p;this.p+=this.m(n-1);return this.p;}}class B extends A{}const b=new B();console.log(b.m(3));'],
  ["virtual method defaults belong to the selected implementation", 'class A{m(n=1){return n;}}class B extends A{m(n=2){return n+1;}}function f(a:A){return a.m();}console.log(f(new A()));console.log(f(new B()));'],
  ["abstract accessor overrides dispatch through a base", 'abstract class A{abstract get p():number;abstract set p(v:number);}class B extends A{x=2;get p(){return this.x;}set p(v:number){this.x=v;}}function f(a:A){a.p+=3;return a.p;}console.log(f(new B()));'],
];
for (const [name, source] of positive) test("class inheritance JS: "+name, () => oracle(source));

const negative = [
  ["this before super", 'class A{}class B extends A{x=1;constructor(){this.x=2;super();}}new B();', /before super/i],
  ["missing super path", 'class A{}class B extends A{constructor(flag:boolean){if(flag)super();}}new B(false);', /super.*every|super.*may not/i],
  ["duplicate super", 'class A{}class B extends A{constructor(){super();super();}}new B();', /super.*twice/i],
  ["super in loop", 'class A{}class B extends A{constructor(){while(true){super();}}}new B();', /super.*loops|exactly once/i],
  ["new abstract", 'abstract class A{x=1;}new A();', /abstract/i],
  ["unimplemented abstract", 'abstract class A{abstract m():number;}class B extends A{}new B();', /implement.*abstract/i],
  ["dynamic instanceof RHS", 'class A{x=1;}function f(c:any){return new A() instanceof c;}f(A);', /instanceof.*statically/i],
  ["getter only write", 'class A{x=1;get p(){return this.x;}}new A().p=2;', /only a getter/i],
  ["setter only read", 'class A{x=1;set p(v:number){this.x=v;}}console.log(new A().p);', /only a setter/i],
  ["static this", 'class A{static x=1;static m(){return this.x;}}console.log(A.m());', /this.*static/i],
  ["static inheritance", 'class A{static m(){return 1;}}class B extends A{}console.log(B.m());', /static inheritance/i],
  ["static block", 'class A{static {console.log(1);}}', /static blocks/i],
  ["unsafe constructor virtual call", 'class A{x=this.m();m(){return 1;}}class B extends A{y=2;m(){return this.y;}}new B();', /virtual call.*construction/i],
  ["unsafe constructor body virtual call", 'class A{x=1;constructor(){console.log(this.m());}m(){return 1;}}class B extends A{y=2;m(){return this.y;}}new B();', /virtual call.*construction/i],
  ["unsafe initializer virtual getter", 'class A{x=this.p;get p(){return 1;}}class B extends A{y=2;get p(){return this.y;}}new B();', /virtual getter.*construction/i],
  ["private field", 'class A{#x=1;}class B extends A{}', /private/i],
  ["index signature", 'class A{[key:string]:number;}class B extends A{}', /index signature/i],
  ["dynamic member", 'const key="x";class A{[key]=1;}class B extends A{}', /dynamic.*member/i],
  ["method value", 'class A{m(){return 1;}}class B extends A{}const f=new B().m;', /method values/i],
  ["apply", 'class A{m(){return 1;}}class B extends A{}new B().m.apply(new B(),[]);', /method values|apply/i],
  ["mixin", 'class A{}function mix(){return A;}class B extends mix(){}', /mixins|statically known/i],
  ["builtin inheritance", 'class B extends Array{}', /built-in inheritance/i],
  ["constructor replacement", 'class A{}class B extends A{constructor(){super();return {};}}new B();', /returning a value.*constructor/i],
  ["generic class", 'class A<T>{}class B extends A<number>{}', /generic class/i],
  ["generic method", 'class A{m<T>(x:T){return x;}}class B extends A{}', /generic.*methods/i],
  ["async method", 'class A{async m(){return 1;}}class B extends A{}', /async/i],
  ["generator method", 'class A{*m(){yield 1;}}class B extends A{}', /generator/i],
  ["overloaded method", 'class A{m(x:number):number;m(x:number){return x;}}class B extends A{}', /overload/i],
  ["class expression", 'class A{}const B=class extends A{};', /class expressions/i],
  ["nested class", 'class A{}function f(){class B extends A{}return 1;}f();', /nested/i],
  ["decorator", 'function dec(x:any){}@dec class A{}class B extends A{}', /decorators/i],
  ["runtime added property", 'class A{x=1;}class B extends A{}const b=new B();b.y=2;', /undeclared class property/i],
  ["this capture across wait", 'class A{x=1;m(){(()=>{wait(1);console.log(this.x);})();}}class B extends A{}new B().m();', /capturing this/i],
  ["any receiver", 'class A{m(){return 1;}}class B extends A{}function f(x:any){return x.m();}f(new B());', /any|statically/i],
  ["unrelated union receiver", 'class A{m(){return 1;}}class B extends A{}class C{m(){return 2;}}function f(x:A|C){return x.m();}f(new B());', /union|statically/i],
  ["unknown receiver", 'class A{m(){return 1;}}class B extends A{}function f(x:unknown){return x.m();}f(new B());', /unknown|statically/i],
  ["bind", 'class A{m(){return 1;}}class B extends A{}new B().m.bind(new B());', /bind|method values/i],
  ["call", 'class A{m(){return 1;}}class B extends A{}new B().m.call(new B());', /call|method values/i],
  ["abstract accessor implementation required", 'abstract class A{abstract get p():number;}class B extends A{}new B();', /abstract|implement/i],
  ["later static field read", 'class A{static x=A.y;static y=2;}console.log(A.x);', /static.*before/i],
  ["later static field read through method", 'class A{static x=A.m();static y=2;static m(){return A.y;}}console.log(A.x);', /static.*before/i],
  ["static access before class", 'console.log(A.x);class A{static x=2;}', /before.*class|before.*declaration/i],
  ["static method before class", 'console.log(A.m());class A{static m(){return 1;}}', /before.*class|before.*declaration/i],
  ["unchecked base to derived cast", 'class A{x=1;}class B extends A{y=2;m(){return this.y;}}const b=new A() as B;console.log(b.m());', /downcast|related/i],
  ["constructor virtual setter", 'class A{x=1;constructor(){this.p=2;}set p(v:number){this.x=v;}}class B extends A{y=2;set p(v:number){console.log(this.y);this.x=v;}}new B();', /virtual setter.*construction/i],
  ["constructor this escapes to unknown virtual call", 'class A{x=1;constructor(){read(this);}m(){return 1;}}class B extends A{y=2;m(){return this.y;}}function read(a:A){console.log(a.m());}new B();', /escape.*construction/i],
  ["nested super call", 'class A{}class B extends A{constructor(){super();(()=>{super();})();}}new B();', /super.*nested|super.*derived constructor/i],
  ["super used as value", 'class A{}class B extends A{constructor(){const x=super();}}new B();', /super.*standalone/i],
  ["void result", 'class A{m(){}}class B extends A{}console.log(new B().m());', /void.*result/i],
  ["partial return", 'class A{m(flag:boolean){if(flag)return 1;}}class B extends A{}console.log(new B().m(false));', /return.*every path/i],
  ["initializer IIFE reads an uninitialized field", 'class A{x=(()=>this.y)();y=2;}class B extends A{}console.log(new B().x);', /before initialization/i],
  ["static initialization reads later field through constructor", 'class A{static x=new A();static y=2;constructor(){console.log(A.y);}}', /static.*before/i],
  ["static initialization reads later field through getter", 'class A{static x=new A().p;static y=2;get p(){return A.y;}}console.log(A.x);', /static.*before/i],
  ["static initialization reads later field through array callback", 'class A{static x=[1].map(n=>A.y)[0];static y=2;}console.log(A.x);', /static.*before/i],
  ["static initialization reads later field through named callback", 'function read(n:number){return A.y;}class A{static x=[1].map(read)[0];static y=2;}console.log(A.x);', /static.*before/i],
  ["super getter cannot bypass initialization virtual-call protection", 'class A{get p(){return this.m();}m(){return 1;}}class B extends A{x=super.p;m(){return this.x;}}new B();', /initializ|construction/i],
  ["setter early return cannot prove a field initialized", 'class A{x:number;constructor(flag:boolean){this.p=flag;}set p(flag:boolean){if(flag)return;this.x=1;}}class B extends A{}new B(true);', /initializ/i],
  ["incompatible override propagates TypeScript diagnostic", 'class A{m(n:number):number{return n;}}class B extends A{m(n:string):string{return n;}}new B();', /TS2416|compatible|assignable/i],
  ["static super", 'class A{static m(){return 1;}}class B extends A{static m(){return super.m();}}console.log(B.m());', /super.*static/i],
  ["constructor unrelated structural argument", 'class A{m(){return 1;}}class B extends A{}class C{m(){return 2;}}class Box{constructor(public item:A){}}console.log(new Box(new C()).item.m());', /related|structural/i],
  ["expression arrow unrelated return", 'class A{m(){return 1;}}class B extends A{}class C{m(){return 2;}}const f=():A=>new C();console.log(f().m());', /related|structural/i],
  ["constructor increment virtual setter", 'class A{x=1;constructor(){this.p++;}get p(){return this.x;}set p(v:number){this.x=v;}}class B extends A{y=2;get p(){return this.x;}set p(v:number){console.log(this.y);this.x=v;}}new B();', /virtual.*construction/i],
];
for (const [name, source, message] of negative) test("class inheritance rejects: "+name, () => {
  assert.throws(() => compile(source), e => {
    assert.ok(e instanceof CompileError);assert.match(e.message,message);assert.match(e.message,/alternative:/);
    assert.equal(path.resolve(e.location.file),entry);assert.equal(e.location.line,1);assert.ok(e.location.column>0 && e.location.column<=source.length);return true;
  });
});
