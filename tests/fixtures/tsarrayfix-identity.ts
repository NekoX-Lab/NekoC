const item = { value: 1 };
const left = [item];
const right = [{ value: 2 }];
const result = left.concat(right, item);
result[0].value = 7;
result[1].value = 8;
console.log(item.value, right[0].value, result[2].value, left.length, right.length, result.length);
console.log(result[0] === result[2]);
