let trace = "";
function a(): number { trace += "A"; return 1; }
function b(): number { trace += "B"; return 2; }
class Plain {
  value: number;
  constructor(unused: number, x = a()) { this.value = x; }
  method(x = a(), unused = 0): number { return x; }
}
onStart(() => {
  const plain = new Plain(b());
  console.log(plain.value, trace);
  trace = "";
  console.log(plain.method(undefined, b()), trace);
  trace = "";
  console.log(new Plain(b(), undefined).value, trace);
});
