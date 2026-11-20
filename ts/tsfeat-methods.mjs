import ts from "typescript";
import { copyClassNodeOrigins } from "./class-metadata.mjs";
import { literalRegex, regexTestHelper } from "./tsstr-regex.mjs";

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
export function lowerTsMethods(sourceFile, sourceIdentity = sourceFile.fileName) {
  const originalFile = sourceFile;
  // Binding a SourceFile caches checker symbols on it. Do not hand those caches
  // to the independent checker in the following lexical-lowering pass.
  sourceFile = ts.createSourceFile(sourceFile.fileName, sourceFile.text,
    sourceFile.languageVersion, true, sourceFile.scriptKind);
  copyClassNodeOrigins(originalFile, sourceFile);
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
  const unwrap = node => {
    while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)
      || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node)
      || ts.isSatisfiesExpression(node))) node = node.expression;
    return node;
  };
  // One source of write facts for all safety proofs. Unbound names also matter
  // in no-types mode (notably the implicit DSL self); do not collapse them to an
  // undefined symbol shared by unrelated identifiers.
  const bindingKey = node => (ts.isShorthandPropertyAssignment(node.parent)
    ? checker.getShorthandAssignmentValueSymbol(node.parent)
    : (ts.isVariableDeclaration(node.parent) || ts.isBindingElement(node.parent))
      ? checker.resolveName(node.text, node, ts.SymbolFlags.Value, false) ?? checker.getSymbolAtLocation(node)
      : checker.getSymbolAtLocation(node)) ?? node.text;
  const writes = new Map();
  const writeTarget = (target, fact) => {
    target = unwrap(target);
    if (ts.isIdentifier(target)) {
      const key = bindingKey(target);
      const facts = writes.get(key) ?? [];
      facts.push(fact);
      writes.set(key, facts);
    } else if (ts.isArrayLiteralExpression(target) || ts.isArrayBindingPattern(target)) {
      for (const element of target.elements) writeTarget(element, null);
    } else if (ts.isObjectLiteralExpression(target) || ts.isObjectBindingPattern(target)) {
      for (const property of target.properties ?? target.elements) writeTarget(property, null);
    } else if (ts.isPropertyAssignment(target)) {
      writeTarget(target.initializer, null);
    } else if (ts.isShorthandPropertyAssignment(target)) {
      writeTarget(target.name, null);
    } else if (ts.isSpreadElement(target) || ts.isSpreadAssignment(target)) {
      writeTarget(target.expression, null);
    } else if (ts.isBindingElement(target)) {
      writeTarget(target.name, null);
    } else if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      writeTarget(target.left, null); // destructuring default, not a known source
    }
    // Property/element writes mutate a container, not its base binding. Such
    // reads are already excluded from the primitive BMP proof.
  };
  const findWrites = node => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      writeTarget(node.left, { operator: node.operatorToken.kind, value: node.right });
    } else if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
      && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)) {
      writeTarget(node.operand, null);
    } else if ((ts.isForOfStatement(node) || ts.isForInStatement(node))
      && !ts.isVariableDeclarationList(node.initializer)) {
      writeTarget(node.initializer, null); // loop/destructured sources stay unknown
    } else if (ts.isVariableDeclaration(node)) {
      const list = node.parent;
      const loop = ts.isVariableDeclarationList(list) && list.parent;
      const loopTarget = loop && (ts.isForOfStatement(loop) || ts.isForInStatement(loop))
        && loop.initializer === list;
      const symbol = ts.isIdentifier(node.name) && checker.getSymbolAtLocation(node.name);
      // A first, simple initializer is the binding's producer, not a later
      // write. All declarations must be considered: var redeclarations can
      // share a symbol with each other, a parameter or a function declaration.
      // Conservatively invalidate merged declarations even without an explicit
      // initializer; a declaration-style loop target is an implicit write too.
      if (loopTarget || !ts.isIdentifier(node.name) || symbol?.declarations?.length > 1
        || bindingKey(node.name) !== symbol) {
        writeTarget(node.name, null);
      }
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
  for (const ch of sourceIdentity.replaceAll("\\", "/")) fileSalt = Math.imul(fileSalt ^ ch.charCodeAt(0), 16777619) >>> 0;
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
        || !(declaration.parent.flags & ts.NodeFlags.Const) || declaration.end > node.pos
        || writes.has(bindingKey(node))) return UNKNOWN;
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
    if (ts.isCallExpression(node)) {
      const declaration = checker.getSymbolAtLocation(node.expression)?.valueDeclaration;
      if (declaration?.type && (ts.isArrayTypeNode(declaration.type) || ts.isTupleTypeNode(declaration.type)
        || ts.isTypeReferenceNode(declaration.type) && ["Array", "ReadonlyArray"].includes(declaration.type.typeName.getText(sourceFile)))) return "array";
    }
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
      if (writes.has(bindingKey(node.expression))) return null;
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
  // This proof follows lexical symbols, not variable spelling or a string type
  // annotation. A string may contain astral characters unless every producer
  // and write is known. Unknown/external/aliased containers stay conservative.
  const references = new Map();
  const indexReferences = node => {
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      if (symbol) {
        const refs = references.get(symbol) ?? [];
        refs.push(node);
        references.set(symbol, refs);
      }
    }
    ts.forEachChild(node, indexReferences);
  };
  indexReferences(sourceFile);
  const bmp = (node, seen = new Set()) => {
    node = unwrap(node);
    if (!node) return false;
    if (seen.has(node)) {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) return bmp(node.expression.expression, seen);
      return ts.isCallExpression(node) && ts.isIdentifier(node.expression)
        && seen.has(checker.getSymbolAtLocation(node.expression)?.valueDeclaration);
    }
    const value = constant(node);
    if (typeof value === "string") return !/[\uD800-\uDFFF]/.test(value);
    const next = new Set(seen).add(node);
    if (ts.isConditionalExpression(node)) return bmp(node.whenTrue, next) && bmp(node.whenFalse, next);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      return bmp(node.left, next) && bmp(node.right, next);
    }
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      const declaration = symbol?.valueDeclaration;
      if (!declaration || next.has(declaration)) return false;
      next.add(declaration);
      if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
        if (!bmp(declaration.initializer, next)) return false;
        return (writes.get(symbol) ?? []).every(fact => fact
          && [ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken].includes(fact.operator)
          && bmp(fact.value, next));
      }
      if (ts.isParameter(declaration) && ts.isFunctionDeclaration(declaration.parent) && declaration.parent.name) {
        const fn = declaration.parent;
        if (fn.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) return false;
        const fnSymbol = checker.getSymbolAtLocation(fn.name);
        const index = fn.parameters.indexOf(declaration);
        const calls = (references.get(fnSymbol) ?? []).filter(ref => ref !== fn.name);
        return calls.length > 0 && !writes.has(symbol) && calls.every(ref => {
          const call = ref.parent;
          return ts.isCallExpression(call) && call.expression === ref && call.arguments[index] && bmp(call.arguments[index], next);
        });
      }
      return false;
    }
    if (ts.isCallExpression(node)) {
      if (ts.isPropertyAccessExpression(node.expression)) {
        return ["substring", "charAt", "slice", "trim", "trimStart", "trimEnd", "toUpperCase", "toLowerCase"].includes(node.expression.name.text)
          && bmp(node.expression.expression, next);
      }
      if (ts.isIdentifier(node.expression)) {
        const symbol = checker.getSymbolAtLocation(node.expression);
        const fn = symbol?.valueDeclaration;
        if (!fn || !ts.isFunctionDeclaration(fn) || !fn.body || writes.has(symbol)) return false;
        if (next.has(fn)) return true; // recursive edges cannot introduce text by themselves
        next.add(fn);
        let found = false, safe = true;
        const visit = part => {
          if (ts.isFunctionLike(part)) return;
          if (ts.isReturnStatement(part)) { found = true; safe &&= bmp(part.expression, next); }
          else ts.forEachChild(part, visit);
        };
        visit(fn.body);
        return found && safe;
      }
    }
    return false;
  };
  const dslReceiver = receiver => {
    receiver = unwrap(receiver);
    if (!ts.isIdentifier(receiver) || writes.has(bindingKey(receiver))) return false;
    if (unshadowed(receiver, "self")) return true; // unwritten implicit DSL global
    const symbol = checker.getSymbolAtLocation(receiver);
    const declaration = symbol?.valueDeclaration;
    if (!declaration || !ts.isParameter(declaration)) return false;
    const callback = declaration.parent;
    const call = callback.parent;
    return (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
      && ts.isCallExpression(call) && unshadowed(call.expression, "sprite")
      && call.arguments[2] === callback && callback.parameters[0] === declaration;
  };
  const checkGrowth = (node, receiver, method, args) => {
    const count = constant(args[0]);
    if (method === "repeat" && typeof count === "number"
      && (Math.trunc(count) < 0 || Math.abs(count) === Infinity)) {
      fail(args[0], "repeat has an invalid negative or infinite constant count", "use a nonnegative finite count; dynamic invalid counts return an empty string");
    }
  };
  let bmpGuard;
  const runtimeBmpGuard = () => {
    if (bmpGuard) return bmpGuard;
    bmpGuard = fresh();
    const text = fresh(), parts = fresh(), item = fresh(), rebuilt = fresh();
    // splitText never selects a surrogate with text_select. The official player
    // keeps code units; the VM replaces isolated units. Check both representations
    // before any unit-selecting block, without relying on a mutable-source proof.
    helpers.push(`function ${bmpGuard}(${text}: string): boolean {
      const ${parts} = splitText(${text}, ""); let ${rebuilt} = "";
      for (const ${item} of ${parts}) {
        if (String(${item}) > "\uD7FF" && String(${item}) < "\uE000") return false;
        ${rebuilt} = join(${rebuilt}, ${item});
      }
      return ${rebuilt} === ${text};
    }`);
    return bmpGuard;
  };
  const growthHelper = (node, receiver, method, args, visit) => {
    for (const builtin of ["Math", "String", "join", "length", "selectText", "splitText"]) {
      if (checker.resolveName(builtin, node, ts.SymbolFlags.Value, false)?.declarations?.length) {
        fail(node, `Cannot lower ${method} while ${builtin} is shadowed`, `rename the local ${builtin} binding`);
      }
    }
    const name = fresh(), text = fresh(), count = fresh(), fill = fresh();
    const out = fresh(), index = fresh(), needed = fresh();
    helpers.push(method === "repeat" ? `function ${name}(${text}: string, ${count}: number): string {
      if (String(${count}) === "NaN") ${count} = 0;
      if (Math.trunc(${count}) < 0 || String(${count}) === "Infinity" || String(${count}) === "-Infinity") return "";
      if (length(${text}) === 0) return "";
      ${count} = Math.min(Math.max(0, Math.trunc(${count})), Math.floor(65536 / length(${text})));
      let ${out} = "";
      while (${count} > 0) {
        if (${count} % 2 === 1) ${out} = join(${out}, ${text});
        ${count} = Math.floor(${count} / 2);
        if (${count} > 0) ${text} = join(${text}, ${text});
      }
      return ${out};
    }` : `function ${name}(${text}: string, ${count}: number, ${fill}: string): string {
      if (String(${count}) === "NaN") ${count} = 0;
      ${count} = Math.min(65536, Math.max(0, Math.trunc(${count})));
      const ${needed}: number = Math.max(0, Math.trunc(${count}) - length(${text}));
      if (${needed} === 0 || length(${fill}) === 0) return ${text};
      if (${needed} % length(${fill}) !== 0 && !${runtimeBmpGuard()}(${fill})) return ${text};
      let ${out} = "";
      while (length(${out}) + length(${fill}) <= ${needed}) {
        ${out} = join(${out}, ${fill});
        if (length(${out}) + length(${fill}) * 2 <= ${needed}) ${fill} = join(${fill}, ${fill});
      }
      if (length(${out}) < ${needed}) ${out} = join(${out}, selectText(${fill}, 1, ${needed} - length(${out})));
      return ${method === "padStart" ? `join(${out}, ${text})` : `join(${text}, ${out})`};
    }`);
    const actual = [receiver, ...args];
    if (method !== "repeat" && args.length < 2) actual.push(f.createStringLiteral(" "));
    return f.createCallExpression(f.createIdentifier(name), undefined, actual.map(arg => ts.visitNode(arg, visit)));
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
      if ((ts.isNewExpression(node) || ts.isCallExpression(node)) && unshadowed(node.expression, "RegExp")) {
        fail(node, "RegExp constructors are not supported", "use an immediate flag-free /literal/.test(text) call or explicit string operations");
      }
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
      if (method === "test" && ts.isRegularExpressionLiteral(unwrap(receiver))) {
        optional();
        arity(node, 1, 1, "RegExp.test");
        const pattern = literalRegex(unwrap(receiver), fail);
        const input = unwrap(args[0]);
        const stringConversion = ts.isCallExpression(input) && unshadowed(input.expression, "String");
        if (kind(input) !== "string" && !stringConversion) fail(args[0], "RegExp.test requires a statically string argument", "convert the argument explicitly with String(value) before matching");
        for (const builtin of ["length", "String", "splitText", "join", "selectText"]) {
          if (checker.resolveName(builtin, node, ts.SymbolFlags.Value, false)?.declarations?.length) {
            fail(node, `Cannot lower RegExp.test while ${builtin} is shadowed`, `rename the local ${builtin} binding`);
          }
        }
        const name = fresh(), text = fresh();
        helpers.push(regexTestHelper(name, text, pattern));
        return replace(node, f.createCallExpression(f.createIdentifier(name), undefined, [ts.visitNode(args[0], visit)]));
      }
      if (method === "localeCompare" && !checker.getSymbolAtLocation(callee.name)?.declarations?.some(ts.isMethodDeclaration)) {
        fail(node, "String.localeCompare is not supported: locale/ICU collation cannot be reproduced by the available string blocks", "choose an explicit code-unit ordering with < and >, or supply a precomputed locale-specific ordering table");
      }
      const listHandle = ts.isCallExpression(receiver) && ts.isPropertyAccessExpression(receiver.expression)
        && receiver.expression.name.text === "list" && dslReceiver(receiver.expression.expression);
      if (Object.hasOwn(stringLimits, method) && kind(receiver) !== "array" && !dslReceiver(receiver) && !listHandle) {
        // Known array/user methods belong to their own lowering. Unknown
        // receivers of code-unit/growth methods must not skip safety checks.
        const isString = kind(receiver) === "string" || possible(receiver)?.every(v => typeof v === "string");
        const userMethod = checker.getSymbolAtLocation(callee.name)?.declarations?.some(ts.isMethodDeclaration);
        if (isString || !userMethod && ["charAt", "substring", "split", "includes", "indexOf", "lastIndexOf", "startsWith", "endsWith", "repeat", "padStart", "padEnd"].includes(method)) {
          optional();
          arity(node, ...stringLimits[method], `String.${method}`);
          if (!["replace", "replaceAll"].includes(method) && args.some(arg => arg.kind === ts.SyntaxKind.RegularExpressionLiteral)) {
            fail(node, `String.${method} regular-expression overload is not supported`, "use a string search/separator instead");
          }
          // replace/replaceAll arguments are validated with the TS checker in
          // compile-ts (narrowed nullable reads, String(...) conversions).
          if (["includes", "indexOf", "lastIndexOf", "startsWith", "endsWith", "split"].includes(method)
            && args[0] && kind(args[0]) !== "string" && !possible(args[0])?.every(v => typeof v === "string")) {
            fail(args[0], `String.${method} requires a string search/separator`, "use an explicit string instead of a regular expression or coercing overload");
          }
          const values = args.map(arg => constant(arg));
          const text = constant(receiver);
          if (["repeat", "padStart", "padEnd"].includes(method)) checkGrowth(node, receiver, method, args);
          if (["charAt", "substring", "includes", "indexOf", "lastIndexOf", "startsWith", "endsWith", "split", "repeat", "padStart", "padEnd"].includes(method)
            && typeof text === "string" && values.every(v => v !== UNKNOWN && (typeof v === "string" || typeof v === "number"))
            && (!["repeat", "padStart", "padEnd"].includes(method)
              || Number.isFinite(values[0]) && values[0] <= 65536
                && (method !== "repeat" || text.length * Math.max(0, Math.trunc(values[0])) <= 65536))) {
            const output = fold(node, () => text[method](...values));
            return replace(node, Array.isArray(output) ? f.createArrayLiteralExpression(output.map(v => literal(v, node))) : literal(output, node));
          }
          const selectsUnits = ["charAt", "substring", "indexOf", "lastIndexOf", "endsWith"].includes(method)
            || method === "startsWith" && args.length > 1
            || method === "includes" && args.length > 1
            || method === "split" && args.length > 0 && !(possible(args[0])?.every(v => typeof v === "string" && v.length > 0));
          if (selectsUnits && !bmp(receiver)) {
            for (const builtin of ["String", "join", "splitText"]) {
              if (checker.resolveName(builtin, node, ts.SymbolFlags.Value, false)?.declarations?.length) {
                fail(node, `Cannot guard ${method} while ${builtin} is shadowed`, `rename the local ${builtin} binding`);
              }
            }
            const name = fresh(), textArg = fresh();
            helpers.push(`function ${name}(${textArg}: string): string { if (!${runtimeBmpGuard()}(${textArg})) return ""; return ${textArg}; }`);
            return replace(node, f.updateCallExpression(node,
              f.updatePropertyAccessExpression(callee, f.createCallExpression(f.createIdentifier(name), undefined, [ts.visitNode(receiver, visit)]), callee.name),
              node.typeArguments, args.map(arg => ts.visitNode(arg, visit))));
          }
          if (["repeat", "padStart", "padEnd"].includes(method)) return replace(node, growthHelper(node, receiver, method, args, visit));
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
      edit.text = replacement;
      text = text.slice(0, edit.start) + replacement + text.slice(edit.end);
    }
    if (helpers.length) text += `\n${helpers.join("\n")}\n`;
    const output = ts.createSourceFile(sourceFile.fileName, text, sourceFile.languageVersion, true, sourceFile.scriptKind);
    copyClassNodeOrigins(sourceFile, output, selected);
    return output;
  } finally {
    result.dispose();
  }
}
