// Scalar logs are compared with Node, the interpreter, and the JIT.
const frequency = new Map<string, number>();
for (const word of "cat dog cat bird dog cat".split(" ")) {
  frequency.set(word, (frequency.get(word) ?? 0) + 1);
}
for (const [word, count] of frequency) console.log(word, count);

const unique = new Set([3, 1, 3, 2, 1]);
unique.delete(1);
unique.add(1);
for (const value of unique) console.log("unique", value);

const keys = new Map<string | number, number>();
keys.set(NaN, 1).set(NaN, 2).set("NaN", 3).set(-0, 4).set(0, 5).set("0", 6);
console.log("keys", keys.size, keys.get(NaN), keys.get("NaN"), keys.get(0), keys.get("0"));

class Vertex {
  edges = new Set<string>();
  constructor(public label: string) {}
}
const graph = new Map<string, Vertex>();
const vertex = new Vertex("root");
graph.set("a", vertex);
vertex.edges.add("b").add("c");
const selected = graph.get("a");
if (selected !== undefined) selected.edges.add("d");
for (const [from, node] of graph) {
  for (const to of node.edges) console.log(from, to);
}
console.log(vertex.edges.size, graph.get("absent") === undefined);

const live = new Map<number, number>([[1, 10], [2, 20], [3, 30]]);
live.forEach((value, key, owner) => {
  console.log("live", key, value);
  if (key === 1) {
    owner.delete(2);
    owner.set(3, 31);
    owner.set(4, 40);
    return;
  }
  if (key === 3) {
    owner.clear();
    owner.set(5, 50);
  }
});
console.log("size", live.size);
if (live.has(5)) console.log("guarded", live.get(5)! + 1);
