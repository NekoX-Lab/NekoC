// JS oracle for null/undefined support (docs/ts-nullable.md).
// Node and `nekoc run` must print the same lines in the same order.

console.log("printing");
let missing: number | null = null;
let unset: string | undefined;
console.log(missing, unset, null, undefined, void 0);
console.log("s=" + unset, `t=${missing}`, String(null), String(missing));
let flag: boolean | null = null;
console.log(flag, flag ?? true);

console.log("linked list");
class ListNode {
  constructor(public value: number, public next: ListNode | null = null) {}
}
let head: ListNode | null = null;
for (let i = 1; i <= 4; i++) head = new ListNode(i * 10, head);
let sum = 0;
let count = 0;
let cur = head;
while (cur !== null) {
  sum += cur.value;
  count++;
  cur = cur.next;
}
console.log(sum, count);
console.log(head?.value, head?.next?.next?.value, head?.next?.next?.next?.next?.value);
function lastValue(node: ListNode | null): number | undefined {
  if (node === null) return undefined;
  while (node.next !== null) node = node.next;
  return node.value;
}
console.log(lastValue(head), lastValue(null));

console.log("binary tree");
class TreeNode {
  left: TreeNode | null = null;
  right: TreeNode | null = null;
  parent?: TreeNode;
  constructor(public key: number) {}
  insert(k: number): void {
    if (k < this.key) {
      if (this.left === null) {
        this.left = new TreeNode(k);
        this.left.parent = this;
      } else this.left.insert(k);
    } else {
      if (this.right) this.right.insert(k);
      else {
        this.right = new TreeNode(k);
        this.right.parent = this;
      }
    }
  }
  depth(): number {
    const l = this.left ? this.left.depth() : 0;
    const r = this.right?.depth() ?? 0;
    return 1 + Math.max(l, r);
  }
  min(): number { return this.left?.min() ?? this.key; }
  has(k: number): boolean {
    if (k === this.key) return true;
    const child = k < this.key ? this.left : this.right;
    return child?.has(k) ?? false;
  }
}
const root = new TreeNode(50);
for (const k of [30, 70, 20, 40, 60, 80, 10]) root.insert(k);
console.log(root.depth(), root.min(), root.has(60), root.has(65));
console.log(root.parent === undefined, root.left?.parent?.key, root.left?.left?.left?.parent?.key);
const found: TreeNode | undefined = undefined;
console.log(found === undefined, found == null, root.left == null);

console.log("optional config");
interface Config { width?: number; title?: string; verbose?: boolean; label: string }
function describe(c: Config): string {
  const w = c.width ?? 100;
  const t = c.title ?? "untitled";
  return c.label + ":" + w + ":" + t + ":" + (c.verbose ?? false);
}
console.log(describe({ label: "a" }));
console.log(describe({ label: "b", width: 0, title: "", verbose: true }));
const config: Config = { label: "c" };
console.log(config.title, config.title?.length, config.width === undefined);
config.title = "hello";
config.width ??= 64;
config.width ??= 32;
console.log(config.title?.length, config.width);

console.log("nullable results");
function find(xs: number[], v: number): number | null {
  for (let i = 0; i < xs.length; i++) if (xs[i] === v) return i;
  return null;
}
const xs = [5, 6, 7];
console.log(find(xs, 6), find(xs, 9), find(xs, 9) ?? -1);
const at = find(xs, 7);
if (at !== null) console.log("at", at + 1);
let name: string | null = null;
name ??= "kit";
name ??= "other";
console.log(name, name.length);
function pick(k: number): string | undefined {
  switch (k) { case 1: return "one"; case 2: return undefined; }
  return "many";
}
console.log(pick(1), pick(2), pick(3));
let sw: number | null = null;
switch (sw) { case null: console.log("case null"); break; default: console.log("other"); }

console.log("arrays of nullable values");
const vals: (number | null)[] = [1, null, 3];
vals.push(null);
let total = 0;
for (const v of vals) { if (v !== null) total += v; }
console.log(total, vals.indexOf(null), vals.includes(null), vals.length);
console.log(vals.map(v => v ?? 0).join(","));

console.log("comparison and truthiness");
let a: number | undefined = undefined;
let b: number | null = null;
console.log(a == b, a === undefined, b == undefined, a != null, a === b);
let zero: number | null = 0;
console.log(zero || 9, zero ?? 9, zero === null);
if (zero) console.log("truthy"); else console.log("falsy zero");
let empty: string | undefined = "";
if (!empty) console.log("empty falsy");
if (flag) console.log("flag"); else console.log("no flag");

console.log("single evaluation");
let calls = 0;
function next(): number { calls++; return calls; }
function maybe(v: number): number | null { calls += 100; return v > 1 ? v : null; }
console.log(maybe(1) ?? next(), calls);
console.log(maybe(5) ?? next(), calls);
class Box {
  hits = 0;
  constructor(public v: number) {}
  bump(by: number): number { this.hits += by; return this.hits; }
  show(): void { console.log("box", this.v); }
}
let box: Box | null = null;
console.log(box?.bump(next()), calls);
box?.show();
box = new Box(7);
console.log(box?.bump(next()), calls);
box?.show();
const holder: { b: Box | null } = { b: box };
holder.b?.show();
console.log(holder.b?.v ?? -1);
holder.b = null;
console.log(holder.b?.v ?? -1, holder.b === null);
function len(s: string | null): number { return s?.length ?? -1; }
console.log(len(null), len("abc"));
