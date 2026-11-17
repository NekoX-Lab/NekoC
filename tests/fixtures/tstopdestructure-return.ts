let calls = 0;
function values(): number[] {
  calls++;
  return [3, 4];
}
const [a, b] = values();
console.log(a, b, calls);
