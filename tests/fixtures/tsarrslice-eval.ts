let calls = 0;
const a = [10, 20, 30];
function array(): number[] { calls++; return a; }
console.log(array().slice(1).join(','));
console.log(calls);

let receiverCalls = 0;
let startCalls = 0;
let endCalls = 0;
let order = '';
let source = [1, 2, 3];
const original = source;
function receiver(): number[] { receiverCalls++; order += 'r'; return source; }
function lower(): number {
  startCalls++;
  order += 's';
  original.push(4);
  source = [9, 8];
  return -2;
}
function upper(): number { endCalls++; order += 'e'; original.push(5); return 99; }
const saved = receiver().slice(lower(), upper());
console.log(receiverCalls, startCalls, endCalls, order);
console.log(saved.join(','), original.join(','), source.join(','));

const grow = [1, 2];
let growthCalls = 0;
function growth(): number { growthCalls++; grow.push(3); return 0; }
console.log(grow.slice(growth()).join(','));
console.log(growthCalls, grow.join(','));
const shrink = [1, 2, 3];
let shrinkCalls = 0;
function shorten(): number { shrinkCalls++; shrink.pop(); shrink.pop(); return 99; }
console.log(shrink.slice(0, shorten()).join(','));
console.log(shrinkCalls, shrink.join(','));
const cleared = [1, 2, 3];
function clear(): number { cleared.length = 0; return -2; }
console.log(cleared.slice(clear()).length, cleared.length);

const values = [10, 20, 30];
let boundary = 1;
function changeBoundary(): number { boundary = 2; return 3; }
console.log(values.slice(boundary, changeBoundary()).join(','), boundary);
let unusedCalls = 0;
function unused(): number { unusedCalls++; return -99; }
console.log(values.slice(99, unused()).length, unusedCalls);

let recursiveCalls = 0;
function nested(depth: number): number {
  recursiveCalls++;
  if (depth > 0) return values.slice(nested(depth - 1), 2).length;
  return 0;
}
console.log(values.slice(nested(2)).join(','), recursiveCalls);
