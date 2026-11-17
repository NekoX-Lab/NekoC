const arrays = [[1], [2], [3]];
const [head, ...tail] = arrays;
head.push(9);
tail[0].push(8);
tail.push([4]);
console.log(arrays[0].join(","), arrays[1].join(","), arrays.length, tail.length);
const objects = [{value: 1}, {value: 2}];
const [object, ...objectTail] = objects;
object.value = 7;
objectTail[0].value = 6;
console.log(objects[0].value, objects[1].value);
class Box {
  value = 1;
  bump(): number { this.value++; return this.value; }
}
const boxes = [new Box(), new Box()];
const [box, ...boxTail] = boxes;
console.log(box.bump(), boxTail[0].bump(), boxes[0].value, boxes[1].value);
