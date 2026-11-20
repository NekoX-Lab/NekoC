stage({ name: "Deterministic compiler fixture" });

class Base {
  constructor(public value: number) {}
  read() { return this.value; }
}
class Child extends Base {
  read() { return super.read() + 2; }
}
const box: Base = new Child(5);
interface Item { value: number; }
let maybe: Item | null = null;
const values = new Map<string, number>();
const labels = new Set();
function cut(text: string) { return text.slice(-2); }

defineProc("record", ["value"], () => { setVar("recorded", param("value")); });

onStart(() => {
  let total = 0;
  for (let i = 0; i < 3; i++) total += i;
  values.set("a", box.read());
  labels.add("a");
  maybe = { value: total };
  callProc("record", total);
  console.log(box.read(), maybe?.value ?? 0, values.get("a"), labels.has("a"), cut("abc"));
});
