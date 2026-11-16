let trace = "";
function first(): number { trace += "A"; return 10; }
function second(): number { trace += "B"; return 20; }
const values = [0];
values.unshift(first(), second());
console.log(trace, values.join(","));
let starts = 0;
function start(): number { starts++; return 1; }
const spliced = [0, 1, 2, 3];
spliced.splice(start(), 2, 8, 9);
console.log(starts, spliced.join(","));

const original = [4];
let receiver = original;
let receiverCalls = 0;
function get(): number[] { receiverCalls++; return receiver; }
function replace(): number { receiver = [99]; return 5; }
get().unshift(replace(), original.length);
console.log(receiverCalls, original.join(","), receiver.join(","));
receiver = original;
get().push(replace(), original.length);
console.log(receiverCalls, original.join(","), receiver.join(","));
receiver = original;
get().splice(1, 0, replace(), original.length);
console.log(receiverCalls, original.join(","), receiver.join(","));

const zero = [1, 2];
zero.unshift(); zero.push(); zero.splice(); zero.splice(0, 0);
zero.splice(1, 0, zero.length, zero.length);
console.log(zero.join(","));
zero.splice(1, 2);
console.log(zero.join(","));

const recursive = [0];
function recurse(n: number): number {
  if (n === 0) return 7;
  recursive.unshift(n, recurse(n - 1));
  return n;
}
recurse(3);
console.log(recursive.join(","));
const recursiveSplice = [0];
function insert(n: number): number {
  if (n === 0) return 8;
  recursiveSplice.splice(0, 0, n, insert(n - 1));
  return n;
}
insert(3);
console.log(recursiveSplice.join(","));

let saved = [1];
const savedAlias = saved;
function change(): number { saved = [2]; return 3; }
saved.unshift(change());
console.log(savedAlias.join(","), saved.join(","));
