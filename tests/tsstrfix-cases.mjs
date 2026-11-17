import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";
import { compileFile } from "../ts/compile-ts.mjs";

export const source = `
let calls = 0;
function index(): number { calls++; return 1; }
let s = "abc";
console.log(s.charAt(index())); console.log(calls);
calls = 0;
function text(): string { calls++; return "abcd"; }
console.log(text().substring(1)); console.log(calls);
console.log(text().substring(3, 1)); console.log(text().substring(2, 2));
calls = 0;
function pos(): number { calls++; return 1; }
const a: string = "ababa";
console.log(a.startsWith("b", pos()));
console.log(a.endsWith("b", pos() + 1));
console.log(a.includes("a", pos() + 4));
console.log(a.lastIndexOf("a", pos()));
console.log(a.split("b", pos()).join("|")); console.log(calls);
function short(): string { return "x"; }
console.log(short().padStart(4, "ab")); console.log(short().padEnd(4, "ab"));
console.log(short().padStart(3.9, "0")); console.log(short().repeat(2.5));
// Force runtime normalization, including different defaults and non-finites.
function probe(value: string, n: number) {
  console.log(value.charAt(n));
  console.log(value.substring(n)); console.log(value.substring(2, n));
  console.log(value.startsWith("b", n)); console.log(value.endsWith("b", n));
  console.log(value.includes("b", n)); console.log(value.indexOf("b", n));
  console.log(value.lastIndexOf("b", n));
  console.log(value.startsWith("", n)); console.log(value.endsWith("", n));
  console.log(value.includes("", n)); console.log(value.indexOf("", n));
  console.log(value.lastIndexOf("", n));
  console.log(value.split("b", n).join("|"));
  console.log(value.split("", n).join("|"));
}
let positions = [-5, -0.5, 0, 1.9, 2, 5, 1000000000000, NaN, Infinity, -Infinity, 4294967297, -4294967295];
for (const n of positions) { probe("ababa", n); probe("", n); }
let original = "abc";
let order = "";
function receiver(): string { order += "r"; return original; }
function start(): number { order += "s"; original = "changed"; return 0; }
function end(): number { order += "e"; return 2; }
console.log(receiver().substring(start(), end())); console.log(order); console.log(original);
original = "abc"; console.log(original.charAt(start())); console.log(original);
console.log(text().substring(index()).substring(index()));
console.log(text().charAt(text().substring(1).length - 1));
order = ""; original = "ababa";
function needle(): string { order += "t"; original = "zzz"; return "b"; }
function offset(): number { order += "p"; return 1; }
console.log(receiver().startsWith(needle(), offset())); console.log(order);
order = ""; original = "ababa";
console.log(receiver().split(needle(), offset()).join("|")); console.log(order);
function recursive(n: number): string {
  if (n === 0) return "abcd";
  return recursive(n - 1).substring(1).substring(0, 2);
}
console.log(recursive(3));
let base = "a,b,c";
let first = base.split(",", 2); let alias = first;
let second = base.split(",", 2); first.push("d");
console.log(alias.join("|")); console.log(second.join("|")); console.log(base);
console.log(base.split().join("|")); console.log(base.lastIndexOf("a"));
console.log(base.substring()); console.log(base.charAt());
// Preserve the existing slice pass, especially negative and empty bounds.
let sliced = "abcd";
console.log(sliced.slice(-3, -1)); console.log(sliced.slice(2, 2)); console.log(sliced.slice(3, 1));
${[0, 1, 3, 4, 5.9, -2].map(n => `console.log(short().padStart(${n}, "ab")); console.log(short().padEnd(${n}, "ab"));`).join("\n")}
console.log(short().padStart(4)); console.log(short().padEnd(4, ""));
console.log(short().repeat(0)); console.log(short().repeat(-0.5));
console.log("中文".padStart(5, "你好")); console.log("😀".padEnd(6, "🙂"));
console.log("😀".repeat(2.5)); console.log("😀".substring(0, 2));
order = "";
function padReceiver(): string { order += "r"; return "x"; }
function padLength(): number { order += "n"; return 4; }
function padFill(): string { order += "f"; return "ab"; }
console.log(padReceiver().padStart(padLength(), padFill())); console.log(order);
order = ""; console.log(padReceiver().repeat(padLength())); console.log(order);
order = "";
function noPadding(): number { order += "n"; return 0; }
console.log(padReceiver().padEnd(noPadding(), padFill())); console.log(order);
order = ""; console.log(padReceiver().repeat(noPadding())); console.log(order);
function emojiFill(): string { return "😀"; }
console.log(padReceiver().padStart(3, emojiFill()));
console.log(short().padEnd(6, "中文"));
// Native search/split never materialize an isolated code unit while scanning.
let unicode = "😀,abc,🙂";
console.log(unicode.includes("a")); console.log(unicode.includes("😀"));
console.log(unicode.startsWith("a"));
console.log(unicode.split(",").join("|"));
console.log(unicode.split(",", 1).join("|"));
console.log(unicode.split(",", 2).join("|"));
console.log(unicode.split("🙂", 10).join("|"));
function unicodeSearch(value: string) {
  console.log(value.includes("a"));
  console.log(value.startsWith("😀")); console.log(value.split(",", 2).join("|"));
}
unicodeSearch(unicode);
unicode = "🙂,xyz"; unicodeSearch(unicode);
// A loop write invalidates BMP proof, but not the native whole-character paths.
let loopText = "abc";
for (loopText of ["😀,abc", "🙂,xyz"]) {
  console.log(loopText.includes("a")); console.log(loopText.startsWith("😀"));
  console.log(loopText.split(",", 1).join("|"));
}
function loopParameter(value: string) {
  for (value of ["😀,abc"]) console.log(value.includes("a"));
}
loopParameter("abc");
function loopReturn(): string {
  let value = "abc";
  for (value of ["😀,abc"]) {}
  return value;
}
console.log(loopReturn().includes("a")); console.log(loopReturn().split(",").join("|"));
let bmpWrites = "abc"; bmpWrites = "中文"; bmpWrites += "字";
console.log(bmpWrites.charAt(0)); console.log(bmpWrites.includes("字", 1));
// Declaration-style var reinitialization must keep native Unicode paths safe;
// a fresh lexical for binding retains its first-initializer BMP proof.
var redeclaredText = "abc";
for (var redeclaredText = "😀,abc"; redeclaredText.length > 0;) {
  console.log(redeclaredText.includes("a")); console.log(redeclaredText.startsWith("😀"));
  console.log(redeclaredText.split(",", 1).join("|")); break;
}
for (let freshText = "中文"; freshText.length > 0;) {
  console.log(freshText.charAt(0)); break;
}
// Hot procedure paths, without wall-clock assertions.
for (let hot = 0; hot < 700; hot++) console.log(s.substring(0, 1));
`;

export function prepare() {
  const expected = [];
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText,
    { console: { log: (...args) => expected.push(args.map(String).join(" ")) } });
  const filename = path.resolve("tests/tsstrfix-generated.ts");
  const report = compileFile(filename, { readFile: name => path.resolve(name) === filename ? source : undefined });
  return { expected, report };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fs.writeFileSync(process.argv[2], JSON.stringify(prepare()));
}
