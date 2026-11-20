import ts from "typescript";

// Lowering can reparse printed code. Never publish its generated line numbers
// as user locations. Reparsed text, even a unique identical AST node, cannot
// establish provenance: a different, unused function may contain that text.
// Such nodes remain block-only until the lowering supplies a precise origin.
export function runtimeSourceLocation(node, originalFiles, helperOrigins, resolve) {
  if (!node) return null;
  const origin = helperOrigins.get(node) ?? helperOrigins.get(ts.getOriginalNode(node));
  const file = origin?.file ?? node.getSourceFile?.();
  if (!file || (!origin && !(node.pos >= 0))) return null;
  const original = originalFiles.get(resolve(file.fileName));
  if (!original) return null;
  if (file.text !== original.text) return null;
  const offset = origin?.offset ?? node.getStart(file);
  const { line, character } = original.getLineAndCharacterOfPosition(offset);
  return { file: original.fileName, line: line + 1, column: character + 1 };
}
