let s: string | null = "a";
function f(): void { s = "b"; }
if (s !== null) { const c = s; console.log(String(c)); }
let n: number | null = 3;
const k = n;
console.log(String(k));
f();
const t = s ?? "z";
console.log("hello".replace("l", t), "a-b-c".replaceAll("-", String(n)));
let score = 0;
for (let i = 0; i < 3; i++) { score += i; console.log("S:000".replace("000", String(score).padStart(3, "0"))); }
