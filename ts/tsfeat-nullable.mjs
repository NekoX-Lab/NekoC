import ts from "typescript";

// null / undefined as runtime values (docs/ts-nullable.md).
//
// The pass rewrites the source text in place, before class lowering, so the
// later passes only ever see non-nullable types. Every value whose static type
// is `B | null | undefined` keeps its ordinary representation when it holds a
// B; null and undefined become a sentinel chosen *outside B's value domain*:
//
//   number / boolean / object or class reference / array:  "null", "undefined" (text)
//   string:                                                 -1, -2 (number)
//
// Kitten N's equality does not coerce between text and numbers, so a sentinel
// never equals a legal value of its position. Sentinels and checks are written
// as calls to typed ambient functions named __nekocNil<Op>_<D>_<k>; the block
// compiler recognizes the reserved prefix (compile-ts.mjs, nilIntrinsic).
//
// Edits never insert newlines into user lines, so diagnostics from later
// passes keep their line numbers. Declarations are appended after the source.

const NIL = ts.TypeFlags.Null | ts.TypeFlags.Undefined;
const LIB = "/__nekoc_nullable_types.d.ts";
const PRINT_CALLS = new Set(["console.log", "consoleLog", "String", "say", "think", "sayFor", "thinkFor"]);

const unparen = node => {
  while (node && ts.isParenthesizedExpression(node)) node = node.expression;
  return node;
};
const isUndefinedIdentifier = node => ts.isIdentifier(node) && node.text === "undefined";
const isVoidZero = node => ts.isVoidExpression(node) && ts.isNumericLiteral(unparen(node.expression)) && unparen(node.expression).text === "0";

