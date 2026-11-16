import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync } from "node:fs";
import { compileFile, CompileError } from "../ts/compile-ts.mjs";
import { assertJsLogs } from "./ts-runtime.mjs";

const entry = path.resolve("virtual/tsmap/main.ts");
const compile = source => compileFile(entry, { readFile: name => name === entry ? source : undefined });
const cases = [
  ["integrated fixture", readFileSync(new URL("./fixtures/tsmap.ts", import.meta.url), "utf8")],
  ["empty constructors infer direct writes and contextual types", `const m = new Map(); m.set("x",1); const s = new Set(); s.add(2); const typed:Map<string,number> = new Map(); console.log(m.get("x") ?? 0,s.has(2),typed.size);`],
  ["receiver, keys, values and constructor entries evaluate once in order", `let calls = 0; function key():string { calls++; return "x"; } function value():number { calls = calls * 10; return calls; } const m = new Map<string,number>([[key(),value()],[key(),value()]]); function receiver():Map<string,number> { calls++; return m; } console.log(calls,receiver().set(key(),value()) === m,calls); console.log(receiver().get(key()) ?? value(),calls);`],
  ["SameValueZero NaN, signed zero and string distinction", `const m = new Map<string|number,number>(); m.set(Number("NaN"),1).set(Number("NaN"),2).set("NaN",3).set(-0,4).set(0,5).set("0",6); console.log(m.size,m.get(Number("NaN")),m.get("NaN"),m.get(0),m.get("0")); const s = new Set<number>([Number("NaN"),Number("NaN"),-0,0]); console.log(s.size,s.has(Number("NaN")));`],
  ["map API, chaining, undefined and insertion order", `const m = new Map<string, number>([["b", 2], ["a", 1], ["b", 3]]); const alias = m; console.log(m.set("c", 4).set("a", 5) === m, alias.size); console.log(m.get("b"), m.get("missing"), m.get("missing") ?? 8, m.has("b")); console.log(m.delete("a"), m.delete("a")); m.set("a", 6); for (const [k,v] of m) console.log(k,v); m.clear(); console.log(alias.size, m.has("b"));`],
  ["set API and array initializer", `const xs = [3,1,3,2]; const s = new Set(xs); const t = s; console.log(s.size, s.add(4).add(1) === s, t.has(4), s.delete(1), s.delete(9)); s.add(1); for (const v of s) console.log(v); s.clear(); console.log(t.size);`],
  ["mixed literal keys keep their runtime types", `const m = new Map<1 | "1" | "x", number>(); m.set(1,10).set("1",20).set("x",30); console.log(m.size,m.get(1),m.get("1")); for (const [k,v] of m.entries()) console.log(k,v);`],
  ["Set supports mixed string and number literal unions", `const s = new Set<1|"1"|"x">([1,"1",1,"x"]); console.log(s.size,s.has(1),s.has("1")); s.delete(1); s.add(1); for(const x of s) console.log(x);`],
  ["iterator views and continue/break", `const m = new Map<string, number>([["a",1],["b",2],["c",3]]); for (const k of m.keys()) { if (k === "b") continue; console.log(k); } for (const v of m.values()) { console.log(v); break; } const s = new Set([1,2]); for (const [k,v] of s.entries()) console.log(k,v); for (const v of s.values()) console.log(v);`],
  ["live iteration modifications", `const m = new Map<number,number>([[1,10],[2,20],[3,30]]); for (const [k,v] of m) { console.log(k,v); if (k === 1) { m.delete(2); m.set(3,31); m.set(4,40); } if (k === 3) { m.clear(); m.set(5,50); } } console.log(m.size);`],
  ["forEach parameter order, returns and mutations", `const m = new Map<string,number>([["a",1],["b",2]]); let total = 0; m.forEach((v,k,owner) => { if (v === 1) { owner.set("c",3); return; } total += v; console.log(k,v,owner === m); }); console.log(total); const s = new Set([2,4]); s.forEach((v,k,owner) => console.log(v,k,owner === s));`],
  ["forEach mutates function locals and isolates nested return", `function sum(m:Map<string,number>):number { let total = 0; m.forEach((v,k) => { if(k === "skip") return; total += v; }); return total; } console.log(sum(new Map<string,number>([["a",1],["skip",9],["b",2]])));`],
  ["word frequency", `const counts = new Map<string,number>(); for (const word of "cat dog cat bird dog cat".split(" ")) counts.set(word, (counts.get(word) ?? 0) + 1); for (const [word,count] of counts) console.log(word,count);`],
  ["deduplication", `const seen = new Set<string>(); let result = ""; for (const word of ["a","b","a","c","b"]) { if (!seen.has(word)) { seen.add(word); result += word; } } console.log(result,seen.size);`],
  ["object values preserve identity", `interface Box { n:number } const box:Box = {n:2}; const m = new Map<string,Box>([["a",box]]); const got = m.get("a"); if (got !== undefined) got.n += 3; const fallback:Box = {n:0}; console.log((m.get("a") ?? fallback).n,box.n,(m.get("z") ?? fallback).n);`],
  ["collection parameters, return values and fields", `function make():Map<string,number> { return new Map<string,number>(); } function fill(m:Map<string,number>):Map<string,number> { return m.set("x",9); } class Holder { m = make(); set = new Set<number>(); } const h = new Holder(); const o = {m:h.m}; console.log(fill(o.m) === h.m, h.m.get("x") ?? 0); h.set.add(3); console.log(h.set.has(3));`],
  ["graph adjacency map", `const graph = new Map<string,Set<string>>(); const a = new Set<string>(["b","c"]); graph.set("a",a); graph.set("b",new Set<string>(["c"])); for (const [from,edges] of graph) for (const to of edges) console.log(from,to); const edges = graph.get("a"); if (edges !== undefined) edges.add("d"); console.log(a.size);`],
  ["has followed by asserted get", `const m = new Map<string,number>([["a",3]]); if (m.has("a")) console.log(m.get("a")! + 1);`],
  ["booleans and strings keep falsy values and sentinel-like text", `const b = new Map<number,boolean>([[1,false]]); const s = new Map<number,string>([[1,""],[2,"undefined"],[3,"-2"]]); console.log(b.get(1) ?? true,b.get(2) ?? true,s.get(1) ?? "missing",s.get(2),s.get(3),s.get(4) ?? "missing");`],
];
for (const [name, source] of cases) {
  test(`tsmap matches Node: ${name}`, () => assertJsLogs(source));
  test(`tsmap share player blocks: ${name}`, () => {
    const report = compile(source);
    const manifest = JSON.parse(readFileSync("docs/compatibility/kn-share-player-blocks.json", "utf8"));
    const walk = value => {
      if (!value || typeof value !== "object") return;
      if (value.blocks) for (const block of Object.values(value.blocks)) assert.ok(manifest.blocks.includes(block.type) || block.type === "procedures_2_stable_parameter", block.type);
      for (const child of Object.values(value)) walk(child);
    };
    walk(report);
  });
}

