let s: string | null = "a";
function f(): void { s = "b"; }
if (s !== null) { const c = s; console.log(String(c)); }
