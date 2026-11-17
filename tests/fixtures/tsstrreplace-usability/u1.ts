let name: string | null = null;
function setName(n: string): void { name = n; }
function show(s: string): void { console.log(s); }
setName("a");
if (name !== null) { show(name); }
const list: string[] = [];
if (name !== null) list.push(name);
function getName(): string { if (name === null) return "none"; return name; }
console.log(getName(), list.length);
