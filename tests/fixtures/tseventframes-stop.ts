let serial = 0;
onMessage("go", () => {
  serial++;
  const local = serial;
  wait(0.1);
  if (local === 1) stop();
  console.log(local);
});
onStart(() => {
  broadcast("go");
  wait(0);
  broadcast("go");
});
