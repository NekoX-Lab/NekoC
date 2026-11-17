let value: string | null | undefined = "X";
let effects = 0;
function searchNull(): string { effects++; value = null; return "a"; }
function searchUndefined(): string { effects++; value = undefined; return "a"; }
function receiverNull(): string { effects++; value = null; return "nullnull"; }
function receiverUndefined(): string { effects++; value = undefined; return "undefinedundefined"; }
function falseBranch(): string { effects += 100; return "wrong"; }
console.log("abc".replace(searchNull(), String(true ? value : falseBranch())));
value = "X";
console.log("abc".replace(searchUndefined(), String(true ? value : falseBranch())));
value = "X";
console.log("aaba".replaceAll(searchNull(), String(true ? value : falseBranch())));
value = "X";
console.log("aaba".replaceAll(searchUndefined(), String(true ? value : falseBranch())));
value = "X";
console.log(receiverNull().replace(String(true ? value : falseBranch()), "X"));
value = "X";
console.log(receiverUndefined().replace(String(true ? value : falseBranch()), "X"));
value = "X";
console.log("nullnull".replaceAll(String(receiverNull() ? value : falseBranch()), "X"));
value = "X";
console.log("undefinedundefined".replaceAll(String(receiverUndefined() ? value : falseBranch()), "X"));
value = "X";
console.log(receiverNull().replaceAll("null", String(true ? value : falseBranch())));
value = "X";
console.log(receiverUndefined().replaceAll("undefined", String(true ? value : falseBranch())));
value = "X";
console.log("abc".replace(searchNull(), String(false ? falseBranch() : (true ? (value) : "Y"))));
value = "X";
console.log("abc".replace(searchUndefined(), String(false ? falseBranch() : ((value)))));
value = "X";
console.log("abc".replace(searchNull(), String(value ?? "fallback")));
console.log(String(true ? -1 : -2));
console.log(String(false ? -1 : -2));
console.log(String(true ? "-1" : "-2"));
console.log(String(false ? "-1" : "-2"));
console.log(effects);
const box: { value: string | null } = { value: "X" };
const alias = box;
function mutateField(): string { alias.value = null; return "a"; }
if (box.value !== null) console.log("abc".replace(mutateField(), String(true ? box.value : "Y")));
let values: (string | undefined)[] = ["X"];
function mutateElement(): string { values[0] = undefined; return "a"; }
if (values[0] !== undefined) console.log("abc".replace(mutateElement(), String(true ? values[0] : "Y")));

let snapshotSource: string | null = "X";
const stable = snapshotSource;
const stableAgain = stable;
function clearSnapshot(): void { snapshotSource = null; }
clearSnapshot();
console.log("abc".replace("a", String(stableAgain)));
console.log("aaba".replaceAll("a", String(true ? stableAgain : "Y")));
const convertedAtCapture = String(snapshotSource);
const fallbackAtCapture = snapshotSource ?? "fallback";
console.log("abc".replace("a", String(convertedAtCapture)));
console.log("aaba".replaceAll("a", String(true ? fallbackAtCapture : "Y")));
const snapshotBox: { value: string | undefined } = { value: "X" };
function clearSnapshotBox(): void { snapshotBox.value = undefined; }
if (snapshotBox.value !== undefined) {
  const stableField = snapshotBox.value;
  clearSnapshotBox();
  console.log("abc".replace("a", String(stableField)));
  const convertedField = String(snapshotBox.value);
  console.log("aaba".replaceAll("a", String(true ? convertedField : "Y")));
}
let snapshotArray: (string | undefined)[] = ["X"];
function clearSnapshotArray(): void { snapshotArray[0] = undefined; }
if (snapshotArray[0] !== undefined) {
  const stableElement = snapshotArray[0];
  clearSnapshotArray();
  console.log("abc".replace("a", String(stableElement)));
  const fallbackElement = snapshotArray[0] ?? "fallback";
  console.log("abc".replace("a", String(fallbackElement)));
}
snapshotSource = "R";
if (snapshotSource !== null) {
  const guarded = snapshotSource;
  console.log("abc".replace("a", String(guarded)));
}
let ordinary = "-1";
ordinary = "-2";
console.log("abc".replace("a", String(ordinary)));
const numberCapture = -1;
console.log("abc".replace("a", String(numberCapture)));
const booleanCapture = false;
console.log("abc".replace("a", String(booleanCapture)));
