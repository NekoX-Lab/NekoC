let calls = 0;
const a = [10, 20, 30];
function array(): number[] { calls++; return a; }
console.log(array().slice(1).join(','));
console.log(calls);
