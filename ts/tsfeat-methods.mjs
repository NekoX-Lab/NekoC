import ts from "typescript";

const UNKNOWN = Symbol("not a constant");
const f = ts.factory;

/**
 * Lower the deliberately small JS-method subset to existing frontend syntax.
 * No user code is evaluated. Constants are literals/primitive const bindings,
 * not mutable arrays or arbitrary calls. The returned tree is reparsed, so it
 * has ordinary parent links and source positions for the workspace compiler.
 *
 * Throws an Error with CompileError-compatible name/code/location properties.
 * The integration layer can wrap it in its own CompileError if required.
 */
export function lowerTsMethods(sourceFile) {
  const originalFile = sourceFile;
  // Binding a SourceFile caches checker symbols on it. Do not hand those caches
  // to the independent checker in the following lexical-lowering pass.
  sourceFile = ts.createSourceFile(sourceFile.fileName, sourceFile.text,
    sourceFile.languageVersion, true, sourceFile.scriptKind);
  const host = {
    getSourceFile: name => name === sourceFile.fileName ? sourceFile : undefined,
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile() {}, getCurrentDirectory: () => "", getDirectories: () => [],
    fileExists: name => name === sourceFile.fileName,
    readFile: name => name === sourceFile.fileName ? sourceFile.text : undefined,
    getCanonicalFileName: name => name, useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
  };
  // The checker is only used for lexical symbol identity and primitive types;
  // no filesystem, standard library, or project type-checking is needed.
  const program = ts.createProgram([sourceFile.fileName], { noLib: true, noResolve: true }, host);
  const checker = program.getTypeChecker();
  const names = new Set();
  const collect = node => {
    if (ts.isIdentifier(node)) names.add(node.text);
    ts.forEachChild(node, collect);
  };
  collect(sourceFile);
  const helpers = [];
  const reassigned = new Set();
  const findWrites = node => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && ts.isIdentifier(node.left)) {
      reassigned.add(checker.getSymbolAtLocation(node.left));
    }
    ts.forEachChild(node, findWrites);
  };
  findWrites(sourceFile);
  const edits = [];
  const printer = ts.createPrinter();
  const replace = (node, replacement) => {
    edits.push({ start: node.getStart(sourceFile), end: node.end,
      text: printer.printNode(ts.EmitHint.Expression, replacement, sourceFile) });
    return replacement;
  };
  let serial = 0;
  let fileSalt = 2166136261;
  for (const ch of sourceFile.fileName.replaceAll("\\", "/")) fileSalt = Math.imul(fileSalt ^ ch.charCodeAt(0), 16777619) >>> 0;
  const fresh = () => {
    let name;
    do { name = `__tsfeatMethods${fileSalt}_${++serial}`; } while (names.has(name));
    names.add(name);
    return name;
  };
  const fail = (node, message, alternative) => {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    const error = new Error(`${message}; alternative: ${alternative}`);
    error.name = "CompileError";
    error.code = "NEKOC_TS_METHOD";
    error.location = { file: sourceFile.fileName, line: line + 1, column: character + 1 };
    throw error;
  };
  const unwrap = node => {
    while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)
      || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node)
      || ts.isSatisfiesExpression(node))) node = node.expression;
    return node;
  };
  const unshadowed = (node, name) => ts.isIdentifier(node) && node.text === name
    && !checker.getSymbolAtLocation(node)?.declarations?.length;
  const globalMember = (node, owner, member) => ts.isPropertyAccessExpression(node)
    && node.name.text === member && unshadowed(node.expression, owner);
  const constant = (node, seen = new Set()) => {
    node = unwrap(node);
    if (!node) return UNKNOWN;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (node.kind === ts.SyntaxKind.NullKeyword) return null;
    if (ts.isIdentifier(node)) {
      if (unshadowed(node, "NaN")) return NaN;
      if (unshadowed(node, "Infinity")) return Infinity;
      if (unshadowed(node, "undefined")) return undefined;
      const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration;
      if (!declaration || !ts.isVariableDeclaration(declaration) || seen.has(declaration)
        || !(declaration.parent.flags & ts.NodeFlags.Const) || declaration.end > node.pos) return UNKNOWN;
      const next = new Set(seen).add(declaration);
      const value = constant(declaration.initializer, next);
      // A const array is still mutable (including through aliases).
      return Array.isArray(value) ? UNKNOWN : value;
    }
    if (globalMember(node, "Number", "NaN")) return NaN;
    if (globalMember(node, "Number", "POSITIVE_INFINITY")) return Infinity;
    if (globalMember(node, "Number", "NEGATIVE_INFINITY")) return -Infinity;
    if (ts.isPrefixUnaryExpression(node)) {
      const value = constant(node.operand, seen);
      if (typeof value !== "number") return UNKNOWN;
      if (node.operator === ts.SyntaxKind.MinusToken) return -value;
      if (node.operator === ts.SyntaxKind.PlusToken) return value;
    }
    if (ts.isBinaryExpression(node)) {
      const left = constant(node.left, seen), right = constant(node.right, seen);
      if (typeof left !== "number" || typeof right !== "number") return UNKNOWN;
      switch (node.operatorToken.kind) {
        case ts.SyntaxKind.PlusToken: return left + right;
        case ts.SyntaxKind.MinusToken: return left - right;
        case ts.SyntaxKind.AsteriskToken: return left * right;
        case ts.SyntaxKind.SlashToken: return left / right;
        case ts.SyntaxKind.PercentToken: return left % right;
        case ts.SyntaxKind.AsteriskAsteriskToken: return left ** right;
      }
    }
    if (ts.isArrayLiteralExpression(node)) {
      const values = [];
      for (const item of node.elements) {
        // Holes/spreads are intentionally not part of this subset.
        if (ts.isOmittedExpression(item) || ts.isSpreadElement(item)) return UNKNOWN;
        const value = constant(item, seen);
        if (value === UNKNOWN) return UNKNOWN;
        values.push(value);
      }
      return values;
    }
    return UNKNOWN;
  };
  const hasLoneSurrogate = text => {
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = text.charCodeAt(++i);
        if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      } else if (code >= 0xdc00 && code <= 0xdfff) return true;
    }
    return false;
  };
  const literal = (value, node) => {
    if (typeof value === "string") {
      if (hasLoneSurrogate(value)) fail(node, "Result contains an isolated UTF-16 surrogate, which KN strings cannot preserve", "keep the complete Unicode character, or use numeric UTF-16 code units");
      return f.createStringLiteral(value);
    }
    if (typeof value === "boolean") return value ? f.createTrue() : f.createFalse();
    if (typeof value === "number") {
      if (Number.isNaN(value)) {
        if (checker.resolveName("Number", node, ts.SymbolFlags.Value, false)?.declarations?.length) fail(node, "Cannot emit numeric NaN while Number is shadowed", "rename the local Number binding");
        return f.createCallExpression(f.createIdentifier("Number"), undefined, [f.createStringLiteral("NaN")]);
      }
      if (!Number.isFinite(value)) fail(node, "Non-finite numeric result cannot be emitted portably", "keep the result as a constant string");
      if (value < 0 || Object.is(value, -0)) return f.createPrefixUnaryExpression(ts.SyntaxKind.MinusToken, f.createNumericLiteral(-value));
      return f.createNumericLiteral(value);
    }
    fail(node, "The result is undefined, which KN cannot represent faithfully", "use charAt(index), which returns an empty string out of range");
  };
  const kind = (node, seen = new Set()) => {
    node = unwrap(node);
    if (ts.isArrayLiteralExpression(node)) return "array";
    if (ts.isIdentifier(node)) {
      const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration;
      if (declaration && !seen.has(declaration)) {
        if (declaration.type && (ts.isArrayTypeNode(declaration.type) || ts.isTupleTypeNode(declaration.type)
          || ts.isTypeReferenceNode(declaration.type) && ["Array", "ReadonlyArray"].includes(declaration.type.typeName.getText(sourceFile)))) return "array";
        if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
          const inferred = kind(declaration.initializer, new Set(seen).add(declaration));
          if (inferred === "array") return "array";
        }
      }
    }
    const value = constant(node);
    if (value !== UNKNOWN) return Array.isArray(value) ? "array" : typeof value;
    const type = checker.getTypeAtLocation(node);
    if (type.flags & ts.TypeFlags.NumberLike) return "number";
    if (type.flags & ts.TypeFlags.StringLike) return "string";
    return "unknown";
  };
  const arity = (call, min, max, label) => {
    if (call.arguments.length < min || call.arguments.length > max
      || call.arguments.some(ts.isSpreadElement)) {
      fail(call, `${label} supports ${min === max ? min : `${min}-${max}`} non-spread argument(s)`, "pass only the documented positional arguments");
    }
  };
  const fold = (call, run) => {
    try { return run(); } catch (error) {
      if (error.code === "NEKOC_TS_METHOD") throw error;
      fail(call, `${error.name}: ${error.message}`, "use arguments in the JavaScript method's valid range");
    }
  };
  // A deliberately conservative bound, not JavaScript's maximum string size.
  // Inspect return expressions without evaluating calls (and without erasing
  // their effects). Mutable bindings, parameters and recursive calls are unknown.
  const possible = (node, seen = new Set()) => {
    node = unwrap(node);
    const value = constant(node);
    if (value !== UNKNOWN) return [value];
    if (!node || seen.has(node)) return null;
    const next = new Set(seen).add(node);
    if (ts.isConditionalExpression(node)) {
      const a = possible(node.whenTrue, next), b = possible(node.whenFalse, next);
      return a && b ? [...a, ...b] : null;
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      if (reassigned.has(checker.getSymbolAtLocation(node.expression))) return null;
      const declaration = checker.getSymbolAtLocation(node.expression)?.valueDeclaration;
      if (ts.isVariableDeclaration(declaration ?? {}) && !(declaration.parent.flags & ts.NodeFlags.Const)) return null;
      const fn = ts.isVariableDeclaration(declaration ?? {}) ? unwrap(declaration.initializer) : declaration;
      if (!fn || next.has(fn) || !ts.isFunctionLike(fn) || !fn.body) return null;
      next.add(fn);
      if (!ts.isBlock(fn.body)) return possible(fn.body, next);
      // Require a final unconditional return; branch returns alone do not prove
      // that every path returns a bounded value.
      if (!ts.isReturnStatement(fn.body.statements.at(-1) ?? {})) return null;
      const values = [];
      let unknown = false;
      const visit = part => {
        if (ts.isFunctionLike(part)) return;
        if (ts.isReturnStatement(part)) {
          const result = possible(part.expression, next);
          if (result) values.push(...result); else unknown = true;
        } else ts.forEachChild(part, visit);
      };
      visit(fn.body);
      return unknown ? null : values;
    }
    return null;
  };
  const stringLimits = { charAt: [0, 1], substring: [0, 2], includes: [1, 2],
    indexOf: [1, 2], lastIndexOf: [1, 2], startsWith: [1, 2], endsWith: [1, 2],
    split: [0, 2], repeat: [1, 1], padStart: [1, 2], padEnd: [1, 2],
    concat: [0, Infinity], replace: [2, 2], replaceAll: [2, 2], trim: [0, 0],
    trimStart: [0, 0], trimEnd: [0, 0], toUpperCase: [0, 0], toLowerCase: [0, 0] };
  const checkGrowth = (node, receiver, method, args) => {
    const counts = possible(args[0]);
    const texts = possible(receiver);
    const fills = args.length > 1 ? possible(args[1]) : [" "];
    if (!counts || counts.some(n => typeof n !== "number" || !Number.isFinite(n)
      || method === "repeat" && Math.trunc(n) < 0 || Math.trunc(n) > 65536)) {
      fail(args[0], `${method} requires a provably finite bounded ${method === "repeat" ? "nonnegative count" : "target length"} (at most 65536)`, "use a numeric constant or a function with bounded literal returns; validate dynamic input before choosing a bounded literal");
    }
    if (method === "repeat") {
      if (!texts || texts.some(s => typeof s !== "string" || counts.some(n => s.length * Math.trunc(n) > 65536))) {
        fail(node, "repeat requires a provably bounded result (at most 65536 UTF-16 code units)", "use a constant string or a function returning bounded literal strings, and a bounded count");
      }
    } else {
      if (!fills || fills.some(s => typeof s !== "string")) fail(node, "padding requires a statically known fill alphabet", "use a literal fill string or a function returning literal strings");
      if (fills.some(s => /[\uD800-\uDFFF]/.test(s))) {
        if (!texts || texts.some(s => typeof s !== "string")) fail(node, "padding cannot prove a complete UTF-16 character boundary", "use a BMP fill string or a constant receiver and target length");
        for (const s of texts) for (const n of counts) for (const fill of fills) {
          literal(s[method](n, fill), node); // validates, does not replace effects
        }
      }
    }
  };
  // Emit a procedure rather than duplicating the receiver expression. Its
  // explicit empty-range guard avoids text_select's reverse-selection behavior.
  const sliceHelper = (call, receiver, start, end, context) => {
    for (const builtin of ["Math", "selectText", "length"]) {
      const symbol = checker.resolveName(builtin, call, ts.SymbolFlags.Value, false);
      if (symbol?.declarations?.length) fail(call, `Cannot lower slice while ${builtin} is shadowed`, `rename the local ${builtin} binding`);
    }
    const name = fresh(), text = fresh(), len = fresh(), lo = fresh(), hi = fresh();
    const bound = value => {
      if (value === Infinity) return len;
      if (value === -Infinity) return "0";
      value = Number.isNaN(value) ? 0 : Math.trunc(value);
      return value < 0 ? `Math.max(${len} + (${value}), 0)` : `Math.min(${value}, ${len})`;
    };
    const code = `function ${name}(${text}: string): string {
      const ${len}: number = length(${text});
      const ${lo}: number = ${bound(start)};
      const ${hi}: number = ${end === undefined ? len : bound(end)};
      if (${lo} >= ${hi}) return "";
      return selectText(${text}, ${lo} + 1, ${hi});
    }`;
    helpers.push(code);
    return f.createCallExpression(f.createIdentifier(name), undefined, [ts.visitNode(receiver, context)]);
  };
  const result = ts.transform(sourceFile, [context => {
    const visit = node => {
      if (!ts.isCallExpression(node)) return ts.visitEachChild(node, visit, context);
      const callee = node.expression;
      const args = node.arguments;
      const optional = () => {
        if (node.questionDotToken || callee.questionDotToken || ts.isOptionalChain(node)) fail(node, "Optional method calls are not supported by this lowering", "check the receiver explicitly before calling the method");
      };
      if (unshadowed(callee, "isNaN") || globalMember(callee, "Number", "isNaN")) {
        optional();
        arity(node, 0, 1, "isNaN");
        const value = args.length ? constant(args[0]) : undefined;
        if (value !== UNKNOWN) return replace(node, literal(globalMember(callee, "Number", "isNaN") ? Number.isNaN(value) : isNaN(value), node));
        fail(node, "Dynamic isNaN/Number.isNaN is not supported: KN conversions and comparisons do not preserve JavaScript NaN/type semantics", "validate input before conversion, or use a constant argument");
      }
      if (globalMember(callee, "String", "fromCharCode")) {
        optional();
        arity(node, 0, 1024, "String.fromCharCode");
        const values = args.map(arg => constant(arg));
        if (values.every(value => value !== UNKNOWN && !Array.isArray(value))) {
          return replace(node, literal(String.fromCharCode(...values), node));
        }
        fail(node, "Dynamic String.fromCharCode is not supported: no KN UTF-16 code-unit constructor exists", "use a literal character or an explicit lookup table for a bounded alphabet");
      }
      if (globalMember(callee, "JSON", "stringify")) {
        optional();
        arity(node, 1, 1, "JSON.stringify");
        const value = constant(args[0]);
        if (value !== UNKNOWN && value !== undefined) return replace(node, literal(JSON.stringify(value), node));
        if (value === undefined) fail(node, "JSON.stringify(undefined) returns undefined, which this frontend cannot represent faithfully", "check for undefined before serialization");
        // A const array can still mutate. Leave dynamic data for the compiler's
        // explicit rejection: the share player has no JSON.stringify reporter.
        return ts.visitEachChild(node, visit, context);
      }
      if (!ts.isPropertyAccessExpression(callee)) return ts.visitEachChild(node, visit, context);
      const receiver = callee.expression, method = callee.name.text;
      const dslReceiver = ts.isIdentifier(receiver) && receiver.text === "self" && kind(receiver) !== "string"
        || receiver.kind === ts.SyntaxKind.ThisKeyword;
      if (Object.hasOwn(stringLimits, method) && kind(receiver) !== "array" && !dslReceiver) {
        // Unknown receivers (including imported/class methods) belong to the
        // later type-aware compiler, not to this string-only pass.
        const isString = kind(receiver) === "string" || possible(receiver)?.every(v => typeof v === "string");
        const userMethod = checker.getSymbolAtLocation(callee.name)?.declarations?.some(ts.isMethodDeclaration);
        if (isString || !userMethod && ["repeat", "padStart", "padEnd"].includes(method)) {
          optional();
          arity(node, ...stringLimits[method], `String.${method}`);
          if (args.some(arg => arg.kind === ts.SyntaxKind.RegularExpressionLiteral)) {
            fail(node, `String.${method} regular-expression overload is not supported`, "use a string search/separator instead");
          }
          if (["includes", "indexOf", "lastIndexOf", "startsWith", "endsWith", "split", "replace", "replaceAll"].includes(method)
            && args[0] && kind(args[0]) !== "string" && !possible(args[0])?.every(v => typeof v === "string")) {
            fail(args[0], `String.${method} requires a string search/separator`, "use an explicit string instead of a regular expression or coercing overload");
          }
          const values = args.map(arg => constant(arg));
          const text = constant(receiver);
          if (["repeat", "padStart", "padEnd"].includes(method)) checkGrowth(node, receiver, method, args);
          if (["charAt", "substring", "includes", "indexOf", "lastIndexOf", "startsWith", "endsWith", "split", "repeat", "padStart", "padEnd"].includes(method)
            && typeof text === "string" && values.every(v => v !== UNKNOWN && (typeof v === "string" || typeof v === "number"))) {
            const output = fold(node, () => text[method](...values));
            return replace(node, Array.isArray(output) ? f.createArrayLiteralExpression(output.map(v => literal(v, node))) : literal(output, node));
          }
          if (["charAt", "substring"].includes(method) && possible(receiver)?.some(s => /[\uD800-\uDFFF]/.test(s))) {
            fail(node, `${method} cannot prove a complete UTF-16 character boundary`, "use constant text and indices, or keep complete Unicode characters");
          }
        }
      }
      if (!["toFixed", "toString", "charCodeAt", "at", "slice"].includes(method)) return ts.visitEachChild(node, visit, context);
      const receiverKind = kind(receiver);
      // Array and object methods are handled by other lowering passes.
      if ((method === "at" || method === "slice") && receiverKind === "array") return ts.visitEachChild(node, visit, context);
      if (method === "slice" && receiverKind !== "string") return ts.visitEachChild(node, visit, context);
      if (method === "toString" && receiverKind !== "number") return ts.visitEachChild(node, visit, context);
      optional();
      const value = constant(receiver);
      if (method === "toFixed" || method === "toString") {
        arity(node, 0, 1, method);
        const argument = args.length ? constant(args[0]) : undefined;
        if (receiverKind !== "number") fail(node, `${method} requires a statically numeric receiver`, "use a number literal or a variable/parameter with a number type");
        if (typeof value === "number" && argument !== UNKNOWN && !Array.isArray(argument)) {
          return replace(node, fold(node, () => literal(method === "toFixed" ? value.toFixed(argument) : value.toString(argument), node)));
        }
        if (method === "toString" && (argument === undefined || argument === 10)) {
          if (checker.resolveName("String", node, ts.SymbolFlags.Value, false)?.declarations?.length) fail(node, "Cannot lower numeric toString while String is shadowed", "rename the local String binding");
          return replace(node, f.createCallExpression(f.createIdentifier("String"), undefined, [ts.visitNode(receiver, visit)]));
        }
        fail(node, `Dynamic ${method} is not supported${method === "toFixed" ? ": scaled rounding does not reproduce JavaScript binary floating-point formatting" : " for nondecimal or dynamic radices"}`, method === "toFixed" ? "format a constant with toFixed, or explicitly use Math.round and label it as rounded rather than fixed-decimal formatting" : "use numericValue.toString() or numericValue.toString(10), or a constant receiver and radix");
      }
      if (receiverKind !== "string") fail(node, `${method} requires a statically string receiver`, "use a string literal or a variable/parameter with a string type");
      arity(node, 0, method === "slice" ? 2 : 1, method);
      const values = args.map(arg => constant(arg));
      if (typeof value === "string" && values.every(arg => arg !== UNKNOWN && !Array.isArray(arg))) {
        return replace(node, literal(value[method](...values), node));
      }
      if (method === "slice" && values.every(arg => arg === undefined || typeof arg === "number")) {
        return replace(node, sliceHelper(node, receiver, values[0] ?? 0, values[1], visit));
      }
      fail(node, `Dynamic string ${method} is not supported${method === "at" ? ": out-of-range at() returns unrepresentable undefined" : method === "charCodeAt" ? ": no KN UTF-16 code-unit reporter exists" : ": indices must be numeric constants"}`, method === "at" ? "use s.charAt(s.length - 1) when an empty string for an empty input is acceptable" : method === "charCodeAt" ? "use literalString.charCodeAt(constantIndex), or an explicit lookup table for a bounded alphabet" : "use constant numeric slice indices (including negative indices), or explicitly normalize and clamp indices before selectText");
    };
    return root => ts.visitNode(root, visit);
  }]);
  try {
    if (!edits.length) return originalFile;
    // Rewrite only method calls. Outer replacements already contain visited
    // inner replacements; discard overlapping inner edits. Preserve line counts
    // (and columns when a replacement fits), so unrelated diagnostics remain at
    // their original positions. Helpers go last rather than shifting user code.
    const ordered = edits.sort((a, b) => a.start - b.start || b.end - a.end);
    const selected = [];
    for (const edit of ordered) {
      if (!selected.length || edit.start >= selected.at(-1).end) selected.push(edit);
    }
    let text = sourceFile.text;
    for (const edit of selected.reverse()) {
      const original = text.slice(edit.start, edit.end);
      const oldLines = original.match(/\n/g)?.length ?? 0;
      const newLines = edit.text.match(/\n/g)?.length ?? 0;
      let replacement = edit.text + "\n".repeat(Math.max(0, oldLines - newLines));
      if (!oldLines && !newLines) replacement = replacement.padEnd(original.length, " ");
      text = text.slice(0, edit.start) + replacement + text.slice(edit.end);
    }
    if (helpers.length) text += `\n${helpers.join("\n")}\n`;
    return ts.createSourceFile(sourceFile.fileName, text, sourceFile.languageVersion, true, sourceFile.scriptKind);
  } finally {
    result.dispose();
  }
}
