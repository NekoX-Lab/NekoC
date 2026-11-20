import { evaluatedChoice } from "./control-expressions.mjs";

// KN EQ is type-sensitive but considers numeric NaN equal to numeric NaN.
// Compare against a numeric NaN, not String(value): text "NaN" is not NaN.
// Callers of equalityValue must supply already captured values.
export function equalityValue(c, left, right, parent, negate = false) {
  const compare = (a, b, p) => {
    const id = c.addBlock({ type: "logic_compare", parent_id: p, fields: { OP: "EQ" }, is_output: true });
    c.connectInput(id, a(id), "A", "value");
    c.connectInput(id, b(id), "B", "value");
    return id;
  };
  const nan = p => {
    const id = c.addBlock({ type: "math_arithmetic", parent_id: p, fields: { type: "divide" }, is_output: true });
    for (const input of ["A", "B"]) c.connectInput(id,
      c.addBlock({ type: "math_number", parent_id: id, fields: { NUM: "0" }, is_output: true }), input, "value");
    return id;
  };
  const not = (value, p) => {
    const id = c.addBlock({ type: "logic_negate", parent_id: p, is_output: true });
    c.connectInput(id, value(id), "logic", "value");
    return id;
  };
  const build = p => {
    const id = c.addBlock({ type: "logic_operation", parent_id: p, fields: { type: "and" }, is_output: true });
    c.connectInput(id, compare(x => c.compileExpression(left, x), x => c.compileExpression(right, x), id), "A", "value");
    // Once EQ holds, excluding NaN on one side excludes the NaN/NaN pair.
    c.connectInput(id, not(x => compare(y => c.compileExpression(left, y), nan, x), id), "B", "value");
    return id;
  };
  return negate ? not(build, parent) : build(parent);
}

export function jsEquality(c, left, right, parent, negate = false) {
  return evaluatedChoice(c, [left, right], parent, ([a, b], definition) => {
    const ret = c.addReturnValueBlock(definition);
    c.connectInput(ret, equalityValue(c, a, b, ret, negate), "VALUE", "value");
    return ret;
  });
}
