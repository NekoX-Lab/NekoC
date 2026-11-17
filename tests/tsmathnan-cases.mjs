import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";
import { compileFile } from "../ts/compile-ts.mjs";

export const source = `
let z = 0; let n = z / z; let p = 1 / z; let v = 5;
// The advisor's six dynamic NaN logs, followed by its Infinity control.
console.log(n);
console.log(Math.max(n, v)); console.log(Math.max(v, n));
console.log(Math.min(n, v)); console.log(Math.min(v, n));
console.log(Math.trunc(n));
console.log(p); console.log(Math.trunc(p), Math.trunc(-p));
console.log(Number.isInteger(p));
let numericMax = Math.max(n, v);
let numericMin = Math.min(n, v);
let textualNan = "NaN";
function probe(x: number): number {
  console.log(Math.max(x), Math.min(x), Math.trunc(x), Number.isInteger(x));
  console.log(Math.max(x, -7, 5), Math.max(-7, x, 5), Math.max(-7, 5, x));
  console.log(Math.min(x, -7, 5), Math.min(-7, x, 5), Math.min(-7, 5, x));
  return Math.max(Math.min(x, 10), -10);
}
let values = [n, p, -p, 0, 7, -7, 1.5, -1.5, 1.7976931348623157e308, 5e-324];
for (let i = 0; i < values.length; i++) console.log(probe(values[i]));
function identity(x: number): number { return x; }
console.log(Math.max(identity(n), identity(5)), Math.min(identity(n), identity(5)));
console.log(Number.isInteger(identity(p)), Number.isInteger(identity(n)));
let trace = "";
function mark(tag: string, x: number): number { trace += tag; return x; }
console.log(Math.max(mark("a", n), mark("b", 5), mark("c", 9)), trace);
trace = "";
console.log(Math.min(mark("a", n), mark("b", 5), mark("c", 9)), trace);
trace = "";
console.log(Math.max(mark("a", 8), Math.min(mark("b", n), mark("c", 5)), mark("d", 9)), trace);
trace = "";
console.log(Number.isInteger(mark("i", p)), Number.isInteger(mark("n", n)), trace);
// A recursive call must not overwrite the caller's already saved first value.
function recursive(depth: number, x: number): number {
  if (depth <= 0) return x;
  return Math.max(mark("r", depth), recursive(depth - 1, x), mark("s", -depth));
}
trace = ""; console.log(recursive(4, n), trace);
trace = ""; console.log(recursive(4, -10), trace);
function nested(depth: number, x: number): number {
  if (depth <= 0) return x;
  return Math.min(depth, Math.max(-depth, nested(depth - 1, x)));
}
console.log(nested(4, n), nested(4, p), nested(4, -p));
function text(): string { trace += "t"; return "NaN"; }
function boolean(): boolean { trace += "b"; return true; }
let s = "Infinity"; let b = false;
trace = "";
console.log(Number.isInteger("NaN"), Number.isInteger(s), Number.isInteger(b));
console.log(Number.isInteger(text()), Number.isInteger(boolean()), trace);
// Keep the numeric type through function arguments, results, and loop bindings.
for (let j = 0; j < 80; j++) {
  console.log(Math.max(j, -j, identity(j + 1)), Math.min(j, -j), Number.isInteger(identity(j)));
}
let hot = 0;
for (let k = 0; k < 600; k++) hot += k;
console.log(hot);
`;

export function prepare() {
  const expected = [];
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText,
    { console: { log: (...args) => expected.push(args.map(String).join(" ")) } });
  const filename = path.resolve("tests/tsmathnan-generated.ts");
  const report = compileFile(filename, { readFile: p => path.resolve(p) === filename ? source : undefined });
  return { expected, report };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fs.writeFileSync(process.argv[2], JSON.stringify(prepare()));
}
