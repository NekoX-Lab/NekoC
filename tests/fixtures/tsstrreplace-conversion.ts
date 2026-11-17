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
