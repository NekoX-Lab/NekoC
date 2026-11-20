import ts from "typescript";
import { classAllocationPlaceholders } from "./class-metadata.mjs";
import { collectionTypes } from "./tsmap-types.mjs";

const REGEX_MESSAGE = "Regular expressions are not supported; use string methods such as includes, indexOf or split";

// Host-only type queries; no filesystem or standard library is required in WASM.
export function objectTypes(sourceFiles, origins = new WeakMap()) {
  const normalize = name => name.replaceAll("\\", "/");
  const files = new Map(sourceFiles.map(file => [normalize(file.fileName), file]));
  const lib = "/__nekoc_object_types.d.ts";
  files.set(lib, ts.createSourceFile(lib,
    `${collectionTypes}\ninterface Array<T> {
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
    }
    interface ReadonlyArray<T> extends Array<T> {}`,
    ts.ScriptTarget.Latest, true));
  const host = {
    getSourceFile: name => files.get(normalize(name)),
    readFile: name => files.get(normalize(name))?.text,
    fileExists: name => files.has(normalize(name)),
    getDefaultLibFileName: () => lib, writeFile() {},
    getCurrentDirectory: () => "", getDirectories: () => [],
    getCanonicalFileName: name => name, useCaseSensitiveFileNames: () => true, getNewLine: () => "\n",
    resolveModuleNames: (names, containingFile) => names.map(name => {
      const base = normalize(containingFile).replace(/[^/]*$/, "") + name;
      const parts = [];
      for (const part of base.split("/")) {
        if (part === "..") parts.pop();
        else if (part !== ".") parts.push(part);
      }
      const resolved = [parts.join("/"), `${parts.join("/")}.ts`, `${parts.join("/")}/index.ts`].find(candidate => files.has(candidate));
      return resolved ? { resolvedFileName: resolved, extension: ts.Extension.Ts } : undefined;
    }),
  };
  const program = ts.createProgram([...files.keys()], { noLib: true, strictNullChecks: true, target: ts.ScriptTarget.ES2020 }, host);
  const checker = program.getTypeChecker();
  // The compiler reuses source nodes in synthetic inline expressions. Snapshot
  // types while the source tree still has its original parents; querying the
  // checker after lowering can otherwise crash inside TypeScript.
  const originalTypes = new WeakMap();
  const originalSymbols = new WeakMap();
  const snapshot = node => {
    if (ts.isExpression(node)) originalTypes.set(node, checker.getTypeAtLocation(node));
    if (ts.isIdentifier(node)) originalSymbols.set(node, checker.getSymbolAtLocation(node));
    ts.forEachChild(node, snapshot);
  };
  for (const file of sourceFiles) snapshot(file);
  const symbol = node => node ? originalSymbols.get(node) ?? originalSymbols.get(ts.getOriginalNode(node)) : undefined;
  const type = node => {
    if (!node) return null;
    const source = origins.get(node) ?? node;
    return originalTypes.get(source) ?? originalTypes.get(ts.getOriginalNode(source)) ?? null;
  };
  const array = node => {
    const t = type(node);
    return !!t && (checker.isArrayType(t) || checker.isTupleType(t));
  };
  const objectType = t => !!t && (t.isUnion() ? t.types.some(objectType)
    : !(t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))
      && !!(t.flags & ts.TypeFlags.Object) && !checker.isArrayType(t) && !checker.isTupleType(t) && !t.getCallSignatures().length);
  const object = node => objectType(type(node));
  const contains = (t, seen = new Set()) => {
    if (!t || seen.has(t)) return false;
    seen.add(t);
    if (t.isUnion()) return t.types.some(part => contains(part, seen));
    if (checker.isArrayType(t) || checker.isTupleType(t)) return contains(checker.getIndexTypeOfType(t, ts.IndexKind.Number), seen);
    return objectType(t);
  };
  const key = node => {
    if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return node.text;
    const t = type(node);
    return t && (t.flags & (ts.TypeFlags.StringLiteral | ts.TypeFlags.NumberLiteral)) ? String(t.value) : null;
  };
  const string = node => !!(type(node)?.flags & ts.TypeFlags.StringLike);
  let dataObjects = false;
  const functions = new Map();
  const scanFunctions = node => {
    if (ts.isObjectLiteralExpression(node)) {
      // 舞台/角色声明的参数可以嵌套对象和数组（如 costumes 列表），沿字面量向上找到所在调用。
      let p = node.parent;
      while (ts.isArrayLiteralExpression(p) || ts.isPropertyAssignment(p) || ts.isObjectLiteralExpression(p) || ts.isParenthesizedExpression(p)) p = p.parent;
      const name = ts.isCallExpression(p) ? p.expression.getText() : "";
      if (!["stage", "sprite", "screen", "Array.from", "defineProc", "defineReporter", "keyButton"].includes(name)) dataObjects = true;
    }
    if (ts.isFunctionLike(node) && node.body) {
      const name = node.name?.text ?? (ts.isVariableDeclaration(node.parent) ? node.parent.name.text : null);
      functions.set(name ?? node, {node, locals: false, calls: new Set(), targets: new Set(), yields: false});
    }
    ts.forEachChild(node, scanFunctions);
  };
  for (const file of sourceFiles) if (!file.fileName.startsWith("__nekoc_")) scanFunctions(file);
  for (const state of functions.values()) {
    const walk = node => {
      if (node !== state.node.body && ts.isFunctionLike(node)) return;
      state.locals ||= ts.isVariableDeclaration(node);
      if (ts.isCallExpression(node)) {
        const name = ts.isIdentifier(node.expression) ? node.expression.text : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : "";
        state.calls.add(name);
        const declaration = checker.getResolvedSignature(node)?.declaration;
        if (declaration) state.targets.add(declaration);
        state.yields ||= ["wait", "waitUntil", "ask", "askChoice", "glideTo", "glideChangeX", "glideChangeY",
          "broadcastAndWait", "tellAndWait", "syncTell", "playAudioAndWait", "say", "think", "stageDialog",
          "fadeVisibility", "appearWith"].includes(name);
        for (const arg of node.arguments) if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) ts.forEachChild(arg.body, walk);
      }
      ts.forEachChild(node, walk);
    };
    walk(state.node.body);
  }
  let changed = true;
  const byNode = new Map([...functions.values()].map(state => [state.node, state]));
  while (changed) {
    changed = false;
    for (const state of functions.values()) if (!state.yields && ([...state.calls].some(name => functions.get(name)?.yields)
      || [...state.targets].some(node => byNode.get(node)?.yields))) { state.yields = true; changed = true; }
  }
  const unsafeLocals = new Set([...functions.values()].filter(s => s.locals && s.yields).map(s => s.node));
  return { array, object, objectType, contains, key, string, type, symbol, checker, program, dataObjects, unsafeLocals };
}

