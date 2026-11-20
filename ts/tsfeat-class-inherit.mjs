import ts from "typescript";
import { objectTypes } from "./share-objects.mjs";
import { classSourceOrigins, mapPrintedClassNodes } from "./class-metadata.mjs";

const ambient = node => !!(node.flags & ts.NodeFlags.Ambient)
  || node.modifiers?.some(m => m.kind === ts.SyntaxKind.DeclareKeyword);
const mod = (node, kind) => node.modifiers?.some(m => m.kind === kind);
const unwrap = node => {
  while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)
    || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node))) node = node.expression;
  return node;
};
const walk = (node, visit) => {
  if (!node || ambient(node) || ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return;
  visit(node);
  ts.forEachChild(node, child => walk(child, visit));
};
export function needsClassInheritance(file) {
  let needed = false;
  walk(file, node => {
    needed ||= ts.isClassDeclaration(node) && (!!node.heritageClauses?.length || mod(node, ts.SyntaxKind.AbstractKeyword))
      || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node) || ts.isClassStaticBlockDeclaration(node)
      || !!mod(node, ts.SyntaxKind.StaticKeyword)
      || ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword;
  });
  return needed;
}

// This pass uses only parsed TS types and emits data interfaces and ordinary
// functions. Runtime identity, including virtual calls during construction, is
// stored in the same official-list heap as the stage-one object handles.
export function lowerClassInheritance(input, sourceIdentity = input.fileName) {
  const file = ts.createSourceFile(input.fileName, input.text, input.languageVersion, true, input.scriptKind);
  const { checker, program } = objectTypes([file]);
  const f = ts.factory, printer = ts.createPrinter();
  const print = node => printer.printNode(ts.EmitHint.Unspecified, node, file);
  const fail = (node, message, alternative = "use a declared concrete class and explicit initialization") => {
    const at = file.getLineAndCharacterOfPosition(node.getStart(file));
    const error = new Error(message + "; alternative: " + alternative);
    error.location = { file: file.fileName, line: at.line + 1, column: at.character + 1 };
    throw error;
  };
  let salt = 2166136261, serial = 0;
  for (const ch of sourceIdentity.replaceAll(String.fromCharCode(92), "/")) salt = Math.imul(salt ^ ch.charCodeAt(0), 16777619) >>> 0;
  const fresh = hint => `__nekocClass_${salt}_${++serial}_${hint.replace(/[^\w$]/g, "_")}`;
  const tag = fresh("typeId");
  const records = [], byNode = new Map(), bySymbol = new Map();
  const origins = new Map(), helpers = [], declarations = new Map();
  const helperBodies = new Map(), fieldInitializers = new Map();
  const addHelper = (name, code, node) => { helpers.push(code); origins.set(name, { file: input, offset: node.getStart(file) }); };
  const typeText = node => node ? print(node) : "number";
  const inferredType = node => checker.typeToTypeNode(checker.getTypeAtLocation(node), undefined, ts.NodeBuilderFlags.NoTruncation);
  const key = node => {
    if (ts.isPrivateIdentifier(node.name)) fail(node, "#private fields are not supported", "use an ordinary declared field");
    if (!node.name || !(ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name) || ts.isNumericLiteral(node.name))) fail(node,
      "Dynamic class member names are not supported", "use a literal field or method name");
    if (node.name.text === "__proto__") fail(node, "__proto__ members are not supported", "choose an ordinary name");
    if (node.name.text.startsWith("__nekocClass_")) fail(node.name, "Class member names starting with __nekocClass_ are reserved", "rename the field or method");
    return node.name.text;
  };
  const decorated = node => ts.canHaveDecorators(node) && ts.getDecorators(node)?.length;
  walk(file, node => {
    if (ts.isIdentifier(node) && node.text.startsWith("__nekocClass_")) fail(node, "Names starting with __nekocClass_ are reserved", "rename the identifier");
    if (decorated(node)) fail(node, "Decorators are not supported", "call an explicit initialization helper");
    if (ts.isClassExpression(node)) fail(node, "Class expressions are not supported", "use a top-level named class declaration");
    if (!ts.isClassDeclaration(node)) return;
    if (!node.name || !ts.isSourceFile(node.parent)) fail(node, "Nested or anonymous runtime classes are not supported", "use a top-level named class");
    if (node.typeParameters?.length) fail(node, "Generic classes are not supported", "declare concrete field types");
    const r = { node, name: node.name.text, parent: null, children: [], fields: new Map(), methods: new Map(),
      accessors: new Map(), statics: new Map(), ctor: null, abstract: !!mod(node, ts.SyntaxKind.AbstractKeyword),
      self: fresh(node.name.text + "_this"), factory: fresh(node.name.text + "_new"), init: fresh(node.name.text + "_fields"),
      construct: fresh(node.name.text + "_construct"), arities: new Set(), factories: new Set() };
    records.push(r); byNode.set(node, r); bySymbol.set(checker.getSymbolAtLocation(node.name), r);
    for (const member of node.members) {
      if (ts.isSemicolonClassElement(member)) continue;
      if (ts.isClassStaticBlockDeclaration(member)) fail(member, "Static blocks are not supported", "initialize static fields explicitly in declaration order");
      if (ts.isIndexSignatureDeclaration(member)) fail(member, "Class index signatures are not supported", "declare literal fields");
      if (ts.isConstructorDeclaration(member)) {
        if (r.ctor || !member.body) fail(member, "Constructor overloads are not supported", "use one constructor with defaults");
        r.ctor = member; continue;
      }
      const name = key(member), isStatic = !!mod(member, ts.SyntaxKind.StaticKeyword);
      if (ts.isPropertyDeclaration(member)) {
        if (member.questionToken) fail(member, "Optional class fields are not supported", "initialize a field and use a validity flag");
        if (member.initializer && (ts.isArrowFunction(unwrap(member.initializer)) || ts.isFunctionExpression(unwrap(member.initializer)))) fail(member,
          "Function-valued fields are not supported", "declare an instance method");
        const field = { node: member, name, type: member.type ?? inferredType(member.name), initializer: member.initializer, owner: r };
        if (isStatic) {
          if (r.statics.has(name)) fail(member, "Duplicate static member", "declare each static member once");
          field.global = fresh(r.name + "_static_" + name); r.statics.set(name, field);
        }
        else { if (r.fields.has(name) || r.methods.has(name) || r.accessors.has(name)) fail(member, "Duplicate class member"); r.fields.set(name, field); }
      } else if (ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
        if (member.typeParameters?.length || member.asteriskToken || mod(member, ts.SyntaxKind.AsyncKeyword)) fail(member,
          "Generic, async and generator methods are not supported", "use a concrete ordinary method");
        const abstract = !!mod(member, ts.SyntaxKind.AbstractKeyword);
        if (!member.body && !abstract) fail(member, "Method overloads require one concrete body and are not supported", "use one method implementation");
        if (abstract && !r.abstract) fail(member, "Abstract methods require an abstract class");
        const kind = ts.isGetAccessorDeclaration(member) ? "get" : ts.isSetAccessorDeclaration(member) ? "set" : "method";
        const method = { node: member, name, kind, owner: r, abstract, static: isStatic, helper: fresh(r.name + "_" + kind + "_" + name) };
        if (isStatic) {
          if (kind !== "method") fail(member, "Static accessors are not supported", "use static get/set methods");
          if (r.statics.has(name)) fail(member, "Static overloads and duplicate members are not supported");
          r.statics.set(name, method);
        } else if (kind === "method") {
          if (r.methods.has(name) || r.fields.has(name) || r.accessors.has(name)) fail(member, "Method overloads and duplicate members are not supported");
          r.methods.set(name, method);
        } else {
          if (r.fields.has(name) || r.methods.has(name)) fail(member, "Accessor/field collisions are not supported");
          let pair = r.accessors.get(name);
          if (!pair) r.accessors.set(name, pair = {});
          if (pair[kind]) fail(member, "Duplicate class accessor");
          pair[kind] = method;
        }
      } else fail(member, "This class member is not supported", "use fields or ordinary methods");
    }
    for (const p of r.ctor?.parameters ?? []) {
      if (!p.modifiers?.some(m => [ts.SyntaxKind.PublicKeyword, ts.SyntaxKind.PrivateKeyword, ts.SyntaxKind.ProtectedKeyword, ts.SyntaxKind.ReadonlyKeyword].includes(m.kind))) continue;
      if (!ts.isIdentifier(p.name) || r.fields.has(p.name.text)) fail(p, "Duplicate or destructured parameter properties are not supported");
      r.fields.set(p.name.text, { node: p, name: p.name.text, type: p.type ?? inferredType(p.name), parameter: p, owner: r });
    }
  });
  for (const r of records) {
    const heritage = r.node.heritageClauses?.find(h => h.token === ts.SyntaxKind.ExtendsKeyword);
    if (!heritage) continue;
    const expression = heritage.types[0].expression;
    if (!ts.isIdentifier(expression) || !(r.parent = bySymbol.get(checker.getSymbolAtLocation(expression)))) fail(expression,
      "extends requires a statically known class identifier; mixins and built-in inheritance are not supported", "extend a declared class directly");
    if (r.parent.node.pos >= r.node.pos) fail(expression, "A base class must be declared before its subclass", "move the base declaration earlier");
    r.parent.children.push(r);
  }
  let nextId = 0;
  const visitTree = r => {
    r.pre = ++nextId; r.root = r.parent?.root ?? r;
    r.allFields = new Map(r.parent?.allFields ?? []);
    for (const [name, field] of r.fields) {
      if (findAccessor(r.parent, name) || findMethod(r.parent, name)) fail(field.node, "Fields cannot replace inherited accessors or methods", "override the method or accessor explicitly");
      r.allFields.set(name, field);
    }
    for (const [name, pair] of r.accessors) {
      const member = (pair.get ?? pair.set).node;
      if (r.parent?.allFields.has(name)) fail(member, "Accessors cannot replace inherited data fields", "use a different property name");
      if (findMethod(r.parent, name)) fail(member, "Accessors cannot replace inherited methods", "use a different property name or override the method with an ordinary method");
    }
    for (const [name, m] of r.methods) if (r.parent?.allFields.has(name) || findAccessor(r.parent, name)) fail(m.node, "Methods cannot replace inherited fields or accessors", "use a distinct member name");
    for (const child of r.children) visitTree(child);
    r.post = nextId;
  };
  function findMethod(r, name) { return r?.methods.get(name) ?? (r?.parent ? findMethod(r.parent, name) : null); }
  function findAccessor(r, name) { return r?.accessors.get(name) ?? (r?.parent ? findAccessor(r.parent, name) : null); }
  for (const r of records.filter(r => !r.parent)) visitTree(r);
  const descendants = r => records.filter(c => c.pre >= r.pre && c.pre <= r.post).sort((a, b) => a.pre - b.pre);
  const related = (a, b) => a.root === b.root && (a.pre >= b.pre && a.pre <= b.post || b.pre >= a.pre && b.pre <= a.post);
  const classFromType = t => {
    if (t?.isThisType) return classFromType(t.getConstraint());
    if (!t || t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Intersection | ts.TypeFlags.TypeParameter)) return null;
    if (t.isUnion()) {
      const classes = t.types.map(classFromType);
      if (classes.some(c => !c) || classes.some(c => c.root !== classes[0].root)) return null;
      let common = classes[0];
      while (common && classes.some(c => c.pre < common.pre || c.pre > common.post)) common = common.parent;
      return common;
    }
    return bySymbol.get(t.getSymbol()) ?? null;
  };
  const classOf = node => classFromType(checker.getTypeAtLocation(node));
  const staticClass = node => ts.isIdentifier(unwrap(node)) ? bySymbol.get(checker.getSymbolAtLocation(unwrap(node))) : null;
  const accessKey = node => ts.isPropertyAccessExpression(node) ? node.name.text
    : ts.isElementAccessExpression(node) && (ts.isStringLiteralLike(unwrap(node.argumentExpression)) || ts.isNumericLiteral(unwrap(node.argumentExpression))) ? unwrap(node.argumentExpression).text : null;
  const accessorUse = node => {
    let n = node; while (n.parent && unwrap(n.parent) === node) n = n.parent;
    const p = n.parent, assignment = ts.isBinaryExpression(p) && p.left === n
      && p.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && p.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
    const update = (ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p))
      && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(p.operator);
    return { get: !assignment || p.operatorToken.kind !== ts.SyntaxKind.EqualsToken, set: assignment || update };
  };
  const enclosingClass = node => { while (node && !ts.isClassDeclaration(node)) node = node.parent; return byNode.get(node); };
  const access = node => {
    node = unwrap(node);
    if (!node || !(ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))) return null;
    const name = accessKey(node);
    if (node.expression.kind === ts.SyntaxKind.SuperKeyword) {
      const r = enclosingClass(node)?.parent;
      if (!r) fail(node, "super requires a derived class");
      let member = node.parent;
      while (member && !ts.isClassDeclaration(member.parent)) member = member.parent;
      if (member && mod(member, ts.SyntaxKind.StaticKeyword)) fail(node, "super in static members is not supported", "name the declaring base class explicitly");
      return { r, name, super: true, method: findMethod(r, name), pair: findAccessor(r, name) };
    }
    const stat = staticClass(node.expression);
    if (stat) {
      const member = stat.statics.get(name);
      if (!member) fail(node, "Static inheritance and undeclared static members are not supported", "name the declaring class explicitly");
      return { r: stat, name, static: true, member, method: member.helper ? member : null };
    }
    const r = classOf(node.expression);
    return r ? { r, name, method: findMethod(r, name), pair: findAccessor(r, name) } : null;
  };
  const allMethods = r => {
    const result = new Map(r.parent ? allMethods(r.parent) : []);
    for (const [name, m] of r.methods) result.set("method:" + name, m);
    for (const [name, pair] of r.accessors) {
      result.delete("get:" + name); result.delete("set:" + name);
      for (const kind of ["get", "set"]) if (pair[kind]) result.set(kind + ":" + name, pair[kind]);
    }
    return result;
  };
  for (const r of records) if (!r.abstract) for (const m of allMethods(r).values()) if (m.abstract) fail(r.node,
    "Non-abstract class must implement abstract member " + m.name, "implement the member or mark the class abstract");
  const inheritanceErrors = new Set([2415, 2416, 2423, 2425, 2515, 2610, 2611, 2653]);
  for (const diagnostic of program.getSemanticDiagnostics(file)) if (inheritanceErrors.has(diagnostic.code)) {
    const node = ts.getTokenAtPosition(file, diagnostic.start ?? 0);
    fail(node, `TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " " )}`,
      "implement compatible inherited members or mark an incomplete class abstract");
  }

  // Reject structural type substitutions, including references nested in
  // containers. Related classes may flow through their common base types.
  const preserve = (node, from, to, seen = new Map()) => {
    if (!from || !to) return;
    if (seen.get(from)?.has(to)) return;
    if (!seen.has(from)) seen.set(from, new Set());
    seen.get(from).add(to);
    if (from.isUnion()) { for (const t of from.types) preserve(node, t, to, seen); return; }
    if (to.isUnion()) {
      const source = classFromType(from);
      if (source && !to.types.some(t => { const target = classFromType(t); return target && source.root === target.root && source.pre >= target.pre && source.pre <= target.post; })) fail(node, "Class references cannot be erased into unrelated unions or unchecked downcasts");
      return;
    }
    const a = classFromType(from), b = classFromType(to);
    if ((a || b) && (!a || !b || a.root !== b.root || a.pre < b.pre || a.pre > b.post)) fail(node, "Class references must preserve a related declared class; unchecked downcasts, structural substitution and type erasure are not supported", "use a common declared base class and narrow with instanceof before accessing derived members");
    if (a || b) return;
    if ((checker.isArrayType(from) || checker.isTupleType(from)) && (checker.isArrayType(to) || checker.isTupleType(to))) {
      preserve(node, checker.getIndexTypeOfType(from, ts.IndexKind.Number), checker.getIndexTypeOfType(to, ts.IndexKind.Number), seen); return;
    }
    if (from.flags & ts.TypeFlags.Object && to.flags & ts.TypeFlags.Object) for (const p of checker.getPropertiesOfType(to)) {
      const q = checker.getPropertyOfType(from, p.name);
      if (q) preserve(node, checker.getTypeOfSymbolAtLocation(q, q.valueDeclaration ?? node), checker.getTypeOfSymbolAtLocation(p, p.valueDeclaration ?? node), seen);
    }
  };
  const effectiveCtor = r => r.ctor ?? (r.parent ? effectiveCtor(r.parent) : null);
  const normalizeArgs = (node, args, r) => {
    if (args.some(ts.isSpreadElement)) fail(node, "Spread constructor arguments are not supported", "pass explicit arguments");
    const parameters = effectiveCtor(r)?.parameters ?? [];
    if (args.length > parameters.length) fail(node, "Extra constructor arguments are not supported", "match the constructor signature");
    let arity = args.length;
    const undefinedArg = a => ts.isIdentifier(unwrap(a)) && unwrap(a).text === "undefined" && !checker.getSymbolAtLocation(unwrap(a))?.declarations?.length;
    while (arity && undefinedArg(args[arity - 1])) arity--;
    for (let i = 0; i < arity; i++) if (undefinedArg(args[i])) fail(args[i], "Interior undefined constructor arguments are not supported", "pass concrete values");
    for (const p of parameters.slice(arity)) if (!p.initializer) fail(p, "Omitted constructor parameters need a concrete default", "pass every required argument");
    return arity;
  };

  // Definite super flow: analyze both branches, and reject calls in repeating
  // control flow. All continuing paths must have called super exactly once.
  const superSites = new WeakMap();
  const checkSuper = r => {
    if (!r.parent || !r.ctor) return;
    const expr = (node, state) => {
      if (!node || ts.isTypeNode(node)) return state;
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.SuperKeyword) {
        if (!ts.isExpressionStatement(node.parent)) fail(node, "super() must be a standalone constructor statement", "call super once as a statement before using this");
        if ([...state].some(n => n !== 0)) fail(node, "super() may execute twice", "call super exactly once on every constructor path");
        for (const arg of node.arguments) expr(arg, state);
        superSites.set(node, normalizeArgs(node, node.arguments, r.parent));
        return new Set([1]);
      }
      if (node.kind === ts.SyntaxKind.ThisKeyword || node.kind === ts.SyntaxKind.SuperKeyword) {
        if (state.has(0)) fail(node, "this or super member access before super() is not allowed", "call super before using this");
      }
      if (ts.isFunctionLike(node)) {
        let captures = false; walk(node, child => { captures ||= child.kind === ts.SyntaxKind.ThisKeyword || child.kind === ts.SyntaxKind.SuperKeyword; });
        if (captures && state.has(0)) fail(node, "Capturing this before super() is not supported", "create the closure after super");
        return state;
      }
      if (ts.isConditionalExpression(node)) {
        state = expr(node.condition, state);
        return new Set([...expr(node.whenTrue, new Set(state)), ...expr(node.whenFalse, new Set(state))]);
      }
      if (ts.isBinaryExpression(node) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)) {
        state = expr(node.left, state); return new Set([...state, ...expr(node.right, new Set(state))]);
      }
      ts.forEachChild(node, child => { state = expr(child, state); });
      return state;
    };
    const stmt = (node, state) => {
      if (ts.isBlock(node)) { for (const s of node.statements) state = stmt(s, state); return state; }
      if (ts.isIfStatement(node)) {
        state = expr(node.expression, state);
        return new Set([...stmt(node.thenStatement, new Set(state)), ...node.elseStatement ? stmt(node.elseStatement, new Set(state)) : state]);
      }
      if (ts.isReturnStatement(node)) {
        if (node.expression) fail(node, "Returning a value from a constructor is not supported", "assign fields and return without a value");
        if (state.has(0)) fail(node, "super() must execute before returning from a derived constructor");
        return new Set();
      }
      if (ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node) || ts.isSwitchStatement(node) || ts.isTryStatement(node)) {
        walk(node, child => { if (ts.isCallExpression(child) && child.expression.kind === ts.SyntaxKind.SuperKeyword) fail(child,
          "super() in loops, switch or try cannot be proven to execute exactly once", "place super in straight-line code or complete if/else branches"); });
      }
      return expr(node, state);
    };
    for (const p of r.ctor.parameters) if (p.initializer) expr(p.initializer, new Set([0]));
    if (stmt(r.ctor.body, new Set([0])).has(0)) fail(r.ctor, "super() may not execute on every constructor path", "call super exactly once before the constructor finishes");
  };
  for (const r of records) checkSuper(r);
  walk(file, node => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.SuperKeyword && !superSites.has(node)) fail(node,
      "super() is only supported directly in a derived constructor, never in nested functions", "call super exactly once in the constructor body");
  });

  // Field initialization is checked for each possible most-derived instance.
  // A virtual call is conservatively rejected whenever a descendant overrides
  // it, even if that override happens not to read its own fields.
  const checkInitialization = r => {
    const initialized = new Set(r.parent?.allFields.keys() ?? []);
    const ownKeys = [...r.fields.keys()];
    const thisField = node => node && (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
      && unwrap(node.expression)?.kind === ts.SyntaxKind.ThisKeyword ? accessKey(node) : null;
    const requireField = (node, name, state) => { if (r.allFields.has(name) && !state.has(name)) fail(node,
      "Class field " + name + " is read before initialization; undefined field values are not supported", "initialize the field earlier"); };
    const expr = (node, state, active = new Set()) => {
      if (!node || ts.isTypeNode(node) || ts.isFunctionLike(node)) return;
      if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)) {
        const a = access(unwrap(node.operand));
        if (a?.pair?.set && (a.super || thisField(unwrap(node.operand)) !== null)) {
          expr(node.operand, state, active);
          if (!a.super && descendants(r).some(c => findAccessor(c, a.name)?.set !== a.pair.set)) fail(node,
            "Virtual setter during construction may reach uninitialized subclass fields", "update the accessor after new");
          if (!active.has(a.pair.set)) stmt(a.pair.set.node.body, new Set(state), new Set(active).add(a.pair.set));
          return;
        }
      }
      const assignmentAccess = ts.isBinaryExpression(node) ? access(unwrap(node.left)) : null;
      if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
        && (thisField(unwrap(node.left)) !== null || assignmentAccess?.super && assignmentAccess.pair)) {
        const name = assignmentAccess?.super ? assignmentAccess.name : thisField(unwrap(node.left));
        const pair = assignmentAccess?.super ? assignmentAccess.pair : findAccessor(r, name);
        if (pair?.set) {
          if (!assignmentAccess?.super && descendants(r).some(c => findAccessor(c, name)?.set !== pair.set)) fail(node, "Virtual setter during construction may reach uninitialized subclass fields", "write the accessor after new");
          if (node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) expr(node.left, state, active);
          expr(node.right, state, active);
          if (!active.has(pair.set)) {
            const local = new Set(state), exits = [];
            if (!stmt(pair.set.node.body, local, new Set(active).add(pair.set), exits)) exits.push(local);
            for (const n of r.allFields.keys()) if (exits.length && exits.every(s => s.has(n))) state.add(n);
          }
          return;
        }
        if (node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) requireField(node, name, state);
        expr(node.right, state, active);
        if (![ts.SyntaxKind.AmpersandAmpersandEqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken].includes(node.operatorToken.kind)) state.add(name);
        return;
      }
      if (ts.isConditionalExpression(node)) {
        expr(node.condition, state, active); const a = new Set(state), b = new Set(state);
        expr(node.whenTrue, a, active); expr(node.whenFalse, b, active); for (const name of a) if (b.has(name)) state.add(name); return;
      }
      if (ts.isBinaryExpression(node) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)) {
        expr(node.left, state, active); expr(node.right, new Set(state), active); return;
      }
      if (ts.isCallExpression(node)) {
        const callee = unwrap(node.expression);
        if (ts.isArrowFunction(callee) || ts.isFunctionExpression(callee)) {
          for (const arg of node.arguments) expr(arg, state, active);
          const next = new Set(active).add(callee);
          if (ts.isBlock(callee.body)) {
            const local = new Set(state), exits = [];
            if (!stmt(callee.body, local, next, exits)) exits.push(local);
            for (const name of r.allFields.keys()) if (exits.length && exits.every(s => s.has(name))) state.add(name);
          } else expr(callee.body, state, next);
          return;
        }
        if (node.expression.kind === ts.SyntaxKind.SuperKeyword) { for (const a of node.arguments) expr(a, state, active); return; }
        const a = access(node.expression);
        if (a?.method && !a.static && (a.super || unwrap(callee.expression)?.kind === ts.SyntaxKind.ThisKeyword)) {
          const m = a.method;
          if (!a.super && descendants(r).some(c => findMethod(c, m.name) !== m)) fail(node,
            "Virtual call during construction may reach an override before subclass fields are initialized", "move the call after new, or call a non-overridden initialization helper");
          for (const arg of node.arguments) expr(arg, state, active);
          if (!active.has(m) && m.node.body) { const next = new Set(active).add(m), local = new Set(state), exits = []; stmt(m.node.body, local, next, exits); for (const n of local) if (exits.every(s => s.has(n))) state.add(n); }
          return;
        }
      }
      const memberAccess = (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) ? access(node) : null;
      const name = memberAccess?.super && memberAccess.pair ? memberAccess.name : thisField(node);
      if (name !== null) {
        const pair = memberAccess?.super ? memberAccess.pair : findAccessor(r, name);
        if (pair?.get) {
          if (!memberAccess?.super && descendants(r).some(c => findAccessor(c, name)?.get !== pair.get)) fail(node, "Virtual getter during construction may read uninitialized subclass fields", "read the accessor after new");
          if (!active.has(pair.get)) stmt(pair.get.node.body, new Set(state), new Set(active).add(pair.get));
        } else requireField(node, name, state);
        return;
      }
      if (node.kind === ts.SyntaxKind.ThisKeyword && (ownKeys.some(n => !state.has(n)) || r.children.length)) fail(node, "An instance cannot escape during construction before all subclass fields are initialized", "move the escape after new or use direct non-overridden initialization methods");
      ts.forEachChild(node, child => expr(child, state, active));
    };
    const stmt = (node, state, active = new Set(), exits = []) => {
      if (!node) return false;
      if (ts.isBlock(node)) { for (const s of node.statements) if (stmt(s, state, active, exits)) return true; return false; }
      if (ts.isIfStatement(node)) {
        expr(node.expression, state, active); const a = new Set(state), b = new Set(state);
        const ar = stmt(node.thenStatement, a, active, exits), br = node.elseStatement ? stmt(node.elseStatement, b, active, exits) : false;
        for (const n of ar ? b : a) if (ar || br || b.has(n)) state.add(n); return ar && br;
      }
      if (ts.isReturnStatement(node)) {
        expr(node.expression, state, active); exits.push(new Set(state));
        if (!active.size && ownKeys.some(n => !state.has(n))) fail(node, "Constructor return leaves fields uninitialized", "initialize every field before returning");
        return true;
      }
      if (ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node) || ts.isSwitchStatement(node) || ts.isTryStatement(node)) { expr(node, new Set(state), active); return false; }
      expr(node, state, active); return false;
    };
    for (const field of r.fields.values()) if (!field.parameter) {
      // JS evaluates an initializer before defining the own field. A same-name
      // inherited value is still available while evaluating the RHS.
      if (field.initializer) { expr(field.initializer, initialized); initialized.add(field.name); }
      else initialized.delete(field.name);
    }
    for (const p of r.ctor?.parameters ?? []) if (p.initializer) expr(p.initializer, new Set(initialized));
    for (const field of r.fields.values()) if (field.parameter) initialized.add(field.name);
    if (r.ctor) stmt(r.ctor.body, initialized);
    for (const name of ownKeys) if (!initialized.has(name)) fail(r.fields.get(name).node, "Class field " + name + " must be initialized on every constructor path", "add an initializer or assign it in the constructor");
  };
  for (const r of records) checkInitialization(r);
  // Static fields are real globals, but a read before their class declaration
  // or initializer must never observe the VM's implicit zero. Follow static
  // and ordinary method bodies transitively while checking each initializer.
  const staticReady = new Set(), staticClasses = new Set();
  let initializingClass = null;
  const requireClassReady = (node, r) => {
    if (r && !staticClasses.has(r) && !(initializingClass === r && enclosingClass(node) === r)) fail(node,
      "A class or static member cannot be accessed before its class declaration has finished evaluating", "move the call or access after the class declaration");
  };
  const omittedDefault = (args, i) => i >= args.length
    || ts.isIdentifier(unwrap(args[i])) && unwrap(args[i]).text === "undefined" && !checker.getSymbolAtLocation(unwrap(args[i]))?.declarations?.length;
  const staticReads = (node, seen = new Set()) => {
    if (!node || ts.isTypeNode(node) || ts.isFunctionLike(node)) return;
    const inspectBody = (declaration, args = []) => {
      if (declaration && !seen.has(declaration)) {
        seen.add(declaration);
        for (const [i, p] of (declaration.parameters ?? []).entries()) if (p.initializer && omittedDefault(args, i)) staticReads(p.initializer, seen);
        staticReads(declaration.body, seen);
        seen.delete(declaration);
      }
    };
    const inspectConstruction = (r, args) => {
      if (!r || seen.has(r)) return;
      seen.add(r);
      if (!r.ctor && r.parent) inspectConstruction(r.parent, args);
      if (r.ctor) inspectBody(r.ctor, args);
      for (const field of r.fields.values()) if (field.initializer) staticReads(field.initializer, seen);
      seen.delete(r);
    };
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword) requireClassReady(node.right, staticClass(node.right));
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const a = access(node);
      if (a?.static) requireClassReady(node, a.r);
      if (a?.static && !a.method && !staticReady.has(a.member)) fail(node, "Static field is read before its declaration initializer has executed", "move the read after the field and class initialization");
      if (a?.pair) {
        const usage = accessorUse(node);
        for (const c of a.super ? [a.r] : descendants(a.r)) {
          const pair = findAccessor(c, a.name);
          if (usage.get) inspectBody(pair?.get?.node);
          if (usage.set) inspectBody(pair?.set?.node, [node]);
        }
      }
    }
    if (ts.isCallExpression(node)) {
      const declaration = checker.getResolvedSignature(node)?.declaration;
      inspectBody(declaration, node.arguments);
      const a = access(node.expression);
      if (a?.method && !a.static) for (const c of a.super ? [a.r] : descendants(a.r)) inspectBody(findMethod(c, a.name)?.node, node.arguments);
      const callee = unwrap(node.expression);
      if (callee.kind === ts.SyntaxKind.SuperKeyword) inspectConstruction(enclosingClass(node)?.parent, node.arguments);
      const synchronousCallbacks = new Set(["map", "filter", "forEach", "reduce", "find", "findIndex", "every", "some", "sort", "from", "warp"]);
      if (declaration?.body || synchronousCallbacks.has(callee.name?.text ?? callee.text)) {
        for (const arg of node.arguments) {
          const callback = unwrap(arg);
          if (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) {
            inspectBody(callback);
            if (!ts.isBlock(callback.body)) staticReads(callback.body, seen);
          } else if (ts.isIdentifier(callback)) {
            for (const decl of checker.getSymbolAtLocation(callback)?.declarations ?? []) inspectBody(decl.initializer ?? decl);
          }
        }
      }
    }
    if (ts.isNewExpression(node)) {
      const r = staticClass(node.expression);
      requireClassReady(node, r);
      inspectConstruction(r, node.arguments ?? []);
    }
    ts.forEachChild(node, child => staticReads(child, seen));
  };
  for (const statement of file.statements) {
    const r = byNode.get(statement);
    if (r) {
      initializingClass = r;
      for (const member of r.node.members) {
        const field = [...r.statics.values()].find(s => s.node === member && !s.helper);
        if (field) { if (field.initializer) staticReads(field.initializer); staticReady.add(field); }
      }
      staticClasses.add(r); initializingClass = null;
    } else staticReads(statement);
  }

  const directCall = node => { let n = node; while (n.parent && unwrap(n.parent) === unwrap(node)) n = n.parent; return ts.isCallExpression(n.parent) && n.parent.expression === n; };
  const allNames = new Set(records.flatMap(r => [...r.methods.keys(), ...r.accessors.keys()]));
  const modes = new WeakMap();
  walk(file, node => {
    if (node.kind !== ts.SyntaxKind.ThisKeyword) return;
    let member = node.parent;
    while (member && !ts.isClassDeclaration(member.parent)) member = member.parent;
    if (member && mod(member, ts.SyntaxKind.StaticKeyword)) fail(node, "this in static members is not supported", "name the declaring class explicitly");
  });
  walk(file, node => {
    if (ts.isParameter(node)) {
      if (node.dotDotDotToken || !ts.isIdentifier(node.name)) fail(node, "Rest or destructured class-program parameters are not supported", "use explicitly named parameters");
      if (node.name.text === "this") fail(node, "Explicit this parameters are not supported");
    }
    if ((ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isParameter(node)) && node.initializer) preserve(node, checker.getTypeAtLocation(node.initializer), checker.getTypeAtLocation(node.name));
    if (ts.isExpression(node) && (ts.isArrayLiteralExpression(node.parent) || ts.isPropertyAssignment(node.parent))) {
      const contextual = checker.getContextualType(node);
      if (contextual) preserve(node, checker.getTypeAtLocation(node), contextual);
    }
    if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) preserve(node.body, checker.getTypeAtLocation(node.body),
      checker.getReturnTypeOfSignature(checker.getSignatureFromDeclaration(node)));
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) preserve(node, checker.getTypeAtLocation(node.expression), checker.getTypeAtLocation(node));
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) preserve(node, checker.getTypeAtLocation(node.right), checker.getTypeAtLocation(node.left));
    if (ts.isReturnStatement(node) && node.expression) {
      let owner = node.parent; while (owner && !ts.isFunctionLike(owner)) owner = owner.parent;
      if (owner && ts.isConstructorDeclaration(owner)) fail(node, "Returning a value from a constructor is not supported", "assign fields and return without a value");
      if (owner) preserve(node, checker.getTypeAtLocation(node.expression), checker.getReturnTypeOfSignature(checker.getSignatureFromDeclaration(owner)));
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword) {
      if (!staticClass(node.right)) fail(node.right, "instanceof requires a statically known class identifier", "use a declared class on the right side");
      if (!classOf(node.left)) fail(node.left, "instanceof requires a statically typed class instance", "use an instance with a concrete class or base class type");
    }
    if (ts.isNewExpression(node)) {
      const r = staticClass(node.expression);
      if (!r) { if (ts.isIdentifier(node.expression) && node.expression.text === "Array") return; fail(node, "new requires a statically known declared class", "construct a declared concrete class"); }
      if (r.abstract) fail(node, "Cannot instantiate an abstract class", "instantiate a concrete subclass");
      let owner = node.parent; while (owner && !ts.isFunctionLike(owner) && !ts.isSourceFile(owner)) owner = owner.parent;
      if (ts.isSourceFile(owner) && node.pos < r.node.pos) fail(node, "A class cannot be instantiated before its declaration", "move new below the class declaration");
      const arity = normalizeArgs(node, node.arguments ?? [], r); modes.set(node, arity); r.factories.add(arity);
      const signature = checker.getResolvedSignature(node);
      if (signature) (node.arguments ?? []).slice(0, arity).forEach((arg, i) => {
        const p = signature.parameters[i];
        if (p) preserve(arg, checker.getTypeAtLocation(arg), checker.getTypeOfSymbolAtLocation(p, node));
      });
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const a = access(node);
      if (a) {
        if (a.name === null) fail(node, "Dynamic class property access is not supported", "use literal member names");
        if (a.method && !directCall(node)) fail(node, "Method values, callbacks, bind, call and apply are not supported", "call the method directly");
        if (!a.static && !a.method && !a.pair && !a.r.allFields.has(a.name)) fail(node, "Runtime addition or access of undeclared class property is not supported", "declare and initialize the field");
        if (a.pair) {
          let n = node; while (n.parent && unwrap(n.parent) === node) n = n.parent;
          const p = n.parent, write = ts.isBinaryExpression(p) && p.left === n && p.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && p.operatorToken.kind <= ts.SyntaxKind.LastAssignment
            || (ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(p.operator);
          const onlyWrite = write && ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken;
          if (write && !a.pair.set) fail(node, "Cannot write an accessor with only a getter", "declare a setter");
          if (!onlyWrite && !a.pair.get) fail(node, "Cannot read an accessor with only a setter", "declare a getter");
        }
      } else if (allNames.has(accessKey(node)) && checker.getTypeAtLocation(node.expression).flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Union | ts.TypeFlags.Intersection | ts.TypeFlags.TypeParameter)) fail(node,
        "Class receiver must be a statically known class or base class; any/unknown/unrelated union receivers are not supported", "use a common declared base class");
    }
    if (ts.isCallExpression(node)) {
      const signature = checker.getResolvedSignature(node);
      if (signature) node.arguments.forEach((arg, i) => { const p = signature.parameters[i]; if (p) preserve(arg, checker.getTypeAtLocation(arg), checker.getTypeOfSymbolAtLocation(p, node)); });
      if (access(node.expression)?.method && signature && checker.getReturnTypeOfSignature(signature).flags & ts.TypeFlags.Void) {
        let n = node; while (n.parent && unwrap(n.parent) === node) n = n.parent;
        if (!ts.isExpressionStatement(n.parent)) fail(node, "Reading a void method result is not supported", "call it as a statement or return an explicit value");
      }
    }
    if (node.kind === ts.SyntaxKind.ThisKeyword) {
      let member = node.parent; while (member && !ts.isClassElement(member)) member = member.parent;
      if (member && mod(member, ts.SyntaxKind.StaticKeyword)) fail(node, "this in static members is not supported", "name the declaring class explicitly");
    }
  });

  // Capture checking follows resolved calls to catch indirect yield boundaries.
  const yieldNames = new Set(["wait", "waitUntil", "ask", "askChoice", "glideTo", "glideChangeX", "glideChangeY", "broadcastAndWait", "tellAndWait", "syncTell", "playAudioAndWait", "say", "think", "stageDialog", "fadeVisibility", "appearWith"]);
  const canYield = (node, seen = new Set()) => {
    if (!node || seen.has(node) || ts.isTypeNode(node) || ts.isFunctionLike(node)) return false; seen.add(node);
    const invocationYields = (declaration, args = []) => {
      if (!declaration || seen.has(declaration)) return false;
      seen.add(declaration);
      const yields = (declaration.parameters ?? []).some((p, i) => p.initializer && omittedDefault(args, i) && canYield(p.initializer, seen))
        || canYield(declaration.body, seen);
      seen.delete(declaration); return yields;
    };
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      if (yieldNames.has(callee.name?.text ?? callee.text) || invocationYields(checker.getResolvedSignature(node)?.declaration, node.arguments)) return true;
      const a = access(callee);
      if (a?.method && !a.static && (a.super ? [a.r] : descendants(a.r)).some(c => invocationYields(findMethod(c, a.name)?.node, node.arguments))) return true;
      for (const arg of node.arguments) {
        const callback = unwrap(arg);
        if (ts.isFunctionLike(callback) && invocationYields(callback)) return true;
        if (ts.isIdentifier(callback) && checker.getSymbolAtLocation(callback)?.declarations?.some(d => invocationYields(d.initializer ?? d))) return true;
      }
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const a = access(node);
      const usage = accessorUse(node);
      if (a?.pair && (a.super ? [a.r] : descendants(a.r)).some(c => {
        const pair = findAccessor(c, a.name);
        return usage.get && invocationYields(pair?.get?.node) || usage.set && invocationYields(pair?.set?.node, [node]);
      })) return true;
    }
    if (ts.isNewExpression(node)) {
      let r = staticClass(node.expression);
      while (r) {
        if (invocationYields(r.ctor, node.arguments ?? []) || [...r.fields.values()].some(field => canYield(field.initializer, seen))) return true;
        r = r.parent;
      }
    }
    return !!ts.forEachChild(node, c => canYield(c, seen));
  };
  for (const r of records) for (const member of r.node.members) {
    const aliases = new Set(); let changed = true;
    while (changed) { changed = false; walk(member, n => {
      if (ts.isVariableDeclaration(n) || ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const target = ts.isVariableDeclaration(n) ? n.name : n.left, value = unwrap(ts.isVariableDeclaration(n) ? n.initializer : n.right);
        if (ts.isIdentifier(target) && (value?.kind === ts.SyntaxKind.ThisKeyword || ts.isIdentifier(value) && aliases.has(checker.getSymbolAtLocation(value)))) {
          const symbol = checker.getSymbolAtLocation(target); if (!aliases.has(symbol)) { aliases.add(symbol); changed = true; }
        }
      }
    }); }
    walk(member, n => {
      if (!ts.isArrowFunction(n) && !ts.isFunctionExpression(n) && !ts.isFunctionDeclaration(n)) return;
      let captured = false; walk(n, c => { captured ||= c.kind === ts.SyntaxKind.ThisKeyword || c.kind === ts.SyntaxKind.SuperKeyword || ts.isIdentifier(c) && aliases.has(checker.getSymbolAtLocation(c)); });
      if (!captured) return;
      let wrapper = n; while (ts.isParenthesizedExpression(wrapper.parent)) wrapper = wrapper.parent;
      const call = wrapper.parent;
      const immediate = ts.isCallExpression(call) && (call.expression === wrapper || ts.isIdentifier(call.expression) && call.expression.text === "warp" && call.arguments.includes(wrapper));
      if (!ts.isArrowFunction(n) || !immediate || canYield(call)) fail(n, "Closures capturing this across yield boundaries and dynamic function this are not supported", "use a direct instance method or explicit instance parameter");
    });
  }

  // One full field shape per inheritance tree avoids erasing reference fields
  // when a derived handle is passed through a base-typed procedure. These are
  // private type declarations; users cannot access another class's fields.
  const treeFields = new Map();
  const storageType = field => {
    const type = checker.getTypeAtLocation(field.node.name);
    if (type.flags & ts.TypeFlags.StringLike) return "string";
    if (type.flags & ts.TypeFlags.NumberLike) return "number";
    if (type.flags & ts.TypeFlags.BooleanLike) return "boolean";
    return typeText(field.type);
  };
  for (const r of records.filter(r => !r.parent)) {
    const fields = new Map();
    for (const c of descendants(r)) for (const [name, field] of c.fields) {
      const old = fields.get(name);
      if (old && storageType(old) !== storageType(field)) fail(field.node,
        "Inherited/shared fields must keep the same type throughout an inheritance tree", "use matching field types or distinct names");
      fields.set(name, field);
    }
    treeFields.set(r, fields);
  }
  const dispatches = new Map();
  const implementation = (r, name, kind) => kind === "method" ? findMethod(r, name) : findAccessor(r, name)?.[kind];
  const target = (r, name, kind, direct = false, arity = undefined, missing = []) => {
    const m = implementation(r, name, kind);
    if (!m) fail(r.node, "Missing " + kind + " implementation for " + name);
    if (direct && m.abstract) fail(m.node, "super cannot call an abstract member without an implementation", "call a concrete ancestor implementation or use a virtual this call after construction");
    const concrete = descendants(r).filter(c => !c.abstract);
    const choices = concrete.map(c => ({ c, m: implementation(c, name, kind) }));
    if (direct || !m.abstract && choices.every(choice => choice.m === m)) return m.helper;
    arity ??= m.node.parameters.length;
    const k = r.name + ":" + kind + ":" + name + ":" + arity + ":" + missing.join(",");
    if (!dispatches.has(k)) dispatches.set(k, { name: fresh(r.name + "_dispatch_" + kind + "_" + name), r, m, choices, arity, missing });
    return dispatches.get(k).name;
  };
  const context = ts.nullTransformationContext;
  const id = text => f.createIdentifier(text);
  const call = (name, args) => f.createCallExpression(id(name), undefined, args);
  const number = n => f.createNumericLiteral(n);
  const numericType = type => {
    if (type.flags & ts.TypeFlags.NumberLike) return true;
    if (type.isUnion()) return type.types.every(numericType);
    // A numeric intersection (number & Brand) narrows number, rather than
    // requiring ToNumeric. Do not mistake an ordinary branded object for it.
    return type.isIntersection() && type.types.some(numericType);
  };
  const prop = (value, name) => f.createElementAccessExpression(value, f.createStringLiteral(name));
  const transformed = (node, self, owner) => ts.visitNode(node, visitor(self, owner));
  const expressionText = (node, self, owner) => print(transformed(node, self, owner));
  const updateAccessor = (node, a, operator, rhs, self, owner) => {
    const receiver = a.super ? id(self) : transformed(node.expression, self, owner);
    const name = fresh(a.r.name + "_accessorUpdate");
    const p = fresh("receiver"), v = fresh("value");
    const get = target(a.r, a.name, "get", a.super), set = target(a.r, a.name, "set", a.super);
    // Evaluate receiver, then getter, then RHS, then setter. A thunk cannot
    // safely retain this across yields; a generated first-stage procedure
    // captures receiver and old value before the RHS call is evaluated.
    const capture = fresh("captureAccessor"), savedType = typeText(inferredType(node));
    const boxType = fresh("AccessorState");
    declarations.set(boxType, `interface ${boxType} { receiver: ${a.r.name}; old: ${savedType}; }`);
    addHelper(capture, `function ${capture}(${p}: ${a.r.name}): ${boxType} { return { receiver: ${p}, old: ${get}(${p}) }; }`, node);
    addHelper(name, `function ${name}(${p}: ${boxType}, ${v}: ${savedType}): number { ${set}(${p}.receiver, ${p}.old ${operator} ${v}); return 0; }`, node);
    return call(name, [call(capture, [receiver]), rhs]);
  };
  const visitor = (self, owner) => node => {
    if (node.kind === ts.SyntaxKind.ThisKeyword && self) return id(self);
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.SuperKeyword) {
        const arity = superSites.get(node) ?? normalizeArgs(node, node.arguments, owner.parent);
        owner.parent.arities.add(arity);
        const construction = call(owner.parent.construct + "_" + arity, [id(self), ...node.arguments.slice(0, arity).map(a => transformed(a, self, owner))]);
        const initialize = call(owner.init, [id(self)]);
        const params = [...owner.fields.values()].filter(field => field.parameter).map(field => f.createExpressionStatement(f.createBinaryExpression(prop(id(self), field.name), ts.SyntaxKind.EqualsToken, id(field.name))));
        // super is required to appear as a statement; insert derived fields
        // exactly at that statement, after the base constructor returns.
        return f.createImmediatelyInvokedArrowFunction([f.createExpressionStatement(construction), f.createExpressionStatement(initialize), ...params]);
      }
      const a = access(node.expression);
      if (a?.method) {
        const missing = node.arguments.flatMap((arg, i) => ts.isIdentifier(unwrap(arg)) && unwrap(arg).text === "undefined"
          && !checker.getSymbolAtLocation(unwrap(arg))?.declarations?.length ? [i] : []);
        const name = a.static ? a.method.helper : target(a.r, a.name, "method", a.super, node.arguments.length, missing);
        const dispatch = [...dispatches.values()].some(d => d.name === name);
        return call(name, [...a.static ? [] : [a.super ? id(self) : transformed(unwrap(node.expression).expression, self, owner)],
          ...node.arguments.map((arg, i) => dispatch && missing.includes(i) ? number(0) : transformed(arg, self, owner))]);
      }
    }
    if (ts.isNewExpression(node)) {
      const r = staticClass(node.expression);
      if (r) return call(r.factory + "_" + modes.get(node), (node.arguments ?? []).slice(0, modes.get(node)).map(a => transformed(a, self, owner)));
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword) {
      const r = staticClass(node.right), receiver = classOf(node.left), name = fresh("instanceof_" + r.name), p = fresh("instance");
      addHelper(name, `function ${name}(${p}: ${receiver.name}): boolean { return ${p}[${JSON.stringify(tag)}] >= ${r.pre} && ${p}[${JSON.stringify(tag)}] <= ${r.post}; }`, node);
      return call(name, [transformed(node.left, self, owner)]);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      const left = unwrap(node.left), a = access(left);
      // Neither the global path for statics nor the heap path for instance
      // fields may eagerly evaluate the skipped RHS of a logical assignment.
      if (a && !a.pair && [ts.SyntaxKind.AmpersandAmpersandEqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken].includes(node.operatorToken.kind)) fail(node,
        "Logical class field assignments are not supported", "use an explicit if statement to preserve short-circuit evaluation");
      if (a?.pair) {
        if (!ts.isExpressionStatement(node.parent)) fail(node, "Value-producing accessor assignments are not supported", "use a standalone assignment and read separately");
        const rhs = transformed(node.right, self, owner);
        if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken) return call(target(a.r, a.name, "set", a.super), [a.super ? id(self) : transformed(left.expression, self, owner), rhs]);
        const operator = ts.tokenToString(node.operatorToken.kind).slice(0, -1);
        if (["&&", "||", "??"].includes(operator)) fail(node, "Logical accessor assignments are not supported", "use an explicit if statement");
        return updateAccessor(left, a, operator, rhs, self, owner);
      }
    }
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)) {
      const operand = unwrap(node.operand), a = access(operand);
      if (a?.pair) {
        if (!ts.isExpressionStatement(node.parent)) fail(node, "Value-producing accessor updates are not supported", "update in a standalone statement");
        // JS ++/-- applies ToNumeric, unlike +=. Rewriting a string getter as
        // old + 1 would concatenate and can also change the setter's domain.
        if (!numericType(checker.getTypeAtLocation(operand))) fail(operand,
          "Accessor updates require statically numeric getters; implicit conversion is not supported",
          "use a number-valued accessor or convert explicitly before assigning");
        return updateAccessor(operand, a, node.operator === ts.SyntaxKind.PlusPlusToken ? "+" : "-", number(1), self, owner);
      }
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const a = access(node);
      if (a?.static && !a.method) return id(a.member.global);
      if (a?.pair) return call(target(a.r, a.name, "get", a.super), [a.super ? id(self) : transformed(node.expression, self, owner)]);
      if (a?.super) fail(node, "super data field access is not supported", "use this.field or super.method()");
    }
    return ts.visitEachChild(node, visitor(self, owner), context);
  };

  const returnType = m => {
    const t = checker.getReturnTypeOfSignature(checker.getSignatureFromDeclaration(m.node));
    if (t.flags & ts.TypeFlags.Void) return "number";
    return t.isThisType ? m.owner.name : typeText(m.node.type ?? checker.typeToTypeNode(t, undefined, ts.NodeBuilderFlags.NoTruncation));
  };
  const replaceReturn = node => {
    if (ts.isFunctionLike(node)) return node;
    if (ts.isReturnStatement(node) && !node.expression) return f.createReturnStatement(number(0));
    return ts.visitEachChild(node, replaceReturn, context);
  };
  const parameters = (nodes, r, defaults = true) => nodes.map(p => {
    if (p.initializer && defaults) { let hasThis = false; walk(p.initializer, n => { hasThis ||= n.kind === ts.SyntaxKind.ThisKeyword; }); if (hasThis) fail(p, "Method defaults reading this are not supported", "read this in the method body or pass an explicit argument"); }
    return p.name.text + ": " + typeText(p.type ?? inferredType(p.name)) + (defaults && p.initializer ? " = " + expressionText(p.initializer, r.self, r) : "");
  }).join(", " );
  {
    // A no-op transformation context is enough for this syntax-only rewrite.
    for (const r of records) {
      const fields = treeFields.get(r.root);
      declarations.set(r.name, `interface ${r.name} { ${JSON.stringify(tag)}: number; ${[...fields.values()].map(field => JSON.stringify(field.name) + ": " + typeText(field.type) + ";").join(" ")} }`);
      const initialized = [...r.fields.values()].filter(field => field.initializer);
      const initializers = initialized.map(field => transformed(field.initializer, r.self, r));
      fieldInitializers.set(r.init, initializers);
      const init = initialized.map((field, i) => `${r.self}[${JSON.stringify(field.name)}] = ${print(initializers[i])};`).join("\n");
      addHelper(r.init, `function ${r.init}(${r.self}: ${r.name}): number { ${init} return 0; }`, r.node);
      for (const m of [...r.methods.values(), ...[...r.accessors.values()].flatMap(pair => Object.values(pair)), ...[...r.statics.values()].filter(m => m.helper)]) {
        if (m.abstract) continue;
        const body = transformed(m.node.body, m.static ? null : r.self, r);
        const concreteBody = ts.visitNode(body, replaceReturn);
        helperBodies.set(m.helper, { statements: concreteBody.statements, trailing: !!(checker.getReturnTypeOfSignature(checker.getSignatureFromDeclaration(m.node)).flags & ts.TypeFlags.Void) });
        const signature = checker.getReturnTypeOfSignature(checker.getSignatureFromDeclaration(m.node));
        const returns = n => ts.isReturnStatement(n) && !!n.expression || ts.isBlock(n) && n.statements.some(returns) || ts.isIfStatement(n) && n.elseStatement && returns(n.thenStatement) && returns(n.elseStatement);
        const hasBareReturn = n => !ts.isFunctionLike(n) && (ts.isReturnStatement(n) && !n.expression || !!ts.forEachChild(n, hasBareReturn));
        const bare = hasBareReturn(m.node.body);
        if (!(signature.flags & ts.TypeFlags.Void) && (!returns(m.node.body) || bare)) fail(m.node, "Value-returning methods must return a concrete value on every path", "add an explicit final return");
        const args = [m.static ? "" : `${r.self}: ${r.name}`, parameters(m.node.parameters, r)].filter(Boolean).join(", " );
        addHelper(m.helper, `function ${m.helper}(${args}): ${returnType(m)} { ${concreteBody.statements.map(print).join("\n")} ${signature.flags & ts.TypeFlags.Void ? "return 0;" : ""} }`, m.node);
      }
    }
    // Record constructor arities before emitting bodies; super/default implicit
    // forwarding can introduce more arities on an ancestor.
    for (const r of records) for (const arity of r.factories) r.arities.add(arity);
    for (const r of [...records].reverse()) {
      if (r.parent && !r.ctor) for (const arity of r.arities) r.parent.arities.add(arity);
      if (r.ctor) walk(r.ctor.body, node => { if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.SuperKeyword) r.parent.arities.add(superSites.get(node)); });
    }
    for (const r of records) for (const arity of r.arities) {
      const params = effectiveCtor(r)?.parameters ?? [], names = params.slice(0, arity).map(p => p.name.text);
      const args = names.map((name, i) => `${name}: ${typeText(params[i].type ?? inferredType(params[i].name))}`);
      let body = "";
      if (!r.ctor && r.parent) body = `${r.parent.construct}_${arity}(${r.self}${names.length ? ", " + names.join(", ") : ""}); ${r.init}(${r.self});`;
      else {
        if (!r.parent) body += `${r.init}(${r.self});`;
        for (const p of params.slice(arity)) body += `let ${p.name.text}: ${typeText(p.type ?? inferredType(p.name))} = ${expressionText(p.initializer, r.self, r)};`;
        if (!r.parent) for (const field of r.fields.values()) if (field.parameter) body += `${r.self}[${JSON.stringify(field.name)}] = ${field.name};`;
        if (r.ctor) {
          const statements = ts.visitNode(transformed(r.ctor.body, r.self, r), replaceReturn).statements;
          helperBodies.set(r.construct + "_" + arity, { statements, trailing: true });
          body += statements.map(print).join("\n");
        }
      }
      const name = r.construct + "_" + arity;
      addHelper(name, `function ${name}(${r.self}: ${r.name}${args.length ? ", " + args.join(", ") : ""}): number { ${body} return 0; }`, r.ctor ?? r.node);
    }
    for (const r of records) for (const arity of r.factories) {
      const params = effectiveCtor(r)?.parameters ?? [], args = params.slice(0, arity).map((p, i) => ({name: fresh("arg" + i), type: typeText(p.type ?? inferredType(p.name))}));
      const fields = [...treeFields.get(r.root).values()];
      const placeholder = field => {
        const t = checker.getTypeAtLocation(field.node.name);
        if (t.flags & ts.TypeFlags.StringLike) return '""';
        if (t.flags & ts.TypeFlags.BooleanLike) return "false";
        if (checker.isArrayType(t) || checker.isTupleType(t)) return "[]";
        if (t.flags & ts.TypeFlags.Object) return `0 as unknown as ${typeText(field.type)}`;
        return "0";
      };
      const allocation = `{ ${JSON.stringify(tag)}: ${r.pre}, ${fields.map(field => JSON.stringify(field.name) + ": " + placeholder(field)).join(", ")} }`;
      const name = r.factory + "_" + arity;
      addHelper(name, `function ${name}(${args.map(a => a.name + ": " + a.type).join(", ")}): ${r.name} { const ${r.self}: ${r.name} = ${allocation}; ${r.construct}_${arity}(${r.self}${args.length ? ", " + args.map(a => a.name).join(", ") : ""}); return ${r.self}; }`, r.node);
    }
    const edits = [];
    const editTree = node => {
      if (ambient(node)) return;
      if (ts.isClassDeclaration(node)) {
        const r = byNode.get(node);
        const statics = [...r.statics.values()].filter(m => !m.helper).map(field => {
          if (!field.initializer) fail(field.node, "Static fields require explicit initialization", "add a scalar or object initializer");
          return `let ${field.global}: ${typeText(field.type)} = ${expressionText(field.initializer, null, r)};`;
        });
        edits.push({start:node.getStart(file), end:node.end, text:declarations.get(r.name) + " " + statics.join(" " )}); return;
      }
      const changed = transformed(node, null, null);
      // Visit source statements as units so nested getter writes and instanceof
      // conditions retain a single consistent transformed tree.
      edits.push({start:node.getStart(file), end:node.end, text:print(changed)});
    };
    for (const statement of file.statements) editTree(statement);
    // Dispatch generation is last: transformed method/constructor bodies may
    // request more dispatchers. Group contiguous equal implementations by id.
    for (const d of dispatches.values()) {
      const ps = d.m.node.parameters.slice(0, d.arity), receiver = fresh("receiver"), classId = fresh("classId"), names = ps.map((_, i) => fresh("arg" + i));
      const groups = [];
      for (const choice of d.choices) {
        if (!choice.m) fail(choice.c.node, `Class ${choice.c.name} accessor ${d.m.name} has no ${d.m.kind === "set" ? "setter" : "getter"} implementation`,
          "declare matching getter and setter implementations in the overriding class");
        if (choice.m.abstract) fail(choice.c.node, "Concrete class lacks an abstract implementation");
        const last = groups.at(-1);
        if (last?.m === choice.m && last.end + 1 === choice.c.pre) last.end = choice.c.pre;
        else groups.push({start:choice.c.pre, end:choice.c.pre, m:choice.m});
      }
      // With no concrete descendant no valid handle can enter this dispatcher.
      // Keep an uninhabited recursive continuation rather than inventing a
      // result (in particular an invalid object zero) for abstract-only trees.
      const body = groups.length ? groups.map((g, i) => {
        const forwarded = names.slice(0, g.m.node.parameters.length).map((name, i) => d.missing.includes(i) ? "undefined" : name);
        return `${i === groups.length - 1 ? "" : `if (${classId} >= ${g.start} && ${classId} <= ${g.end}) `}{ return ${g.m.helper}(${receiver}${forwarded.length ? ", " + forwarded.join(", ") : ""}); }`;
      }).join("\n")
        : `return ${d.name}(${receiver}${names.length ? ", " + names.join(", ") : ""});`;
      addHelper(d.name, `function ${d.name}(${receiver}: ${d.r.name}${names.length ? ", " + names.map((n, i) => n + ": " + typeText(ps[i].type ?? inferredType(ps[i].name))).join(", ") : ""}): ${returnType(d.m)} { const ${classId} = ${receiver}[${JSON.stringify(tag)}]; ${body} }`, d.m.node);
    }
    let text = file.text;
    for (const e of edits.reverse()) {
      const lines = text.slice(e.start,e.end).match(/\n/g)?.length ?? 0;
      text = text.slice(0,e.start) + e.text.replace(/\r?\n\s*/g, " ") + "\n".repeat(lines) + text.slice(e.end);
    }
    // Unused class helpers can contain field accesses without any allocation
    // anywhere in the program. Do not send those unreachable bodies through
    // the ordinary compiler, which correctly has no heap in that case.
    const reachable = new Set();
    let changed = true, references = text;
    while (changed) {
      changed = false;
      for (const code of helpers) {
        const name = /^function (\w+)/.exec(code)[1];
        if (!reachable.has(name) && new RegExp(`\\b${name}\\b`).test(references)) {
          reachable.add(name); references += "\n" + code; changed = true;
        }
      }
    }
    text += "\n" + [...declarations.entries()].filter(([name]) => !records.some(r => r.name === name)).map(([,code]) => code).join("\n")
      + "\n" + helpers.filter(code => reachable.has(/^function (\w+)/.exec(code)[1])).join("\n") + "\n";
    const output = ts.createSourceFile(input.fileName, text, input.languageVersion, true, input.scriptKind);
    for (const helper of output.statements) {
      const name = helper.name?.text;
      const body = helperBodies.get(name);
      if (body) {
        const start = helper.body.statements.length - Number(body.trailing) - body.statements.length;
        body.statements.forEach((original, i) => mapPrintedClassNodes(helper.body.statements[start + i], original, input, origins.get(name)));
      }
      fieldInitializers.get(name)?.forEach((original, i) => {
        const assignment = helper.body.statements[i];
        mapPrintedClassNodes(assignment, original, input, origins.get(name));
        mapPrintedClassNodes(assignment.expression.right, original, input, origins.get(name));
      });
    }
    classSourceOrigins.set(output, origins);
    return output;
  }
}