// Cheap syntactic gate: programs that never mention nullish syntax are
// returned untouched, so their generated blocks stay byte-identical.
function mentionsNullish(file) {
  let found = false;
  const visit = node => {
    if (found) return;
    if (node.kind === ts.SyntaxKind.NullKeyword || node.kind === ts.SyntaxKind.UndefinedKeyword
      || isUndefinedIdentifier(node) && !(ts.isCallExpression(node.parent) && node.parent.arguments.includes(node))
      || ts.isVoidExpression(node)
      || (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isCallExpression(node)) && node.questionDotToken
      || ts.isBinaryExpression(node) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.QuestionQuestionEqualsToken].includes(node.operatorToken.kind)
      || (ts.isPropertySignature(node) || ts.isPropertyDeclaration(node)) && node.questionToken) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

// Type facts only (strictNullChecks); no runtime implementation is implied.
const AMBIENT = `
interface Array<T> {
  [n: number]: T; length: number;
  push(...items: T[]): number; unshift(...items: T[]): number;
  pop(): T | undefined; shift(): T | undefined;
  find(predicate: (value: T, index: number, array: T[]) => unknown): T | undefined;
  findIndex(predicate: (value: T, index: number, array: T[]) => unknown): number;
  map<U>(callback: (value: T, index: number, array: T[]) => U): U[];
  filter(predicate: (value: T, index: number, array: T[]) => unknown): T[];
  forEach(callback: (value: T, index: number, array: T[]) => void): void;
  reduce<U>(callback: (acc: U, value: T, index: number, array: T[]) => U, initial: U): U;
  slice(start?: number, end?: number): T[]; concat(...items: (T | T[])[]): T[];
  reverse(): T[]; sort(compare?: (a: T, b: T) => number): T[];
  splice(start: number, count?: number, ...items: T[]): T[];
  join(separator?: string): string; indexOf(value: T): number; includes(value: T): boolean;
  every(predicate: (value: T, index: number, array: T[]) => unknown): boolean;
  some(predicate: (value: T, index: number, array: T[]) => unknown): boolean;
  fill(value: T): T[];
}
interface ReadonlyArray<T> extends Array<T> {}
interface String {
  readonly length: number; [n: number]: string;
  charAt(index: number): string; indexOf(search: string): number; includes(search: string): boolean;
  slice(start?: number, end?: number): string; substring(start: number, end?: number): string;
  toUpperCase(): string; toLowerCase(): string; trim(): string; split(separator: string): string[];
  startsWith(search: string): boolean; endsWith(search: string): boolean; repeat(count: number): string;
  padStart(length: number, fill?: string): string; padEnd(length: number, fill?: string): string;
  replace(search: string, replacement: string): string; replaceAll(search: string, replacement: string): string;
}
interface Number { toFixed(digits?: number): string; }
interface Boolean {}
interface Object {}
interface Function {}
interface CallableFunction {}
interface NewableFunction {}
interface IArguments {}
interface RegExp {}
declare namespace Math {
  const PI: number; function floor(n: number): number; function ceil(n: number): number;
  function round(n: number): number; function abs(n: number): number; function sqrt(n: number): number;
  function max(...n: number[]): number; function min(...n: number[]): number; function random(): number;
  function pow(a: number, b: number): number; function trunc(n: number): number;
}
`;

function nullableChecker(sourceFile) {
  const lib = "/__nekoc_nullable_types.d.ts";
  const files = new Map([[sourceFile.fileName, sourceFile], [lib, ts.createSourceFile(lib, AMBIENT, ts.ScriptTarget.Latest, true)]]);
  const host = {
    getSourceFile: name => files.get(name), readFile: name => files.get(name)?.text, fileExists: name => files.has(name),
    getDefaultLibFileName: () => lib, writeFile() {}, getCurrentDirectory: () => "", getDirectories: () => [],
    getCanonicalFileName: name => name, useCaseSensitiveFileNames: () => true, getNewLine: () => "\n",
  };
  return ts.createProgram([...files.keys()], { noLib: true, noResolve: true, strictNullChecks: true }, host).getTypeChecker();
}

export function lowerTsNullable(input) {
  if (!mentionsNullish(input)) return input;
  const text = input.text;
  const sourceFile = ts.createSourceFile(input.fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const checker = nullableChecker(sourceFile);
  const fail = (node, message, alternative) => {
    const p = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    const error = new Error(`${message}; alternative: ${alternative}`);
    error.name = "CompileError";
    error.code = "NEKOC_TS_NULLABLE";
    error.location = { file: sourceFile.fileName, line: p.line + 1, column: p.character + 1 };
    throw error;
  };
  const scanReserved = node => {
    if (ts.isIdentifier(node) && node.text.startsWith("__nekocNil")) fail(node, "Names starting with __nekocNil are reserved for null/undefined lowering", "rename this identifier");
    ts.forEachChild(node, scanReserved);
  };
  scanReserved(sourceFile);

  let salt = 2166136261;
  for (const ch of sourceFile.fileName.replaceAll("\\", "/")) salt = Math.imul(salt ^ ch.charCodeAt(0), 16777619) >>> 0;
  salt %= 100000;

  // ---------- types and domains ----------
  const parts = t => (t.isUnion() ? t.types : [t]);
  const maybeNil = t => !!t && parts(t).some(p => p.flags & NIL);
  const base = t => parts(t).filter(p => !(p.flags & (NIL | ts.TypeFlags.Void)));
  const kindOf = p => {
    if (p.flags & ts.TypeFlags.StringLike) return "S";
    if (p.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.EnumLike)) return "N";
    if (p.flags & ts.TypeFlags.BooleanLike) return "B";
    if (p.flags & ts.TypeFlags.Object && !p.getCallSignatures().length) return "R";
    return "?";
  };
  // null: the base type has no domain (pure null/undefined/any); "?": mixed.
  const domain = t => {
    if (!t || t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return null;
    const b = base(t);
    if (!b.length) return null;
    const kinds = new Set(b.map(kindOf));
    return kinds.size === 1 && !kinds.has("?") ? [...kinds][0] : "?";
  };
  const legacyOptionalParameter = node => {
    node = unparen(node);
    if (!ts.isIdentifier(node)) return false;
    const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration;
    if (!declaration || !ts.isParameter(declaration) || !declaration.questionToken) return false;
    const mentions = n => n.kind === ts.SyntaxKind.UndefinedKeyword || ts.isLiteralTypeNode(n) && n.literal.kind === ts.SyntaxKind.NullKeyword || !!ts.forEachChild(n, mentions);
    return !declaration.type || !mentions(declaration.type);
  };
  const flowType = node => checker.getTypeAtLocation(node);
  const declaredType = node => {
    node = unparen(node);
    if (chainLink(node)) return plainType(node);
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      const declaration = symbol?.valueDeclaration;
      if (declaration && (ts.isVariableDeclaration(declaration) || ts.isParameter(declaration) || ts.isPropertyDeclaration(declaration))) {
        return checker.getTypeOfSymbolAtLocation(symbol, declaration);
      }
    }
    if (ts.isPropertyAccessExpression(node)) {
      const symbol = checker.getSymbolAtLocation(node.name);
      if (symbol && symbol.flags & ts.SymbolFlags.Property) return checker.getTypeOfSymbolAtLocation(symbol, symbol.valueDeclaration ?? node);
    }
    if (ts.isElementAccessExpression(node)) {
      const target = checker.getNonNullableType(declaredType(node.expression));
      const key = unparen(node.argumentExpression);
      const property = (ts.isStringLiteral(key) || ts.isNumericLiteral(key)) && checker.getPropertyOfType(target, key.text);
      if (property) return checker.getTypeOfSymbolAtLocation(property, property.valueDeclaration ?? node);
      const index = checker.getIndexTypeOfType(target, flowType(key).flags & ts.TypeFlags.NumberLike ? ts.IndexKind.Number : ts.IndexKind.String);
      if (index) return index;
    }
    return flowType(node);
  };
  const untrusted = node => {
    node = unparen(node);
    if (!ts.isCallExpression(node)) return false;
    const declaration = checker.getResolvedSignature(node)?.declaration;
    return !!declaration && declaration.getSourceFile().fileName === LIB && maybeNil(flowType(node));
  };
  // A value that may hold a sentinel at this point of the program.
  // An optional chain may short-circuit even when TS typed it never/undefined.
  const chainMayShort = n => {
    for (; chainLink(n); n = n.expression) if (n.questionDotToken && maybeNil(plainType(n.expression))) return true;
    return false;
  };
  const mayHoldNil = node => maybeNil(flowType(node)) || chainLink(unparen(node)) && chainMayShort(unparen(node));
  const nilValue = node => !legacyOptionalParameter(node) && mayHoldNil(node) && domain(declaredType(node)) !== null;
  // Declared nullable, even where TS has narrowed this read to non-null.
  const nilDeclared = node => !legacyOptionalParameter(node) && (mayHoldNil(node) || maybeNil(declaredType(node)))
    && domain(declaredType(node)) !== null;

  // Do not erase nullish slice boundaries into numeric-typed sentinels: the
  // array helper intentionally accepts numbers only, not JS ToNumber coercion.
  const checkSliceBoundaries = node => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "slice") {
      const receiver = checker.getNonNullableType(flowType(node.expression.expression));
      if (checker.isArrayType(receiver) || checker.isTupleType(receiver)) {
        for (const arg of node.arguments) {
          if (mayHoldNil(arg)) fail(arg, "Array.slice boundaries must be numbers",
            "omit optional arguments or convert the value to a number before this call");
        }
      }
    }
    ts.forEachChild(node, checkSliceBoundaries);
  };

  // ---------- declarations ----------
  const topTypes = new Set(["Array", "ReadonlyArray"]);
  for (const statement of sourceFile.statements) {
    if ((ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isClassDeclaration(statement)
      || ts.isEnumDeclaration(statement)) && statement.name) topTypes.add(statement.name.text);
  }
  const printer = ts.createPrinter({ removeComments: true });
  const keys = new Map();
  const declarations = [];
  const typeText = (t, node) => {
    const typeNode = checker.typeToTypeNode(t, undefined, ts.NodeBuilderFlags.NoTruncation | ts.NodeBuilderFlags.UseAliasDefinedOutsideCurrentScope
      | ts.NodeBuilderFlags.InTypeAlias);
    if (!typeNode) fail(node, "This nullable type cannot be represented", "use a named top-level type");
    const printed = printer.printNode(ts.EmitHint.Unspecified, typeNode, sourceFile).replace(/\s+/g, " ");
    const file = ts.createSourceFile("__nekoc_nil_type.ts", `type __T = ${printed};`, ts.ScriptTarget.Latest, true);
    const check = n => {
      if (ts.isTypeQueryNode(n) || ts.isImportTypeNode(n) || ts.isTypeReferenceNode(n) && !topTypes.has(ts.isIdentifier(n.typeName) ? n.typeName.text : n.typeName.left.getText(file))) {
        fail(node, `Nullable value type ${printed} must name only top-level declared types`, "declare the interface, type alias or class at the top level of the file");
      }
      ts.forEachChild(n, check);
    };
    check(file.statements[0].type);
    return stripTypes(file, file.statements[0].type);
  };
  const keyFor = (t, node) => {
    const d = domain(t);
    if (d === null || d === "?") fail(node, `Values of type ${checker.typeToString(t)} cannot hold null/undefined at runtime`,
      "use a single number, string, boolean, object or class type plus null/undefined");
    const b = checker.getNonNullableType(t);
    const shown = typeText(b, node);
    const id = `${d}|${shown}`;
    if (!keys.has(id)) {
      const k = `${d}_${salt}${keys.size + 1}`;
      keys.set(id, k);
      declarations.push(
        `declare function __nekocNilNull_${k}(): ${shown};`,
        `declare function __nekocNilUndef_${k}(): ${shown};`,
        `declare function __nekocNilIs_${k}(value: ${shown}): boolean;`,
        `declare function __nekocNilTruthy_${k}(value: ${shown}): boolean;`,
        `declare function __nekocNilText_${k}(value: ${shown}): string;`,
        `declare function __nekocNilCoalesce_${k}(value: ${shown}, fallback: ${shown}): ${shown};`,
        `declare function __nekocNilIf_${k}(condition: boolean, whenTrue: ${shown}, whenFalse: ${shown}): ${shown};`,
        `declare function __nekocNilLooseEq_${k}(a: ${shown}, b: ${shown}): boolean;`);
    }
    return keys.get(id);
  };
  const sentinel = (literal, k) => `__nekocNil${literal.kind === ts.SyntaxKind.NullKeyword ? "Null" : "Undef"}_${k}()`;
  const undef = k => `__nekocNilUndef_${k}()`;

  // ---------- text emission ----------
  const memo = new Map();
  const inType = node => {
    for (let p = node; p; p = p.parent) {
      if (ts.isTypeNode(p) && !ts.isExpressionWithTypeArguments(p)) return true;
      if (ts.isStatement(p) || ts.isSourceFile(p)) return false;
    }
    return false;
  };
  function splice(node, overrides = new Map()) {
    const start = ts.isSourceFile(node) ? 0 : node.getStart(sourceFile);
    let result = "";
    let cursor = start;
    ts.forEachChild(node, child => {
      if (child.pos === child.end && !overrides.has(child)) return;
      const s = child.getStart(sourceFile);
      if (s < cursor) return;
      result += text.slice(cursor, s) + (overrides.has(child) ? overrides.get(child) : out(child));
      cursor = child.end;
    });
    return result + text.slice(cursor, node.end);
  }
  function out(node) {
    if (memo.has(node)) return memo.get(node);
    let result = inType(node) ? typeRule(node) : rule(node);
    if (result === undefined) result = splice(node);
    memo.set(node, result);
    return result;
  }

  // Syntactic stripping shared by user types and printed declaration types.
  function stripTypes(file, root) {
    const local = new Map();
    const emit = node => {
      if (local.has(node)) return local.get(node);
      let result;
      if (ts.isUnionTypeNode(node)) {
        const kept = node.types.filter(t => !(t.kind === ts.SyntaxKind.UndefinedKeyword || ts.isLiteralTypeNode(t) && t.literal.kind === ts.SyntaxKind.NullKeyword));
        if (kept.length && kept.length < node.types.length) result = kept.map(emit).join(" | ");
      } else if (ts.isPropertySignature(node) && node.questionToken) {
        result = sub(node, new Map([[node.questionToken, ""]]));
      }
      if (result === undefined) result = sub(node);
      local.set(node, result);
      return result;
    };
    const sub = (node, overrides = new Map()) => {
      let result = "";
      let cursor = node.getStart(file);
      ts.forEachChild(node, child => {
        const s = child.getStart(file);
        if (s < cursor) return;
        result += file.text.slice(cursor, s) + (overrides.has(child) ? overrides.get(child) : emit(child));
        cursor = child.end;
      });
      return result + file.text.slice(cursor, node.end);
    };
    return emit(root);
  }
  function typeRule(node) {
    if (ts.isUnionTypeNode(node)) {
      const kept = node.types.filter(t => !(t.kind === ts.SyntaxKind.UndefinedKeyword || ts.isLiteralTypeNode(t) && t.literal.kind === ts.SyntaxKind.NullKeyword));
      if (kept.length && kept.length < node.types.length) return kept.map(out).join(" | ");
    }
    if (ts.isPropertySignature(node) && node.questionToken) return splice(node, new Map([[node.questionToken, ""]]));
    return undefined;
  }

  // ---------- contexts ----------
  const climb = node => {
    let c = node;
    while (c.parent && (ts.isParenthesizedExpression(c.parent)
      || (ts.isAsExpression(c.parent) || ts.isSatisfiesExpression(c.parent)) && maybeNil(flowType(c.parent)))) c = c.parent;
    return c;
  };
  const isEquality = kind => [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(kind);
  const isLogical = kind => kind === ts.SyntaxKind.AmpersandAmpersandToken || kind === ts.SyntaxKind.BarBarToken;
  const calleeText = call => {
    const e = call.expression;
    if (ts.isIdentifier(e)) return e.text;
    if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)) return `${e.expression.text}.${e.name.text}`;
    return "";
  };
  const isStringType = node => !!(flowType(node).flags & ts.TypeFlags.StringLike) && !maybeNil(flowType(node));
  const conditionContext = node => context(node) === "truthy";
  function context(node) {
    const c = climb(node);
    const p = c.parent;
    if (!p) return "bad";
    if (ts.isAsExpression(p)) {
      // The collection pass reserves this helper namespace and proves the
      // matching has/get guard before generating a non-null result signature.
      let owner = p.parent;
      while (owner && !ts.isFunctionDeclaration(owner)) owner = owner.parent;
      if (owner?.name?.text.match(/^__nekocMap_\d+_\d+_op_known$/)) return "flow";
    }
    if ((ts.isIfStatement(p) || ts.isWhileStatement(p) || ts.isDoStatement(p)) && p.expression === c) return "truthy";
    if (ts.isForStatement(p)) return p.condition === c ? "truthy" : "discard";
    if (ts.isConditionalExpression(p)) return p.condition === c ? "truthy" : "flow";
    if (ts.isPrefixUnaryExpression(p)) return p.operator === ts.SyntaxKind.ExclamationToken ? "truthy" : "bad";
    if (ts.isPostfixUnaryExpression(p)) return "bad";
    if (ts.isBinaryExpression(p)) {
      const op = p.operatorToken.kind;
      if (isLogical(op)) return conditionContext(p) ? "truthy" : "logical";
      if (isEquality(op)) return "compare";
      if (op === ts.SyntaxKind.QuestionQuestionToken) return p.left === c ? "coalesce" : "flow";
      if (op === ts.SyntaxKind.QuestionQuestionEqualsToken) return p.left === c ? "coalesce" : "flow";
      if (op === ts.SyntaxKind.EqualsToken) return p.right === c ? "flow" : "target";
      if (op === ts.SyntaxKind.PlusEqualsToken && p.right === c && isStringType(p.left)) return "print";
      if (op === ts.SyntaxKind.PlusToken && isStringType(p.left === c ? p.right : p.left)) return "print";
      if (op === ts.SyntaxKind.CommaToken) return p.left === c ? "discard" : context(p);
      return "bad";
    }
    if (ts.isCallExpression(p) || ts.isNewExpression(p)) {
      if (p.expression === c) return "bad";
      if (ts.isCallExpression(p) && PRINT_CALLS.has(calleeText(p))) return "print";
      return checker.getResolvedSignature(p)?.declaration ? "flow" : "bad";
    }
    if (ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) {
      if (p.expression !== c) return "bad";
      if (p.questionDotToken) return "chain";
      return ts.isOptionalChain(p) && ts.isOptionalChain(c) ? "chain" : "bad";
    }
    if (ts.isTemplateSpan(p)) return "print";
    if (ts.isReturnStatement(p) || ts.isArrowFunction(p) || ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p)
      || ts.isShorthandPropertyAssignment(p) || ts.isArrayLiteralExpression(p) || ts.isParameter(p)
      || ts.isPropertyDeclaration(p) || ts.isCaseClause(p) || ts.isSwitchStatement(p)) return "flow";
    if (ts.isExpressionStatement(p) || ts.isVoidExpression(p)) return "discard";
    if (ts.isTypeOfExpression(p) || ts.isDeleteExpression(p)) return "legacy";
    return "bad";
  }

  const isNilLiteral = node => {
    node = unparen(node);
    return node.kind === ts.SyntaxKind.NullKeyword
      || isUndefinedIdentifier(node) && !checker.getSymbolAtLocation(node)?.declarations?.length
      || isVoidZero(node);
  };
  const literalKind = node => (unparen(node).kind === ts.SyntaxKind.NullKeyword ? { kind: ts.SyntaxKind.NullKeyword } : { kind: 0 });
  const literalText = node => (unparen(node).kind === ts.SyntaxKind.NullKeyword ? "null" : "undefined");

  // Pure references may be read twice (test, then use) without changing behavior.
  const pure = node => {
    node = unparen(node);
    if (ts.isNonNullExpression(node) || ts.isAsExpression(node)) return pure(node.expression);
    if (ts.isIdentifier(node) || node.kind === ts.SyntaxKind.ThisKeyword) return true;
    if (ts.isPropertyAccessExpression(node)) {
      const symbol = checker.getSymbolAtLocation(node.name);
      if (symbol && symbol.flags & ts.SymbolFlags.Accessor) return false;
      return pure(node.expression);
    }
    if (ts.isElementAccessExpression(node)) {
      const a = unparen(node.argumentExpression);
      return pure(node.expression) && (ts.isIdentifier(a) || ts.isLiteralExpression(a));
    }
    return false;
  };

  // Target type of a literal null/undefined in a value position.
  const literalTarget = node => {
    const c = climb(node);
    const p = c.parent;
    if (ts.isCaseClause(p)) return declaredType(p.parent.parent.expression);
    if (ts.isReturnStatement(p)) {
      let fn = p.parent;
      while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
      const signature = fn && checker.getSignatureFromDeclaration(fn);
      if (signature) return checker.getReturnTypeOfSignature(signature);
    }
    if (ts.isConditionalExpression(p) || ts.isBinaryExpression(p) && (isLogical(p.operatorToken.kind)
      || p.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) {
      return checker.getContextualType(p) ?? flowType(p);
    }
    if (ts.isBinaryExpression(p) && [ts.SyntaxKind.EqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken].includes(p.operatorToken.kind)) return declaredType(p.left);
    return checker.getContextualType(c);
  };
  const omittedArgument = node => {
    let c = node;
    while (c.parent && (ts.isParenthesizedExpression(c.parent) || ts.isAsExpression(c.parent) || ts.isSatisfiesExpression(c.parent)
      || ts.isNonNullExpression(c.parent) || ts.isTypeAssertionExpression(c.parent))) c = c.parent;
    const p = c.parent;
    if (!ts.isCallExpression(p) && !ts.isNewExpression(p) || !isUndefinedIdentifier(unparen(node))) return false;
    const index = p.arguments.indexOf(c);
    const parameter = checker.getResolvedSignature(p)?.declaration?.parameters?.[index];
    return !!parameter && (!!parameter.questionToken || !!parameter.initializer);
  };

  // ---------- optional chains ----------
  const chainLink = n => (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n) || ts.isCallExpression(n) || ts.isNonNullExpression(n)) && ts.isOptionalChain(n);
  const outermostChain = n => chainLink(n) && !(n.parent && chainLink(n.parent) && n.parent.expression === n);
  // Type of a chain prefix read without `?.`, from declared (not narrowed)
  // types: TS narrows `let x: T | null = null; x?.m()` to never and loses m.
  const plainType = n => {
    n = unparen(n);
    if (!chainLink(n) && !((ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n) || ts.isCallExpression(n)))) return declaredType(n);
    const receiver = plainType(n.expression);
    const target = receiver && checker.getNonNullableType(receiver);
    if (ts.isPropertyAccessExpression(n)) {
      const property = target && checker.getPropertyOfType(target, n.name.text);
      if (property) return checker.getTypeOfSymbolAtLocation(property, n);
    } else if (ts.isElementAccessExpression(n)) {
      const element = target && checker.getIndexTypeOfType(target, ts.IndexKind.Number);
      if (element) return element;
    } else if (ts.isCallExpression(n)) {
      const signature = target?.getCallSignatures()[0];
      if (signature) return checker.getReturnTypeOfSignature(signature);
    } else if (ts.isNonNullExpression(n)) return target;
    // Unknown optional properties/calls must not recurse back through
    // declaredType -> plainType on the same chain node.
    return flowType(n);
  };
  const plainPure = n => {
    if (chainLink(n)) {
      if (ts.isCallExpression(n) || ts.isNonNullExpression(n)) return false;
      if (ts.isPropertyAccessExpression(n)) {
        const symbol = checker.getSymbolAtLocation(n.name);
        if (symbol && symbol.flags & ts.SymbolFlags.Accessor) return false;
        return plainPure(n.expression);
      }
      const a = unparen(n.argumentExpression);
      return plainPure(n.expression) && (ts.isIdentifier(a) || ts.isLiteralExpression(a));
    }
    return pure(n);
  };
  const plainText = n => {
    if (!chainLink(n)) return out(n);
    if (ts.isNonNullExpression(n)) fail(n, "Non-null assertions inside optional chains are not supported", "split the chain and test each value explicitly");
    if (ts.isCallExpression(n) && n.questionDotToken) fail(n, "Optional function calls f?.() are not supported because functions are not runtime values", "call a declared function or method directly");
    const overrides = new Map([[n.expression, plainText(n.expression)]]);
    if (n.questionDotToken) overrides.set(n.questionDotToken, ts.isPropertyAccessExpression(n) ? "." : "");
    return splice(n, overrides);
  };
  const chainTests = chain => {
    const tests = [];
    const prefixes = [];
    for (let n = chain; chainLink(n); n = n.expression) if (n.questionDotToken) prefixes.unshift(n.expression);
    for (const prefix of prefixes) {
      if (untrusted(prefix)) fail(prefix, "pop/shift/find results do not carry a runtime undefined value", "check the length or findIndex result first, then read by index");
      const t = plainType(prefix);
      if (legacyOptionalParameter(prefix) || !maybeNil(t)) continue;
      if (!plainPure(prefix)) fail(prefix, "Optional chaining is supported only on variables, this and property paths", "store the receiver in a const first, then use ?. on that const");
      tests.push(`__nekocNilIs_${keyFor(t, prefix)}(${plainText(prefix)})`);
    }
    return tests;
  };

  // ---------- rules ----------
  function rule(node) {
    const specific = specificRule(node);
    if (!ts.isExpression(node) || ts.isParenthesizedExpression(node.parent) || !valuePosition(node)) return specific;
    return contextRule(node, specific);
  }
  function valuePosition(node) {
    const p = node.parent;
    if (!p || ts.isTypeNode(node)) return false;
    if (node.kind === ts.SyntaxKind.NullKeyword || isUndefinedIdentifier(node)) return false;
    if (ts.isIdentifier(node)) {
      if (ts.isPropertyAccessExpression(p) && p.name === node) return false;
      if ((ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p)
        || ts.isFunctionDeclaration(p) || ts.isClassDeclaration(p) || ts.isMethodDeclaration(p) || ts.isEnumMember(p)
        || ts.isBindingElement(p) || ts.isGetAccessor(p) || ts.isSetAccessor(p) || ts.isPropertySignature(p)
        || ts.isMethodSignature(p) || ts.isInterfaceDeclaration(p) || ts.isTypeAliasDeclaration(p) || ts.isEnumDeclaration(p)
        || ts.isFunctionExpression(p) || ts.isClassExpression(p)) && p.name === node) return false;
      if (ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p) || ts.isExportSpecifier(p)
        || ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p) || ts.isQualifiedName(p) || ts.isModuleDeclaration(p)) return false;
    }
    if (ts.isExpressionWithTypeArguments(node) || ts.isExpressionWithTypeArguments(p) || ts.isHeritageClause(p)) return false;
    if (ts.isOmittedExpression(node) || ts.isSpreadElement(node)) return false;
    return true;
  }
  function contextRule(node, specific) {
    if (!mayHoldNil(node) || legacyOptionalParameter(node)) return specific;
    const ctx = context(node);
    if (untrusted(node)) {
      const target = ctx === "flow" ? literalTarget(node) ?? (ts.isVariableDeclaration(climb(node).parent) ? declaredType(climb(node).parent.name) : null) : null;
      if (["truthy", "coalesce", "chain", "compare", "logical"].includes(ctx) || target && maybeNil(target)) {
        fail(node, "pop/shift/find results do not carry a runtime undefined value", "check the length or findIndex result first, then read by index");
      }
      return specific;
    }
    const d = domain(declaredType(node));
    if (d === null) return specific;
    const inner = () => specific ?? splice(node);
    switch (ctx) {
      case "truthy":
        return `__nekocNilTruthy_${keyFor(declaredType(node), node)}(${inner()})`;
      case "print":
        if (d === "R") fail(node, "Objects cannot be converted to text", "print a scalar property instead");
        return d === "S" ? `__nekocNilText_${keyFor(declaredType(node), node)}(${inner()})` : specific;
      case "flow": case "compare": case "coalesce": case "chain": case "logical": case "discard": case "target": case "legacy":
        if (d === "?") fail(node, `Values of type ${checker.typeToString(flowType(node))} cannot hold null/undefined at runtime`,
          "use a single number, string, boolean, object or class type plus null/undefined");
        return specific;
      default:
        fail(node, `This value may be null or undefined here (type ${checker.typeToString(flowType(node))})`,
          "narrow it first, for example if (x !== null) { ... }, or use ?. / ?? (null/undefined arithmetic and property reads are not supported)");
    }
  }

  function specificRule(node) {
    if (ts.isCallExpression(node) && calleeText(node) === "String" && node.arguments.length === 1) {
      // TS may keep a stale string flow type across earlier calls. Decode at
      // each selected value's origin, preserving branches and single evaluation.
      const nullableSource = part => ts.isExpression(part) && valuePosition(part) && nilDeclared(part)
        || !!ts.forEachChild(part, nullableSource);
      const unsupportedSelection = value => fail(value, "String conversion cannot preserve nullable value selection in this expression",
        "use explicit if/else branches and String(value), or ?? on a nullable variable with a string fallback");
      const convert = value => {
        if (ts.isParenthesizedExpression(value) || ts.isAsExpression(value)
          || ts.isSatisfiesExpression(value)) return `(${convert(value.expression)})`;
        if (ts.isConditionalExpression(value)) {
          // The condition must keep raw truthiness, not truthiness of decoded
          // "null"/"undefined" strings. Reject unproven nullable conditions.
          if (nullableSource(value.condition)) unsupportedSelection(value.condition);
          return `(${out(value.condition)} ? ${convert(value.whenTrue)} : ${convert(value.whenFalse)})`;
        }
        if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.CommaToken) {
          return `(${out(value.left)}, ${convert(value.right)})`;
        }
        if (ts.isBinaryExpression(value) && (isLogical(value.operatorToken.kind)
          || value.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) {
          // Converting operands first would change truthiness / coalescing.
          // Keep the existing proven ?? lowering; reject other nullable
          // selections until their raw result domain can be preserved reliably.
          if (nullableSource(value) && (isLogical(value.operatorToken.kind)
            || !nilDeclared(value.left) || nullableSource(value.right))) {
            unsupportedSelection(value);
          }
        }
        if (isNilLiteral(value)) return JSON.stringify(literalText(value));
        if (untrusted(value)) fail(value, "String conversion cannot decode this library result's null/undefined value",
          "check the length or findIndex result first, then convert the selected element");
        if (nilDeclared(value) && !legacyOptionalParameter(value)) {
          const t = declaredType(value);
          if (domain(t) === "R") fail(value, "Objects cannot be converted to text", "convert a scalar property instead");
          return `__nekocNilText_${keyFor(t, value)}(${specificRule(value) ?? splice(value)})`;
        }
        if (nullableSource(value) && !(ts.isCallExpression(value) && calleeText(value) === "String")
          && !(ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) {
          unsupportedSelection(value);
        }
        return `String(${out(value)})`;
      };
      return convert(node.arguments[0]);
    }
    if (ts.isPropertySignature(node) && node.questionToken) return splice(node, new Map([[node.questionToken, ""]]));
    // Statement forms
    if (ts.isExpressionStatement(node)) {
      const e = unparen(node.expression);
      if (outermostChain(e)) {
        const tests = chainTests(e);
        const plain = plainText(e);
        return tests.length ? `{ if (!(${tests.join(" || ")})) ${plain}; }` : `${plain};`;
      }
      if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken && nilDeclared(e.left)) {
        if (untrusted(e.left)) fail(e.left, "pop/shift/find results do not carry a runtime undefined value", "check the length first");
        if (!pure(e.left)) fail(e.left, "??= is supported on variables, this and property paths", "store the receiver in a const first");
        const k = keyFor(declaredType(e.left), e.left);
        return `{ if (__nekocNilIs_${k}(${out(e.left)})) ${out(e.left)} = ${out(e.right)}; }`;
      }
      return undefined;
    }
    if (ts.isReturnStatement(node) && !node.expression) {
      let fn = node.parent;
      while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
      const signature = fn && !ts.isConstructorDeclaration(fn) && checker.getSignatureFromDeclaration(fn);
      const t = signature && checker.getReturnTypeOfSignature(signature);
      if (t && maybeNil(t) && domain(t) !== null && fn.type) return `return ${undef(keyFor(t, node))};`;
      return undefined;
    }
    if (ts.isPropertyDeclaration(node) && !node.initializer && !node.exclamationToken
      && !node.modifiers?.some(m => [ts.SyntaxKind.AbstractKeyword, ts.SyntaxKind.DeclareKeyword].includes(m.kind))) {
      const t = checker.getTypeAtLocation(node.name);
      if (node.questionToken || maybeNil(t) && domain(t) !== null) {
        const body = splice(node, node.questionToken ? new Map([[node.questionToken, ""]]) : new Map());
        const insert = ` = ${undef(keyFor(t, node))}`;
        return body.endsWith(";") ? body.slice(0, -1) + insert + ";" : body + insert;
      }
    }
    if (ts.isPropertyDeclaration(node) && node.questionToken) return splice(node, new Map([[node.questionToken, ""]]));
    if (ts.isVariableDeclaration(node) && !node.initializer && ts.isVariableDeclarationList(node.parent)
      && !ts.isForOfStatement(node.parent.parent) && !ts.isForInStatement(node.parent.parent)
      && !(node.parent.parent.modifiers?.some(m => m.kind === ts.SyntaxKind.DeclareKeyword)) && ts.isIdentifier(node.name)) {
      const t = declaredType(node.name);
      if (node.type && maybeNil(t) && domain(t) !== null) return `${splice(node)} = ${undef(keyFor(t, node))}`;
    }
    if (ts.isNonNullExpression(node) && !ts.isOptionalChain(node) && nilValue(node.expression) && !untrusted(node.expression)) {
      fail(node, "Non-null assertions are not checked at runtime", "narrow the value with an explicit check such as if (x !== null)");
    }
    if (outermostChain(node)) {
      const tests = chainTests(node);
      const plain = plainText(node);
      if (!tests.length) return plain;
      const t = domain(flowType(node)) === null ? plainType(node) : flowType(node);
      if (domain(t) === null) fail(node, "The result of this optional call is used as a value but has no value type", "call it as a separate statement");
      const k = keyFor(t, node);
      return `__nekocNilIf_${k}(${tests.join(" || ")}, ${undef(k)}, ${plain})`;
    }
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if (op === ts.SyntaxKind.QuestionQuestionEqualsToken && nilValue(node.left)) {
        fail(node, "??= is supported only as a separate statement", "write x ??= value; on its own line, then read x");
      }
      if (op === ts.SyntaxKind.QuestionQuestionToken) {
        if (untrusted(node.left)) fail(node.left, "pop/shift/find results do not carry a runtime undefined value", "check the length or findIndex result first, then read by index");
        if (!nilDeclared(node.left)) return undefined;
        const left = domain(declaredType(node.left));
        const result = domain(flowType(node)) === null ? declaredType(node.left) : flowType(node);
        if (left === "?" || domain(result) !== left) fail(node, "?? needs both sides to have the same value type", "convert the fallback to the left side's type, or use an explicit if/else");
        return `__nekocNilCoalesce_${keyFor(result, node)}(${out(node.left)}, ${out(node.right)})`;
      }
      if (isEquality(op)) {
        const loose = op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken;
        const negate = op === ts.SyntaxKind.ExclamationEqualsToken || op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
        const leftNil = isNilLiteral(node.left), rightNil = isNilLiteral(node.right);
        if (leftNil !== rightNil) {
          const value = leftNil ? node.right : node.left;
          const literal = leftNil ? node.left : node.right;
          if (untrusted(value)) fail(value, "pop/shift/find results do not carry a runtime undefined value", "check the length or findIndex result first, then read by index");
          if (legacyOptionalParameter(value)) return undefined;
          const t = declaredType(value);
          const d = domain(t);
          if (d === null) return undefined;
          const k = keyFor(t, value);
          if (loose) return `${negate ? "!" : ""}__nekocNilIs_${k}(${out(value)})`;
          const s = sentinel(literalKind(literal), k);
          return leftNil ? `${s} ${node.operatorToken.getText(sourceFile)} ${out(value)}` : `${out(value)} ${node.operatorToken.getText(sourceFile)} ${s}`;
        }
        if (!leftNil && loose && nilValue(node.left) && nilValue(node.right)) {
          const a = domain(declaredType(node.left)), b = domain(declaredType(node.right));
          if (a !== b) fail(node, "Loose equality between different nullable value types is not supported", "compare each side with null separately");
          return `${negate ? "!" : ""}__nekocNilLooseEq_${keyFor(declaredType(node.left), node)}(${out(node.left)}, ${out(node.right)})`;
        }
        return undefined;
      }
      if (isLogical(op) && !conditionContext(node) && nilValue(node.left)) {
        const t = flowType(node);
        const d = domain(declaredType(node.left));
        if (d === "?" || domain(t) !== d || maybeNil(flowType(node.right)) && domain(declaredType(node.right)) !== d
          || !maybeNil(flowType(node.right)) && domain(flowType(node.right)) !== d) {
          fail(node, "&& / || on a nullable value must keep one value type", "compare with null explicitly, e.g. x !== null && x.ok, or use ??");
        }
        if (!pure(node.left)) fail(node.left, "&& / || value selection on nullable values needs a variable or property path on the left", "store the left side in a const first, or use ??");
        const k = keyFor(t, node);
        const test = `__nekocNilTruthy_${keyFor(declaredType(node.left), node.left)}(${out(node.left)})`;
        return op === ts.SyntaxKind.BarBarToken
          ? `__nekocNilIf_${k}(${test}, ${out(node.left)}, ${out(node.right)})`
          : `__nekocNilIf_${k}(${test}, ${out(node.right)}, ${out(node.left)})`;
      }
      return undefined;
    }
    if (ts.isConditionalExpression(node)) {
      const t = flowType(node);
      if (maybeNil(t) && domain(t) === "R") {
        return `__nekocNilIf_${keyFor(t, node)}(${out(node.condition)}, ${out(node.whenTrue)}, ${out(node.whenFalse)})`;
      }
      return undefined;
    }
    if (isNilLiteral(node) && !ts.isParenthesizedExpression(node) && (node.kind === ts.SyntaxKind.NullKeyword || isUndefinedIdentifier(node) || isVoidZero(node))) {
      const c = climb(node);
      const p = c.parent;
      if (ts.isBinaryExpression(p) && isEquality(p.operatorToken.kind)) return undefined;
      if (omittedArgument(node)) return undefined;
      const arithmetic = ts.isBinaryExpression(p) && !isEquality(p.operatorToken.kind) && !isLogical(p.operatorToken.kind)
        && ![ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.EqualsToken, ts.SyntaxKind.CommaToken, ts.SyntaxKind.QuestionQuestionEqualsToken].includes(p.operatorToken.kind)
        && context(node) === "bad"
        || ts.isPrefixUnaryExpression(p) && p.operator !== ts.SyntaxKind.ExclamationToken
        || (ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) && p.expression === c;
      if (arithmetic) fail(node, `${literalText(node)} cannot be used in arithmetic, relational comparisons or as a receiver`,
        "compare it with === / !==, or use ?? to supply a number first");
      if (context(node) === "print" || ts.isCallExpression(p) && PRINT_CALLS.has(calleeText(p))) return JSON.stringify(literalText(node));
      const t = literalTarget(node);
      if (t && maybeNil(t) && domain(t) !== null) return sentinel(literalKind(node), keyFor(t, node));
      return undefined;
    }
    if (ts.isObjectLiteralExpression(node)) {
      let ctx = checker.getContextualType(node);
      if (!ctx) return undefined;
      ctx = checker.getNonNullableType(ctx);
      if (ctx.isUnion() || node.properties.some(p => ts.isSpreadAssignment(p))) return undefined;
      const present = new Set(node.properties.map(p => p.name && (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name) || ts.isNumericLiteral(p.name)) ? p.name.text : null));
      const missing = checker.getPropertiesOfType(ctx).filter(p => p.flags & ts.SymbolFlags.Optional && !present.has(p.name));
      if (!missing.length) return undefined;
      const added = missing.map(p => {
        const t = checker.getTypeOfSymbolAtLocation(p, node);
        const name = /^[A-Za-z_$][\w$]*$/.test(p.name) ? p.name : JSON.stringify(p.name);
        return `${name}: ${undef(keyFor(t, node))}`;
      }).join(", ");
      if (!node.properties.length) return `{ ${added} }`;
      const last = node.properties[node.properties.length - 1];
      return splice(node, new Map([[last, `${out(last)}, ${added}`]]));
    }
    return undefined;
  }

  checkSliceBoundaries(sourceFile);
  const result = out(sourceFile);
  if (result === text && !declarations.length) return input;
  const lowered = `${result}\n${declarations.join("\n")}\n`;
  const file = ts.createSourceFile(input.fileName, lowered, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (file.parseDiagnostics?.length) {
    const d = file.parseDiagnostics[0];
    throw new Error(`null/undefined lowering produced invalid code: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")} near ${JSON.stringify(lowered.slice(Math.max(0, d.start - 40), d.start + 40))}`);
  }
  return file;
}
