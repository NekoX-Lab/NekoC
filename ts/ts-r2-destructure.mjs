import ts from "typescript";

// Lower the shallow, statically keyed subset before nullable/class passes so
// ordinary property reads keep their type information and existing checks.
// The backend still owns object identity, array storage and invocation frames.
export function lowerTsDestructuring(sourceFile) {
  const names = new Set();
  const collect = node => {
    if (ts.isIdentifier(node)) names.add(node.text);
    ts.forEachChild(node, collect);
  };
  collect(sourceFile);
  let salt = 2166136261;
  for (const ch of sourceFile.fileName.replaceAll("\\", "/")) salt = Math.imul(salt ^ ch.charCodeAt(0), 16777619) >>> 0;
  let serial = 0;
  const fresh = () => {
    let name;
    do { name = `__nekocDestructure_${salt}_${++serial}`; } while (names.has(name));
    names.add(name);
    return name;
  };
  const fail = (node, message) => {
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    const error = new Error(message);
    error.name = "CompileError";
    error.code = "NEKOC_TS_DESTRUCTURE";
    error.location = { file: sourceFile.fileName, line: position.line + 1, column: position.character + 1 };
    throw error;
  };
  const unwrap = node => {
    while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)
      || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node)
      || ts.isSatisfiesExpression(node))) node = node.expression;
    return node;
  };
  const edits = [];
  let checker;
  const writableTarget = node => {
    if (!checker) {
      const host = {
        getSourceFile: name => name === sourceFile.fileName ? sourceFile : undefined,
        getDefaultLibFileName: () => "", writeFile() {}, getCurrentDirectory: () => "",
        getDirectories: () => [], fileExists: name => name === sourceFile.fileName,
        readFile: () => undefined, getCanonicalFileName: name => name,
        useCaseSensitiveFileNames: () => true, getNewLine: () => "\n",
      };
      checker = ts.createProgram([sourceFile.fileName], { noLib: true, noResolve: true }, host).getTypeChecker();
    }
    const declarations = checker.getSymbolAtLocation(node)?.declarations;
    return declarations?.length && declarations.every(declaration => {
      if (ts.isParameter(declaration)) return ts.isIdentifier(declaration.name);
      while (ts.isBindingElement(declaration)) declaration = declaration.parent.parent;
      return ts.isVariableDeclaration(declaration) && ts.isVariableDeclarationList(declaration.parent)
        && !(declaration.parent.flags & ts.NodeFlags.Const);
    });
  };
  // Inner edits are consumed by an enclosing replacement. This keeps unrelated
  // source/comments intact, including declarations before/after a pattern.
  const render = node => {
    const start = node.getStart(sourceFile);
    let text = sourceFile.text.slice(start, node.end);
    for (const edit of edits.filter(edit => edit.start >= start && edit.end <= node.end)
      .sort((a, b) => b.start - a.start)) {
      text = text.slice(0, edit.start - start) + edit.text + text.slice(edit.end - start);
    }
    return text;
  };
  const replace = (node, text) => {
    const start = node.getStart(sourceFile);
    for (let i = edits.length - 1; i >= 0; i--) {
      if (edits[i].start >= start && edits[i].end <= node.end) edits.splice(i, 1);
    }
    const oldLines = sourceFile.text.slice(start, node.end).match(/\n/g)?.length ?? 0;
    const newLines = text.match(/\n/g)?.length ?? 0;
    edits.push({ start, end: node.end, text: text + "\n".repeat(Math.max(0, oldLines - newLines)) });
  };
  const visit = node => {
    if (ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return;
    if (ts.isObjectBindingPattern(node)) {
      const declaration = node.parent;
      if (!ts.isVariableDeclaration(declaration) || !ts.isVariableDeclarationList(declaration.parent)
        || !ts.isVariableStatement(declaration.parent.parent)) {
        fail(node, "Object destructuring requires a standalone variable declaration; bind the parameter or loop value to a variable, then read its properties");
      }
      if (!declaration.initializer || !node.elements.length) {
        fail(node, "Object destructuring needs an initializer and at least one property; use an explicitly initialized object and property reads");
      }
      for (const element of node.elements) {
        if (element.dotDotDotToken || element.initializer || !ts.isIdentifier(element.name)) {
          fail(element, "Object destructuring rest, defaults and nested patterns are not supported; read properties explicitly and use ?? for an undefined fallback");
        }
        const key = element.propertyName ?? element.name;
        if (!(ts.isIdentifier(key) || ts.isStringLiteralLike(key) || ts.isNumericLiteral(key))) {
          fail(key, "Object destructuring keys must be literal property names; read a known property explicitly instead of a computed key");
        }
      }
    }
    ts.forEachChild(node, visit);
    if (ts.isVariableStatement(node) && node.declarationList.declarations.some(d => ts.isObjectBindingPattern(d.name))) {
      const kind = node.declarationList.flags & ts.NodeFlags.Const ? "const"
        : node.declarationList.flags & ts.NodeFlags.Let ? "let" : "var";
      const modifiers = node.modifiers?.map(modifier => modifier.getText(sourceFile)).join(" ") ?? "";
      const prefix = modifiers ? `${modifiers} ` : "";
      if (node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DeclareKeyword)) {
        fail(node, "Ambient object destructuring is not supported; declare the individual property bindings instead");
      }
      const statements = [];
      for (const declaration of node.declarationList.declarations) {
        if (!ts.isObjectBindingPattern(declaration.name)) {
          statements.push(`${prefix}${kind} ${render(declaration)};`);
          continue;
        }
        const saved = fresh();
        const type = declaration.type ? `: ${render(declaration.type)}` : "";
        statements.push(`const ${saved}${type} = (${render(declaration.initializer)});`);
        for (const element of declaration.name.elements) {
          const key = element.propertyName ?? element.name;
          const access = ts.isIdentifierText(key.text, sourceFile.languageVersion)
            ? `${saved}.${key.text}` : `${saved}[${JSON.stringify(key.text)}]`;
          statements.push(`${prefix}${kind} ${element.name.text} = ${access};`);
        }
      }
      const text = statements.join(" ");
      const parent = node.parent;
      const inList = ts.isSourceFile(parent) || ts.isBlock(parent) || ts.isCaseClause(parent) || ts.isDefaultClause(parent);
      replace(node, inList ? text : `{ ${text} }`);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isArrayLiteralExpression(unwrap(node.left))) {
      let statement = node;
      while (ts.isParenthesizedExpression(statement.parent)) statement = statement.parent;
      if (!ts.isExpressionStatement(statement.parent)) {
        fail(node, "Array destructuring assignments must be standalone statements; assign first, then read the result in a separate expression");
      }
      statement = statement.parent;
      const targets = unwrap(node.left).elements;
      const values = unwrap(node.right);
      if (!ts.isArrayLiteralExpression(values) || values.elements.some(element => ts.isOmittedExpression(element) || ts.isSpreadElement(element))) {
        fail(node.right, "Array destructuring assignment requires a dense array literal without spread; read existing array elements into explicit temporary variables instead");
      }
      targets.forEach((target, index) => {
        if (ts.isOmittedExpression(target)) return;
        if (!ts.isIdentifier(target)) {
          fail(target, "Array destructuring assignment supports only variable targets and elisions; split property targets, nested patterns, rest and defaults into explicit statements");
        }
        if (!writableTarget(target)) {
          fail(target, "Array destructuring assignment requires a declared mutable variable or parameter; declare a let binding instead of assigning to a constant, import or unknown name");
        }
        if (index >= values.elements.length) {
          fail(target, "Array destructuring assignment cannot read a missing element; supply every assigned value explicitly");
        }
      });
      const saved = fresh();
      // A real block prevents lazy expression inlining from duplicating the RHS
      // or discarding unused literal elements (which may have side effects).
      const statements = [`const ${saved} = (${render(node.right)});`];
      targets.forEach((target, index) => {
        if (!ts.isOmittedExpression(target)) statements.push(`${target.text} = ${saved}[${index}];`);
      });
      replace(statement, `{ ${statements.join(" ")} }`);
    }
  };
  visit(sourceFile);
  if (!edits.length) return sourceFile;
  let text = sourceFile.text;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  }
  return ts.createSourceFile(sourceFile.fileName, text, sourceFile.languageVersion, true, sourceFile.scriptKind);
}
