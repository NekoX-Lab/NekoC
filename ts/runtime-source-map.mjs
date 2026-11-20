import ts from "typescript";

// Lowering can reparse printed code. Never publish its generated line numbers
// as user locations. Keep original ranges when the text is unchanged, otherwise
// accept only a unique, unchanged source span. Ambiguous/generated spans remain
// block-only until that lowering pass supplies a precise origin.
export function runtimeSourceLocation(node, originalFiles, helperOrigins, resolve) {
  if (!node) return null;
  const origin = helperOrigins.get(node) ?? helperOrigins.get(ts.getOriginalNode(node));
  const file = origin?.file ?? node.getSourceFile?.();
  if (!file || (!origin && !(node.pos >= 0))) return null;
  const original = originalFiles.get(resolve(file.fileName));
  if (!original) return null;
  let offset = origin?.offset ?? node.getStart(file);
  if (file.text !== original.text) {
    if (origin) return null;
    const span = file.text.slice(offset, node.end);
    if (!span.trim()) return null;
    // Text in comments, strings or a larger identifier is not an origin. Only
    // complete nodes of the same kind can establish an unchanged source span.
    const candidates = [];
    const visit = candidate => {
      if (candidate.kind === node.kind && candidate.getText(original) === span) {
        candidates.push(candidate.getStart(original));
      }
      ts.forEachChild(candidate, visit);
    };
    visit(original);
    if (candidates.length !== 1) return null;
    [offset] = candidates;
  }
  const { line, character } = original.getLineAndCharacterOfPosition(offset);
  return { file: original.fileName, line: line + 1, column: character + 1 };
}
