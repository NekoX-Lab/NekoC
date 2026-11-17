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

export function hostFor(body) {
  const files = new Map([
    [path.resolve("tsnonfiniteinit.ts"), body],
    [path.resolve("values.ts"), moduleSource],
  ]);
  return { readFile: file => files.get(path.resolve(file)) };
}

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
  return [source, importedSource, barrierSource].map(body => ({
    report: compileFile("tsnonfiniteinit.ts", hostFor(body)), expected: expectedFor(body),
  })).concat({
    report: compileFile("tsnonfiniteinit.ts", hostFor(concurrentSource)),
    expected: ["ready NaN 3 -Infinity", "resumed 3"],
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fs.writeFileSync(process.argv[2], JSON.stringify(prepare()));
}
