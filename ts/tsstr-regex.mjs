// A stateless literal-only RegExp subset. Never execute user regexes in the
// compiler: unsupported syntax is rejected before it reaches a KN workspace.
export function literalRegex(node, fail) {
  const raw = node.text;
  const end = raw.lastIndexOf("/");
  const reject = () => fail(node, "Regular expressions are not supported outside the literal test subset: RegExp.test supports only an immediate, flag-free literal with plain text and optional ^/$ anchors",
    "use /text/.test(value), /^text/.test(value), /text$/.test(value) or /^text$/.test(value); express character classes, repetition and stateful matching explicitly");
  if (end < 1 || end !== raw.length - 1) reject();
  const body = raw.slice(1, end);
  let start = false, finish = false, text = "";
  const escapes = { n: "\n", r: "\r", t: "\t", f: "\f", v: "\v" };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "^" && i === 0) { start = true; continue; }
    if (ch === "$" && i === body.length - 1) { finish = true; continue; }
    if (ch === "\\") {
      const escaped = body[++i];
      if (Object.hasOwn(escapes, escaped)) text += escapes[escaped];
      else if (escaped && "^$\\.*+?()[]{}|/".includes(escaped)) text += escaped;
      else reject();
    } else {
      if ("^$.*+?()[]{}|".includes(ch)) reject();
      text += ch;
    }
  }
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)) reject();
  return { text, start, finish };
}

export function regexTestHelper(name, value, pattern) {
  const { text, start, finish } = pattern;
  if (!text) return `function ${name}(${value}: string): boolean { return ${start && finish ? `length(${value}) === 0` : "true"}; }`;
  // Prefix every split input with a nonnumeric character that cannot start the
  // needle. This preserves numeric-looking prefixes under KN split coercion.
  // Official block source locations and hashes: docs/ts-r3-string.md.
  // Suffix search advances one complete character from each match so overlapping
  // matches are retained, and selectText never cuts a surrogate pair.
  const guard = text.startsWith("~") ? "!" : "~";
  const step = Array.from(text)[0].length;
  return `function ${name}(${value}: string): boolean {
    let tail: string = ${value};
    while (true) {
      const parts = splitText(join(${JSON.stringify(guard)}, tail), ${JSON.stringify(text)});
      if (parts.length < 2) return false;
      const offset: number = length(String(parts[0])) - 1;
      ${start ? `return offset === 0${finish ? ` && length(tail) === ${text.length}` : ""};` : finish ? `if (offset + ${text.length} === length(tail)) return true;
      if (offset + ${step} >= length(tail)) return false;
      tail = selectText(tail, offset + ${step + 1}, length(tail));` : "return true;"}
    }
  }`;
}
