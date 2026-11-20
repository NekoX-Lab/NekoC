// Shared by the Node frontend and the browser SDK. Locations refer to the
// original source, never a lowering's generated helpers. No filesystem globals.
function suggestionFor({ source, code, message }) {
  const alternative = message.match(/alternative:\s*([\s\S]+)/i);
  if (alternative) return alternative[1].trim();
  if (code === "NEKOC_INTERNAL") return "Report this compiler error with the source file and a minimal reproduction.";
  if (/Unable to read|not found|Cannot find module|Unable to resolve import/i.test(message)) {
    return "Check the file path, spelling and relative import path, and make sure the source file is readable.";
  }
  if (source === "syntax") return "Fix the syntax at the marked position; check for a missing expression, delimiter or closing bracket.";
  if (source === "types") {
    if (["TS2304", "TS2552"].includes(code)) return "Check the name's spelling and declare or import it before use; see docs/api.md for available APIs.";
    if (["TS2322", "TS2345"].includes(code)) return "Make the value's type match the declared variable or parameter type; use an explicit conversion if needed.";
    if (["TS2554", "TS2555"].includes(code)) return "Pass the number of arguments required by the function signature; see ts/nekoc.d.ts or docs/api.md.";
    return "Check the reported types and the declaration in ts/nekoc.d.ts or docs/api.md, then correct the value or call.";
  }
  // Many compatibility checks already explain a supported rewrite. Expose it
  // separately so editors do not need to parse prose to display a suggestion.
  const rewrite = message.match(/(?:;\s*|\.\s+)((?:use|replace|remove|rename|move|convert|pass|omit|only|first|narrow|select|inline|split)\b[\s\S]+)/i);
  if (rewrite) return rewrite[1].trim();
  if (/relative imports/i.test(message)) return "Use a relative import such as ./helper.ts instead of a package import.";
  if (/callback/i.test(message)) return "Pass a block arrow callback, for example onStart(() => { /* code */ }).";
  return "Rewrite the marked construct using the supported TypeScript subset and APIs in llms.txt and docs/api.md.";
}

/** Add presentation fields without inventing unavailable source coordinates. */
export function enrichDiagnostic(diagnostic, readFile) {
  let snippet = diagnostic.snippet ?? null;
  if (snippet === null && diagnostic.file && diagnostic.line > 0) {
    try {
      const text = readFile?.(diagnostic.file);
      if (typeof text === "string") snippet = text.split(/\r\n|[\n\r\u2028\u2029]/)[diagnostic.line - 1] ?? null;
    } catch { /* A failed source read must not hide the original diagnostic. */ }
  }
  return { ...diagnostic, snippet, suggestion: diagnostic.suggestion || suggestionFor(diagnostic) };
}

export function formatDiagnostic(d) {
  const where = d.file ? d.line && d.column ? `${d.file}:${d.line}:${d.column}` : d.file : "";
  const lines = [`${where ? `${where}: ` : ""}${d.severity} ${d.code}: ${d.message}${d.source ? ` [${d.source}]` : ""}`];
  if (typeof d.snippet === "string" && d.line && d.column) {
    const gutter = String(d.line);
    lines.push(`  ${gutter} | ${d.snippet}`, `  ${" ".repeat(gutter.length)} | ${d.snippet.slice(0, d.column - 1).replace(/[^\t]/g, " ")}^`);
  }
  if (d.suggestion) lines.push(`  help: ${d.suggestion}`);
  return lines.join("\n");
}
