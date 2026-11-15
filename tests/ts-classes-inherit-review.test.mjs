import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import ts from "typescript";
import { CompileError, compileFile } from "../ts/compile-ts.mjs";
import { assertJsLogs } from "./ts-runtime.mjs";

const entry = path.resolve("virtual/class-inherit-review.ts");
const compile = source => compileFile(entry, { readFile: name => name === entry ? source : undefined });
const supported = [
  ["inherited field value stays available to its own initializer", 'class A{x=1;}class B extends A{x:number=this.x+1;}console.log(new B().x);'],
  ["readonly literal fields share the primitive storage type", 'class A{x=1;}class B extends A{readonly x=2;}console.log(new B().x+1);'],
  ["field IIFE returns finish only that invocation", 'class A{x=1;}class B extends A{y=(()=>{return this.x;})();}console.log(new B().y);'],
  ["field IIFE merges initialization from all return paths", 'class A{x=1;}class B extends A{y:number;z=(()=>{if(this.x>0){this.y=2;return 3;}this.y=4;return 5;})();}const b=new B();console.log(b.y);console.log(b.z);'],
  ["reduced override parameter list retains argument effects", 'let log="";class A{m(n:number,k:number){return n+k;}}class B extends A{m(){return 8;}}function arg(s:string){log+=s;return 3;}function f(a:A){return a.m(arg("a"),arg("b"));}console.log(f(new B()));console.log(log);'],
  ["parenthesized method receiver dispatches once", 'let n=0;class A{x=2;m(){return this.x;}}class B extends A{m(){return this.x+1;}}const a:A=new B();function get():A{n++;return a;}console.log((get().m)());console.log((get()["m"])());console.log(n);'],
  ["related union receivers use their common base dispatcher", 'class A{m(){return 1;}}class B extends A{m(){return 2;}}class C extends A{m(){return 3;}}function f(a:A|B){return a.m();}function g(a:B|C){return a.m();}console.log(f(new B()));console.log(g(new C()));'],
];
for (const [name, source] of supported) test("inheritance review JS: " + name, () => assertJsLogs(source, { target: ts.ScriptTarget.ES2022 }));

const unsupported = [
  ["sibling scalar field types cannot overwrite method arithmetic", 'class A{}class B extends A{x=2;m(){return this.x+1;}}class C extends A{x="a";}console.log(new B().m());', /fields.*same type/i],
  ["IIFE conditional write is not definite initialization", 'class A{x=1;}class B extends A{y:number;z=(()=>{if(this.x>0)return 3;this.y=4;return 5;})();}console.log(new B().y);', /initializ/i],
  ["parenthesized constructor call keeps virtual guard", 'class A{x=1;constructor(){console.log((this.m)());}m(){return 1;}}class B extends A{y=2;m(){return this.y;}}new B();', /virtual call.*construction/i],
  ["super abstract method has no direct implementation", 'abstract class A{abstract m():number;}abstract class B extends A{m(){return super.m();}}', /super.*abstract/i],
  ["getter-only override removes inherited setter", 'class A{x=1;get p(){return this.x;}set p(v:number){this.x=v;}}class B extends A{get p(){return this.x;}}function f(a:A){a.p=3;}f(new B());', /B.*p.*setter/i],
  ["setter-only override removes inherited getter", 'class A{x=1;get p(){return this.x;}set p(v:number){this.x=v;}}class B extends A{set p(v:number){this.x=v;}}function f(a:A){return a.p;}console.log(f(new B()));', /B.*p.*getter/i],
  ["string member names cannot collide with hidden class ids", 'class A{"__nekocClass_123_1_typeId"=4;}class B extends A{}console.log(new B());', /member names.*reserved/i],
];
for (const [name, source, message] of unsupported) test("inheritance review rejects: " + name, () => {
  assert.throws(() => compile(source), e => {
    assert.ok(e instanceof CompileError);
    assert.match(e.message, message);
    assert.match(e.message, /alternative:/);
    assert.equal(path.resolve(e.location.file), entry);
    assert.equal(e.location.line, 1);
    assert.ok(e.location.column > 0 && e.location.column <= source.length);
    return true;
  });
});
