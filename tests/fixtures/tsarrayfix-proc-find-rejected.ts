defineProc("shrink", [], () => { deleteListItem("items", "last", 1); });
appendList("items", 1); appendList("items", 2); appendList("items", 3);
const a = getList<number>("items");
let visits = 0;
const result = a.findIndex(x => { visits++; callProc("shrink"); return false; });
console.log(result, visits, a.length);
