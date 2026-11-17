setTimeout(() => {
  warp(() => {
    const inside = 7;
    [2].forEach(y => console.log("warp", inside + y));
  });
  repeatTimes(1, () => {
    const inside = "hello";
    [2].forEach(y => console.log("repeat", inside, y));
  });
  ifThen(true, () => {
    const inside = { value: 7 };
    [2].forEach(y => console.log("if", inside.value + y));
  });
  [1].forEach(x => {
    warp(() => {
      const inside = x + 7;
      [2].forEach(y => console.log("array", inside + y));
    });
  });
  repeatTimes(1, () => {
    const [inside, other] = [7, 3];
    [2].forEach(y => console.log("destructure", inside + other + y));
  });
}, 0);
onMessage("go", () => {
  const outer = 7;
  [1].forEach(x => {
    warp(() => {
      const inside = x;
      [2].forEach(y => console.log("event-array", outer + inside + y));
    });
  });
});
onStart(() => {
  wait(0.2);
  broadcast("go");
});
