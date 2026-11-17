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
];
