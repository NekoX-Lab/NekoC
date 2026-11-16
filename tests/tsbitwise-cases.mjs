import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";
import { compileFile } from "../ts/compile-ts.mjs";

export const values = ["0", "-0", "-1", "1", "2147483647", "2147483648", "-2147483648", "4294967301",
  "-4294967301", "1.9", "-1.9", "NaN", "Infinity", "-Infinity", "9007199254740991", "-9007199254740991",
  "1e100", "-1e100", "1.7976931348623157e308", "5e-324", "31", "32", "33", "-1.9"];
export const operators = ["&", "|", "^", "<<", ">>", ">>>"];
const probes = operators.map(op => `console.log(a ${op} b);`).join("\n");
const assignments = operators.map(op => `let x = a; x ${op}= b; console.log(x);`).map(s => `{ ${s} }`).join("\n");
export const source = `
function probe(a: number, b: number) {
  ${probes}
  ${assignments}
}
let values = [${values.join(",")}];
for (let i = 0; i < ${values.length}; i++) {
  let a = values[i];
  console.log(~a);
  console.log(a | 0, a >>> 0, a & 255, a & 0, a & 2147483647, a & -1, a ^ 0);
  console.log(a << 31, a >> 31, a >>> 31, a << 32, a >> 33, a >>> -1);
  for (let j = 0; j < ${values.length}; j++) probe(a, values[j]);
}
// Deterministic non-boundary doubles, not just small integers.
let state = 12345;
for (let k = 0; k < 80; k++) {
  state = (state * 1664525 + 1013904223) % 4294967296;
  probe((state - 2147483648) * 1000.25, k - 40);
}
// Work-level xorshift32, hot enough to enter the JIT in the enabled run.
let seed = 2463534242;
for (let step = 0; step < 256; step++) {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  console.log(seed >>> 0);
}
// Evaluation order, nested operations, compound target/RHS side effects.
let count = 0;
function next(): number { count++; return count; }
console.log(next() ^ next(), count);
console.log(~next(), next() << next(), count);
console.log((next() | next()) & (next() ^ next()), count);
let old = 42;
function mutate(): number { old = 100; return 3; }
old ^= mutate(); console.log(old);
let array = [17, 33];
function index(): number { count++; return 0; }
array[index()] <<= next(); console.log(array[0], count);
let object = {value: -17};
function target() { count++; return object; }
function rhs(): number { object.value = 100; return 3; }
target().value >>= rhs(); console.log(object.value, count);
object.value >>>= 0; console.log(object.value);
object.value &= 255; console.log(object.value);
// Nested call frames and lazy branches must not corrupt helpers' locals.
function recursive(n: number): number {
  if (n <= 0) return 0;
  return (n << n) ^ recursive(n - 1);
}
console.log(recursive(12), false ? next() & next() : 77, count);
// ToInt32/ToUint32 return positive zero, including truncated negative fractions.
let tiny = -0.5;
console.log(1 / (tiny >>> 0), 1 / (tiny | 0), 1 / (tiny & 255), 1 / (tiny << 0));
`;

export function prepare() {
  const expected = [];
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText,
    { console: { log: (...args) => expected.push(args.map(String).join(" ")) } });
  const filename = path.resolve("tests/tsbitwise-generated.ts");
  const report = compileFile(filename, { readFile: p => path.resolve(p) === filename ? source : undefined });
  return { expected, report };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fs.writeFileSync(process.argv[2], JSON.stringify(prepare()));
}
