// Baseline after the fix/ts-semantics integration (originally main at
// 4e64c70a848088a6506f8b4979545d085625fef8; see README.md).
// Keys are stable 1-based indexes into the original two probe collections.
const errors = {
  28: "Functions cannot be stored or returned as runtime values",
  30: "Rest parameters",
  53: "for...in enumerates property keys",
  105: "Dynamic toFixed is not supported: scaled rounding does not reproduce J",
  110: "Cannot determine JavaScript + / += semantics for any, union or non-primitive operands",
  136: "Regular expressions are not supported",
  162: "Array index is statically out of bounds",
  183: "Reading a null/undefined variable at runtime is not supported",
  185: "Unsupported expression call: Date.now",
  186: "instanceof requires a statically known class identifier",
  187: "Unsupported binary expression operator",
  188: "delete is not supported",
  190: "Cannot determine JavaScript + / += semantics for any, union or non-primitive operands",
  197: "Cannot determine JavaScript + / += semantics for any, union or non-primitive operands",
  199: "Namespaces containing runtime values",
  204: "async / await are not supported",
  205: "Generator functions are not supported: gen",
  207: "Functions cannot be stored or returned as runtime values",
};
const diffs = {};
const extraErrors = {
  16: "Unsupported statement call: g.push",
  25: "Cannot determine JavaScript loose equality for any, union or non-primitive operands",
};
const extraDiffs = {
  36: {error: "reporter procedure recursion exceeds 200", node: "1000"},
};

export function baseline(group, index) {
  const error = (group === "core" ? errors : extraErrors)[index];
  const difference = (group === "core" ? diffs : extraDiffs)[index];
  return error ? { status: "compile-error", error }
    : difference ? { status: "known-diff", ...difference }
      : { status: "match" };
}
