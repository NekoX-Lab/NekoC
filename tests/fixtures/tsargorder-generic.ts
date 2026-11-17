function start<T extends number>(n: T) {
  const a = [1, 2, 3];
  a.splice(n, 1, 8);
  console.log(a.join(","));
}
function count<T extends number>(n: T) {
  const a = [1, 2, 3];
  a.splice(1, n, 8);
  console.log(a.join(","));
}
function chain<T extends number, U extends T>(n: U) {
  const a = [1, 2, 3];
  a.splice(n, n, 8, 9);
  console.log(a.join(","));
}
function literals<T extends 0 | 1>(n: T) {
  const a = [1, 2, 3];
  a.splice(n, n, 8);
  console.log(a.join(","));
}
start(1); start(99); start(1.9);
count(1); count(-1); count(99);
chain(1); literals(1);
