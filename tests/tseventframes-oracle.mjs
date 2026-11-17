import { readFileSync } from "node:fs";
import ts from "typescript";
import vm from "node:vm";

// Node executes the same lexical bindings and array/object operations. Replace
// cooperative waits with generators and use deterministic logical deadlines;
// no wall clock assertions or browser scheduling claims enter these tests.
export function eventOracle(name) {
  const source = readFileSync(`tests/fixtures/tseventframes-${name}.ts`, "utf8");
  const file = ts.createSourceFile("event.ts", source, ts.ScriptTarget.Latest, true);
  const transform = ts.transform(file, [context => {
    const f = context.factory;
    const visit = node => {
      if (ts.isCallExpression(node)) {
        const name = node.expression.getText(file);
        if (name === "wait") return f.createYieldExpression(undefined, ts.visitNode(node.arguments[0], visit));
        // Each callback becomes a generator, allowing wait to suspend its JS
        // activation. Synchronous array callbacks contain no wait in fixtures.
        if (["onMessage", "onStart", "setTimeout", "setInterval"].includes(name)) {
          return f.updateCallExpression(node, node.expression, node.typeArguments, node.arguments.map(arg => {
            if (!ts.isArrowFunction(arg) && !ts.isFunctionExpression(arg)) return ts.visitNode(arg, visit);
            const body = ts.visitNode(arg.body, visit);
            return f.createFunctionExpression(undefined, f.createToken(ts.SyntaxKind.AsteriskToken), undefined,
              undefined, arg.parameters, undefined, ts.isBlock(body) ? body : f.createBlock([f.createExpressionStatement(body)]));
          }));
        }
      }
      return ts.visitEachChild(node, visit, context);
    };
    return node => ts.visitNode(node, visit);
  }]);
  const javascript = ts.transpileModule(ts.createPrinter().printFile(transform.transformed[0]), {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText;
  transform.dispose();
  const logs = [], handlers = new Map(), starts = [], pending = [], variables = new Map();
  let now = 0, order = 0;
  const enqueue = (iterator, delay = 0) => pending.push({ iterator, at: now + Math.max(delay, 1 / 60), order: order++ });
  const stopped = {};
  vm.runInNewContext(javascript, {
    console: { log: (...args) => logs.push(args.map(String).join(" ")) },
    onStart: callback => starts.push(callback),
    onMessage: (name, callback) => handlers.set(name, callback),
    broadcast: name => enqueue(handlers.get(name)()),
    setTimeout: (callback, ms) => enqueue(callback(), ms / 1000),
    setInterval: (callback, ms) => enqueue(callback(), ms / 1000),
    setVar: (key, value) => variables.set(key, value),
    getVar: key => variables.get(key),
    changeVar: (key, value) => variables.set(key, variables.get(key) + value),
    stop: () => { throw stopped; },
  });
  starts.forEach(callback => enqueue(callback()));
  while (pending.length) {
    pending.sort((a, b) => a.at - b.at || a.order - b.order);
    const next = pending.shift();
    now = next.at;
    try {
      const result = next.iterator.next();
      if (!result.done) enqueue(next.iterator, result.value);
    } catch (error) { if (error !== stopped) throw error; }
  }
  return logs;
}

if (process.argv[1]?.endsWith("tseventframes-oracle.mjs")) console.log(JSON.stringify(eventOracle(process.argv[2])));
