let cur: string | undefined;
function tick(): void { cur = "x"; }
function use(): string { const c = cur; if (c === undefined) return ""; return c; }
tick();
const v = cur ?? "d";
const arr = [v];
arr.push(cur ?? "e");
function id(s: string): string { return s; }
console.log(id(v), use(), arr.join(","));
