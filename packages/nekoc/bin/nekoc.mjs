#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { compileFile, CompileError, compileErrorDiagnostics, formatDiagnostic } from "../dist/frontend/compile-ts.mjs";
import { compile, check, createPlayer, importProject } from "../index.mjs";
import { decodeFrame } from "../frame.mjs";

try {
  const [command, input, ...args] = process.argv.slice(2);
  if (!input || !["check", "build", "run"].includes(command)) {
    throw new Error("Usage: nekoc check <file> [--json] [--target=kitten-n|kitten4] | build <file> [-o out.bcmkn] [--target=kitten-n|kitten4] | run <file.bcmkn> [--frames N]");
  }
  if (command === "run") {
    if (args.some((arg, i) => i !== 0 && i !== 1) || (args.length && args[0] !== "--frames")) throw new Error("Unknown run option");
    const frames = args.length ? Number(args[1]) : 60;
    if (!Number.isSafeInteger(frames) || frames < 0) throw new Error("--frames must be a non-negative integer");
    const { project } = importProject(fs.readFileSync(input, "utf8"));
    const player = createPlayer(project);
    try {
      for (let i = 0; i < frames; i++) {
        for (const log of decodeFrame(player.handle({ dt: 1 / 60, budget_ms: 16 })).logs ?? []) {
          console.log(typeof log === "string" ? log : JSON.stringify(log));
        }
      }
    } finally { player.free(); }
  } else {
    const targetArgs = args.filter(arg => arg.startsWith("--target="));
    if (targetArgs.length > 1) throw new Error("Specify --target only once");
    const target = targetArgs[0]?.slice("--target=".length) ?? "kitten-n";
    const options = args.filter(arg => !arg.startsWith("--target="));
    // Discover imports using the same frontend resolver, without directory walks.
    const files = {};
    try { compileFile(path.resolve(input), { readFile(name) {
      try { const text = fs.readFileSync(name, "utf8"); files[name] = text; return text; } catch { return undefined; }
    } }, { target }); } catch (error) { if (!(error instanceof CompileError) || command !== "check") throw error; }
    const entry = path.resolve(input).replace(/^[A-Za-z]:/, "").replaceAll("\\", "/");
    const normalized = Object.fromEntries(Object.entries(files).map(([name, text]) => [name.replace(/^[A-Za-z]:/, "").replaceAll("\\", "/"), text]));
    if (command === "check") {
      if (options.some((arg) => arg !== "--json")) throw new Error("Unknown check option");
      const result = check(entry, { files: normalized, target });
      console.log(args.includes("--json") ? JSON.stringify(result) : result.ok ? `${input}: ok` : result.diagnostics.map(formatDiagnostic).join("\n"));
      process.exitCode = result.ok ? 0 : 1;
    } else {
      if (options.length && (options[0] !== "-o" || options.length !== 2)) throw new Error("Expected -o out.bcmkn");
      const { bcmkn } = compile(entry, { files: normalized, target });
      const output = options[1] ?? input.replace(/\.[^.]+$/, "") + ".bcmkn";
      fs.writeFileSync(output, JSON.stringify(bcmkn));
      console.log(output);
    }
  }
} catch (error) {
  if (error instanceof CompileError) {
    compileErrorDiagnostics(error).forEach((d) => console.error(formatDiagnostic(d)));
  } else console.error(error?.message ?? String(error));
  process.exitCode = 1;
}
