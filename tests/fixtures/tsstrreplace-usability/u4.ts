let target: string | null = "A";
function pick(): void {
  if (target === null) return;
  const t = target;
  wait(0.1);
  console.log(t);
  const items: string[] = [];
  items.push(t);
  console.log(items.length);
}
pick();
