import ts from "typescript";
import { objectTypes } from "./share-objects.mjs";

// Lower collections before nullable/classes: every link is an ordinary typed
// object reference, and get's missing result uses the existing nullable pass.
export function lowerTsCollections(input) {
  if (!/\b(?:Map|Set|WeakMap|WeakSet)\b/.test(input.text)) return input;
  const file = ts.createSourceFile(input.fileName, input.text, ts.ScriptTarget.Latest, true);
  const { checker } = objectTypes([file]);
  const fail = (node, message) => {
    const p = file.getLineAndCharacterOfPosition(node.getStart(file));
    const error = new Error(`${message}; use explicit string/number keys and supported collection operations instead`);
    error.location = { file: file.fileName, line: p.line + 1, column: p.character + 1 };
    error.name = "CompileError";
    throw error;
  };
  let hash = 2166136261;
  for (const c of file.fileName.replaceAll("\\", "/")) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619) >>> 0;
  let serial = 0;
  const fresh = hint => `__nekocMap_${hash}_${++serial}_${hint}`;
  const records = new Map();
  const additions = [];
  const parts = t => t?.isUnion() ? t.types : t ? [t] : [];
  const nameOf = t => t?.target?.symbol?.name ?? t?.symbol?.name;
  const typeText = t => checker.typeToString(t, undefined, ts.TypeFormatFlags.NoTruncation);
  const scalarKey = t => parts(t).length && parts(t).every(p => p.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike));
  // JS's empty constructors default to any in TypeScript. Infer concrete
  // domains from direct writes, or use an empty scalar domain until a write.
  const inferred = [];
  const inferEmpty = n => {
    if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && ["Map", "Set"].includes(n.expression.text)
      && !n.typeArguments?.length && !n.arguments?.length && ts.isVariableDeclaration(n.parent)
      && ts.isIdentifier(n.parent.name) && !n.parent.type) {
      const symbol = checker.getSymbolAtLocation(n.parent.name), keys = [], values = [];
      const writes = c => {
        if (ts.isCallExpression(c) && ts.isPropertyAccessExpression(c.expression) && ts.isIdentifier(c.expression.expression)
          && checker.getSymbolAtLocation(c.expression.expression) === symbol && c.expression.name.text === (n.expression.text === "Map" ? "set" : "add")) {
          const texts = c.arguments.map(a => typeText(checker.getBaseTypeOfLiteralType(checker.getTypeAtLocation(a))));
          if (texts[0]) keys.push(texts[0]);
          if (texts[1]) values.push(texts[1]);
        }
        ts.forEachChild(c, writes);
      };
      writes(file);
      const key = [...new Set(keys)].join(" | ") || "string | number";
      const value = [...new Set(values)].join(" | ") || "number";
      inferred.push({ at: n.expression.end, text: `<${key}${n.expression.text === "Map" ? ", " + value : ""}>` });
    }
    ts.forEachChild(n, inferEmpty);
  };
  inferEmpty(file);
  if (inferred.length) {
    let text = file.text;
    for (const edit of inferred.sort((a, b) => b.at - a.at)) text = text.slice(0, edit.at) + edit.text + text.slice(edit.at);
    return lowerTsCollections(ts.createSourceFile(input.fileName, text, ts.ScriptTarget.Latest, true));
  }
  const record = (t, node) => {
    const kind = nameOf(t);
    if (kind !== "Map" && kind !== "Set") return null;
    if (t.symbol?.declarations?.some(d => d.getSourceFile().fileName !== "/__nekoc_object_types.d.ts")) fail(node, "Shadowing the built-in Map/Set types is not supported; rename the custom type");
    const args = checker.getTypeArguments(t);
    const key = args[0], value = kind === "Map" ? args[1] : key;
    if (!scalarKey(key)) fail(node, `${kind} keys/elements must be string or number (literal unions allowed); annotate new ${kind} with concrete type arguments`);
    if (parts(value).some(p => checker.isArrayType(p) || checker.isTupleType(p))) fail(node, "Map array values are not supported; store an object with explicit fields or another Map instead");
    if (parts(value).some(p => p.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter))) fail(node, "Map values need a concrete type");
    if (parts(value).some(p => p.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined))) fail(node, "Nullable Map value types are not supported; wrap the nullable value in an initialized object field");
    const domains = new Set(parts(value).map(p => p.flags & ts.TypeFlags.StringLike ? "string" : p.flags & ts.TypeFlags.NumberLike ? "number" : p.flags & ts.TypeFlags.BooleanLike ? "boolean" : p.flags & ts.TypeFlags.Object ? "reference" : "unsupported"));
    if (kind === "Map" && (domains.size !== 1 || domains.has("unsupported"))) fail(node, "Map values must have one concrete scalar or reference domain; wrap mixed values in a typed object");
    const id = typeText(t);
    if (records.has(id)) return records.get(id);
    const r = { kind, key, value, name: fresh(kind), node: fresh("Entry"), fn: fresh("op") };
    records.set(id, r);
    // Recursively lower collection-valued maps, while preserving user object /
    // class type names for the subsequent class and object passes.
    r.k = typeText(key);
    r.v = record(value, node)?.name ?? typeText(value);
    additions.push(`
interface ${r.node} { key: ${r.k}; value: ${r.v}; next: ${r.node} | null; live: boolean; }
interface ${r.name} { first: ${r.node} | null; last: ${r.node} | null; size: number; }
function ${r.fn}_new(): ${r.name} { return { first: null, last: null, size: 0 }; }
function ${r.fn}_find(m: ${r.name}, k: ${r.k}): ${r.node} | null {
  let n = m.first;
  while (n !== null) {
    if (n.live && (n.key === k || (!(n.key <= n.key) && !(k <= k)))) return n;
    n = n.next;
  }
  return null;
}
function ${r.fn}_set(m: ${r.name}, k: ${r.k}, v: ${r.v}): ${r.name} {
  if (k === 0) k = 0;
  const found = ${r.fn}_find(m, k);
  if (found !== null) { found.value = v; return m; }
  const n: ${r.node} = { key: k, value: v, next: null, live: true };
  const last = m.last;
  if (last !== null) last.next = n;
  else m.first = n;
  m.last = n;
  m.size += 1;
  return m;
}
${kind === "Map" ? `function ${r.fn}_get(m: ${r.name}, k: ${r.k}): ${r.v} | undefined {
  const n = ${r.fn}_find(m, k);
  if (n !== null) return n.value;
  return undefined;
}
function ${r.fn}_known(m: ${r.name}, k: ${r.k}): ${r.v} {
  return ${r.fn}_get(m, k) as ${r.v};
}` : ""}
function ${r.fn}_has(m: ${r.name}, k: ${r.k}): boolean { return ${r.fn}_find(m, k) !== null; }
function ${r.fn}_delete(m: ${r.name}, k: ${r.k}): boolean {
  const n = ${r.fn}_find(m, k);
  if (n === null) return false;
  n.live = false; m.size -= 1; return true;
}
function ${r.fn}_clear(m: ${r.name}): void {
  let n = m.first;
  while (n !== null) { n.live = false; n = n.next; }
  m.size = 0;
}
`);
    return r;
  };
  const collection = node => record(checker.getTypeAtLocation(node), node);
  const nullableCollection = (node, optional = false) => {
    // A definitely-null variable can be flow-narrowed to null/never. Its
    // declared collection type still determines the optional-call diagnostic.
    const symbol = checker.getSymbolAtLocation(node);
    const type = optional && symbol?.valueDeclaration
      ? checker.getTypeOfSymbolAtLocation(symbol, symbol.valueDeclaration)
      : checker.getTypeAtLocation(node);
    return parts(type).some(t => t.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined))
      && record(checker.getNonNullableType(type), node);
  };
  const unwrap = node => {
    while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node))) node = node.expression;
    return node;
  };
  const view = node => {
    const direct = collection(node);
    if (direct) return { r: direct, receiver: node, mode: direct.kind === "Map" ? "entries" : "keys" };
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const r = collection(node.expression.expression);
      if (r && ["keys", "values", "entries"].includes(node.expression.name.text)) {
        if (node.arguments.length) fail(node, "Collection iterators take no arguments");
        return { r, receiver: node.expression.expression, mode: node.expression.name.text };
      }
    }
    return null;
  };
  const loop = (v, bindings, body, receiverText) => {
    const m = fresh("iter"), n = fresh("cursor");
    // Advancing in the for increment preserves continue and observes links
    // appended by the body, including when visiting the previous tail.
    return `{ const ${m} = ${receiverText ?? out(v.receiver)}; for (let ${n} = ${m}.first; ${n} !== null; ${n} = ${n}.next) { if (${n}.live) { ${bindings(n)} ${typeof body === "function" ? body(n) : body} } } }`;
  };
  const splice = node => {
    let result = "", cursor = ts.isSourceFile(node) ? 0 : node.getStart(file);
    ts.forEachChild(node, child => {
      const start = child.getStart(file);
      if (start < cursor) return;
      result += file.text.slice(cursor, start) + out(child);
      cursor = child.end;
    });
    return result + file.text.slice(cursor, node.end);
  };
  function out(node) {
    const result = emit(node);
    // Keep subsequent user diagnostics on their original lines, as nullable
    // lowering does. Helpers are appended only after the original source.
    const originalLines = (node.getText(file).match(/\n/g) ?? []).length;
    const resultLines = (result.match(/\n/g) ?? []).length;
    return result + "\n".repeat(Math.max(0, originalLines - resultLines));
  }
  function emit(node) {
    if (ts.isIdentifier(node) && node.text.startsWith("__nekocMap")) fail(node, "Names starting with __nekocMap are reserved; rename the identifier");
    if (ts.isIdentifier(node) && ["WeakMap", "WeakSet"].includes(node.text)) fail(node, `${node.text} is not supported`);
    if (ts.isIdentifier(node) && node.text === "NaN" && checker.getSymbolAtLocation(node)?.declarations?.every(d => d.getSourceFile().fileName === "/__nekoc_object_types.d.ts")) return `Number("NaN")`;
    if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
      && ts.isPropertyAccessExpression(node.expression.expression)
      && node.expression.expression.name.text === "forEach"
      && collection(node.expression.expression.expression)) return out(node.expression);
    if (ts.isSpreadElement(node) && collection(node.expression)) fail(node, "Collection spread is not supported; copy elements with an explicit for-of loop");
    if (ts.isElementAccessExpression(node) && collection(node.expression)) fail(node, "Collection indexed property access is not supported; call .get(key), .set(key, value) or .has(key)");
    if ((ts.isAsExpression(node) || ts.isTypeAssertionExpression(node))
      && (collection(node.expression) || collection(node))) {
      const from = collection(node.expression), to = collection(node);
      if (!from || !to || from !== to) fail(node, "Collection assertions must preserve the exact Map/Set type; do not erase or invent collection handles");
    }
    if (ts.isNonNullExpression(node)) {
      const call = unwrap(node.expression);
      if (ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === "get") {
        const r = collection(call.expression.expression);
        if (r) {
          const pure = n => ts.isIdentifier(n) || ts.isStringLiteralLike(n) || ts.isNumericLiteral(n);
          const same = (a, b) => b && a.getText(file) === b.getText(file)
            && (!ts.isIdentifier(a) || checker.getSymbolAtLocation(a) === checker.getSymbolAtLocation(b));
          let guard;
          for (let p = node.parent; p; p = p.parent) {
            if (ts.isFunctionLike(p) || ts.isForStatement(p) || ts.isForOfStatement(p) || ts.isWhileStatement(p) || ts.isDoStatement(p)) break;
            if (ts.isIfStatement(p) && node.pos >= p.thenStatement.pos && node.end <= p.thenStatement.end) {
              const c = unwrap(p.expression);
              if (ts.isCallExpression(c) && ts.isPropertyAccessExpression(c.expression) && c.expression.name.text === "has"
                && pure(c.expression.expression) && c.arguments.length === 1 && pure(c.arguments[0])
                && same(c.expression.expression, call.expression.expression)
                && same(c.arguments[0], call.arguments[0])) guard = p;
            }
          }
          if (!guard) fail(node, "Map.get non-null assertion needs a matching if (map.has(key)) guard; store the result and check !== undefined otherwise");
          const scan = n => {
            if (n.end <= guard.expression.end || n.getStart(file) >= call.getStart(file)) return;
            // console.log is a compiler intrinsic, with no runtime property
            // lookup. All actual property/index reads can invoke accessors.
            const intrinsicLog = ts.isPropertyAccessExpression(n) && n.getText(file) === "console.log"
              && !checker.getSymbolAtLocation(n.expression);
            if (n.end <= call.getStart(file) && (ts.isCallExpression(n) || ts.isNewExpression(n) || ts.isPostfixUnaryExpression(n)
              || ts.isPrefixUnaryExpression(n) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(n.operator)
              || ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment
              || ts.isPropertyAccessExpression(n) && !intrinsicLog || ts.isElementAccessExpression(n))) {
              fail(node, "Map.get assertion after calls, writes or property reads may invalidate has(key); store get's result and check !== undefined");
            }
            ts.forEachChild(n, scan);
          };
          scan(guard.thenStatement);
          return `${r.fn}_known(${out(call.expression.expression)}, ${out(call.arguments[0])})`;
        }
      }
    }
    if (ts.isTypeReferenceNode(node)) {
      const r = record(checker.getTypeFromTypeNode(node), node);
      if (r) return r.name;
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && ["Map", "Set"].includes(node.expression.text)) {
      const r = collection(node);
      if (!r) fail(node, "Shadowing collection constructors is not supported; rename the constructor");
      if (node.arguments?.length > 1) fail(node, "Collection constructors accept at most one argument");
      const init = node.arguments?.[0];
      if (!init) return `${r.fn}_new()`;
      const h = fresh("init"), args = [], statements = [];
      if (r.kind === "Map") {
        if (!ts.isArrayLiteralExpression(init)) fail(init, "new Map expects a literal array of [key, value] pairs");
        for (const pair of init.elements) {
          if (!ts.isArrayLiteralExpression(pair) || pair.elements.length !== 2 || pair.elements.some(ts.isSpreadElement)) fail(pair, "new Map expects [key, value] pairs");
          if (!checker.isTypeAssignableTo(checker.getTypeAtLocation(pair.elements[0]), r.key) || !checker.isTypeAssignableTo(checker.getTypeAtLocation(pair.elements[1]), r.value)) fail(pair, "Map initializer key/value types do not match the collection type");
          args.push(...pair.elements.map(out));
          const i = args.length - 2;
          statements.push(`${r.fn}_set(m, a${i}, a${i + 1});`);
        }
        additions.push(`function ${h}(${args.map((_, i) => `a${i}: ${i % 2 ? r.v : r.k}`).join(", ")}): ${r.name} { const m = ${r.fn}_new(); ${statements.join(" ")} return m; }`);
      } else {
        const source = checker.getTypeAtLocation(init);
        const element = checker.getIndexTypeOfType(source, ts.IndexKind.Number);
        if (!checker.isArrayType(source) && !checker.isTupleType(source) || !element || !scalarKey(element) || !checker.isTypeAssignableTo(element, r.key)) fail(init, "new Set requires an array whose string/number elements match the Set type");
        args.push(out(init));
        additions.push(`function ${h}(xs: (${r.k})[]): ${r.name} { const m = ${r.fn}_new(); for (const x of xs) ${r.fn}_set(m, x, x); return m; }`);
      }
      return `${h}(${args.join(", ")})`;
    }
    if (ts.isForOfStatement(node)) {
      const v = view(node.expression);
      if (v) {
        if (ts.isLabeledStatement(node.parent)) fail(node.parent, "Labeled collection iteration is not supported; use an unlabeled loop and an explicit stop flag");
        if (node.awaitModifier || !ts.isVariableDeclarationList(node.initializer) || node.initializer.declarations.length !== 1) fail(node, "Collection for-of requires const/let bindings");
        const binding = node.initializer.declarations[0].name;
        const keyword = node.initializer.flags & ts.NodeFlags.Const ? "const" : "let";
        if (v.mode === "entries") {
          if (!ts.isArrayBindingPattern(binding) || binding.elements.length !== 2 || binding.elements.some(e => !ts.isBindingElement(e) || !ts.isIdentifier(e.name) || e.initializer || e.dotDotDotToken)) fail(binding, "Collection entries require for (const [key, value] of map)");
          return loop(v, n => `${keyword} ${binding.elements[0].name.text} = ${n}.key; ${keyword} ${binding.elements[1].name.text} = ${n}.${v.r.kind === "Set" ? "key" : "value"};`, out(node.statement));
        }
        if (!ts.isIdentifier(binding)) fail(binding, "Collection keys/values require an identifier loop binding");
        return loop(v, n => `${keyword} ${binding.text} = ${n}.${v.mode === "keys" || v.r.kind === "Set" ? "key" : "value"};`, out(node.statement));
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const receiver = node.expression.expression, method = node.expression.name.text;
      if (nullableCollection(receiver, ts.isOptionalChain(node)) || ts.isOptionalChain(node) && collection(receiver)) {
        fail(node, "Optional or nullable collection method calls are not supported; save the receiver in a variable and check !== undefined and !== null before calling its method");
      }
      const r = collection(receiver);
      if (r) {
        if (method === "forEach") {
          const cb = unwrap(node.arguments[0]);
          if (node.arguments.length !== 1 || !cb || !ts.isArrowFunction(cb) || cb.parameters.length > 3 || cb.parameters.some(p => !ts.isIdentifier(p.name) || p.dotDotDotToken || p.initializer)) fail(node, "Collection forEach requires an inline arrow with identifier parameters");
          // A label preserves return, but cannot supply a function's var scope.
          // Reject var rather than silently binding it in the enclosing function.
          const checkScope = n => {
            if (ts.isFunctionLike(n)) return;
            if (ts.isVariableDeclarationList(n) && !(n.flags & ts.NodeFlags.BlockScoped)) fail(n, "Collection forEach callback var declarations are not supported; use let/const and initialize callback locals explicitly");
            ts.forEachChild(n, checkScope);
          };
          checkScope(cb.body);
          const v = { r, receiver, mode: "entries" };
          const m = fresh("map");
          const label = fresh("callback");
          const hasReturn = n => !ts.isFunctionLike(n) && (ts.isReturnStatement(n) || ts.forEachChild(n, hasReturn));
          const callbackBody = n => {
            if (ts.isReturnStatement(n)) return `{ ${n.expression ? out(n.expression) + ";" : ""} break ${label}; }`;
            if (!hasReturn(n)) return out(n);
            let result = "", cursor = n.getStart(file);
            ts.forEachChild(n, child => { const start = child.getStart(file); if (start < cursor) return; result += file.text.slice(cursor, start) + callbackBody(child); cursor = child.end; });
            return result + file.text.slice(cursor, n.end);
          };
          const body = ts.isBlock(cb.body) ? callbackBody(cb.body) : `{ ${out(cb.body)}; }`;
          // A labeled callback block preserves return without propagating it
          // into the caller's script. Bind the receiver once outside the loop.
          if (!ts.isExpressionStatement(node.parent)) fail(node, "Collection forEach is supported as a separate statement");
          return `{ const ${m} = ${out(receiver)}; ${loop(v, n => cb.parameters.map((p, i) => `let ${p.name.text}: ${i === 0 ? r.v : i === 1 ? r.k : r.name} = ${i === 2 ? m : `${n}.${i === 0 && r.kind === "Map" ? "value" : "key"}`};`).join(" "), `${label}: ${body}`, m)} }`;
        }
        if (["keys", "values", "entries"].includes(method)) fail(node, "Collection iterators are supported only directly in for-of; copy elements with an explicit loop instead of Array.from/spread/custom iterators");
        const arity = { set: 2, add: 1, get: 1, has: 1, delete: 1, clear: 0 }[method];
        if (arity === undefined || r.kind === "Set" && ["get", "set"].includes(method) || r.kind === "Map" && method === "add") fail(node, `Unsupported ${r.kind} method ${method}`);
        if (node.arguments.length !== arity) fail(node, `${r.kind}.${method} expects ${arity} arguments`);
        for (let i = 0; i < arity; i++) {
          const arg = node.arguments[i], target = i === 0 ? r.key : r.value;
          const t = checker.getTypeAtLocation(arg);
          if (ts.isSpreadElement(arg) || t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown) || !checker.isTypeAssignableTo(t, target)) fail(arg, `${r.kind}.${method} argument has an unsupported or incompatible type; annotate it with the collection key/value type`);
        }
        if (method === "add") {
          const h = `${r.fn}_add`;
          if (!r.add) { r.add = true; additions.push(`function ${h}(m: ${r.name}, k: ${r.k}): ${r.name} { return ${r.fn}_set(m, k, k); }`); }
          return `${h}(${out(receiver)}, ${out(node.arguments[0])})`;
        }
        return `${r.fn}_${method}(${[out(receiver), ...node.arguments.map(out)].join(", ")})`;
      }
    }
    if (ts.isPropertyAccessExpression(node) && collection(node.expression)) {
      if (node.name.text !== "size") fail(node, "Collection methods cannot be detached or used as values; call the method directly");
      if (ts.isBinaryExpression(node.parent) && node.parent.left === node && node.parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment || ts.isPostfixUnaryExpression(node.parent) || ts.isPrefixUnaryExpression(node.parent) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.parent.operator)) fail(node, "Collection size is read-only");
    }
    return splice(node);
  }
  const result = out(file);
  if (!records.size) return input;
  return ts.createSourceFile(input.fileName, `${result}\n${additions.join("\n")}\n`, ts.ScriptTarget.Latest, true);
}
