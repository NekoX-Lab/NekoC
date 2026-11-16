const item = { value: 1, nested: { text: 'a' } };
const source = [item, { value: 2, nested: { text: 'b' } }];
const copy = source.slice(-2, 99);
console.log(copy[0] === item, copy[1] === source[1]);
copy[0].value = 7;
copy[1].nested.text = 'changed';
copy.push(item);
console.log(item.value, source[1].nested.text, source.length, copy.length);
copy.reverse();
console.log(source[0].value, copy[0].value, source[0] === item);
class Box {
  value = 3;
  add(): number { this.value += 1; return this.value; }
}
const box = new Box();
const boxes = [box];
const clones = boxes.slice();
console.log(clones[0] === box, clones[0].add(), box.value);
const rows = [[1, 2], [3]];
const rowsCopy = rows.slice();
rowsCopy[0].push(4);
console.log(rows[0].join(','), rowsCopy[0].join(','));
const numbers = [1, 2, 3];
const numbersCopy = numbers.slice();
numbersCopy.reverse();
console.log(numbers.join(','), numbersCopy.join(','));
