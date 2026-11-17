let calls = 0;
let order = "";
let mutable = 3;
function next(x: number): number {
  calls++;
  order += String(x);
  return x;
}
function mutate(): number {
  mutable = 12;
  return 4;
}
function pair(x: number, y: number): number {
  return Math.hypot(x, y);
}
function recursive(n: number): number {
  if (n === 0) return 3;
  return Math.hypot(next(4), recursive(n - 1));
}
function relay(n: number): number {
  if (n === 0) return 0;
  return Math.hypot(3 * n, relay(n - 1), 4 * n);
}
console.log(Math.hypot(next(3), next(4), next(12)) === 13);
console.log(calls);
console.log(order);
console.log(Math.hypot(mutable, mutate()) === 5);
console.log(mutable);
console.log(Math.hypot(pair(next(6), next(8)), next(0)) === 10);
console.log(Math.hypot(next(5), Math.hypot(next(0), next(12))) === 13);
console.log(recursive(3) > 7.5498344352 && recursive(2) < 6.4031242375);
console.log(relay(3) > 18.7082869338 && relay(3) < 18.7082869340);
for (let i = 0; i < 3; i++) {
  console.log(pair(3 * i, 4 * i) === 5 * i);
}
console.log(calls);
console.log(order);
