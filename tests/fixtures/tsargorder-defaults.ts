let trace = "";
let state = 0;
function a(): number { trace += "A"; return 1; }
function b(): number { trace += "B"; state = 7; return 2; }
function f(x = a(), y = 0): number { return x + y; }
function read(x = state, unused = 0): number { return x; }
function multiple(x = a(), y = a(), unused = 0): number { return x + y; }
function ignored(x = a(), unused = 0): number { return 9; }
function statement(x = a(), unused = 0) { console.log(x, trace); }
function nested(x = f(undefined, b()), unused = 0): number { return x; }
function arrayArgument(x = a(), values: number[] = []): number { return values.length + x; }
function stringArgument(x = a(), value = ""): string { return value + x; }
function arrayStatement(x = a(), values: number[] = []) { values.push(x); }
function arrayDefault(): number[] { trace += "L"; return [7]; }
function defaultStatement(values = arrayDefault(), unused = 0) { values.push(9); console.log(values.join(","), trace); }
function unusedGlobalDefault(value = state): number { return 5; }
onStart(() => {
  console.log(f(undefined, b()), trace);
  trace = ""; state = 0;
  console.log(read(undefined, b()), trace);
  trace = "";
  console.log(multiple(undefined, undefined, b()), trace);
  trace = "";
  console.log(f(0, b()), trace);
  trace = "";
  console.log(ignored(undefined, b()), trace);
  trace = "";
  statement(undefined, b());
  trace = "";
  console.log(nested(undefined, b()), trace);
  trace = "";
  const values = [4];
  console.log(arrayArgument(undefined, values), trace);
  trace = "";
  let text = "value";
  console.log(stringArgument(undefined, text), trace);
  trace = "";
  arrayStatement(undefined, values);
  console.log(values.join(","), trace);
  trace = "";
  defaultStatement(undefined, b());
  state = 2;
  console.log(unusedGlobalDefault());
  trace = "";
  let total = 0;
  for (let i = 0; i < 600; i++) {
    total += f(undefined, b());
  }
  console.log(total, trace.length, trace.substring(0, 8));
});
