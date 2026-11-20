import ts from "typescript";
import { objectTypes } from "./share-objects.mjs";
import { classSourceOrigins } from "./class-metadata.mjs";
import { needsClassInheritance, lowerClassInheritance } from "./tsfeat-class-inherit.mjs";

// Classes are statically bound functions plus ordinary share-object handles.
// No prototype lookup, method values or host objects reach the block compiler.
export function lowerTsClasses(input) {
  if (needsClassInheritance(input)) return lowerClassInheritance(input);
  const ambient = node => !!(node.flags & ts.NodeFlags.Ambient)
    || node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DeclareKeyword);
  const hasClasses = node => !ambient(node) && !ts.isTypeNode(node) && (ts.isClassDeclaration(node) || ts.isClassExpression(node)
    || node.kind === ts.SyntaxKind.SuperKeyword
    || ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword
    || ts.forEachChild(node, hasClasses));
  if (!hasClasses(input)) return input;
  const f = ts.factory;
  const sourceFile = ts.createSourceFile(input.fileName, input.text, input.languageVersion, true, input.scriptKind);
  const checker = objectTypes([sourceFile]).checker;
  const fail = (node, message, alternative) => {
    const p = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    const error = new Error(message + "; alternative: " + alternative);
    error.name = "CompileError";
    error.code = "NEKOC_TS_CLASS";
    error.location = { file: sourceFile.fileName, line: p.line + 1, column: p.character + 1 };
    throw error;
  };
  const walk = (node, visit) => {
    if (ambient(node) || ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return;
    visit(node);
    ts.forEachChild(node, child => walk(child, visit));
  };
  const unwrap = node => {
    while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)
      || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node))) node = node.expression;
    return node;
  };
  const names = new Set();
  walk(sourceFile, node => { if (ts.isIdentifier(node)) names.add(node.text); });
  let salt = 2166136261;
  for (const ch of sourceFile.fileName.replaceAll("\\", "/")) salt = Math.imul(salt ^ ch.charCodeAt(0), 16777619) >>> 0;
  let serial = 0;
  const fresh = hint => {
    let name;
    do { name = "__nekocClass_" + salt + "_" + (++serial) + "_" + hint.replace(/[^\w$]/g, "_"); } while (names.has(name));
    names.add(name);
    return name;
  };
  const modifier = (node, kind) => node.modifiers?.some(m => m.kind === kind);
  const decorated = node => ts.canHaveDecorators(node) && ts.getDecorators(node)?.length;
  const memberName = node => {
    if (ts.isPrivateIdentifier(node.name)) fail(node.name, "#private class fields are not supported in class stage 1", "declare an ordinary instance field instead");
    if (!node.name || !(ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name) || ts.isNumericLiteral(node.name))) {
      fail(node, "Computed class member names are not supported in class stage 1", "declare a literal field or method name instead");
    }
    if (node.name.text === "__proto__") fail(node, "__proto__ class members are not supported", "choose an ordinary field name");
    return node.name.text;
  };
  const typeOf = node => checker.typeToTypeNode(checker.getTypeAtLocation(node), undefined,
    ts.NodeBuilderFlags.NoTruncation | ts.NodeBuilderFlags.UseAliasDefinedOutsideCurrentScope)
    ?? f.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword);
  const records = [];
  const byDeclaration = new Map();
  const bySymbol = new Map();
  const methodNames = new Set();
  walk(sourceFile, node => {
    if (ts.isIdentifier(node) && node.text.startsWith("__nekocClass_")) fail(node,
      "Names starting with __nekocClass_ are reserved for class lowering", "rename this identifier");
  });
  walk(sourceFile, node => {
    if (ts.isParameter(node) && decorated(node)) fail(node,
      "Parameter decorators are not supported in class stage 1", "call an explicit initialization helper instead of decorating a parameter");
    if (ts.isClassExpression(node)) fail(node, "Class expressions are not supported in class stage 1", "use a named class declaration");
    if (node.kind === ts.SyntaxKind.SuperKeyword) fail(node, "super is not supported in class stage 1; inheritance is reserved for stage 2", "call an explicitly named helper with this instead");
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword) {
      fail(node, "instanceof is not supported in class stage 1; inheritance is reserved for stage 2", "compare a declared scalar kind field explicitly");
    }
    if (!ts.isClassDeclaration(node)) return;
    if (!node.name) fail(node, "Anonymous class declarations are not supported in class stage 1", "give the class a name");
    if (!ts.isSourceFile(node.parent)) fail(node, "Nested class declarations are not supported in class stage 1", "move the class declaration to the top level");
    if (decorated(node)) fail(node, "Class decorators are not supported in class stage 1", "call an explicit initialization helper instead");
    if (modifier(node, ts.SyntaxKind.AbstractKeyword)) fail(node, "abstract classes are not supported in class stage 1; inheritance is reserved for stage 2", "use a concrete class with implemented methods");
    const extendsClause = node.heritageClauses?.find(clause => clause.token === ts.SyntaxKind.ExtendsKeyword);
    if (extendsClause) fail(extendsClause, "extends is not supported in class stage 1; inheritance is reserved for stage 2", "store the other instance in a declared field and call it explicitly");
    if (node.typeParameters?.length) fail(node, "Generic classes are not supported in class stage 1", "declare a concrete class with explicit field types");
    const record = { node, name: node.name.text, fields: new Map(), methods: new Map(), ctor: null,
      factory: fresh(node.name.text + "_new"), self: fresh(node.name.text + "_this"), arities: new Set() };
    records.push(record);
    byDeclaration.set(node, record);
    bySymbol.set(checker.getSymbolAtLocation(node.name), record);
    const seen = new Set();
    for (const member of node.members) {
      if (ts.isSemicolonClassElement(member)) continue;
      if (decorated(member)) fail(member, "Class member decorators are not supported in class stage 1", "call an explicit initialization helper instead");
      for (const parameter of member.parameters ?? []) if (decorated(parameter)) fail(parameter,
        "Class parameter decorators are not supported in class stage 1", "perform explicit initialization in the method or constructor body");
      for (const parameter of member.parameters ?? []) {
        if (ts.isIdentifier(parameter.name) && parameter.name.text === "this") fail(parameter,
          "Explicit this parameters are not supported in class stage 1", "remove the explicit this parameter; instance methods already have a typed receiver");
        if (ts.isMethodDeclaration(member) && parameter.initializer) {
          const usesReceiver = child => child.kind === ts.SyntaxKind.ThisKeyword || ts.forEachChild(child, usesReceiver);
          if (usesReceiver(parameter.initializer)) fail(parameter.initializer,
            "Method defaults reading this are not supported in class stage 1", "pass the field value explicitly at the call or read this inside the method body");
        }
      }
      if (modifier(member, ts.SyntaxKind.StaticKeyword) || ts.isClassStaticBlockDeclaration(member)) {
        fail(member, "static class members are not supported in class stage 1", "use a top-level variable or ordinary function");
      }
      if (modifier(member, ts.SyntaxKind.AbstractKeyword)) fail(member, "abstract members are not supported in class stage 1; inheritance is reserved for stage 2", "provide a concrete method body");
      if (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
        fail(member, "Class getter/setter accessors are not supported in class stage 1", "use a field and explicit get/set methods");
      }
      if (ts.isIndexSignatureDeclaration(member)) fail(member, "Class index signatures are not supported in class stage 1", "declare each field by its literal name");
      if (ts.isConstructorDeclaration(member)) {
        if (record.ctor || !member.body) fail(member, "Constructor overloads are not supported in class stage 1", "use one constructor with default parameters");
        record.ctor = member;
        continue;
      }
      const name = memberName(member);
      if (seen.has(name)) fail(member, "Duplicate class member " + name + " is not supported", "declare each field and method once");
      seen.add(name);
      if (ts.isPropertyDeclaration(member)) {
        if (member.questionToken) fail(member, "Optional class fields are not supported in class stage 1", "declare an initialized field and an explicit validity flag");
        record.fields.set(name, { node: member, name, type: member.type ?? typeOf(member.name), initializer: member.initializer });
      } else if (ts.isMethodDeclaration(member)) {
        if (!member.body || member.questionToken) fail(member, "Class methods must have a concrete body in class stage 1", "provide one method implementation");
        if (member.asteriskToken || modifier(member, ts.SyntaxKind.AsyncKeyword)) fail(member, "Async/generator class methods are not supported in class stage 1", "use an ordinary method and explicit state");
        if (member.typeParameters?.length) fail(member, "Generic class methods are not supported in class stage 1", "use explicit concrete parameter and return types");
        record.methods.set(name, { node: member, name, helper: fresh(record.name + "_" + name), owner: record });
        methodNames.add(name);
      } else fail(member, "This class member is not supported in class stage 1", "use a declared data field or ordinary instance method");
    }
    for (const parameter of record.ctor?.parameters ?? []) {
      if (!parameter.modifiers?.some(m => [ts.SyntaxKind.PublicKeyword, ts.SyntaxKind.PrivateKeyword,
        ts.SyntaxKind.ProtectedKeyword, ts.SyntaxKind.ReadonlyKeyword].includes(m.kind))) continue;
      if (!ts.isIdentifier(parameter.name)) fail(parameter, "Destructured parameter properties are not supported", "use a named parameter and an explicit field assignment");
      if (seen.has(parameter.name.text)) fail(parameter, "Duplicate class member " + parameter.name.text + " is not supported", "declare the field once as a parameter property");
      seen.add(parameter.name.text);
      record.fields.set(parameter.name.text, { node: parameter, name: parameter.name.text, type: parameter.type ?? typeOf(parameter.name), parameter });
    }
  });
  const classFromType = type => {
    if (!type) return null;
    if (type.isThisType && type.getConstraint()) return classFromType(type.getConstraint());
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Union | ts.TypeFlags.Intersection | ts.TypeFlags.TypeParameter)) return null;
    const symbol = type.getSymbol();
    if (bySymbol.has(symbol)) return bySymbol.get(symbol);
    for (const declaration of symbol?.declarations ?? []) if (byDeclaration.has(declaration)) return byDeclaration.get(declaration);
    return null;
  };
  const classOf = node => classFromType(checker.getTypeAtLocation(node));
  const preserveClass = (node, from, to, seen = new Map()) => {
    if (!from || !to) return;
    let targets = seen.get(from);
    if (targets?.has(to)) return;
    if (!targets) seen.set(from, targets = new Set());
    targets.add(to);
    const a = classFromType(from), b = classFromType(to);
    if ((a || b) && a !== b) fail(node,
      "Class references must preserve the same concrete class; structural substitution or type erasure cannot determine instance methods statically",
      "use one concrete class type throughout the variable, parameter, return value and container");
    if (from.isUnion()) { for (const part of from.types) preserveClass(node, part, to, seen); return; }
    if (to.isUnion()) {
      // The later receiver check diagnoses actual union method calls. Storing
      // a class in its explicit union does not erase its declared identity.
      return;
    }
    const fromArray = checker.isArrayType(from) || checker.isTupleType(from);
    const toArray = checker.isArrayType(to) || checker.isTupleType(to);
    if (fromArray && toArray) {
      preserveClass(node, checker.getIndexTypeOfType(from, ts.IndexKind.Number), checker.getIndexTypeOfType(to, ts.IndexKind.Number), seen);
      return;
    }
    if (from.flags & ts.TypeFlags.Object && to.flags & ts.TypeFlags.Object && !a && !b) {
      for (const property of checker.getPropertiesOfType(to)) {
        const other = checker.getPropertyOfType(from, property.name);
        if (other) preserveClass(node, checker.getTypeOfSymbolAtLocation(other, other.valueDeclaration ?? node),
          checker.getTypeOfSymbolAtLocation(property, property.valueDeclaration ?? node), seen);
      }
    }
  };
  const accessName = node => ts.isPropertyAccessExpression(node) ? node.name.text
    : ts.isElementAccessExpression(node) && ts.isStringLiteralLike(unwrap(node.argumentExpression)) ? unwrap(node.argumentExpression).text : null;
  const methodAccess = inputNode => {
    const node = unwrap(inputNode);
    if (!node || !(ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))) return null;
    return classOf(node.expression)?.methods.get(accessName(node)) ?? null;
  };
  const newModes = new WeakMap();
  const directCall = access => {
    let node = access;
    while (node.parent && unwrap(node.parent) === unwrap(access)) node = node.parent;
    return ts.isCallExpression(node.parent) && node.parent.expression === node;
  };
  const alwaysReturns = node => ts.isReturnStatement(node) && !!node.expression
    || ts.isBlock(node) && node.statements.some(alwaysReturns)
    || ts.isIfStatement(node) && !!node.elseStatement
      && alwaysReturns(node.thenStatement) && alwaysReturns(node.elseStatement);
  const hasBareReturn = node => !ts.isFunctionLike(node) && (ts.isReturnStatement(node) && !node.expression
    || !!ts.forEachChild(node, hasBareReturn));
  for (const record of records) for (const method of record.methods.values()) {
    const result = checker.getReturnTypeOfSignature(checker.getSignatureFromDeclaration(method.node));
    if (!(result.flags & ts.TypeFlags.Void) && (!alwaysReturns(method.node.body) || hasBareReturn(method.node.body))) fail(method.node,
      "Value-returning class methods must return a concrete value on every path; undefined method results are not supported",
      "return an explicit scalar or instance on every path, or use a void method only as a statement");
  }
  // The heap has no JavaScript undefined sentinel. Prove every declared field
  // is initialized before exposing the completed instance, and diagnose the
  // common forward-read case instead of making its reserved zero observable.
  for (const record of records) {
    const initialized = new Set();
    const requireField = (node, key, state) => {
      if (record.fields.has(key) && !state.has(key)) fail(node,
        "Class field " + JSON.stringify(key) + " is read before initialization; undefined field values are not supported",
        "initialize the field earlier or assign it before reading it in the constructor");
    };
    const thisField = node => (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
      && unwrap(node.expression)?.kind === ts.SyntaxKind.ThisKeyword ? accessName(node) : null;
    const expression = (node, state, active = new Set()) => {
      if (!node || ts.isTypeNode(node)) return;
      if (ts.isFunctionLike(node)) return;
      if (ts.isBinaryExpression(node) && [ts.SyntaxKind.AmpersandAmpersandToken,
        ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)) {
        expression(node.left, state, active);
        expression(node.right, new Set(state), active);
        return;
      }
      if (ts.isConditionalExpression(node)) {
        expression(node.condition, state, active);
        const yes = new Set(state), no = new Set(state);
        expression(node.whenTrue, yes, active);
        expression(node.whenFalse, no, active);
        for (const key of yes) if (no.has(key)) state.add(key);
        return;
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
        && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && thisField(unwrap(node.left)) !== null) {
        const key = thisField(unwrap(node.left));
        if (node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) requireField(node.left, key, state);
        expression(node.right, state, active);
        if (![ts.SyntaxKind.AmpersandAmpersandEqualsToken, ts.SyntaxKind.BarBarEqualsToken,
          ts.SyntaxKind.QuestionQuestionEqualsToken].includes(node.operatorToken.kind)) state.add(key);
        return;
      }
      if (ts.isCallExpression(node)) {
        const callee = unwrap(node.expression);
        if (ts.isArrowFunction(callee) || ts.isFunctionExpression(callee)) {
          for (const arg of node.arguments) expression(arg, state, active);
          if (ts.isBlock(callee.body)) statement(callee.body, state, active);
          else expression(callee.body, state, active);
          return;
        }
        const key = thisField(callee);
        const method = key === null ? null : record.methods.get(key);
        if (method) {
          for (const arg of node.arguments) expression(arg, state, active);
          if (!active.has(method)) {
            const next = new Set(active).add(method);
            const local = new Set(state), exits = [];
            if (!statement(method.node.body, local, next, exits)) exits.push(local);
            for (const key of record.fields.keys()) if (exits.length && exits.every(exit => exit.has(key))) state.add(key);
          }
          return;
        }
      }
      const key = thisField(node);
      if (key !== null) { requireField(node, key, state); return; }
      if (node.kind === ts.SyntaxKind.ThisKeyword && [...record.fields.keys()].some(name => !state.has(name))) fail(node,
        "An instance cannot escape before its fields are initialized in class stage 1",
        "initialize all fields before passing this to another function or storing an alias");
      ts.forEachChild(node, child => expression(child, state, active));
    };
    const statement = (node, state, active = new Set(), exits = []) => {
      if (ts.isBlock(node)) {
        for (const child of node.statements) if (statement(child, state, active, exits)) return true;
        return false;
      }
      if (ts.isIfStatement(node)) {
        expression(node.expression, state, active);
        const yes = new Set(state), no = new Set(state);
        const yesReturns = statement(node.thenStatement, yes, active, exits);
        const noReturns = node.elseStatement ? statement(node.elseStatement, no, active, exits) : false;
        const continuing = yesReturns ? no : noReturns ? yes : null;
        for (const key of continuing ?? yes) if (continuing || no.has(key)) state.add(key);
        return yesReturns && noReturns;
      }
      // Loops may run zero times: their reads still need initialized fields,
      // but assignments alone cannot prove initialization after the loop.
      if (ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node)
        || ts.isWhileStatement(node) || ts.isDoStatement(node) || ts.isSwitchStatement(node)
        || ts.isTryStatement(node)) {
        expression(node, new Set(state), active);
        return false;
      }
      if (ts.isReturnStatement(node) && !active.size) {
        const missing = [...record.fields.keys()].find(name => !state.has(name));
        if (missing !== undefined) fail(node, "Constructor return leaves class field " + JSON.stringify(missing) + " uninitialized",
          "initialize every field before returning from the constructor");
      }
      expression(node, state, active);
      if (ts.isReturnStatement(node)) { exits.push(new Set(state)); return true; }
      return false;
    };
    for (const field of record.fields.values()) {
      if (field.parameter) continue;
      // Every JS field declaration defines its slot in declaration order, even
      // without an initializer. An earlier initializer cannot initialize a
      // later declaration by writing it before that declaration runs.
      initialized.delete(field.name);
      if (field.initializer) {
        expression(field.initializer, initialized);
        initialized.add(field.name);
      }
    }
    // A caller can supply any parameter explicitly, skipping its default.
    // Check default reads, but never use their writes to prove required fields.
    for (const parameter of record.ctor?.parameters ?? []) if (parameter.initializer) expression(parameter.initializer, new Set(initialized));
    for (const field of record.fields.values()) if (field.parameter) initialized.add(field.name);
    if (record.ctor) statement(record.ctor.body, initialized);
    for (const field of record.fields.values()) if (!initialized.has(field.name)) fail(field.node,
      "Class field " + JSON.stringify(field.name) + " must be initialized before the constructor finishes; undefined field defaults are not supported",
      "add a field initializer or assign this field on every constructor path");
  }
  const yieldingNames = new Set(["wait", "waitUntil", "ask", "askChoice", "glideTo", "glideChangeX", "glideChangeY",
    "broadcastAndWait", "tellAndWait", "syncTell", "playAudioAndWait", "say", "think", "stageDialog", "fadeVisibility", "appearWith"]);
  const canYield = (node, seen = new Set()) => {
    if (!node || seen.has(node)) return false;
    seen.add(node);
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
      if (yieldingNames.has(name)) return true;
      const declaration = checker.getResolvedSignature(node)?.declaration;
      if (canYield(declaration?.body, seen)) return true;
      if ((ts.isArrowFunction(callee) || ts.isFunctionExpression(callee)) && canYield(callee.body, seen)) return true;
    }
    return !!ts.forEachChild(node, child => canYield(child, seen));
  };
  const rejectCapture = member => {
    const aliases = new Set();
    if (member.body) walk(member.body, node => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
        && unwrap(node.initializer)?.kind === ts.SyntaxKind.ThisKeyword) aliases.add(checker.getSymbolAtLocation(node.name));
    });
    let changed = true;
    while (changed) {
      changed = false;
      if (member.body) walk(member.body, node => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && ts.isIdentifier(unwrap(node.initializer))
          && aliases.has(checker.getSymbolAtLocation(unwrap(node.initializer)))) {
          const key = checker.getSymbolAtLocation(node.name);
          if (!aliases.has(key)) { aliases.add(key); changed = true; }
        }
      });
    }
    const scan = node => {
      if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) {
        let usesThis = false;
        if (node.body) walk(node.body, child => {
          if (child.kind === ts.SyntaxKind.ThisKeyword || ts.isIdentifier(child) && aliases.has(checker.getSymbolAtLocation(child))) usesThis = true;
        });
        if (usesThis) {
          let wrapped = node;
          while (ts.isParenthesizedExpression(wrapped.parent)) wrapped = wrapped.parent;
          const call = wrapped.parent;
          const immediatelyInvoked = ts.isCallExpression(call) && call.expression === wrapped;
          const inlineWarp = ts.isCallExpression(call) && ts.isIdentifier(call.expression)
            && call.expression.text === "warp" && call.arguments.includes(wrapped);
          if (usesThis && !ts.isArrowFunction(node)) fail(node,
            "A function expression/declaration has its own this; dynamic this binding is not supported in class stage 1",
            "use an instance method or an arrow function used immediately without yielding");
          if ((!immediatelyInvoked && !inlineWarp) || canYield(node.body)) fail(node,
            "Arrow functions/closures capturing this that can survive a yield boundary are not supported in class stage 1",
            "call an instance method directly, or use an ordinary function with an explicit instance parameter");
        }
      }
      ts.forEachChild(node, scan);
    };
    if (member.body) scan(member.body);
  };
  for (const record of records) {
    if (record.ctor) rejectCapture(record.ctor);
    for (const method of record.methods.values()) rejectCapture(method.node);
    for (const field of record.fields.values()) if (field.initializer && (ts.isArrowFunction(field.initializer) || ts.isFunctionExpression(field.initializer))) {
      fail(field.node, "Function-valued class fields are not supported in class stage 1", "declare an instance method and call it directly");
    }
  }
  walk(sourceFile, node => {
    if ((ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isParameter(node)) && node.initializer) preserveClass(node,
      checker.getTypeAtLocation(node.initializer), checker.getTypeAtLocation(node.name));
    if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) {
      const signature = checker.getSignatureFromDeclaration(node);
      if (signature) preserveClass(node.body, checker.getTypeAtLocation(node.body), checker.getReturnTypeOfSignature(signature));
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) preserveClass(node,
      checker.getTypeAtLocation(node.right), checker.getTypeAtLocation(node.left));
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.AmpersandAmpersandEqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken].includes(node.operatorToken.kind)) {
      const left = unwrap(node.left);
      if ((ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left)) && classOf(left.expression)) fail(node,
        "Logical class field assignments are not supported", "use an explicit if statement to preserve short-circuit evaluation");
    }
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) preserveClass(node,
      checker.getTypeAtLocation(node.expression), checker.getTypeAtLocation(node));
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const method = methodAccess(node);
      if (method && !directCall(node)) fail(node, "Using a class method as a value, callback, bind or call target is not supported in class stage 1", "call obj.method(args) directly, or use an ordinary function with an explicit instance parameter");
      const owner = classOf(node.expression);
      const name = accessName(node);
      if (owner && name !== null && !owner.fields.has(name) && !owner.methods.has(name)) {
        fail(node, "Runtime addition or access of undeclared class property " + JSON.stringify(name) + " is not supported", "declare and initialize the field in the class before accessing it");
      }
      if (owner && name === null) fail(node, "Dynamic class property access is not supported in class stage 1", "use a declared field or method with a literal name");
    }
    if (ts.isCallExpression(node)) {
      const signature = checker.getResolvedSignature(node);
      const method = methodAccess(node.expression);
      if (method && signature && checker.getReturnTypeOfSignature(signature).flags & ts.TypeFlags.Void) {
        let value = node;
        while (value.parent && unwrap(value.parent) === node) value = value.parent;
        if (!ts.isExpressionStatement(value.parent)) fail(node,
          "Reading a void class method result is not supported; undefined method results have no heap value",
          "call the void method as a statement or return an explicit scalar from the method");
      }
      if (signature) node.arguments.forEach((argument, i) => {
        const target = signature.parameters[i];
        if (target) preserveClass(argument, checker.getTypeAtLocation(argument), checker.getTypeOfSymbolAtLocation(target, node));
      });
      const callee = unwrap(node.expression);
      if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
        const type = checker.getTypeAtLocation(callee.expression);
        if (methodNames.has(accessName(callee)) && !classFromType(type)
          && type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Union | ts.TypeFlags.Intersection | ts.TypeFlags.TypeParameter)) {
          fail(callee, "Class method receiver needs a statically known single class; any/unknown/union receivers are not supported", "annotate the receiver with one concrete class and explicitly select union cases before calling");
        }
      }
    }
    if (ts.isNewExpression(node)) {
      const callee = unwrap(node.expression);
      if (ts.isIdentifier(callee) && callee.text === "Array" && !checker.getSymbolAtLocation(callee)?.declarations?.length) return;
      const record = bySymbol.get(checker.getSymbolAtLocation(unwrap(node.expression)));
      if (!record) fail(node, "new requires a statically known declared class in class stage 1", "call new with the concrete named class declaration");
      let owner = node.parent;
      while (owner && !ts.isFunctionLike(owner) && !ts.isSourceFile(owner)) owner = owner.parent;
      if (ts.isSourceFile(owner) && node.pos < record.node.pos) fail(node,
        "A class cannot be instantiated before its declaration (class temporal dead zone)", "move new after the class declaration");
      if (node.arguments?.some(ts.isSpreadElement)) fail(node,
        "Spread constructor arguments are not supported in class stage 1", "pass the constructor arguments explicitly");
      if ((node.arguments?.length ?? 0) > (record.ctor?.parameters.length ?? 0)) fail(node,
        "Extra constructor arguments are not supported in class stage 1", "pass only the declared constructor arguments");
      let arity = node.arguments?.length ?? 0;
      while (arity && ts.isIdentifier(unwrap(node.arguments[arity - 1])) && unwrap(node.arguments[arity - 1]).text === "undefined"
        && !checker.getSymbolAtLocation(unwrap(node.arguments[arity - 1]))?.declarations?.length) arity--;
      for (let i = 0; i < arity; i++) if (ts.isIdentifier(unwrap(node.arguments[i])) && unwrap(node.arguments[i]).text === "undefined"
        && !checker.getSymbolAtLocation(unwrap(node.arguments[i]))?.declarations?.length) fail(node.arguments[i],
        "Interior undefined constructor arguments are not supported in class stage 1", "supply a concrete argument or omit trailing arguments with defaults");
      newModes.set(node, arity);
      const signature = checker.getResolvedSignature(node);
      if (signature) (node.arguments ?? []).slice(0, arity).forEach((argument, i) => {
        const target = signature.parameters[i];
        if (target) preserveClass(argument, checker.getTypeAtLocation(argument), checker.getTypeOfSymbolAtLocation(target, node));
      });
    }
    if (ts.isReturnStatement(node) && node.expression) {
      let owner = node.parent;
      while (owner && !ts.isFunctionLike(owner)) owner = owner.parent;
      if (owner && ts.isConstructorDeclaration(owner)) fail(node, "Returning a value from a constructor is not supported in class stage 1", "assign declared fields and let new return the initialized instance");
      if (owner) {
        const signature = checker.getSignatureFromDeclaration(owner);
        if (signature) preserveClass(node, checker.getTypeAtLocation(node.expression), checker.getReturnTypeOfSignature(signature));
      }
    }
  });
  const id = name => f.createIdentifier(name);
  const assign = (target, value) => f.createExpressionStatement(f.createBinaryExpression(target, ts.SyntaxKind.EqualsToken, value));
  const property = (target, name) => f.createElementAccessExpression(target, f.createStringLiteral(name));
  const parameter = (node, self) => f.updateParameterDeclaration(node, undefined, node.dotDotDotToken,
    node.name, node.questionToken, node.type, node.initializer && ts.visitNode(node.initializer, visitor(self)));
  const edits = [];
  const helpers = [];
  const origins = new Map();
  const printer = ts.createPrinter();
  let context;
  const visitor = self => node => {
    if (node.kind === ts.SyntaxKind.ThisKeyword && self) return id(self);
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      const method = methodAccess(callee);
      if (method) return f.createCallExpression(id(method.helper), undefined,
        [ts.visitNode(callee.expression, visitor(self)), ...node.arguments.map(arg => ts.visitNode(arg, visitor(self)))]);
    }
    if (ts.isNewExpression(node)) {
      const record = bySymbol.get(checker.getSymbolAtLocation(unwrap(node.expression)));
      if (record) {
        const arity = newModes.get(node) ?? node.arguments?.length ?? 0;
        record.arities.add(arity);
        return f.createCallExpression(id(record.factory + "_" + arity), undefined,
          (node.arguments ?? []).slice(0, arity).map(arg => ts.visitNode(arg, visitor(self))));
      }
    }
    return ts.visitEachChild(node, visitor(self), context);
  };
  const placeholder = field => {
    const type = checker.getTypeAtLocation(field.node.name);
    if (type.flags & ts.TypeFlags.StringLike) return f.createStringLiteral("");
    if (type.flags & ts.TypeFlags.BooleanLike) return f.createFalse();
    if (checker.isArrayType(type) || checker.isTupleType(type)) return f.createArrayLiteralExpression();
    // References are private allocation slots until initialized by the factory.
    const zero = f.createNumericLiteral(0);
    if (type.flags & ts.TypeFlags.Object) return f.createAsExpression(f.createAsExpression(zero,
      f.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword)), field.type);
    return zero;
  };
  const result = ts.transform(sourceFile, [transformationContext => {
    context = transformationContext;
    const visit = node => {
      if (ambient(node)) return node;
      if (ts.isClassDeclaration(node)) {
        const record = byDeclaration.get(node);
        const classType = f.createTypeReferenceNode(record.name, undefined);
        const fields = [...record.fields.values()];
        const declaration = f.createInterfaceDeclaration(
          node.modifiers?.filter(m => m.kind === ts.SyntaxKind.ExportKeyword),
          record.name, undefined, undefined, fields.map(field => f.createPropertySignature(
            undefined, f.createStringLiteral(field.name), undefined, field.type)));
        const makeFunction = (name, parameters, type, statements) => f.createFunctionDeclaration(
          undefined, undefined, name, undefined, parameters, type, f.createBlock(statements, true));
        const replaceBareReturn = child => {
          if (ts.isFunctionLike(child)) return child;
          if (ts.isReturnStatement(child) && !child.expression) return f.createReturnStatement(f.createNumericLiteral(0));
          return ts.visitEachChild(child, replaceBareReturn, context);
        };
        for (const method of record.methods.values()) {
          origins.set(method.helper, { file: input, offset: method.node.getStart(sourceFile) });
          const receiver = f.createParameterDeclaration(undefined, undefined, record.self, undefined, classType);
          let body = ts.visitNode(method.node.body, visitor(record.self));
          const signature = checker.getSignatureFromDeclaration(method.node);
          const inferredReturn = checker.getReturnTypeOfSignature(signature);
          const returnType = method.node.type?.kind === ts.SyntaxKind.ThisType ? classType : method.node.type ?? (inferredReturn.isThisType ? classType
            : checker.typeToTypeNode(inferredReturn, undefined, ts.NodeBuilderFlags.NoTruncation));
          const returnsVoid = !!(inferredReturn.flags & ts.TypeFlags.Void);
          if (returnsVoid) body = ts.visitNode(body, replaceBareReturn);
          const statements = Array.from(body.statements);
          if (returnsVoid) statements.push(f.createReturnStatement(f.createNumericLiteral(0)));
          helpers.push(makeFunction(method.helper, [receiver, ...method.node.parameters.map(node => parameter(node, record.self))],
            returnsVoid ? f.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword) : returnType, statements));
        }
        // Record all new sites before emitting arity-specific allocation
        // wrappers. Constructor defaults must run after fields (as in JS),
        // rather than being evaluated as arguments before allocation.
        walk(sourceFile, child => {
          if (ts.isNewExpression(child) && bySymbol.get(checker.getSymbolAtLocation(unwrap(child.expression))) === record) {
            record.arities.add(newModes.get(child) ?? child.arguments?.length ?? 0);
          }
        });
        if (!record.arities.size) record.arities.add(record.ctor?.parameters.length ?? 0);
        const instance = id(record.self);
        const constructor = record.ctor;
        const allocation = f.createVariableStatement(undefined, f.createVariableDeclarationList([
          f.createVariableDeclaration(instance, undefined, classType, f.createObjectLiteralExpression(
            fields.map(field => f.createPropertyAssignment(f.createStringLiteral(field.name), placeholder(field))))),
        ], ts.NodeFlags.Const));
        const initialization = [];
        for (const field of fields) if (field.initializer) initialization.push(assign(property(instance, field.name), ts.visitNode(field.initializer, visitor(record.self))));
        const constructorName = fresh(record.name + "_constructor");
        for (const arity of record.arities) {
          origins.set(record.factory + "_" + arity, { file: input, offset: node.getStart(sourceFile) });
          origins.set(constructorName + "_" + arity, { file: input, offset: (constructor ?? node).getStart(sourceFile) });
          const forwarded = Array.from({ length: arity }, (_, i) => fresh(record.name + "_arg" + i));
          const statements = [allocation, ...initialization];
          if (constructor) {
            const body = [];
            for (const omitted of constructor.parameters.slice(arity)) {
              if (!omitted.initializer) fail(omitted,
                "Omitted constructor parameters need a concrete default; undefined parameter values are not supported",
                "provide every constructor argument or add a default initializer");
              body.push(f.createVariableStatement(undefined, f.createVariableDeclarationList([
                f.createVariableDeclaration(omitted.name, undefined, omitted.type, ts.visitNode(omitted.initializer, visitor(record.self))),
              ], ts.NodeFlags.Let)));
            }
            for (const field of fields) if (field.parameter) body.push(assign(property(instance, field.name), id(field.parameter.name.text)));
            body.push(...ts.visitNode(ts.visitNode(constructor.body, visitor(record.self)), replaceBareReturn).statements);
            body.push(f.createReturnStatement(f.createNumericLiteral(0)));
            helpers.push(makeFunction(constructorName + "_" + arity,
              [f.createParameterDeclaration(undefined, undefined, record.self, undefined, classType),
                ...constructor.parameters.slice(0, arity).map(node => f.updateParameterDeclaration(node, undefined,
                  node.dotDotDotToken, node.name, undefined, node.type, undefined))],
              f.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword), body));
            statements.push(f.createExpressionStatement(f.createCallExpression(id(constructorName + "_" + arity), undefined,
              [instance, ...forwarded.map(id)])));
          }
          statements.push(f.createReturnStatement(instance));
          helpers.push(makeFunction(record.factory + "_" + arity, forwarded.map((name, i) => f.createParameterDeclaration(undefined,
            undefined, name, undefined, constructor?.parameters[i]?.type ?? typeOf(constructor?.parameters[i]?.name ?? node.name))), classType, statements));
        }
        edits.push({ start: node.getStart(sourceFile), end: node.end, text: printer.printNode(ts.EmitHint.Unspecified, declaration, sourceFile) });
        return node;
      }
      if (ts.isCallExpression(node) && methodAccess(unwrap(node.expression)) || ts.isNewExpression(node)) {
        const replacement = visitor(null)(node);
        edits.push({ start: node.getStart(sourceFile), end: node.end, text: printer.printNode(ts.EmitHint.Expression, replacement, sourceFile) });
        return replacement;
      }
      return ts.visitEachChild(node, visit, context);
    };
    return root => ts.visitNode(root, visit);
  }]);
  try {
    if (!edits.length) return sourceFile;
    const selected = [];
    for (const edit of edits.sort((a, b) => a.start - b.start || b.end - a.end)) {
      if (!selected.length || edit.start >= selected.at(-1).end) selected.push(edit);
    }
    let text = sourceFile.text;
    for (const edit of selected.reverse()) {
      const original = text.slice(edit.start, edit.end);
      const lines = original.match(/\n/g)?.length ?? 0;
      const compact = edit.text.replace(/\r?\n\s*/g, " ");
      text = text.slice(0, edit.start) + compact.padEnd(lines ? 0 : original.length, " ")
        + "\n".repeat(lines) + text.slice(edit.end);
    }
    text += "\n" + helpers.map(helper => printer.printNode(ts.EmitHint.Unspecified, helper, sourceFile)).join("\n") + "\n";
    const output = ts.createSourceFile(sourceFile.fileName, text, sourceFile.languageVersion, true, sourceFile.scriptKind);
    classSourceOrigins.set(output, origins);
    return output;
  } finally { result.dispose(); }
}
