import ts from "typescript";

// Validate the original AST, including unused functions and imported modules.
// These constructs have no lowering: accepting them after erasure can silently
// drop effects (spread/disposal/tagged templates). Do not scan type-only syntax.
export function validateUnsupportedSyntax(sourceFile, reject) {
  const visit = node => {
    if (ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)
      || node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DeclareKeyword)) return;
    if (ts.isVariableDeclarationList(node) && (node.flags & ts.NodeFlags.Using)) {
      reject(node, "using declarations are not supported: automatic resource disposal is not implemented; use an ordinary const binding and call an explicit cleanup function");
    }
    if (ts.isBigIntLiteral(node)) {
      reject(node, "BigInt literals are not supported: target arithmetic uses numbers, not arbitrary-precision integers; use number values within the safe integer range or represent large integers as text");
    }
    if (ts.isFunctionLike(node) && node.asteriskToken) {
      reject(node.asteriskToken, "Generator functions are not supported: calling a generator creates an iterator without executing its body; alternative: return an array instead or use an ordinary callback");
    }
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken].includes(node.operatorToken.kind)) {
      reject(node.operatorToken, "Logical assignment ||= / &&= is not supported: the assignment backend cannot preserve short-circuit evaluation; alternative: use an explicit if statement and assign only in the selected branch");
    }
    if (ts.isForInStatement(node)) {
      reject(node, "for...in enumerates property keys, not list elements; use for...of or an explicit index loop");
    }
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) {
      const clause = node.importClause;
      if (!clause || clause.name || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings) || clause.namedBindings.elements.length === 0) {
        reject(node, "Only named imports are supported: default, namespace, side-effect and empty imports have no runtime module initialization; use a relative named function import and call an exported init function explicitly");
      }
    }
    if (node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword)) {
      reject(node, "Default exports are not supported: modules expose named functions only; use export function name(...) and a named import");
    }
    if (ts.isTaggedTemplateExpression(node)) {
      reject(node, "Tagged templates are not supported: template objects and tag invocation are not implemented; use an ordinary function call with explicit string arguments");
    }
    if (ts.isMetaProperty(node)) {
      reject(node, "import.meta / new.target are not supported: target scripts have no JavaScript module or constructor metadata; pass the required value as an explicit argument");
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      reject(node, "Dynamic import() is not supported: runtime module loading and Promises are not implemented; use a static relative named import of a function");
    }
    if (ts.isSpreadElement(node) && (ts.isCallExpression(node.parent) || ts.isNewExpression(node.parent))) {
      const callee = node.parent.expression;
      if (ts.isPropertyAccessExpression(callee) && ["replace", "replaceAll"].includes(callee.name.text)) {
        reject(node.parent, `String.${callee.name.text} supports 2 non-spread argument(s); pass the string search and replacement explicitly`);
      }
      reject(node, "Spread arguments are not supported: calls need an explicit argument list; pass each argument explicitly or pass an array to a function that accepts an array");
    }
    if (ts.isSpreadElement(node) && ts.isArrayLiteralExpression(node.parent)) {
      // Assignment patterns share ArrayLiteralExpression syntax with values.
      // Let destructuring lowering diagnose a rest target (not an iterable
      // spread), or the dense-literal RHS requirement, on the original tree.
      let array = node.parent;
      while (ts.isParenthesizedExpression(array.parent)) array = array.parent;
      const assignment = array.parent;
      let target = assignment && ts.isBinaryExpression(assignment) ? assignment.left : undefined;
      while (target && ts.isParenthesizedExpression(target)) target = target.expression;
      const destructuring = assignment && ts.isBinaryExpression(assignment)
        && assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && target && ts.isArrayLiteralExpression(target);
      if (!destructuring) {
        reject(node, "Array spread is not supported: the list backend does not expand iterable elements; use slice() for a shallow copy, concat() for arrays, or an explicit for-of loop");
      }
    }
    if (ts.isVoidExpression(node)) {
      let value = node.expression;
      while (ts.isParenthesizedExpression(value)) value = value.expression;
      if (!ts.isNumericLiteral(value) || value.text !== "0") {
        reject(node, "void expressions other than void 0 are not supported: discarding a value must still preserve its effects and return undefined; evaluate the expression as a separate statement, then use an explicitly typed undefined value if needed");
      }
    }
    if (ts.isDebuggerStatement(node)) {
      reject(node, "debugger statements are not supported: generated blocks have no JavaScript debugger breakpoint; use console.log to inspect scalar values");
    }
    if (ts.isWithStatement(node)) {
      reject(node, "with statements are not supported: bindings must resolve statically; use explicit object.property access");
    }
    if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly) {
      reject(node, "import = declarations are not supported: CommonJS and namespace aliases have no runtime loader; use a static relative named import of a function");
    }
    if (ts.isExportAssignment(node)) {
      reject(node, "Default/export = assignments are not supported: modules expose named functions only; use export function name(...) and a named import");
    }
    if (ts.isExportDeclaration(node) && !node.isTypeOnly
      && (!node.exportClause || !ts.isNamedExports(node.exportClause)
        || node.exportClause.elements.some(element => !element.isTypeOnly))) {
      reject(node, "Value export lists and re-exports are not supported: only direct function exports are registered; use export function name(...) and import directly from its module");
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

// Keep the original reason stable for existing clients; only add a rewrite
// hint where older backend diagnostics did not provide one.
export function unsupportedMessage(node, message) {
  if (/\b(?:alternative:|use |instead|rename|remove |replace |pass |initialize |add |rewrite |split |convert |narrow |move |copy |return an array)/i.test(message)) return message;
  let advice;
  if (/import|export|module/i.test(message)) advice = "export a named function from a relative .ts module and import it by the same name";
  else if (/parameter|argument/i.test(message)) advice = "pass explicit arguments matching the declared parameters; use a named parameter with a default instead of destructuring or rest";
  else if (/destructur|variable name/i.test(message)) advice = "bind a simple variable, then read each property or array element explicitly";
  else if (/Math/.test(message)) advice = "compose supported Math operations or write an ordinary numeric helper (see docs/js-support.md)";
  else if (node && ts.isNewExpression(node)) advice = "use an initialized data object, an array, or a supported class/Map/Set constructor (see docs/js-support.md)";
  else if (node && ts.isCallExpression(node)) advice = "call a declared function or a supported builtin directly (see docs/js-support.md); replace host APIs with explicit inputs and events";
  else advice = "rewrite this construct as explicit variables, if/while statements and ordinary function calls (see docs/js-support.md)";
  return `${message}; alternative: ${advice}`;
}
