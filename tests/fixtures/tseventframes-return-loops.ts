onMessage("for", () => {
  const local = 7;
  for (let i = 0; i < local; i++) {
    console.log("for", local + i);
    return;
  }
  console.log("unreachable for");
});
onMessage("do", () => {
  const local = 8;
  do {
    console.log("do", local);
    return local;
  } while (local < 10);
  console.log("unreachable do");
});
onMessage("conditional", () => {
  const local = 3;
  for (let i = 0; i < local; i++) {
    if (i === 0) continue;
    if (i === 2) return;
    console.log("conditional", i);
  }
  console.log("unreachable conditional");
});
onMessage("do-continue", () => {
  let i = 0;
  do {
    i++;
    if (i === 1) continue;
    if (i === 3) return;
    console.log("do-continue", i);
  } while (i < 4);
  console.log("unreachable do-continue");
});
onMessage("fallthrough", () => {
  const limit = 2;
  for (let i = 0; i < limit; i++) {
    if (i < 0) return;
    if (i === 0) continue;
    console.log("fallthrough", i);
  }
  console.log("fallthrough done");
});
onStart(() => {
  broadcast("for");
  wait(0.1);
  broadcast("do");
  wait(0.1);
  broadcast("conditional");
  wait(0.1);
  broadcast("do-continue");
  wait(0.1);
  broadcast("fallthrough");
});