for (const [source, message] of [
  [`const m = new Map<object,number>();`, /string or number/],
  [`const m = new Map<string,number[]>();`, /array values/],
  [`const m = new WeakMap();`, /WeakMap/],
  [`const m = new Map<string,number>(); const it = m.keys();`, /only directly in for-of/],
  [`const s = new Set([1,2]); const xs = [...s];`, /spread|iterator/i],
  [`const m = new Map<string,number>(); const xs = Array.from(m.keys());`, /for-of/],
  [`const m = new Map<string,number>(); m.set(1,2);`, /incompatible/],
  [`const m = new Map<string,number>(); m.set("a",{});`, /incompatible/],
  [`const s = new Set<boolean>();`, /string or number/],
  [`const m = new Map<string,number>(); m.size = 4;`, /read-only/],
  [`const m = new Map<string,number>(); m["set"]("a",1);`, /indexed/],
  [`const m = new Map<string,number>(); const fn = m.get;`, /detached/],
  [`const m = new Map<string,number>(); console.log(m.get("x")!);`, /guard/],
  [`const m = new Map<string,number>(); if(m.has("x")) { m.delete("x"); console.log(m.get("x")!); }`, /invalidate/],
  [`const m = new Map<string,number>(); const x = m as any;`, /assertions/],
  [`const m = new Map<string,number|null>();`, /Nullable/],
  [`const m = new Map<string,number>(); const k = "x"; if(m.has(k)) { const k = "y"; console.log(m.get(k)!); }`, /guard/],
  [`const m = new Map<string,number>(); if(m.has("x")) { const f = () => m.get("x")!; f(); }`, /guard/],
  [`new Set<number>([true]);`, /requires an array/],
  [`class Map {} const m = new Map();`, /Shadowing/],
]) test(`tsmap rejects: ${source}`, () => assert.throws(() => compile(source), error => {
  assert.ok(error instanceof CompileError);
  assert.match(error.message, message);
  assert.ok(error.location?.line > 0);
  assert.match(error.message, /use|instead/i);
  return true;
}));

test("tsmap diagnostics preserve lines after multiline constructors", () => {
  const source = `const m = new Map<string,number>([\n ["a",1],\n ["b",2]\n]);\nunknownCall();`;
  assert.throws(() => compile(source), error => {
    assert.match(error.message, /unknownCall/);
    assert.equal(error.location.line, 5);
    return true;
  });
});
