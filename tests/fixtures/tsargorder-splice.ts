function boundary(start: number, count: number) {
  const a = [1, 2, 3];
  a.splice(start, count, 8, 9);
  console.log(a.join(","));
}
let trace = "";
let current = [1, 2, 3];
const original = current;
function receiver(): number[] { trace += "R"; return current; }
function start(): number { trace += "S"; current.push(4); return 3; }
function count(): number { trace += "C"; current.push(5); return 99; }
function item(): number { trace += "I"; current = [7]; return 8; }
function reentrant(n: number): number {
  if (n === 0) return 8;
  current.splice(99, 0, n, reentrant(n - 1));
  return n;
}
onStart(() => {
  boundary(99, 0); boundary(3, 0); boundary(1e20, 0);
  boundary(1.9, 0); boundary(1.9, 1.9);
  boundary(1, 1e20); boundary(1, -9); boundary(1, -0.5);
  boundary(-1, 0); boundary(-99, 1); boundary(-0.5, 0);
  boundary(NaN, NaN); boundary(Infinity, Infinity); boundary(-Infinity, Infinity);
  boundary(NaN, 1); boundary(1, NaN); boundary(1, -Infinity);
  const empty: number[] = [];
  empty.splice(99, 0, 8, 9);
  console.log(empty.join(","));
  const omitted = [1, 2, 3];
  omitted.splice(1.9);
  console.log(omitted.join(","));
  omitted.splice(99);
  // @ts-expect-error JS also accepts zero arguments (a no-op).
  omitted.splice();
  console.log(omitted.join(","));
  receiver().splice(start(), count(), item(), 9);
  console.log(original.join(","), current.join(","), trace);
  const object = { value: 1 };
  const objects = [{ value: 0 }];
  objects.splice(99, 0, object, object);
  objects[1].value = 7;
  console.log(object.value, objects[2].value);
  const nested = [[0]];
  const element = [1];
  nested.splice(99, 0, element, element);
  nested[1].push(2);
  console.log(element.join(","), nested[2].join(","));
  current = [0]; reentrant(3);
  console.log(current.join(","));
  let total = 0;
  for (let i = 0; i < 600; i++) {
    const hot = [1, 2, 3];
    hot.splice(99, 0, 8, 9);
    total += hot[3] * 10 + hot[4];
  }
  console.log(total);
});
