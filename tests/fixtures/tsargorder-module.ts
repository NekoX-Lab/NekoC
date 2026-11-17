function a(): number { console.log("A"); return 1; }
export function b(): number { console.log("B"); return 2; }
export function f(x = a(), unused = 0): number { return x; }
