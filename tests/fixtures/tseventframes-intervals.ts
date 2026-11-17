let serial = 0;
function schedule() {
  setInterval(() => {
    serial++;
    const local = serial;
    const array = [local];
    wait(0.1);
    console.log(local, array[0]);
    stop();
  }, 0);
}
onStart(() => {
  schedule();
  wait(0);
  schedule();
});
