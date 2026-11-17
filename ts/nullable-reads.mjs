import ts from "typescript";

const unwrap = node => {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)
    || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node)
    || ts.isSatisfiesExpression(node)) node = node.expression;
  return node;
};
const nilType = type => !!type && (type.isUnion() ? type.types : [type])
  .some(part => part.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void));

// Both original replacement validation and nullable String lowering must use
// the same proof for a raw value captured after TS narrowing became stale.
export function createNullableReadAnalysis(checker, declaredReadType, flowKind) {
  const writesByFile = new WeakMap();
  const nullishWritesByFile = new WeakMap();
  const readSymbol = node => ts.isIdentifier(node) ? checker.getSymbolAtLocation(node)
    : ts.isPropertyAccessExpression(node) ? checker.getSymbolAtLocation(node.name)
    : ts.isElementAccessExpression(node) ? readSymbol(node.expression) : null;
  const captureSources = node => {
    const symbol = readSymbol(node);
    if (!symbol) return [];
    const declaration = symbol.valueDeclaration;
    const sources = declaration?.initializer ? [declaration.initializer] : [];
    if (declaration && ts.isShorthandPropertyAssignment(declaration)) {
      const value = checker.getShorthandAssignmentValueSymbol(declaration)?.valueDeclaration;
      if (value?.initializer) sources.push(value.initializer);
    }
    const file = node.getSourceFile();
    if (!writesByFile.has(file)) {
      const writes = new Map();
      const visit = part => {
        if (ts.isBinaryExpression(part) && part.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          const left = unwrap(part.left);
          const target = readSymbol(left);
          if (target) {
            if (!writes.has(target)) writes.set(target, []);
            writes.get(target).push({ element: ts.isElementAccessExpression(left), source: part.right });
          }
        }
        ts.forEachChild(part, visit);
      };
      visit(file);
      writesByFile.set(file, writes);
    }
    // Include writes in nested functions and across loop back edges. No call
    // purity/alias assumptions or source-order-as-execution-order proof.
    return nilType(declaredReadType(node)) ? sources
      : sources.concat((writesByFile.get(file).get(symbol) ?? [])
        .filter(write => !write.element || ts.isElementAccessExpression(node)).map(write => write.source));
  };
  const canWriteNullish = node => {
    const file = node.getSourceFile();
    if (!nullishWritesByFile.has(file)) {
      const symbols = new Set();
      const visit = part => {
        if (ts.isBinaryExpression(part) && part.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
          && part.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
          const target = unwrap(part.left);
          if (ts.isIdentifier(target) && (nilType(checker.getTypeAtLocation(part.right))
            || nilType(declaredReadType(unwrap(part.right))))) symbols.add(readSymbol(target));
        }
        ts.forEachChild(part, visit);
      };
      visit(file);
      nullishWritesByFile.set(file, symbols);
    }
    return nullishWritesByFile.get(file).has(readSymbol(node));
  };
  const unstableRead = (expression, seen = new Set()) => {
    const node = unwrap(expression);
    if (seen.has(node)) return false;
    seen.add(node);
    if (ts.isConditionalExpression(node)) return unstableRead(node.whenTrue, seen) || unstableRead(node.whenFalse, seen);
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if ([ts.SyntaxKind.CommaToken, ts.SyntaxKind.QuestionQuestionToken].includes(op)) return unstableRead(node.right, seen);
      return unstableRead(node.left, seen) || unstableRead(node.right, seen);
    }
    if (ts.isArrayLiteralExpression(node)) return node.elements.some(value => unstableRead(value, seen));
    if (ts.isTemplateExpression(node)) return node.templateSpans.some(span => unstableRead(span.expression, seen));
    if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) return unstableRead(node.operand, seen);
    if (captureSources(node).some(source => unstableRead(source, seen))) return true;
    if ((!readSymbol(node) && !ts.isElementAccessExpression(node)) || !nilType(declaredReadType(node))) return false;
    // Calls alone cannot invalidate a scalar binding when this program has no
    // assignment that could put null/undefined in it. Inspect nested functions
    // too, but do not infer property/array alias safety from this binding fact.
    if (ts.isIdentifier(node) && !canWriteNullish(node)) return false;
    let scope = node;
    while (scope.parent && !ts.isFunctionLike(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
    const readStart = node.end;
    let checkpoint = scope.getStart();
    if (ts.isIdentifier(node)) {
      const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration;
      if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer
        && declaration.end <= readStart && declaration.getStart() >= checkpoint
        && flowKind(declaration.initializer) === "string") checkpoint = declaration.end;
    }
    const sameRead = value => {
      value = unwrap(value);
      if (ts.isIdentifier(node) && ts.isIdentifier(value)) {
        return checker.getSymbolAtLocation(node) === checker.getSymbolAtLocation(value);
      }
      return value.getText() === node.getText();
    };
    const guardsRead = condition => {
      condition = unwrap(condition);
      if (!ts.isBinaryExpression(condition)) return false;
      const op = condition.operatorToken.kind;
      if (op === ts.SyntaxKind.AmpersandAmpersandToken) return guardsRead(condition.left) || guardsRead(condition.right);
      if (![ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(op)) return false;
      return sameRead(condition.left) && nilType(checker.getTypeAtLocation(condition.right))
        || sameRead(condition.right) && nilType(checker.getTypeAtLocation(condition.left));
    };
    for (let child = node, parent = child.parent; parent && parent !== scope; child = parent, parent = parent.parent) {
      if (ts.isIfStatement(parent) && child === parent.thenStatement && guardsRead(parent.expression)
        || ts.isConditionalExpression(parent) && child === parent.whenTrue && guardsRead(parent.condition)) {
        const condition = ts.isIfStatement(parent) ? parent.expression : parent.condition;
        checkpoint = Math.max(checkpoint, condition.getStart());
      }
    }
    for (let parent = node.parent; parent && parent !== scope; parent = parent.parent) {
      if ((ts.isForStatement(parent) || ts.isForInStatement(parent) || ts.isForOfStatement(parent)
        || ts.isWhileStatement(parent) || ts.isDoStatement(parent)) && checkpoint <= parent.getStart()) return true;
    }
    const effectBeforeRead = value => {
      if (value.end <= checkpoint || value.getStart() >= readStart) return false;
      if (value !== scope && ts.isFunctionLike(value)) return false;
      if (value.end <= readStart && (ts.isCallExpression(value) || ts.isNewExpression(value)
        || ts.isTaggedTemplateExpression(value) || ts.isAwaitExpression(value) || ts.isYieldExpression(value)
        || ts.isDeleteExpression(value)
        || ts.isBinaryExpression(value) && value.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
          && value.operatorToken.kind <= ts.SyntaxKind.LastAssignment
        || (ts.isPrefixUnaryExpression(value) || ts.isPostfixUnaryExpression(value))
          && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(value.operator))) return true;
      return !!ts.forEachChild(value, effectBeforeRead);
    };
    return effectBeforeRead(scope);
  };
  const unsafeCapture = expression => {
    const visit = node => {
      if (ts.isFunctionLike(node)) return false;
      // Declared nullable reads can be decoded at this read. A nonnullable
      // snapshot instead needs a proven initializer AND every possible write.
      if (readSymbol(node) && !nilType(declaredReadType(node)) && unstableRead(node)) return true;
      // Names in obj.name are not an additional value read.
      if (ts.isPropertyAccessExpression(node)) return visit(node.expression);
      if (ts.isElementAccessExpression(node)) return visit(node.argumentExpression);
      return !!ts.forEachChild(node, visit);
    };
    return visit(expression);
  };
  return { unstableRead, unsafeCapture };
}
