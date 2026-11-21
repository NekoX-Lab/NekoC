import ts from "typescript";
import { evaluatedChoice, evaluatedValue, lazyChoice, returnChoice } from "./control-expressions.mjs";
import { equalityValue } from "./js-equality.mjs";

// Block lowering for the reserved calls emitted by tsfeat-nullable.mjs.
// Only official text/number/compare/logic/control/custom-block blocks are used.
const PATTERN = /__nekocNil(Null|Undef|Is|Truthy|Text|Coalesce|If|LooseEq)_([RNBS])_\d+$/;

export function nilIntrinsic(name) {
  const match = typeof name === "string" && PATTERN.exec(name);
  return match ? { op: match[1], domain: match[2] } : null;
}

// Strings use numbers; every other domain uses text (docs/ts-nullable.md).
function sentinel(c, domain, kind, parentId) {
  return domain === "S"
    ? c.addBlock({ type: "math_number", parent_id: parentId, fields: { NUM: kind === "Null" ? "-1" : "-2" }, is_output: true })
    : c.addBlock({ type: "text", parent_id: parentId, fields: { TEXT: kind === "Null" ? "null" : "undefined" }, is_output: true });
}

function equals(c, domain, value, kind, parentId) {
  const id = c.addBlock({ type: "logic_compare", parent_id: parentId, fields: { OP: "EQ" }, is_output: true });
  c.connectInput(id, c.compileExpression(value, id), "A", "value");
  c.connectInput(id, sentinel(c, domain, kind, id), "B", "value");
  return id;
}

function logic(c, op, left, right, parentId) {
  const id = c.addBlock({ type: "logic_operation", parent_id: parentId, fields: { type: op }, is_output: true });
  c.connectInput(id, left(id), "A", "value");
  c.connectInput(id, right(id), "B", "value");
  return id;
}

function isNil(c, domain, value, parentId) {
  return logic(c, "or", id => equals(c, domain, value, "Null", id), id => equals(c, domain, value, "Undef", id), parentId);
}

function bool(c, value, parentId) {
  return c.addBlock({ type: "logic_boolean", parent_id: parentId, fields: { BOOL: value ? "true" : "false" }, is_output: true });
}

function text(c, value, parentId) {
  return c.addBlock({ type: "text", parent_id: parentId, fields: { TEXT: value }, is_output: true });
}

const simple = node => ts.isIdentifier(node) || node.kind === ts.SyntaxKind.ThisKeyword;

export function compileNilIntrinsic(c, { op, domain }, call, parentId) {
  const [a, b, d] = call.arguments;
  switch (op) {
    case "Null": case "Undef":
      return sentinel(c, domain, op, parentId);
    case "Is":
      if (simple(a)) return isNil(c, domain, a, parentId);
      return evaluatedValue(c, a, parentId, (value, ret) => isNil(c, domain, value, ret));
    case "Truthy": {
      if (domain === "R") {
        const id = c.addBlock({ type: "logic_negate", parent_id: parentId, is_output: true });
        c.connectInput(id, compileNilIntrinsic(c, { op: "Is", domain }, call, id), "logic", "value");
        return id;
      }
      // JS truthiness of the non-null value is the existing if (value) test.
      return evaluatedChoice(c, [a], parentId, ([value], definition) => returnChoice(c, definition,
        id => isNil(c, domain, value, id),
        ret => bool(c, false, ret),
        ret => lazyBool(c, value, ret)));
    }
    case "Text":
      if (domain !== "S") return c.compileExpression(a, parentId);
      return evaluatedChoice(c, [a], parentId, ([value], definition) => returnChoice(c, definition,
        id => equals(c, domain, value, "Null", id),
        ret => text(c, "null", ret),
        ret => evaluatedChoice(c, [value], ret, ([inner], innerDefinition) => returnChoice(c, innerDefinition,
          id => equals(c, domain, inner, "Undef", id),
          ret2 => text(c, "undefined", ret2),
          ret2 => c.compileExpression(inner, ret2)))));
    case "Coalesce":
      // The fallback is compiled inside the branch, so it runs only for null/undefined.
      return evaluatedChoice(c, [a], parentId, ([value], definition) => returnChoice(c, definition,
        id => isNil(c, domain, value, id),
        ret => c.compileExpression(b, ret),
        ret => c.compileExpression(value, ret)));
    case "If":
      return lazyChoice(c, a, b, d, parentId);
    case "LooseEq":
      return evaluatedChoice(c, [a, b], parentId, ([left, right], definition) => {
        const ret = c.addReturnValueBlock(definition);
        c.connectInput(ret, logic(c, "or",
          id => logic(c, "and", x => isNil(c, domain, left, x), x => isNil(c, domain, right, x), id),
          id => {
            if (domain === "N" && c.target.name === "kitten-n") return equalityValue(c, left, right, id);
            const eq = c.addBlock({ type: "logic_compare", parent_id: id, fields: { OP: "EQ" }, is_output: true });
            c.connectInput(eq, c.compileExpression(left, eq), "A", "value");
            c.connectInput(eq, c.compileExpression(right, eq), "B", "value");
            return eq;
          }, ret), "VALUE", "value");
        return ret;
      });
    default:
      return c.unsupported(call, "Unknown null/undefined helper");
  }
}

// if (value) return true; else return false; nested in an existing reporter.
function lazyBool(c, value, parentId) {
  return evaluatedChoice(c, [value], parentId, ([inner], definition) => returnChoice(c, definition,
    id => c.compileExpression(inner, id),
    ret => bool(c, true, ret),
    ret => bool(c, false, ret)));
}
