export function values(): number[] {
  console.log("module rhs");
  return [3, 4, 5];
}
export function local(values: number[]): number {
  const [head, ...tail] = values;
  if (head < 0) return 0;
  return head + tail[0];
}
