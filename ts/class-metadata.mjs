import ts from "typescript";

// Trust is attached to parsed nodes, never inferred from a user's identifier.
// The class pass reserves helper names before creating these declarations.
export const classAllocationPlaceholders = new WeakSet();
export const classFunctionNames = new WeakMap();
export const classSourceOrigins = new WeakMap();
export const classNodeOrigins = new WeakMap();

// Printing/reparsing discards TypeScript's original-node links. Pair the
// emitted tree with the tree it was printed from before those links are lost.
export function mapPrintedClassNodes(parsed, printed, file, fallback) {
  const original = ts.getOriginalNode(printed);
  const origin = classNodeOrigins.get(printed) ?? classNodeOrigins.get(original)
    ?? (original.pos >= 0 ? { file, offset: original.getStart() } : fallback);
  if (origin) classNodeOrigins.set(parsed, origin);
  const children = [], originals = [];
  ts.forEachChild(parsed, node => { children.push(node); });
  ts.forEachChild(printed, node => { originals.push(node); });
  if (children.length !== originals.length) return;
  children.forEach((node, index) => {
    if (node.kind === originals[index].kind) mapPrintedClassNodes(node, originals[index], file, origin);
  });
}

// A textual method replacement only invalidates positions inside that edit;
// nodes elsewhere retain their precise origin even if an earlier edit grew.
export function copyClassNodeOrigins(input, output, edits = []) {
  const mapped = new Map();
  const collect = node => {
    const origin = classNodeOrigins.get(node);
    if (origin) mapped.set(`${node.kind}:${node.getStart(input)}`, origin);
    ts.forEachChild(node, collect);
  };
  collect(input);
  if (!mapped.size) return;
  const ordered = [...edits].sort((a, b) => a.start - b.start);
  const visit = node => {
    const position = node.getStart(output);
    let shift = 0, offset = position, replacement = false;
    for (const edit of ordered) {
      const start = edit.start + shift;
      if (position < start) break;
      if (position < start + edit.text.length) {
        offset = edit.start;
        replacement = true;
        break;
      }
      shift += edit.text.length - (edit.end - edit.start);
      offset = position - shift;
    }
    const origin = mapped.get(`${node.kind}:${offset}`)
      ?? (replacement ? mapped.get(`${ts.SyntaxKind.CallExpression}:${offset}`) : undefined);
    if (origin) classNodeOrigins.set(node, origin);
    ts.forEachChild(node, visit);
  };
  visit(output);
}

export function markClassHelpers(file, names) {
  classFunctionNames.set(file, names);
  for (const statement of file.statements) {
    if (!ts.isFunctionDeclaration(statement) || !names.has(statement.name?.text)) continue;
    for (const child of statement.body?.statements ?? []) {
      if (!ts.isVariableStatement(child)) continue;
      for (const declaration of child.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.name.text.startsWith("__nekocClass_")
          || !declaration.initializer || !ts.isObjectLiteralExpression(declaration.initializer)) continue;
        for (const property of declaration.initializer.properties) {
          if (ts.isPropertyAssignment(property)) classAllocationPlaceholders.add(property.initializer);
        }
      }
    }
  }
}
