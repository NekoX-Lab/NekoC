const a = [10, 20, 30];
console.log(a.slice(1, 5).join(','));
console.log(a.slice(0.9, 2.9).join(','));
let start = -2;
console.log(a.slice(start).join(','));
console.log(a.join(','));
console.log(a.slice().join(','), a.slice(1).join(','));
console.log(a.slice(99).length, a.slice(2, 1).length, a.slice(1, 1).length);
console.log(a.slice(-2, -1).join(','), a.slice(-99, 99).join(','));
console.log(a.slice(-2.9, -0.9).join(','), a.slice(-0.9, 2.9).join(','));
console.log(a.slice(-2.9, 2.9).join(','), a.slice(0, -1.9).join(','));
let from = -2.9;
let to = -0.9;
console.log(a.slice(from, to).length, a.slice(from).join(','));
const bounds = [NaN, Infinity, -Infinity, 0, -0, 0.9, -0.9, 2.9, -2.9, 99, -99];
for (const lower of bounds) {
  console.log(a.slice(lower).join(','));
  for (const upper of bounds) {
    const result = a.slice(lower, upper);
    console.log(result.length, result.join(','));
  }
}
const empty: number[] = [];
console.log(empty.slice().length, empty.slice(-2, 99).length, empty.slice(NaN, Infinity).length);
console.log(a.join(','));
onStart(() => {
  const [head, ...tail] = a;
  console.log(head, tail.join(','));
  const [only, ...none] = [7];
  console.log(only, none.length);
});
