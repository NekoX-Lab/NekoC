export {};
const Infinity = 0;
const a = [10, 20, 30];
console.log(a.slice().join(','));
console.log(a.slice(1).join(','));
console.log(a.slice(1, 3).join(','));
console.log(a.slice(0, Infinity).length);
let receiverCalls = 0;
let startCalls = 0;
function receiver() { receiverCalls++; return a; }
function start() { startCalls++; a.push(40); return 1; }
console.log(receiver().slice(start()).join(','));
console.log(receiverCalls, startCalls, a.join(','));
