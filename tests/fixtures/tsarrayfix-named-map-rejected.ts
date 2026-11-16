appendList("items", 1); appendList("items", 2); appendList("items", 3);
const a = getList<number>("items");
let visits = 0;
const result = a.map(x => {
  visits++;
  deleteListItem("items", "last", 1);
  return x;
});
console.log(result.length, visits, result.join(","), a.length);
