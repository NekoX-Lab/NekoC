// Pure synchronous TS: Node is the independent scalar-output oracle.
type Cell = { value: number; label: string; active: boolean };
let initializers = 0;
let targets = 0;
let indices = 0;

function make(value: number): Cell {
  initializers += 1;
  return { value, label: "cell", active: false };
}

function mutate(cell: Cell, delta: number): Cell {
  cell.value += delta;
  cell.label += delta;
  cell.active = true;
  return cell;
}

const first = make(3);
const second = make(8);
const alias = mutate(first, 2);
console.log(first.value);
console.log(first.label);
console.log(first.active);
console.log(alias === first);
console.log(first === second);

const parent = { child: first, cells: [first, second] };
const oldChild = parent.child;
parent.child = second;
parent.child.value++;
oldChild.value += 1;
console.log(first.value);
console.log(second.value);
console.log(parent.cells[0] === oldChild);

function target(): Cell {
  targets += 1;
  return parent.child;
}

function index(): number {
  indices += 1;
  return 1;
}

function rhs(): number {
  first.value = 100;
  parent.child = second;
  return 2;
}

parent.child = first;
target().value += rhs();
console.log(first.value);
console.log(second.value);
console.log(targets);
parent.cells[index()].value += 3;
console.log(second.value);
console.log(indices);

function choose(cell: Cell, take: boolean): Cell {
  if (take) return cell;
  return make(20);
}

const returned = choose(first, true);
const fresh = choose(first, false);
console.log(returned === first);
console.log(fresh.value);
console.log(initializers);

const empty = {};
const otherEmpty = {};
console.log(empty === empty);
console.log(empty === otherEmpty);
const keys = { 1e2: 3, 0x10: 4, length: 5, toString: 6, constructor: 7 };
console.log(keys[100]);
console.log(keys[16]);
console.log(keys.length);
console.log(keys.toString);
console.log(keys.constructor);

function afterCallback(): { value: number } {
  [1].forEach((value: number) => {
    if (value > 0) return;
    console.log(value);
  });
  return { value: 30 };
}
console.log(afterCallback().value);
