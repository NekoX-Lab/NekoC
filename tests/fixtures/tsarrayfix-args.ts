let calls = 0;
function from(): number { calls++; return 1; }
const a = [1, 2, 1];
console.log(a.includes(1, from()));
console.log(a.indexOf(1, from()));
console.log(a.lastIndexOf(1, from()));
console.log(a.concat([3], [4]).join(","));
console.log(calls);
for (const index of [0, 1, 2, -1, -2, -3, -4, 100, -100, 1.9, -1.9, 0 / 0, 1 / 0, -1 / 0]) {
  console.log(a.includes(1, index), a.indexOf(1, index), a.lastIndexOf(1, index));
}
console.log(a.lastIndexOf(1));
const empty: number[] = [];
console.log(empty.includes(1, from()), empty.indexOf(1, from()), empty.lastIndexOf(1, from()), calls);
console.log(a.concat().join(","), a.concat([3]).join(","));
console.log(a.concat(3, [4, 5], 6, []).join(","), a.join(","));
let target = a;
let trace = "";
function get(): number[] { trace += "R"; return target; }
function search(): number { trace += "V"; target = [9]; return 1; }
function offset(): number { trace += "F"; return 1; }
console.log(get().indexOf(search(), offset()), trace, target.join(","));
trace = ""; target = a;
function extra(): number[] { trace += "A"; a.push(7); return [3]; }
function last(): number[] { trace += "B"; return [4]; }
console.log(get().concat(extra(), last()).join(","), trace, a.join(","));
const nan = [0 / 0, 1];
console.log(nan.includes(0 / 0), nan.indexOf(0 / 0), nan.lastIndexOf(0 / 0));
const strings = ["a", "b", "a"];
console.log(strings.includes("a", 1), strings.indexOf("a", 1), strings.lastIndexOf("a", 1));
console.log([true].concat(false, [true], false).join(","));
const inner = [8];
const nested = [inner].concat([inner], inner);
inner.push(9);
console.log(nested.length, nested[0].length, nested[1].length);
