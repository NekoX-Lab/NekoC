let effects = 0;
function next(): number { effects++; return effects; }
function defaults(a = next(), b = 0) { return a * 10 + b; }
const source = [{ n: 1 }, { n: 2 }];
const [head, ...tail] = source;
const copy = tail.slice().concat([head]);
copy[0].n = 9;
onStart(() => {
  console.log(source[1].n);
  console.log(source.length);
  console.log(tail.length);
  console.log(copy.length);
  console.log(defaults(undefined, next()));
  console.log(effects);
});
