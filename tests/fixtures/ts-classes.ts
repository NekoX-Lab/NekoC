// The class oracle deliberately logs only scalars. The same source is run by
// Node (with TypeScript's parameter-property transform) and by nekoc run.
let initializationTrace = "";
let receiverCalls = 0;
let argumentCalls = 0;

function initialize(label: string, value: number): number {
  initializationTrace += label;
  return value;
}

class Counter {
  value = initialize("field;", 2);
  copied = this.value + 1;
  label = "counter";
  assigned: number;

  constructor(public step: number, start: number) {
    initializationTrace += "constructor;";
    this.value += start;
    this.assigned = start;
  }

  add(amount: number): number {
    this.value += amount;
    return this.value;
  }

  advance(): number {
    return this.add(this.step);
  }

  arithmetic(): number {
    this.value *= 2;
    this.value -= 2;
    this.value /= 2;
    this.value %= 10;
    this.value **= 2;
    this.value++;
    ++this.value;
    this.value--;
    --this.value;
    this.label += "!";
    return this.value;
  }

  sum(n: number): number {
    const saved = n;
    if (n <= 0) return 0;
    const child = this.sum(n - 1);
    return saved + child;
  }

  even(n: number): boolean {
    if (n === 0) return true;
    return this.odd(n - 1);
  }

  odd(n: number): boolean {
    if (n === 0) return false;
    return this.even(n - 1);
  }
}

class Defaults {
  count = 0;
  title = "";
  enabled = false;
  values = [1, 2];
  child = { value: 3 };
}

const defaults = new Defaults();
console.log("defaults");
console.log(defaults.count);
console.log(defaults.title);
console.log(defaults.enabled);
console.log(defaults.values[1]);
console.log(defaults.child.value);

const first = new Counter(3, 5);
const second = new Counter(2, 1);
console.log("initialization");
console.log(initializationTrace);
console.log(first.copied);
console.log(first.assigned);
console.log(first.step);
console.log(first.value);
console.log(first.advance());
console.log(first.arithmetic());
console.log(first.label);
console.log(first.sum(5));
console.log(first.even(6));
console.log(first.odd(6));

const alias = first;
alias.add(5);
console.log("identity and containers");
console.log(first.value);
console.log(alias === first);
console.log(first === second);
const counters = [first, second];
counters[1].add(4);
console.log(second.value);
const holder = { counter: first };
holder.counter.advance();
console.log(alias.value);
holder.counter = second;
holder.counter.add(1);
console.log(second.value);

function roundTrip(counter: Counter, amount: number): Counter {
  counter.add(amount);
  return counter;
}
function makeCounter(step: number): Counter {
  return new Counter(step, 0);
}
const returned = roundTrip(counters[0], 2);
console.log(returned === first);
console.log(returned.value);
const fresh = makeCounter(7);
console.log(fresh.advance());
console.log(fresh !== first);

function receiver(): Counter {
  receiverCalls += 1;
  return first;
}
function argument(): number {
  argumentCalls += 1;
  first.value = 20;
  return 2;
}
console.log("single evaluation");
console.log(receiver().add(argument()));
console.log(receiverCalls);
console.log(argumentCalls);
