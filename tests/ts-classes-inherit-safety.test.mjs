import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import ts from "typescript";
import { CompileError, compileFile } from "../ts/compile-ts.mjs";
import { assertJsLogs } from "./ts-runtime.mjs";

const entry = path.resolve("virtual/class-inherit-safety.ts");
const compile = source => compileFile(entry, { readFile: name => name === entry ? source : undefined });
const positive = [
  ["explicit constructor argument skips an unsafe default", 'class A{static x=new A(3);static y=2;constructor(n=A.y){console.log(n);}}console.log(A.y);'],
  ["explicit static method argument skips an unsafe default", 'class A{static x=A.m(3);static y=2;static m(n=A.y){return n;}}console.log(A.x);'],
  ["explicit ordinary argument skips an unsafe default", 'function f(n=A.y){return n;}class A{static x=f(3);static y=2;}console.log(A.x);'],
  ["implicit derived constructor forwards explicit argument", 'class A{constructor(n=B.y){console.log(n);}}class B extends A{static x=new B(3);static y=2;}console.log(B.y);'],
  ["internal class binding is available in static methods", 'class A{static y=2;static x=A.m();static m(){return A.y;}}console.log(A.x);'],
  ["external function sees already completed class", 'class A{static y=2;}function f(){return A.y;}class B{static x=f();}console.log(B.x);'],
  ["nested bare return does not alter method return proof", 'class A{m(){const f=()=>{return;};return 1;}}class B{static x=1;}console.log(new A().m());'],
  ["unused inherited classes do not require a heap", 'class A{x=1;}class B extends A{}function f(A:number){return A+1;}console.log(f(2));'],
  ["unused inherited classes allow shadowed local names", 'class A{x=1;}class B extends A{}function f(){const A=3;return A;}console.log(f());'],
  ["synchronous super capture is safe", 'class A{x=1;m(){return this.x;}}class B extends A{m(){return(()=>super.m())();}}console.log(new B().m());'],
  ["getter read does not invoke a yielding setter", 'class A{x=1;get p(){return this.x;}set p(v:number){wait(1);this.x=v;}m(){return(()=>this.p)();}}class B extends A{}console.log(new B().m());'],
];
for (const [name, source] of positive) test("class safety JS: " + name, () => assertJsLogs(source, { target: ts.ScriptTarget.ES2022 }));

const negative = [
  ["constructor default reads a later static field", 'class A{static x=new A();static y=2;constructor(n=A.y){console.log(n);}}', /static.*before/i],
  ["static method default reads a later static field", 'class A{static x=A.m();static y=2;static m(n=A.y){return n;}}console.log(A.x);', /static.*before/i],
  ["ordinary default reads a later static field", 'function f(n=A.y){return n;}class A{static x=f();static y=2;}console.log(A.x);', /before.*declaration/i],
  ["explicit undefined runs constructor default", 'class A{static x=new A(undefined);static y=2;constructor(n=A.y){console.log(n);}}', /static.*before/i],
  ["inherited default runs through implicit constructor", 'class A{constructor(n=B.y){console.log(n);}}class B extends A{static x=new B();static y=2;}', /before.*declaration/i],
  ["instance method default reads later static field", 'class A{static x=new A().m();static y=2;m(n=A.y){return n;}}console.log(A.x);', /static.*before/i],
  ["custom callback cannot hide an unsafe static read", 'function invoke(cb:()=>number){return cb();}class A{static x=invoke(()=>A.y);static y=2;}console.log(A.x);', /static.*before/i],
  ["indirect new before class declaration", 'function make(){return new A();}console.log(make().x);class A{x=1;static y=2;}', /before.*declaration/i],
  ["external function cannot use current internal binding", 'function f(){return A.y;}class A{static y=2;static x=f();}console.log(A.x);', /before.*declaration/i],
  ["external function cannot construct current class", 'function f(){return new A();}class A{x=1;static x=f();}console.log(A.x.x);', /before.*declaration/i],
  ["indirect instanceof before class declaration", 'function f(a:A){return a instanceof B;}class A{x=1;}console.log(f(new A()));class B extends A{}', /before.*declaration/i],
  ["initializer instanceof before class declaration", 'class A{static y=new A() instanceof B;}class B extends A{}console.log(A.y);', /before.*declaration/i],
  ["method bare return still rejects undefined", 'class A{m(flag:boolean){if(flag)return;return 1;}}class B extends A{}console.log(new B().m(false));', /return.*every path/i],
  ["super capture cannot survive wait", 'class A{x=1;m(){return this.x;}}class B extends A{m(){return(()=>{wait(1);return super.m();})();}}console.log(new B().m());', /capturing this/i],
  ["capture includes yielding virtual override", 'class A{x=1;read(){return 1;}m(){console.log((()=>this.read())());}}class B extends A{read(){wait(1);return 2;}}new B().m();', /capturing this/i],
  ["capture includes yielding getter", 'class A{x=1;get p(){wait(1);return this.x;}m(){return(()=>this.p)();}}class B extends A{}console.log(new B().m());', /capturing this/i],
  ["capture includes yielding setter", 'class A{x=1;set p(v:number){wait(1);this.x=v;}m(){(()=>{this.p=2;})();}}class B extends A{}new B().m();', /capturing this/i],
  ["capture includes yielding method default", 'function delay(){wait(1);return 0;}class A{x=1;read(n=delay()){return this.x;}m(){return(()=>this.read())();}}class B extends A{}console.log(new B().m());', /capturing this/i],
  ["capture includes yielding arrow default", 'function delay(){wait(1);return 0;}class A{x=1;m(){return((n=delay())=>this.x)();}}class B extends A{}console.log(new B().m());', /capturing this/i],
];
for (const [name, source, message] of negative) test("class safety rejects: " + name, () => {
  assert.throws(() => compile(source), e => {
    assert.ok(e instanceof CompileError); assert.match(e.message, message); assert.match(e.message, /alternative:/);
    assert.equal(path.resolve(e.location.file), entry); assert.equal(e.location.line, 1);
    assert.ok(e.location.column > 0 && e.location.column <= source.length); return true;
  });
});
