import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { compileFile } from "../ts/compile-ts.mjs";

// Preserve the advisor's exact 2/4/6/8-layer inputs (including byte lengths).
export function chainSource(depth, leaf = "x * 1.01 + 1", input = "getVar<number>('input')") {
  return "function f0(x: number): number { return " + leaf + "; }\n"
    + Array.from({ length: depth }, (_, i) => `function f${i + 1}(x: number): number { return f${i}(x) + f${i}(x + 1); }`).join("\n")
    + `\nonStart(() => { console.log(f${depth}(${input})); });`;
}

export const baseline = [
  { depth: 2, bytes: 239, blocks: 38, procedures: 1 },
  { depth: 4, bytes: 361, blocks: 166, procedures: 1 },
  { depth: 6, bytes: 483, blocks: 774, procedures: 1 },
  { depth: 8, bytes: 605, blocks: 3590, procedures: 1 },
];

export const repeated = (value, count = 140) => Array(count).fill(value).join(" + ");
export const semanticSource = `
let serial = 0;
function next(): number { serial++; console.log(serial); return serial; }
function wide(value: number, unused: number = 9): number { return ${repeated("value")}; }
function defaults(value: number = next(), unused: number = next()): number { return ${repeated("value")}; }
function statement(value: number, unused: number) { ${Array(80).fill("serial += value;").join(" ")} }
function recursive(n: number): number { let saved = n; if (n <= 0) return 0; return saved + recursive(n - 1); }
function outer(seed: number): number {
  function captured(value: number): number { return ${repeated("value + seed")}; }
  return captured(next());
}
onStart(() => {
  console.log(wide(next(), next()), serial);
  console.log(wide(next()), serial);
  console.log(defaults(), serial);
  console.log(defaults(undefined, undefined), serial);
  console.log(defaults(2), serial);
  statement(next(), next());
  console.log(serial);
  console.log(outer(3), serial);
  console.log(recursive(5));
  for (let i = 0; i < 600; i++) console.log(wide(i, next()), serial);
});
`;

export function prepare(source = semanticSource) {
  const expected = [];
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText, {
    onStart: callback => callback(),
    console: { log: (...args) => expected.push(args.map(String).join(" ")) },
  });
  return { expected, report: compileFile("tsinlinebudget.ts", { readFile: () => source }) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fs.writeFileSync(process.argv[2], JSON.stringify([
    prepare(),
    prepare(chainSource(12, "x * 2 + 1", "3")),
  ]));
}
