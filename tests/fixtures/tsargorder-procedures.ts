let trace = "";
let serial = 0;
function next(): number { trace += "D"; serial++; return serial; }
function explicit(): number { trace += "E"; serial += 10; return serial; }
function recur(n: number, x = next(), unused = 0): number {
  const saved = x;
  if (n === 0) return saved;
  return saved * 100 + recur(n - 1, undefined, explicit());
}
function multi(x = next(), y = next(), unused = 0): number {
  if (x > 0) return x * 100 + y;
  return 0;
}
function noReturn(x = next(), unused = 0) {
  if (x > 0) console.log(x, trace);
}
// Explicit numeric annotations and a wide expression force the shared budget
// path independently of recursion or object lowering.
function wide(x: number = next(), unused: number = 0): number {
  return x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x
    +x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x
    +x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x
    +x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x
    +x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x
    +x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x
    +x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x;
}
onStart(() => {
  console.log(recur(2, undefined, explicit()), trace);
  trace = ""; serial = 0;
  console.log(multi(undefined, undefined, explicit()), trace);
  trace = ""; serial = 0;
  noReturn(undefined, explicit());
  trace = ""; serial = 0;
  console.log(multi(5, undefined, multi(undefined, undefined, explicit())), trace);
  trace = ""; serial = 0;
  console.log(wide(undefined, explicit()), trace);
});
