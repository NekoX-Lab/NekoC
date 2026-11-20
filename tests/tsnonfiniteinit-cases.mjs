import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { compileFile } from "../ts/compile-ts.mjs";

export const source = `
let nan = 0/0; let inf = 1/0; let neg = -1/0;
console.log(nan, inf, neg);
let zero = 0;
console.log(zero/zero, 1/zero, -1/zero);
let best = 1/0;
if (3 < best) best = 3;
console.log(best);
let copy = nan; copy = inf;
console.log(copy + 1);
copy = neg;
console.log(copy * 2);
copy = nan;
if (copy !== copy) console.log("invalid"); else console.log("wrong");
if (inf > 3 && neg < -3) console.log("bounds"); else console.log("wrong");
let items = [nan, inf, neg];
console.log(items[0], items[1] + 1, items[2] * 2);
function pass(value: number): number {
  if (value !== value) return value;
  return value + 1;
}
console.log(pass(nan), pass(inf), pass(neg));
let text = "Infinity";
console.log(inf + 1, text + 1);
let finite = 7/2; let truth = true; let falsity = false;
console.log(finite, truth, falsity, text);
let overflow = 1e308 * 2; let underflow = -1e308 * 2;
let remainder = 1 % 0; let invalid = (1/0) - (1/0);
console.log(overflow, underflow, remainder, invalid);
let literal = 1e999; let negativeLiteral = -1e999;
console.log(literal, negativeLiteral);
// Exercise hot variable reads/arithmetic as well as one-shot initialization.
for (let i = 0; i < 600; i++) copy = inf + i;
console.log(copy);
`;

export const importedSource = `
import { nonfinite } from "./values";
let nan = 0/0; let inf = 1/0; let neg = -1/0;
let fromFunction = nonfinite(0);
console.log(nan, inf, neg, fromFunction);
console.log(nonfinite(1), nonfinite(-1));
`;
export const moduleSource = `export function nonfinite(n: number): number {
  let value = 0/0;
  if (n > 0) return 1/0;
  if (n < 0) return -1/0;
  return value;
}`;

// Only runtime initializers: this used to have no startup script or barrier.
export const barrierSource = `
let nan = 0/0; let inf = 1/0; let neg = -1/0;
onStart(() => { console.log("first", nan, inf, neg); });
onStart(() => { console.log("second", nan, inf, neg); });
`;

// A waiting handler cannot prevent another handler from starting. Startup
// source order also matters: the handler must see inf AFTER the assignment.
export const concurrentSource = `
let nan = 0/0; let inf = 1/0; let neg = -1/0;
wait(0.02);
inf = 3;
let signaled = false;
onStart(() => { waitUntil(signaled); console.log("resumed", inf); });
onStart(() => { console.log("ready", nan, inf, neg); signaled = true; });
`;

export const equalitySource = `
let nan = 0/0; let inf = 1/0; let neg = -1/0; let zero = 0;
console.log(nan === nan, nan !== nan, nan == nan, nan != nan);
console.log(inf === inf, neg === neg, inf !== neg, zero === -zero);
let order = 0;
function take(n: number): number { order = order * 10 + n; return n; }
console.log(take(1) === take(2), order);
let value = 1;
function change(): number { value = 2; return 1; }
console.log(value === change(), value);
function recurse(n: number): number {
  if (n <= 0) return 0/0;
  let child = recurse(n - 1);
  if (child !== child) return child;
  return 1;
}
console.log(recurse(4) !== nan);
let hits = 0;
for (let i = 0; i < 100; i++) {
  if (nan !== nan) hits += 1;
  if (inf === inf) hits += 1;
}
console.log(hits);
`;

export function hostFor(body) {
  const files = new Map([
    [path.resolve("tsnonfiniteinit.ts"), body],
    [path.resolve("values.ts"), moduleSource],
  ]);
  return { readFile: file => files.get(path.resolve(file)) };
}

