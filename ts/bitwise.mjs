import ts from "typescript";

// All arithmetic stays exact after ToUint32. In particular, discard the high
// bits BEFORE left-shift multiplication (a * 2**31 could exceed 2**53).
const helpers = {
  uint: { source: `function __nekocBit_uint(x) {
    if (!(Math.abs(x) <= 1.7976931348623157e308)) return 0;
    let n = 0;
    if (x < 0) n = Math.ceil(x); else n = Math.floor(x);
    n = n % 4294967296;
    if (n === 0) return 0;
    if (n < 0) n += 4294967296;
    return n;
  }` },
  signed: { source: `function __nekocBit_signed(x) {
    if (x >= 2147483648) return x - 4294967296;
    return x;
  }` },
  int: { needs: ["uint", "signed"], source: `function __nekocBit_int(x) {
    return __nekocBit_signed(__nekocBit_uint(x));
  }` },
  not: { needs: ["int"], source: `function __nekocBit_not(x) { return -1 - __nekocBit_int(x); }` },
  mask: { needs: ["uint"], source: `function __nekocBit_mask(x, modulus) { return __nekocBit_uint(x) % modulus; }` },
  power: { needs: ["uint"], source: `function __nekocBit_power(x) { return Math.pow(2, __nekocBit_uint(x) % 32); }` },
  shl: { needs: ["uint", "signed"], source: `function __nekocBit_shl(x, power) {
    return __nekocBit_signed((__nekocBit_uint(x) % (4294967296 / power)) * power);
  }` },
  shr: { needs: ["int"], source: `function __nekocBit_shr(x, power) { return Math.floor(__nekocBit_int(x) / power); }` },
  ushr: { needs: ["uint"], source: `function __nekocBit_ushr(x, power) { return Math.floor(__nekocBit_uint(x) / power); }` },
};
for (const [name, condition] of [["and", "a % 2 + b % 2 === 2"], ["or", "a % 2 + b % 2 > 0"], ["xor", "a % 2 !== b % 2"]]) {
  helpers[name] = { needs: ["uint", "signed"], source: `function __nekocBit_${name}(x, y) {
    let a = __nekocBit_uint(x); let b = __nekocBit_uint(y);
    let result = 0; let bit = 1;
    while (a > 0 || b > 0) {
      if (${condition}) result += bit;
      a = Math.floor(a / 2); b = Math.floor(b / 2); bit *= 2;
    }
    return __nekocBit_signed(result);
  }` };
}

export const bitwiseTokens = new Map([
  [ts.SyntaxKind.AmpersandToken, "and"], [ts.SyntaxKind.BarToken, "or"], [ts.SyntaxKind.CaretToken, "xor"],
  [ts.SyntaxKind.LessThanLessThanToken, "shl"], [ts.SyntaxKind.GreaterThanGreaterThanToken, "shr"],
  [ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken, "ushr"], [ts.SyntaxKind.TildeToken, "not"],
]);
export const bitwiseAssignments = new Map([
  [ts.SyntaxKind.AmpersandEqualsToken, ts.SyntaxKind.AmpersandToken],
  [ts.SyntaxKind.BarEqualsToken, ts.SyntaxKind.BarToken],
  [ts.SyntaxKind.CaretEqualsToken, ts.SyntaxKind.CaretToken],
  [ts.SyntaxKind.LessThanLessThanEqualsToken, ts.SyntaxKind.LessThanLessThanToken],
  [ts.SyntaxKind.GreaterThanGreaterThanEqualsToken, ts.SyntaxKind.GreaterThanGreaterThanToken],
  [ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken, ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken],
]);

const call = (name, args) => ts.factory.createCallExpression(ts.factory.createIdentifier(`__nekocBit_${name}`), undefined, args);
const number = n => ts.factory.createNumericLiteral(n);

// This same plan is used for discovery and emission, including compound writes
// to synthesized heap/array reads. Only literal (side-effect-free) constants
// are eliminated; every remaining argument is evaluated once, left to right.
export function bitwisePlan(operator, left, right, constantNumber) {
  let name = bitwiseTokens.get(operator);
  let args = right ? [left, right] : [left];
  const needs = new Set();
  const need = name => {
    if (needs.has(name)) return;
    for (const dependency of helpers[name].needs ?? []) need(dependency);
    needs.add(name);
  };
  if (right) {
    const b = constantNumber(right);
    if (["shl", "shr", "ushr"].includes(name)) {
      if (b !== null) args = [left, number(2 ** (b & 31))];
      else { need("power"); args = [left, call("power", [right])]; }
      if (b !== null && (b & 31) === 0) { name = name === "ushr" ? "uint" : "int"; args = [left]; }
    } else if ((name === "or" || name === "xor") && b !== null && (b | 0) === 0
      || name === "and" && b !== null && (b | 0) === -1) {
      name = "int"; args = [left];
    } else if (name === "and" && b !== null) {
      const mask = b >>> 0;
      if (mask < 2147483648 && Number.isInteger(Math.log2(mask + 1))) {
        name = "mask"; args = [left, number(mask + 1)];
      }
    }
  }
  need(name);
  return { expression: call(name, args), sources: [...needs].map(name => helpers[name].source) };
}
