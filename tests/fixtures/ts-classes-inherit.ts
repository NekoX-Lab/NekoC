let trace = "";
function mark(label: string): number { trace += label + ";"; return 1; }
abstract class Animal {
  base = mark("base-field");
  constructor(public age: number) { mark("base-body"); }
  abstract speak(): string;
  describe(): string { return this.speak() + this.age; }
  get years(): number { return this.age; }
  set years(value: number) { this.age = value; }
}
class Cat extends Animal {
  cat = mark("cat-field");
  constructor(age: number) { mark("before-super"); super(age + 1); mark("after-super"); }
  speak(): string { return "cat"; }
  get years(): number { return this.age * 2; }
  set years(value: number) { this.age = value / 2; }
}
class Kitten extends Cat {
  kitten = mark("kitten-field");
  speak(): string { return super.speak() + "!"; }
}
class Dog extends Animal {
  dog = mark("dog-field");
  speak(): string { return "dog"; }
}
const kitten = new Kitten(2);
console.log(trace);
console.log(kitten.describe());
trace = "";
const dog = new Dog(5);
console.log(trace);
const animals: Animal[] = [kitten, dog, new Cat(3)];
for (const animal of animals) {
  console.log(animal.speak());
  console.log(animal instanceof Animal);
  console.log(animal instanceof Cat);
  if (animal instanceof Kitten) console.log(animal.kitten);
}
let receiverCalls = 0;
function receiver(): Animal { receiverCalls += 1; return kitten; }
console.log(receiver().describe());
receiver().years += 4;
console.log(receiverCalls);
console.log(kitten.age);
console.log(kitten.years);
dog.years = 7;
console.log(dog.years);
console.log(animals[0] === kitten);
trace = "";
class Registry {
  static count = mark("static-one");
  static next = mark("static-two") + Registry.count;
  static add(n: number): number { Registry.count += n; return Registry.count; }
}
mark("after-class");
console.log(trace);
console.log(Registry.next);
console.log(Registry.add(3));
console.log(Registry.count);
