function local(values: number[]): number {
  const [head, , ...tail] = values;
  if (head < 0) return 0;
  return head + tail[0];
}
function recursive(n: number): number {
  const [a, b] = [n, n + 1];
  if (n === 0) return a + b;
  const child = recursive(n - 1);
  return a + b + child;
}
console.log(local([3, 4, 5]), local([6, 7, 8]), recursive(3));
onStart(() => {
  const [head, ...tail] = [[1], [2], [3]];
  head.push(9);
  tail[0].push(8);
  console.log(head.join(","), tail[0].join(","), tail.length);
});
