let serial = 0;
let returns = 0;
onMessage("go", () => {
  serial++;
  const local = serial;
  wait(0.1);
  console.log(local);
  if (local === 1) return returns++;
  return local;
  console.log("unreachable");
});
onStart(() => {
  broadcast("go");
  wait(0);
  broadcast("go");
  wait(0.5);
  if (returns !== 1) console.log("bad-return-side-effect");
});
