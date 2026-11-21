export const rejectedCases = [
  ["core-166 array copy", 'const a = [1, 2]; const b = [...a, 4]; console.log(b.join(","));', "Array spread"],
  ["empty array", 'console.log([...[]].length);', "Array spread"],
  ["multiple array operands", 'console.log([0, ...[1], ...[2], 3].length);', "Array spread"],
  ["string iteration", 'console.log([..."a😀"].length);', "Array spread"],
  ["Set iterator", 'const s = new Set([1, 2]); console.log([...s].length);', "Array spread"],
  ["nested array", 'console.log([[...[1, 2]]].length);', "Array spread"],
  ["object program array", 'const p = { x: 1 }; const a = [...[p]]; console.log(a[0].x);', "Array spread"],
  ["spread into destructuring source", 'const [head] = [...[1, 2]]; console.log(head);', "Array spread"],
  ["spread RHS assignment", 'let a = 0; [a] = [...[1]];', "Array destructuring assignment requires a dense array literal without spread"],
  ["unused function array", 'function unused() { return [...[1, 2]]; }', "Array spread"],
  ["dead branch array", 'if (false) { const a = [...[1]]; }', "Array spread"],
  ["object copy and overwrite", 'const a = { x: 1 }; const b = { ...a, x: 2 }; console.log(b.x);', "Object spread"],
  ["object shallow copy", 'const a = { child: { n: 1 } }; const b = { ...a }; b.child.n = 2;', "Object spread"],
  ["object primitive", 'const a = { ..."ab" };', "Object spread"],
  ["object null", 'const a = { ...null };', "Object spread"],
  ["object metadata", 'const options = { name: "test" }; stage({ ...options });', "Object spread"],
  ["object unused function", 'function unused() { return { ...{ x: 1 } }; }', "Object spread"],
  ["core-035 rest sum", 'function sum(...a: number[]) { let s = 0; for (const x of a) s += x; return s; } console.log(sum(1, 2, 3));', "Rest parameters"],
  ["default and rest", 'function f(a = 7, ...tail: number[]) { return a + tail.length; } console.log(f(undefined, 2, 3));', "Rest parameters"],
  ["rest arrow", 'const f = (...a: number[]) => a.length; console.log(f(1, 2));', "Rest parameters"],
  ["rest function expression", 'const f = function (...a: number[]) { return a.length; };', "Rest parameters"],
  ["rest class constructor", 'class C { constructor(...a: number[]) {} }', "Rest parameters"],
  ["rest class method", 'class C { f(...a: number[]) { return a.length; } }', "Rest parameters"],
  ["rest object method", 'const a = { f(...args: number[]) { return args.length; } };', "Rest parameters"],
  ["rest callback", 'onStart((...args) => {});', "Rest parameters"],
  ["rest mapper", 'console.log([1, 2].map((...args) => args.length));', "Rest parameters"],
  ["unused nested rest", 'function outer() { function unused(...a: number[]) { return a.length; } return 1; }', "Rest parameters"],
  ["custom function call", 'function f(a: number, b: number) { return a + b; } console.log(f(...[1, 2]));', "Spread arguments"],
  ["empty call defaults", 'function f(a = 7) { return a; } console.log(f(...[]));', "Spread arguments"],
  ["undefined call defaults", 'function f(a = 7, b = 8) { return a + b; } console.log(f(...[undefined, 2]));', "Spread arguments"],
  ["spread then positional default", 'function f(a = 7, b = 8) { return a + b; } console.log(f(...[], 2));', "Spread arguments"],
  ["call argument effects", 'let n = 0; function next(): number { n++; return n; } function f(a: number, b: number) { return a * 10 + b; } console.log(f(...[next()], next()));', "Spread arguments"],
  ["Math variadic call", 'console.log(Math.max(...[1, 2]));', "Spread arguments"],
  ["array push call", 'const a = [0]; a.push(...[1, 2]);', "Spread arguments"],
  ["string replace call", 'console.log("ab".replaceAll(...["a", "c"]));', "String.replaceAll supports 2 non-spread argument(s)"],
  ["console call", 'console.log(...[1, 2]);', "Spread arguments"],
  ["class constructor call", 'class C { constructor(public a = 7) {} } const c = new C(...[1]);', "Spread arguments"],
  ["class method call", 'class C { f(a = 7) { return a; } } console.log(new C().f(...[1]));', "Spread arguments"],
  ["IIFE call", 'console.log(((a = 7) => a)(...[]));', "Spread arguments"],
  ["unused default expression", 'function unused(a = Math.max(...[1, 2])) { return a; }', "Spread arguments"],
  ["runtime heritage call", 'class C extends factory(...[1]) {}', "Spread arguments"],
  ["default array spread", 'function unused(a = [...[1, 2]]) { return a.length; }', "Array spread"],
  ["default object spread", 'function unused(a = { ...{x: 1} }) { return a.x; }', "Object spread"],
  ["array assignment rest", 'let tail = [0]; [...tail] = [1, 2];', "Array destructuring assignment supports only variable targets and elisions"],
  ["object binding rest", 'const { x, ...rest } = { x: 1, y: 2 };', "Object destructuring rest"],
];

export function expectedLocation(source, file) {
  // Preserve main's established call-level String overload and RHS-literal
  // destructuring locations. Other spread/rest errors point at the ellipsis.
  const offset = source.includes('"ab".replaceAll(...') ? source.indexOf('"ab".replaceAll(')
    : source.includes('[a] = [...') ? source.indexOf('[...', source.indexOf('[a] ='))
    : source.indexOf("...");
  const lines = source.slice(0, offset).split(String.fromCharCode(10));
  return { file: file.replaceAll(String.fromCharCode(92), "/"), line: lines.length, column: lines.at(-1).length + 1 };
}

export const supportedCases = [
  ["array binding rest", `const a = [1, 2, 3]; const [head, ...tail] = a;
    tail.push(4); console.log(head); console.log(tail.join(",")); console.log(a.join(","));`],
  ["rest keeps shallow identity", `const a = [{ n: 1 }, { n: 2 }]; const [, ...tail] = a;
    tail[0].n = 9; tail.push({n: 3}); console.log(a[1].n); console.log(a.length); console.log(tail.length);`],
  ["explicit copy and calls", `function f(a = 7, b = 8) { return a * 10 + b; }
    const a = [1, 2]; const b = a.slice().concat([4]); b.push(5);
    console.log(b.join(",")); console.log(a.join(","));
    console.log(f()); console.log(f(undefined, 2)); console.log(f(0, 0));`],
  ["default side effects follow explicit arguments", `let n = 0;
    function next(): number { n++; return n; }
    function f(a = next(), b = 0) { return a * 10 + b; }
    console.log(f(undefined, next())); console.log(n);`],
  ["default with array binding rest", `function f(a = 7) { return a; }
    onStart(() => { const [head, ...tail] = [1, 2, 3];
      console.log(f() + head + tail.length); console.log(f(0) + tail.length); });`],
  ["erased rest types and ordinary dots", `type F = (...args: number[]) => number;
    interface Call { (...args: number[]): number; }
    type Tuple = [number, ...number[]];
    // ... is not runtime syntax here.
    const text = "..."; const f: F = (a: number) => a + 1;
    console.log(text); console.log(f(2));`],
];