export const reviewEqualitySource = `
let nan: number = 0/0; let zero = 0;
let out = "";
switch (nan) { case nan: out = "wrong"; break; default: out = "ok"; }
console.log(out);
switch (zero/zero) { case zero/zero: out = "wrong"; break; default: out = "ok2"; }
console.log(out);
let order = "";
function select(): number { order += "d"; return 2; }
function candidate(n: number): number { order += String(n); return n === 0 ? 0/0 : n; }
switch (select()) {
  case candidate(0): out = "wrong"; break;
  case candidate(1): out = "wrong"; break;
  case candidate(2): out = "matched"; break;
  case candidate(3): out = "wrong"; break;
  default: out = "wrong";
}
console.log(out, order);
function same<T>(a: T, b: T): boolean { return a === b; }
function different<T>(a: T, b: T): boolean { return a !== b; }
let mixed: number | string = nan; let dynamic: any = nan;
console.log(same(nan, nan), different(nan, nan), mixed === mixed, dynamic !== dynamic);
console.log(same("NaN", "NaN"), same(true, true), same(1, 2), same(1/0, 1/0));
console.log(same(-zero, zero), same("cat", "dog"));
let typedAny: any = "NaN"; console.log(typedAny === typedAny);
function nullableEq(a: number | null | undefined, b: number | null | undefined): boolean { return a == b; }
function nullableNe(a: number | null | undefined, b: number | null | undefined): boolean { return a != b; }
function nullableStrict(a: number | null | undefined, b: number | null | undefined): boolean { return a === b; }
function nullableStrictNe(a: number | null | undefined, b: number | null | undefined): boolean { return a !== b; }
console.log(nullableEq(nan, nan), nullableNe(nan, nan), nullableStrict(nan, nan), nullableStrictNe(nan, nan));
console.log(nullableEq(null, undefined), nullableNe(null, undefined), nullableStrict(null, undefined), nullableStrictNe(null, undefined));
console.log(nullableEq(1/0, 1/0), nullableEq(-zero, zero), nullableEq(1, 2));
order = "";
function nullableTake(n: number): number | null { order += String(n); return n === 1 ? nan : null; }
console.log(nullableEq(nullableTake(1), nullableTake(2)), order);
order = "";
console.log(same(candidate(1), candidate(2)), order);
let other: any = "0"; let numeric: any = zero; let flag: any = false;
console.log(other === numeric, numeric === flag, flag === flag, other !== numeric);
let object = { value: 1 }; let alias = object; let distinct = { value: 1 };
console.log(object === alias, object === distinct, object !== alias, object !== distinct);
function sameObject(a: { value: number }, b: { value: number }): boolean { return a === b; }
console.log(sameObject(object, alias), sameObject(object, distinct));
function numericSame<T extends number>(a: T, b: T): boolean { return a === b; }
console.log(numericSame(nan, nan), numericSame(1/0, 1/0));
order = "";
let changing: any = 1;
function mutate(): any { order += "r"; changing = 2; return 1; }
console.log(changing === mutate(), changing, order);
let hits = 0;
for (let i = 0; i < 100; i++) {
  if (!same(nan, nan) && different(nan, nan)) hits += 1;
  if (!nullableEq(nan, nan) && nullableNe(nan, nan)) hits += 1;
  switch (dynamic) { case nan: hits -= 100; break; default: hits += 1; }
}
console.log(hits);
switch (typedAny) { case "NaN": out = "text"; break; default: out = "wrong"; }
console.log(out);
`;

export function expectedFor(body) {
  const expected = [];
  const starts = [];
  const text = body.replace('import { nonfinite } from "./values";', moduleSource.replace("export ", ""));
  vm.runInNewContext(ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText, {
    console: { log: (...args) => expected.push(args.map(String).join(" ")) },
    onStart: callback => starts.push(callback),
  });
  starts.forEach(callback => callback());
  return expected;
}

export function prepare() {
  return [source, importedSource, barrierSource, equalitySource, reviewEqualitySource].map(body => ({
    report: compileFile("tsnonfiniteinit.ts", hostFor(body)), expected: expectedFor(body),
  })).concat({
    report: compileFile("tsnonfiniteinit.ts", hostFor(concurrentSource)),
    expected: ["ready NaN 3 -Infinity", "resumed 3"],
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fs.writeFileSync(process.argv[2], JSON.stringify(prepare()));
}
