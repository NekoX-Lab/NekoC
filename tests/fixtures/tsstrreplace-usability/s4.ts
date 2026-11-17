let n: number | null = 3;
function f(): void { n = 4; }
f();
console.log("a-b".replaceAll("-", String(n)));
