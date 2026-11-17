let serial = 0;
const shared = [0];
const object = { value: 0 };
function inlineLocal(n: number) {
  const saved = n;
  console.log("inline", saved);
}
onMessage("go", () => {
  serial++;
  const local = serial;
  const own = [local];
  const alias: number[] = shared;
  const ref = object;
  let sum = 0;
  wait(0.1);
  for (let i = 0; i < 2; i++) {
    for (let j = 0; j < 2; j++) {
      if (j === 0) continue;
      sum += local + i + j;
      wait(0);
    }
  }
  own.forEach(value => {
    const callbackLocal = value;
    sum += value;
    own.forEach(other => { sum += other + callbackLocal; });
  });
  const mapped = own.map(value => value + local);
  const made = Array.from({ length: 2 }, (_, i) => local + i);
  console.log("callbacks", local, mapped[0], made[1]);
  alias[0] = alias[0] + local;
  ref.value += local;
  changeVar("named", 1);
  console.log(local, own[0], sum);
  inlineLocal(local);
});
onStart(() => {
  setVar("named", 0);
  broadcast("go");
  wait(0);
  broadcast("go");
  wait(0.8);
  console.log("shared", serial, shared[0], object.value, getVar("named"));
});
