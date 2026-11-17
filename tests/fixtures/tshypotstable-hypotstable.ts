let x = 1e200;
let y = 1e-200;
console.log(Math.hypot(x, x) === Infinity);
console.log(Math.hypot(y, y) > 0);
