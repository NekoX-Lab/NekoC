import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import ts from "typescript";
import { CompileError, compileFile } from "../ts/compile-ts.mjs";
import { assertJsLogs } from "./ts-runtime.mjs";

const entry = path.resolve("virtual/class-boundaries.ts");
const compile = source => compileFile(entry, { readFile: name => name === entry ? source : undefined });

for (const [name, source] of [
  ["existing Array construction coexists with class handles", 'class C { x=3; } const c=new C(); const xs=new Array(2).fill(7); console.log(xs[1]); console.log(c.x);'],
  ["bare method returns finish only their invocation", 'class C { x=1; m(stop:boolean) { if(stop)return; this.x=2; } } const c=new C(); c.m(true); console.log(c.x); c.m(false); console.log(c.x);'],
  ["array callbacks resolve the concrete receiver class", 'class C { x=2; m(){return this.x;} } const xs=[new C(),new C()]; const result=xs.map((c:C)=>c.m()); console.log(result[0]); console.log(result[1]);'],
]) {
  test("class boundaries match Node: " + name, () => assertJsLogs(source, { target: ts.ScriptTarget.ES2022 }));
}

for (const [name, source, message] of [
  ["direct class TDZ", 'const c=new C(); class C { x=1; } console.log(c.x);', /before.*declaration|temporal dead zone/i],
  ["constructor replacement return", 'class C { x=1; constructor(){return {x:2};} } new C();', /returning a value.*constructor/i],
  ["method default using this", 'class C { x=1; m(n=this.x){return n;} } console.log(new C().m());', /method defaults.*this/i],
  ["void method result cannot expose a synthetic zero", 'class C { x=1; m(){this.x=2;} } console.log(new C().m());', /void.*method.*result|undefined.*method/i],
  ["partial method returns cannot expose undefined", 'class C { x=1; m(flag:boolean){if(flag)return this.x;} } console.log(new C().m(false));', /return.*every path|undefined.*method/i],
  ["mixed bare and value method returns", 'class C { x=1; m(flag:boolean){if(flag)return;return this.x;} } console.log(new C().m(true));', /return.*every path|undefined.*method/i],
  ["explicit arguments skip field initialization in constructor defaults", 'class C { x: number; constructor(n = (this.x = 2)) {} } console.log(new C(1).x);', /initializ|undefined.*field/i],
  ["later field declarations reset earlier initializer writes", 'class C { first = (this.later = 2); later: number; } console.log(new C().later);', /initializ|undefined.*field/i],
  ["IIFE retains this across a yield", 'class C { x=1; m(){(()=>{wait(1);console.log(this.x);})();} } new C().m();', /captur.*this|this.*yield/i],
  ["IIFE retains this across an indirect yield", 'function pause(){wait(1);} class C { x=1; m(){(()=>{pause();console.log(this.x);})();} } new C().m();', /captur.*this|this.*yield/i],
]) {
  test("class boundaries reject at original source: " + name, () => {
    assert.throws(() => compile(source), error => {
      assert.ok(error instanceof CompileError);
      assert.match(error.message, message);
      assert.match(error.message, /alternative:|use|instead/i);
      assert.equal(path.resolve(error.location.file), entry);
      assert.equal(error.location.line, 1);
      assert.ok(error.location.column >= 1 && error.location.column <= source.length);
      return true;
    });
  });
}