export function validateObjectOperations(file, types, reject) {
  const checker = types.checker;
  const generated = file.fileName.startsWith("__nekoc_");
  // User callback ASTs are validated in their original scope. Adapters contain
  // intentionally untyped handle pass-throughs and are not user erasure sites.
  if (generated) return;
  const erased = t => !!(t?.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter));
  const carries = node => types.contains(types.type(node));
  const unwrap = node => {
    while (node && (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node))) node = node.expression;
    return node;
  };
  const propertyInitializer = (value, name) => {
    value = unwrap(value);
    if (!value || !ts.isObjectLiteralExpression(value)) return undefined;
    const property = value.properties.find(property => property.name
      && (ts.isIdentifier(property.name) ? property.name.text : types.key(property.name)) === name);
    return property && (ts.isPropertyAssignment(property) ? property.initializer
      : ts.isShorthandPropertyAssignment(property) ? property.name : undefined);
  };
  // Both directions matter: losing a nested handle leaks its numeric encoding;
  // inventing one lets a scalar address unrelated live heap cells.
  const preserves = (source, target, seen = new Map(), value, scalarInitializer = false) => {
    if (!source || !target) return true;
    if (source === target) return true;
    value = unwrap(value);
    // A type pair reached through a new literal must not memoize permission for
    // another occurrence that aliases existing storage of the same type.
    if (value && (ts.isObjectLiteralExpression(value) || ts.isArrayLiteralExpression(value))) seen = new Map();
    let targets = seen.get(source);
    if (targets?.has(target)) return true;
    seen = new Map(seen);
    seen.set(source, targets = new Set(targets));
    targets.add(target);
    const scalar = t => t.isUnion() ? t.types.every(scalar) : !(t.flags & ts.TypeFlags.Object);
    if (scalar(source) && scalar(target)) {
      // Mutable aliases share storage: widening number to number|string (or
      // any) permits writes that invalidate the original alias's operators.
      const from = checker.getBaseTypeOfLiteralType(source);
      const to = checker.getBaseTypeOfLiteralType(target);
      if (scalarInitializer && !erased(source) && checker.isTypeAssignableTo(source, target)) return true;
      return !erased(source) && !erased(target)
        && checker.isTypeAssignableTo(from, to) && checker.isTypeAssignableTo(to, from);
    }
    if (source.isUnion()) return source.types.every(part => preserves(part, target, seen, value, scalarInitializer));
    if (target.isUnion()) return target.types.some(part => preserves(source, part, new Map(seen), value, scalarInitializer));
    const sourceArray = checker.isArrayType(source) || checker.isTupleType(source);
    const targetArray = checker.isArrayType(target) || checker.isTupleType(target);
    if (sourceArray || targetArray) {
      if (!sourceArray || !targetArray) return false;
      if (value && ts.isArrayLiteralExpression(value)) {
        const tuple = checker.isTupleType(target) ? target.target : undefined;
        const slots = tuple && checker.getTypeArguments(target);
        const flags = tuple?.elementFlags;
        const rest = flags?.findIndex(flag => flag & (ts.ElementFlags.Rest | ts.ElementFlags.Variadic)) ?? -1;
        const length = value.elements.length;
        if (tuple) {
          if (length < tuple.minLength || rest < 0 && length > slots.length) return false;
          if (flags.some(flag => flag & ts.ElementFlags.Variadic)) {
            reject(value, "Unresolved variadic tuple initialization is not supported; replace the generic spread with an explicit fixed or rest tuple element type");
          }
        }
        return value.elements.every((element, index) => {
          if (ts.isSpreadElement(element) || ts.isOmittedExpression(element)) return false;
          // Rest type arguments describe one repeated element, not a fixed
          // literal index. Fixed suffix slots are anchored to the literal end.
          const suffix = rest < 0 ? 0 : slots.length - rest - 1;
          const slotIndex = rest < 0 || index < rest ? index
            : index >= length - suffix ? slots.length - (length - index) : rest;
          const slot = tuple ? slots[slotIndex] : checker.getIndexTypeOfType(target, ts.IndexKind.Number);
          return !!slot && preserves(types.type(element), slot, new Map(seen), element, true);
        });
      }
      return preserves(checker.getIndexTypeOfType(source, ts.IndexKind.Number), checker.getIndexTypeOfType(target, ts.IndexKind.Number), seen);
    }
    const a = types.objectType(source), b = types.objectType(target);
    if (a !== b) return false;
    // Property types also select scalar blocks (notably numeric + vs text_join).
    // Erasing TS assertions cannot convert a stored number into a string.
    // Literal refinements (including readonly class fields) use the same storage.
    if (!a) return checker.isTypeAssignableTo(checker.getBaseTypeOfLiteralType(source), checker.getBaseTypeOfLiteralType(target));
    for (const property of checker.getPropertiesOfType(source)) {
      const from = checker.getTypeOfSymbolAtLocation(property, property.valueDeclaration ?? file);
      const other = checker.getPropertyOfType(target, property.name);
      const initializer = propertyInitializer(value, property.name);
      if (types.contains(from) && (!other || !preserves(from, checker.getTypeOfSymbolAtLocation(other, other.valueDeclaration ?? file), seen, initializer))) return false;
    }
    for (const property of checker.getPropertiesOfType(target)) {
      const other = checker.getPropertyOfType(source, property.name);
      if (!other || (other.flags & ts.SymbolFlags.Optional) && !(property.flags & ts.SymbolFlags.Optional)) return false;
      // Generated class allocations reserve inaccessible slots (e.g. [] has
      // type never[]) before the checked user field initializers run.
      if (classAllocationPlaceholders.has(other.valueDeclaration?.initializer)) continue;
      const to = checker.getTypeOfSymbolAtLocation(property, property.valueDeclaration ?? file);
      const from = checker.getTypeOfSymbolAtLocation(other, other.valueDeclaration ?? file);
      // Only the actual new slot's initializer can permit scalar widening.
      // An identifier referring to an existing container is never fresh.
      const initializer = propertyInitializer(value, property.name);
      if (!preserves(from, to, seen, initializer, !!initializer)) return false;
    }
    return true;
  };
  const boundary = (node, source, target) => {
    const value = ts.isVariableDeclaration(node) ? node.initializer
      : ts.isReturnStatement(node) ? node.expression
      : ts.isBinaryExpression(node) ? node.right
      : ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) ? node.expression : node;
    if ((types.contains(source) || types.contains(target)) && !preserves(source, target, new Map(), value)) {
      reject(node, "Object shapes must preserve initialized references recursively and compatible scalar property types; replace any/unknown/generic erasure, optional properties or assertions with explicit matching object/container types");
    }
  };
  const returnType = owner => {
    const signature = (ts.isArrowFunction(owner) || ts.isFunctionExpression(owner))
      ? checker.getContextualType(owner)?.getCallSignatures()[0] ?? checker.getSignatureFromDeclaration(owner)
      : checker.getSignatureFromDeclaration(owner);
    return signature && checker.getReturnTypeOfSignature(signature);
  };
  const visit = node => {
    // A newly allocated instance reserves every field before running any user
    // initializer. These inaccessible slots have been checked by the class
    // pass; a user cast must still pass the ordinary reference-shape rules.
    if (classAllocationPlaceholders.has(node)) return;
    const invocationCallback = node.parent && ts.isCallExpression(node.parent)
      && ["onStart", "onClick", "onKey", "onMessage", "when", "onBumpActor", "setTimeout", "setInterval"]
        .includes(node.parent.expression.name?.text ?? node.parent.expression.text);
    if (types.dataObjects && types.unsafeLocals.has(node) && !invocationCallback) reject(node, "Functions with local state cannot yield or call yielding functions in object programs; rewrite as a state machine or pass explicit per-event state parameters");
    if (types.dataObjects && ts.isThrowStatement(node)) reject(node, "Throw across object allocation/procedure boundaries is not supported; return an explicit scalar status and branch before creating objects instead");
    if (ts.isObjectLiteralExpression(node) && node.properties.some(p => p.name && ts.isComputedPropertyName(p.name))) {
      reject(node, "Computed object literal keys are not supported; use literal property names");
    }
    if (!generated) {
      if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
        const contextual = checker.getContextualType(node)?.getCallSignatures()[0];
        if (contextual) node.parameters.forEach((parameter, i) => {
          const input = contextual.parameters[i];
          if (input) boundary(parameter, checker.getTypeOfSymbolAtLocation(input, node), types.type(parameter.name));
        });
      }
      if (types.dataObjects && ts.isFunctionLike(node) && node.body && ts.isBlock(node.body)
        && types.contains(returnType(node))) {
        const returns = statement => {
          if (ts.isReturnStatement(statement)) return !!statement.expression;
          if (ts.isBlock(statement)) return statement.statements.some(returns);
          if (ts.isIfStatement(statement)) return !!statement.elseStatement && returns(statement.thenStatement) && returns(statement.elseStatement);
          return false;
        };
        if (!returns(node.body)) reject(node, "Object-returning functions must return an initialized reference on every path; add an explicit final return");
      }
      if (ts.isVariableDeclaration(node)) {
        const loop = node.parent?.parent;
        const forOf = loop && ts.isForOfStatement(loop) && loop.initializer === node.parent;
        if (!node.initializer && !forOf && types.contains(types.type(node.name))) reject(node, "Object references must be initialized at declaration; initialize a full object literal instead of an uninitialized reference");
        if (forOf) boundary(node, checker.getIndexTypeOfType(types.type(loop.expression), ts.IndexKind.Number), types.type(node.name));
        if (node.initializer) boundary(node, types.type(node.initializer), types.type(node.name));
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) boundary(node, types.type(node.right), types.type(node.left));
      if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) boundary(node, types.type(node.expression), types.type(node));
      if (ts.isExpression(node) && ((ts.isPropertyAssignment(node.parent) && node.parent.initializer === node) || ts.isArrayLiteralExpression(node.parent))) {
        const contextual = checker.getContextualType(node);
        if (contextual) boundary(node, types.type(node), contextual);
      }
      if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) boundary(node.body, types.type(node.body), returnType(node));
      if (ts.isReturnStatement(node)) {
        let owner = node.parent;
        while (owner && !ts.isFunctionLike(owner)) owner = owner.parent;
        if (owner) {
          const target = returnType(owner);
          // A later value-return does not make an earlier bare return safe.
          // An absent return must not enter numeric heap-address arithmetic;
          // diagnose the user's return, not a generated helper.
          if (!node.expression && types.contains(target)) {
            reject(node, "Object-returning functions must return an initialized reference on every path; replace this empty return with an explicit object/container value");
          }
          if (node.expression) boundary(node, types.type(node.expression), target);
        }
      }
    }
    if (ts.isExpression(node) && node.parent && (ts.isPropertyAssignment(node.parent) || ts.isArrayLiteralExpression(node.parent))
      && types.object(node) && erased(types.checker.getContextualType(node))) {
      reject(node, "Object container values must preserve their static shape; replace any/unknown properties or elements with explicit object types");
    }
    if (ts.isArrowFunction(node) && !ts.isBlock(node.body) && node.type && types.object(node.body)
      && erased(types.checker.getTypeFromTypeNode(node.type))) {
      reject(node, "Object return types must preserve their static shape; replace any/unknown with an explicit object type");
    }
    if (ts.isVariableDeclaration(node) && node.initializer && types.object(node.initializer) && erased(types.type(node.name))
      || ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && types.object(node.right) && erased(types.type(node.left))) {
      reject(node, "Object aliases must preserve their static shape; replace any/unknown with an explicit object type");
    }
    // A RegExp is a host object, not a planned data object; say so instead of
    // reporting its methods as missing properties.
    if (ts.isRegularExpressionLiteral(node)) reject(node, REGEX_MESSAGE);
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && types.object(node.expression)) {
      let receiver = node.expression;
      while (ts.isParenthesizedExpression(receiver)) receiver = receiver.expression;
      if (ts.isRegularExpressionLiteral(receiver)) reject(receiver, REGEX_MESSAGE);
      const target = types.type(node.expression);
      const key = ts.isPropertyAccessExpression(node) ? node.name.text : types.key(node.argumentExpression);
      if (target.isUnion()) reject(node, "Object union/missing reference property access is not supported (including pop/shift/find); use an initialized single shape and indexed access after an explicit selection check instead");
      if (key !== null) {
        const property = types.checker.getPropertyOfType(target, key);
        if (!property || property.flags & ts.SymbolFlags.Optional) {
          reject(node, `Object property ${JSON.stringify(key)} must be present and initialized; add it to the object literal (missing/optional properties are not supported)`);
        }
      }
    }
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
      && !(ts.isIdentifier(node.expression) && ["self", "this"].includes(node.expression.text))
      && types.type(node.expression)?.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Union)) {
      const symbol = ts.isIdentifier(node.expression) ? types.checker.getSymbolAtLocation(node.expression) : null;
      if (symbol?.declarations?.some(ts.isParameter) && !file.fileName.startsWith("__nekoc_helpers")) {
        reject(node, "Object parameter access needs a statically known shape; annotate it, for example obj: { x: number }, instead of any/unknown/union");
      }
    }
    if ((ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) && erased(types.type(node)) && types.object(node.expression)) {
      reject(node, "Casting a data object to any/unknown is not supported; preserve its static shape for share-player property checks");
    }
    if ((ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) && types.object(node.expression)) {
      const source = types.type(node.expression);
      const target = types.type(node);
      if (!types.object(node) || types.checker.getPropertiesOfType(target).some(property => {
        const original = types.checker.getPropertyOfType(source, property.name);
        return !original || !!(original.flags & ts.SymbolFlags.Optional) && !(property.flags & ts.SymbolFlags.Optional);
      })) {
        reject(node, "Object assertions cannot invent initialized properties or scalar values; initialize the full shape in an object literal instead");
      }
    }
    if (ts.isReturnStatement(node) && node.expression && types.object(node.expression)) {
      let owner = node.parent;
      while (owner && !ts.isFunctionLike(owner)) owner = owner.parent;
      if (owner?.type && erased(types.checker.getTypeFromTypeNode(owner.type))) {
        reject(node, "Object return types must preserve their static shape; replace any/unknown with an explicit object type");
      }
    }
    if (ts.isConditionalExpression(node) && (types.object(node.whenTrue) || types.object(node.whenFalse))) {
      reject(node, "Object-valued conditional expressions are not supported; use if/else with explicit assignments instead");
    }
    if (ts.isDeleteExpression(node)) reject(node, "delete is not supported; assign an explicit property value instead");
    if (ts.isCallExpression(node)) {
      const name = ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)
        ? `${node.expression.expression.text}.${node.expression.name.text}`
        : ts.isIdentifier(node.expression) ? node.expression.text : "";
      if (["JSON.parse", "JSON.stringify", "Object.keys", "Object.values", "Object.entries", "Object.assign"].includes(name)) {
        reject(node, `${name} is not supported for share-player objects; read or write properties explicitly instead of JSON serialization/reflection`);
      }
      if (["console.log", "consoleLog", "String", "Number", "parseInt", "parseFloat", "say", "think", "sayFor", "thinkFor", "join", "length", "ask", "textJoin"].includes(name) && node.arguments.some(carries)) {
        reject(node, "Object coercion/logging is not supported; pass a scalar property (obj.x) instead");
      }
      if (ts.isPropertyAccessExpression(node.expression)
        && ["say", "think", "sayFor", "thinkFor"].includes(node.expression.name.text) && node.arguments.some(carries)) {
        reject(node, "Object text coercion is not supported; pass a scalar property (obj.x) instead");
      }
      // A user function may otherwise erase an object argument before its body
      // reaches logging/coercion checks. Generated adapters have untyped scalar
      // and handle parameters by design; validate their original user AST instead.
      const signature = types.checker.getResolvedSignature(node);
      if (signature) {
        node.arguments.forEach((arg, i) => {
          if (ts.isFunctionLike(arg)) return;
          const parameter = signature.parameters[Math.min(i, signature.parameters.length - 1)];
          if (!parameter) return;
          let target = checker.getTypeOfSymbolAtLocation(parameter, node);
          if (parameter.valueDeclaration?.dotDotDotToken) target = checker.getIndexTypeOfType(target, ts.IndexKind.Number) ?? target;
          boundary(arg, types.type(arg), target);
        });
        if (types.contains(types.type(node))) {
          const declaration = signature.declaration;
          if (declaration?.typeParameters?.length && declaration.getSourceFile().fileName !== "/__nekoc_object_types.d.ts") {
            reject(node, "Generic object-returning functions are not supported; use an explicit non-generic object signature");
          }
        }
        const declaration = signature.declaration;
        if (node.arguments.some(carries) && declaration?.typeParameters?.length
          && declaration.getSourceFile().fileName !== "/__nekoc_object_types.d.ts") {
          reject(node, "Generic object arguments may erase reference shapes; use an explicit non-generic object signature instead");
        }
      }
      if (ts.isPropertyAccessExpression(node.expression) && types.array(node.expression.expression)) {
        const method = node.expression.name.text;
        const element = checker.getIndexTypeOfType(types.type(node.expression.expression), ts.IndexKind.Number);
        if (["pop", "shift", "find"].includes(method) && types.contains(element)) {
          reject(node, `Object array ${method} may return a missing reference; use an indexed access after an explicit length/selection check instead`);
        }
        if (method === "reduce" && (types.contains(element) || node.arguments.some(carries))) {
          reject(node, "Object-valued reduce is not supported by the generated accumulator adapter; use an explicit for loop and initialized accumulator object instead");
        }
      }
      if (signature?.declaration && !signature.declaration.getSourceFile().fileName.startsWith("__nekoc_")) {
        node.arguments.forEach((arg, i) => {
          const parameter = signature.parameters[i];
          if (types.object(arg) && parameter && erased(types.checker.getTypeOfSymbolAtLocation(parameter, node))) {
            reject(arg, "Object function arguments need a statically known shape; annotate the parameter instead of any/unknown");
          }
        });
      }
      if (ts.isPropertyAccessExpression(node.expression) && types.array(node.expression.expression)
        && ["join", "sort"].includes(node.expression.name.text)) {
        const element = types.checker.getIndexTypeOfType(types.type(node.expression.expression), ts.IndexKind.Number);
        if (types.contains(element) && (!node.arguments.length || node.expression.name.text === "join")) {
          reject(node, "Object array coercion is not supported; map scalar properties before join/sort, or supply a scalar-property comparator");
        }
      }
    }
    if (ts.isTemplateExpression(node) && node.templateSpans.some(span => carries(span.expression))) {
      reject(node, "Object template coercion is not supported; interpolate a scalar property instead");
    }
    if (ts.isBinaryExpression(node) && (carries(node.left) || carries(node.right))) {
      const allowed = [ts.SyntaxKind.EqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken,
         ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken];
      if (!allowed.includes(node.operatorToken.kind)) reject(node, "Object numeric/string coercion is not supported; use a scalar property instead");
      if ([ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(node.operatorToken.kind)
        && !(types.object(node.left) && types.object(node.right))) {
        reject(node, "Comparing an object with a scalar is not supported; compare two object references or scalar properties instead");
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken
      && (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left))) {
      const value = types.type(node.left);
      if (value?.isUnion() && value.types.some(t => t.flags & ts.TypeFlags.StringLike) && value.types.some(t => t.flags & ts.TypeFlags.NumberLike)) {
        reject(node, "Mixed string/number object properties cannot use +=; keep a single scalar type or split explicit typed branches");
      }
    }
    if (ts.isPrefixUnaryExpression(node) && carries(node.operand) && node.operator !== ts.SyntaxKind.ExclamationToken) {
      reject(node, "Object numeric coercion is not supported; use a scalar property instead");
    }
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
      && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)
      && types.string(node.operand)) reject(node, "String property ++/-- coercion is not supported; convert the scalar explicitly and use a separate numeric assignment instead");
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
      && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)
      && (ts.isPropertyAccessExpression(node.operand) || ts.isElementAccessExpression(node.operand))
      && !ts.isExpressionStatement(node.parent) && !ts.isForStatement(node.parent)) {
      reject(node, "Object/element ++/-- update values are not supported; use a separate update statement, then read the property");
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
}
