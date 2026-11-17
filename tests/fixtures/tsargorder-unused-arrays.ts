let trace = "";
let current = [1];
const original = current;
function arr(): number[] { trace += "E"; return current; }
function defaultValue(): number { trace += "D"; return 2; }
function constant(x = 2, unused: number[] = []) { console.log(x); }
function dynamic(x = defaultValue(), unused: number[] = []) { console.log(x); }
function unused(unused: number[]) { console.log("body"); }
function change(): number { trace += "C"; current = [9]; return 3; }
function used(values: number[], item: number) { values.push(item); values.push(item); }
constant(undefined, arr()); console.log(trace);
trace = "";
dynamic(2, arr()); console.log(trace);
trace = "";
dynamic(undefined, arr()); console.log(trace);
trace = "";
unused(arr()); console.log(trace);
trace = "";
used(arr(), change());
console.log(original.join(","), current.join(","), trace);
