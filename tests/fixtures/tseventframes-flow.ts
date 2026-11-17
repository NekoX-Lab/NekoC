onMessage("switch", "p", () => {
  switch (messageValue("p")) {
    case 1: wait(0.2); console.log("switch one"); break;
    case 2: wait(0); console.log("switch two"); break;
  }
});
onMessage("try", "p", () => {
  try {
    if (messageValue("p") === 1) {
      wait(0.2);
      console.log("try one");
    } else {
      throw "two";
    }
  } catch {
    console.log("try two");
  }
});
onMessage("loop", "p", () => {
  while (true) {
    if (messageValue("p") === 1) {
      wait(0.2);
      console.log("loop one");
      break;
    }
    wait(0);
    if (messageValue("p") === 2) break;
    continue;
  }
  console.log("loop done", messageValue("p"));
});
onMessage("continue", "p", () => {
  do {
    if (messageValue("p") === 1) wait(0.2);
    else wait(0);
    continue;
  } while (false);
  console.log("continue done", messageValue("p"));
});
onStart(() => {
  broadcast("switch", 1);
  wait(0);
  broadcast("switch", 2);
  wait(0.4);
  broadcast("try", 1);
  wait(0);
  broadcast("try", 2);
  wait(0.4);
  broadcast("loop", 1);
  wait(0);
  broadcast("loop", 2);
  wait(0.4);
  broadcast("continue", 1);
  wait(0);
  broadcast("continue", 2);
});
