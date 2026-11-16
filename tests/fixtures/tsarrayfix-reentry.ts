const a = [0]; const b = [9];
let current = a;
function value(): number {
  if (current === a) {
    current = b;
    broadcastAndWait("nested");
    return 1;
  }
  return 2;
}
function mutate() { current.unshift(value(), 3); }
onMessage("nested", () => { mutate(); });
onStart(() => {
  mutate();
  wait(0.1);
  console.log(a.join(","), b.join(","));
});
