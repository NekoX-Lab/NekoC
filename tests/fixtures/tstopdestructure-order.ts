let calls = 0;
console.log("before", calls);
function readBindings(): number {
  if (head < 0) return 0;
  return head + second;
}
onStart(() => { console.log("start", head, second, last, calls, readBindings()); });
wait(0.02);
function values(): number[] {
  calls++;
  console.log("rhs", calls);
  return [3, 4, 5, 6];
}
const [head, , ...tail] = values(), after = head + tail[0];
console.log("after", head, tail.join(","), after, calls);
const [, second] = values(), [third, fourth] = [7, 8], last = second + third;
console.log(second, third, fourth, last, calls);
const [] = values();
console.log("empty", calls);
console.log("end", calls);
