#!/usr/bin/env node
// Read-only corpus scan; reports contain metadata, never third-party work bodies.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { projectBlocks } from "./kn-share-player-check.mjs";

export function frequencies(works, coverage) {
  const statuses = new Map([...coverage.matchAll(/^\| (?:\d+ \| )?`([^`]+)` \| ([^|]+) \|/gm)]
    .map(match => [match[1], match[2].trim()]));
  const counts = new Map();
  for (const { id, project } of works) {
    if (![undefined, "KN", "TANYUE_KN"].includes(project.toolType)) throw Error(`Not a KN work: ${id}`);
    // Legacy and TANYUE works have the same native workspace schema. This
    // scanner-only shallow view never changes the corpus or CLI runtime input.
    for (const { type } of projectBlocks({ ...project, toolType: "KN" })) {
      if (!counts.has(type)) counts.set(type, { type, status: statuses.get(type) ?? "清单外／需核实", occurrences: 0, works: new Set() });
      const item = counts.get(type);
      item.occurrences++;
      item.works.add(id);
    }
  }
  return [...counts.values()].map(row => ({ ...row, works: [...row.works].sort(), workCount: row.works.size }))
    .sort((a, b) => b.workCount - a.workCount || a.type.localeCompare(b.type, "en"));
}

function main() {
  const { values } = parseArgs({ options: {
    corpus: { type: "string" }, coverage: { type: "string", default: "docs/kn-block-coverage.md" },
    nekoc: { type: "string" }, out: { type: "string" }, ticks: { type: "string", default: "600" },
  } });
  if (!values.corpus || !values.out) throw Error("Usage: --corpus <KN directory> --out <dist/report.json> [--nekoc <exe>] [--coverage <md>]");
  const ticks = Number(values.ticks);
  if (!Number.isSafeInteger(ticks) || ticks < 1) throw Error("ticks must be a positive integer");
  const output = path.resolve(values.out);
  const dist = path.resolve("dist") + path.sep;
  if (!output.startsWith(dist)) throw Error("Reports must stay in this worktree's ignored dist/");
  const files = fs.readdirSync(values.corpus).filter(name => /\.(json|bcmkn)$/.test(name)).sort();
  if (!files.length) throw Error("Empty corpus");
  const works = files.map(file => {
    const source = fs.readFileSync(path.join(values.corpus, file));
    return { id: path.parse(file).name, file, sha256: createHash("sha256").update(source).digest("hex"), project: JSON.parse(source) };
  });
  if (new Set(works.map(work => work.id)).size !== works.length) throw Error("Duplicate work IDs");
  const coverage = fs.readFileSync(values.coverage, "utf8");
  const rows = frequencies(works, coverage);
  const report = { schema: "nekoc-kn-r2-corpus-v1", ticks, workCount: works.length,
    coverageSha256: createHash("sha256").update(coverage).digest("hex"),
    scope: "Static workspaces, including dormant blocks and fallback shadows; completion is not semantic parity.",
    gaps: rows.filter(row => ["部分语义", "固定值占位", "缺失"].includes(row.status)),
    outsideCatalog: rows.filter(row => row.status === "清单外／需核实"), rows, works: [] };
  for (const { id, file, sha256 } of works) {
    const row = { id, sha256 };
    if (values.nekoc) {
      const run = spawnSync(path.resolve(values.nekoc), ["run", path.resolve(values.corpus, file), "--ticks", String(ticks), "--seed", "1"],
        { encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
      row.exitCode = run.status;
      if (run.status === 0) {
        try {
          const snapshot = JSON.parse(run.stdout);
          row.ticks = snapshot.ticks;
          row.activeThreads = snapshot.active_threads;
          row.budgetYields = snapshot.budget_yields;
          row.notices = snapshot.kn_panel_notices;
          row.status = snapshot.ticks === ticks ? "completed" : "incomplete";
        } catch (error) { row.status = "invalid-output"; row.error = error.message; }
      } else {
        row.status = run.error?.code === "ETIMEDOUT" ? "timeout" : "failed";
        row.error = (run.stderr || run.error?.message || "no error detail").trim();
      }
      console.log(`${id}: ${row.status}${row.error ? `: ${row.error.split("\n")[0]}` : ""}`);
    }
    report.works.push(row);
  }
  report.completed = report.works.filter(work => work.status === "completed").length;
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ works: works.length, completed: report.completed, gaps: report.gaps.map(({ type, workCount }) => ({ type, workCount })) }, null, 2));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
