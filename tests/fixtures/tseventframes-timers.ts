let serial = 0;
const shared = [0];
function schedule() {
  setTimeout(() => {
    serial++;
    const local = serial;
    const array = [local];
    const alias: number[] = shared;
    wait(0.1);
    array.forEach(value => { alias[0] = alias[0] + value; });
    console.log(local, array[0]);
    if (local === 1) return;
    return local;
    console.log("unreachable");
  }, 0);
}
onStart(() => {
  schedule();
  wait(0);
  schedule();
  wait(0.5);
  console.log("shared", serial, shared[0]);
});
