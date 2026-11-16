import { returnedArray, returnedStart } from "./tsarrayfix-module-data";
export function search(): number {
  const values = [1, 2, 1];
  console.log(values.includes(1, 1), values.indexOf(1, returnedStart()), values.lastIndexOf(1, -2));
  return values.indexOf(1, 1);
}
export function scalar(): number[] { return [1, 2].concat(3); }
export function annotated(a: number[]): number[] { return [1, 2].concat(a); }
export function returned(): number[] { return [1, 2].concat(returnedArray()); }
export function callback(): number[] {
  return [1, 2].map(x => x + 1);
}
