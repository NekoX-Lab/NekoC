// Advisor's original finite variable probe (not literal-only folding).
let x = 1e200;
let y = 1e-200;
console.log(Math.hypot(x, x));
console.log(Math.hypot(y, y));
