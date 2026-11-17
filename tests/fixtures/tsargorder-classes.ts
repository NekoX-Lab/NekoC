let trace = "";
function a(): number { trace += "A"; return 1; }
function d(): number { trace += "D"; return 3; }
function b(): number { trace += "B"; return 2; }
class Plain {
  value: number;
  constructor(unused: number, x = a()) { this.value = x; }
  method(x = a(), unused = 0): number { return x; }
}
class Base {
  method(x = a(), y = 0): number { return x + y; }
}
class Derived extends Base {
  method(x = d(), y = 0): number { return x + y; }
}
class Short extends Base {
  method(x = d()): number { return x; }
}
function invoke(value: Base): number { return value.method(undefined, b()); }
onStart(() => {
  const plain = new Plain(b());
  console.log(plain.value, trace);
  trace = "";
  console.log(plain.method(undefined, b()), trace);
  const base = new Base();
  const derived = new Derived();
  const short = new Short();
  trace = ""; console.log(invoke(base), trace);
  trace = ""; console.log(invoke(derived), trace);
  trace = ""; console.log(invoke(short), trace);
  trace = ""; console.log(derived.method(), trace);
  trace = ""; console.log(short.method(), trace);
  trace = ""; console.log(derived.method(5, b()), trace);
});
