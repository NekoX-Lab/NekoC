import ts from "typescript";

// Trust is attached to parsed nodes, never inferred from a user's identifier.
// The class pass reserves helper names before creating these declarations.
export const classAllocationPlaceholders = new WeakSet();
export const classFunctionNames = new WeakMap();
export const classSourceOrigins = new WeakMap();

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
