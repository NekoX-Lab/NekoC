// The first two cases reproduce the advisor probes without depending on local files.
export const asyncCases = [
  ["Promise return", "async function f(): Promise<number> { return 7; }\nconsole.log(f());"],
  ["await in async function", "async function f(): Promise<number> { const x = await 7; return x; }\nconsole.log(f());"],
  ["exported function", "export async function f() { return 7; }"],
  ["function expression", "const f = async function () { return 7; }; console.log(f());"],
  ["named function expression", "const f = async function inner() { return 7; };"],
  ["expression arrow", "const f = async () => 7; console.log(f());"],
  ["block arrow", "const f = async () => { return 7; };"],
  ["unused nested function", "function outer() {\n  async function unused() { return 7; }\n  return 1;\n}"],
  ["dead branch", "if (false) { const unused = async () => 7; }"],
  ["event arrow", "onStart(async () => { console.log(7); });"],
  ["event function", "onMessage('go', async function () { console.log(7); });"],
  ["sprite body", "sprite('cat', {}, async self => { self.onStart(() => {}); });"],
  ["sprite event", "sprite('cat', {}, self => { self.onStart(async () => {}); });"],
  ["timeout arrow", "setTimeout(async () => { console.log(7); }, 10);"],
  ["interval function", "setInterval(async function () { console.log(7); }, 10);"],
  ["array map", "console.log([1].map(async x => x + 1));"],
  ["array forEach", "[1].forEach(async function (x) { console.log(x); });"],
  ["array reduce", "console.log([1].reduce(async (a, x) => a + x, 0));"],
  ["class method", "class C { async f() { return 7; } }"],
  ["object method", "const o = { async f() { return 7; } };"],
  ["top-level await", "const x = await 7; console.log(x);"],
  ["await in sync function", "function f() { const x = await 7; return x; } console.log(f());"],
  ["await in callback", "onStart(() => {\n  const x = await 7;\n  console.log(x);\n});"],
  ["unused await", "function unused() { return await 7; }"],
  ["await in template expression", "console.log(`value: ${await 7}`);"],
  ["for await", "for await (const x of [1]) { console.log(x); }"],
];

export function expectedLocation(source, file) {
  const offset = source.search(/\basync\b|\bawait\b/);
  const lines = source.slice(0, offset).split("\n");
  return { file: file.replaceAll("\\", "/"), line: lines.length, column: lines.at(-1).length + 1 };
}

export const syncSource = `// async / await in comments are not syntax.
const text = "async await";
const template = \`async await\`;
function async(awaited: number) { return awaited + 1; }
class Named { async() { return 9; } }
const o = { async: 7, await: 8 };
console.log(text, template, async(o.async), o.await, new Named().async());
onStart(() => { wait(0.01); console.log(7); });
setTimeout(function () { console.log(8); }, 10);
const timer = setInterval(() => { console.log(9); }, 20);
clearInterval(timer);
console.log([1, 2].map(x => x + 1).join(","));`;
