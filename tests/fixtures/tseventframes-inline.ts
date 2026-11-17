let serial = 0;
function animate(n: number) {
  const saved = n;
  const items = [n];
  wait(0.1);
  console.log(saved, items[0]);
}
onMessage("go", () => { serial++; animate(serial); });
onStart(() => {
  broadcast("go");
  wait(0);
  broadcast("go");
});
