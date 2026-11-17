let serial = 0;
sprite("cat", {}, self => {
  self.onStart(() => {
    createClone();
    createClone();
    broadcast("go");
    wait(0);
    broadcast("go");
  });
  onMessage("go", () => {
    serial++;
    const local = serial;
    const clone = currentCloneIndex();
    const array = [local];
    wait(0.1);
    console.log(local, array[0], clone === currentCloneIndex());
  });
});
