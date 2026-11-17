function narrowed(a: string | null, b: string | undefined): string {
  if (a !== null && b !== undefined) return "aaba".replace(a, b);
  return "skipped";
}
console.log(narrowed("a", "X"));
console.log(narrowed(null, undefined));
function fallback(a: string | null, b: string | undefined): string {
  return "aaba".replaceAll(a ?? "a", b ?? "X");
}
console.log(fallback(null, undefined));
console.log(fallback("b", "Y"));
function converted(a: string | null, b: string | undefined): string {
  return "nullundefined".replace(String(a), String(b));
}
console.log(converted(null, undefined));
class Replacement {
  value: string | null = "X";
  run(): string {
    if (this.value !== null) return "aaba".replaceAll("a", this.value);
    return "skipped";
  }
}
console.log(new Replacement().run());
let values: (string | undefined)[] = ["a"];
if (values[0] !== undefined) console.log("abc".replace(values[0], "X"));
let absent: string | null = null;
let calls = 0;
function replacement(): string { calls++; return "X"; }
console.log(absent?.replace("a", replacement()) ?? "NULL");
console.log(absent?.replaceAll("a", replacement()) ?? "NULL");
console.log(calls);
