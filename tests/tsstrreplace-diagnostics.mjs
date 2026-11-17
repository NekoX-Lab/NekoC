export const diagnosticCases = [
  { name: "nullable", source: 'let s: string | null = "😀";\nconsole.log(s?.replaceAll("", "X"));', line: 2, column: 13, message: /UTF-16.*nonempty constant string search/ },
  ...['"b", () => "X"', '/b/, "X"'].map((args, i) => ({
    name: `class-${i}`,
    source: `class A {\n  s: string = "abc";\n  f(): string {\n    return this.s.replace(${args});\n  }\n}\nconsole.log(new A().f());`,
    line: 4, column: 12, message: /exactly two string arguments/,
  })),
  ...["search", "replacement"].map(name => ({
    name: `surrogate-${name}`, source: `let ${name}: string = "\\uD83D";\nconsole.log("😀".replace(${name === "search" ? 'search, "X"' : '"😀", replacement'}));`,
    line: 1, column: name === "search" ? 22 : 27, message: /isolated UTF-16 surrogates.*complete Unicode/,
  })),
  { name: "template", source: 'let n = 1;\nlet replacement = `prefix${n}\\uD83D`;\nconsole.log("abc".replace("a", replacement));', line: 2, column: 29, message: /isolated UTF-16 surrogates.*complete Unicode/ },
  ...["replace", "replaceAll"].flatMap(method => ["null", "undefined"].flatMap(nil => ["search", "replacement"].map(position => ({
    name: `nullable-${method}-${nil}-${position}`,
    source: `let a: string | ${nil} = ${nil};\nconsole.log("aaba".${method}(${position === "search" ? 'a, "X"' : '"a", a'}));`,
    line: 2, column: 13, message: /without implicit conversion.*narrow null\/undefined.*String\(value\)/,
  })))),
  ...[
    ['parameter', 'function f(a: string | null): string {\n  return "abc".replace("a", a);\n}\nconsole.log(f(null));', 2, 10],
    ['class-field', 'class A {\n  value: string | null = null;\n  f(): string {\n    return "abc".replace("a", this.value);\n  }\n}\nconsole.log(new A().f());', 4, 12],
    ['array-element', 'let values: (string | undefined)[] = [undefined];\nconsole.log("abc".replaceAll("a", values[0]));', 2, 13],
    ['optional-parameter', 'function f(a?: string): string {\n  return "abc".replace("a", a);\n}\nconsole.log(f());', 2, 10],
  ].map(([name, source, line, column]) => ({ name: `nullable-${name}`, source, line, column,
    message: /without implicit conversion.*narrow null\/undefined.*String\(value\)/ })),
  ...["replace", "replaceAll"].flatMap(method => ["null", "undefined"].flatMap(nil => ["search-call", "receiver-search", "receiver-replacement"].map(mode => {
    const source = mode === "search-call"
      ? `let value: string | ${nil} = "X";\nfunction search(): string { value = ${nil}; return "a"; }\nconsole.log("aaba".${method}(search(), value));`
      : `let value: string | ${nil} = "a";\nfunction receiver(): string { value = ${nil}; return "aaba"; }\nconsole.log(receiver().${method}(${mode === "receiver-search" ? 'value, "X"' : '"a", value'}));`;
    return { name: `stale-${method}-${nil}-${mode}`, source, line: 3, column: 13,
      message: /nullable argument after intervening side effects.*stable string.*\?\?.*String\(value\)/ };
  }))),
  ...[
    ["alias", 'const obj: { value: string | null } = { value: "X" };\nconst alias = obj;\nfunction search(): string { alias.value = null; return "a"; }\nif (obj.value !== null) console.log("abc".replace(search(), obj.value));', 4, 37],
    ["between-guard-and-call", 'let value: string | null = "X";\nfunction change(): void { value = null; }\nif (value !== null) {\n  change();\n  console.log("abc".replace("a", value));\n}', 5, 15],
    ["closure", 'function outer(): string {\n  const obj: { value: string | null } = { value: "X" };\n  function search(): string { obj.value = null; return "a"; }\n  if (obj.value !== null) return "abc".replace(search(), obj.value);\n  return "skipped";\n}\nconsole.log(outer());', 4, 34],
    ["array-alias", 'let values: (string | undefined)[] = ["X"];\nconst alias = values;\nfunction search(): string { alias[0] = undefined; return "a"; }\nif (values[0] !== undefined) console.log("abc".replace(search(), values[0]));', 4, 42],
    ["late-capture", 'let value: string | null = "X";\nfunction change(): void { value = null; }\nchange();\nconst captured = value;\nconsole.log("abc".replace("a", captured));', 5, 13],
    ["loop-back-edge", 'let value: string | null = "X";\nfunction change(): void { value = null; }\nfor (let i = 0; i < 2; i++) {\n  console.log("abc".replace("a", value));\n  change();\n}', 4, 15],
  ].map(([name, source, line, column]) => ({ name: `stale-${name}`, source, line, column,
    message: /nullable argument after intervening side effects.*stable string.*\?\?.*String\(value\)/ })),
];
