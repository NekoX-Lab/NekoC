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
type Index = number & { readonly brand?: "index" };
type Count = number & { readonly count?: "count" };
function brandedStart(n: Index) {
  const a = [1, 2, 3];
  a.splice(n, 1, 8);
  console.log(a.join(","));
}
function brandedCount(n: Count) {
  const a = [1, 2, 3];
  a.splice(1, n, 8);
  console.log(a.join(","));
}
function constrainedStart<T extends Index>(n: T) {
  const a = [1, 2, 3];
  a.splice(n, 1, 8);
  console.log(a.join(","));
}
function constrainedCount<T extends Count>(n: T) {
  const a = [1, 2, 3];
  a.splice(1, n, 8);
  console.log(a.join(","));
}
function brandedChain<T extends Index, U extends T, V extends U>(n: V) {
  const a = [1, 2, 3];
  a.splice(n, n, 8);
  console.log(a.join(","));
}
function emptyBrand<T extends number & {}>(n: T) {
  const a = [1, 2, 3];
  a.splice(n, n, 8);
  console.log(a.join(","));
}
type OtherIndex = number & { readonly other?: "other" };
function numericUnion(n: Index | OtherIndex) {
  const a = [1, 2, 3];
  a.splice(n, n, 8);
  console.log(a.join(","));
}
brandedStart(1); brandedCount(1);
constrainedStart(1); constrainedCount(1);
brandedChain(1); emptyBrand(1); numericUnion(1);
