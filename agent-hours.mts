#!/usr/bin/env node
// agent-hours: how many hours your Claude Code agents actually worked, what an hour bought, and
// how that compares with your own pre-AI commit history. https://github.com/dested/agent-hours
//
// Reads ~/.claude/projects (every session and subagent transcript) and local git. Nothing leaves
// this machine. Runs on Node 22.18+ or Bun with no install:
//   node agent-hours.mts
//   node agent-hours.mts --repos ~/code/old-a,~/code/old-b --author "me@example.com" --before 2022-06-01
//
// An agent-hour is one agent actively working for 60 minutes: the model generating or a tool
// running. Each gap between transcript events is classified by the event that ends it:
//   your next message, or an AskUserQuestion/plan answer   → waiting on you (not counted)
//   a background-agent notification, or an idle wake-up    → waiting on agents (not counted)
//   a tool result                                          → tool time (capped at 12 min)
//   a model message                                        → model time (capped at 15 min)
//   a foreground subagent call returning                   → delegated (the subagent counts it)
// Your own hours come from commit timestamps: commits under 2 h apart form one session, plus
// 30 min before each session's first commit. Both sides count code files only and drop any
// commit that adds or removes more than 3,000 lines (imports, pastes, mass deletions).
import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";

const HELP = `agent-hours [options]
  --root DIR        transcript root, repeatable (default: $CLAUDE_CONFIG_DIR/projects or ~/.claude/projects)
  --since DATE      only transcripts that start on or after DATE (YYYY-MM-DD)
  --repos A,B,...   repos holding your own pre-AI work, for the human comparison
  --author REGEX    your commit author email(s), case-insensitive (default: git config user.email)
  --before DATE     human cutoff (default 2022-06-01, before Copilot)
  --no-git          skip looking up the agents' commits
  --json            machine-readable output`;

const { values: opt } = parseArgs({
  options: {
    root: { type: "string", multiple: true },
    since: { type: "string" },
    repos: { type: "string" },
    author: { type: "string" },
    before: { type: "string", default: "2022-06-01" },
    "no-git": { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});
if (opt.help) {
  console.log(HELP);
  process.exit(0);
}

const H = 3_600_000;
const MODEL_CAP = 15 * 60_000;
const TOOL_CAP = 12 * 60_000;
const TRIM = 3000;
const HUMAN_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode", "EnterPlanMode"]);
const DELEGATING = new Set(["Agent", "Task", "Workflow"]);
// `git commit` output ("[main 1a2b3c4] msg"), or a commit helper's "committed <sha> on <branch>: N files".
const COMMIT_RE = /\[[\w./-]+(?: \(root-commit\))? ([0-9a-f]{7,40})\] |committed ([0-9a-f]{7,40}) on [\w./-]+: \d+ file/g;
const CODE_EXT = new Set(
  ("ts tsx js jsx mjs cjs mts cts py rb go rs java kt kts swift c cc cpp cxx h hpp cs fs vb php html htm css scss sass less " +
    "vue svelte astro sql sh bash zsh ps1 lua dart scala ex exs erl clj hs ml r jl zig nim gd glsl wgsl hlsl prisma graphql " +
    "proto xaml razor cshtml m mm sol tf").split(" "),
);
const SKIP_PATH =
  /(^|\/)(bun\.lockb?|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|composer\.lock|Gemfile\.lock|poetry\.lock)$|(^|\/)(dist|build|\.next|node_modules|bower_components|out|coverage|vendor|third_party)\/|\.min\.(js|css)$|\.map$/;

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (o: Rec, k: string): string | null => {
  const v = o[k];
  return typeof v === "string" ? v : null;
};
const lineCount = (s: string | null) => (s ? s.split("\n").length : 0);
const isCode = (path: string) => !SKIP_PATH.test(path) && CODE_EXT.has(path.slice(path.lastIndexOf(".") + 1).toLowerCase());

type Ev = { k: "prompt" | "notify" | "result" | "asst"; t: number; human?: boolean; delegated?: boolean; id?: string; usesTool?: boolean };

interface Run {
  crew: boolean;
  first: number;
  last: number;
  activeMs: number;
  modelMs: number;
  /** Gaps that end in a prompt: a resumed subagent sat idle until someone wrote to it. */
  promptWaitMs: number;
  codeWritten: number;
  byWeek: Map<string, number>;
  commits: { sha: string; cwd: string }[];
}

function weekOf(t: number): string {
  const d = new Date(t);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => (isRec(b) && b.type === "text" ? (str(b, "text") ?? "") : "")).join("");
}

async function parseRun(path: string, crew: boolean): Promise<Run> {
  const events: Ev[] = [];
  const toolNames = new Map<string, string>();
  const commits: { sha: string; cwd: string }[] = [];
  let codeWritten = 0;
  let first = Infinity;
  let last = -Infinity;
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue;
    let d: unknown;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRec(d) || !isRec(d.message)) continue;
    const t = Date.parse(str(d, "timestamp") ?? "");
    if (!Number.isFinite(t)) continue;
    first = Math.min(first, t);
    last = Math.max(last, t);
    const msg = d.message;
    const content = Array.isArray(msg.content) ? msg.content : [];
    if (d.type === "assistant") {
      let usesTool = false;
      for (const b of content) {
        if (!isRec(b) || b.type !== "tool_use" || !isRec(b.input)) continue;
        usesTool = true;
        const name = str(b, "name") ?? "?";
        toolNames.set(str(b, "id") ?? "", name);
        const input = b.input;
        const file = str(input, "file_path");
        if (!file || !isCode(file.replace(/\\/g, "/"))) continue;
        if (name === "Write") codeWritten += lineCount(str(input, "content"));
        else if (name === "Edit") codeWritten += lineCount(str(input, "new_string"));
        else if (name === "MultiEdit" && Array.isArray(input.edits))
          for (const e of input.edits) if (isRec(e)) codeWritten += lineCount(str(e, "new_string"));
      }
      events.push({ k: "asst", t, id: str(msg, "id") ?? `${t}`, usesTool });
    } else if (content.some((b) => isRec(b) && b.type === "tool_result")) {
      let human = false;
      let delegated = false;
      for (const b of content) {
        if (!isRec(b) || b.type !== "tool_result") continue;
        const name = toolNames.get(str(b, "tool_use_id") ?? "") ?? "";
        if (HUMAN_TOOLS.has(name)) human = true;
        if (DELEGATING.has(name)) delegated = true;
        if (name !== "Bash") continue;
        for (const m of textOf(b.content).matchAll(COMMIT_RE)) {
          const sha = m[1] ?? m[2];
          if (sha) commits.push({ sha, cwd: str(d, "cwd") ?? "" });
        }
      }
      events.push({ k: "result", t, human, delegated: delegated && !human });
    } else if (d.isMeta !== true) {
      const text = textOf(msg.content);
      if (text.includes("<task-notification>")) events.push({ k: "notify", t });
      else if (!text.startsWith("<local-command-")) events.push({ k: "prompt", t });
    }
  }
  let activeMs = 0;
  let modelMs = 0;
  let promptWaitMs = 0;
  const byWeek = new Map<string, number>();
  const work = (from: number, ms: number) => {
    activeMs += ms;
    byWeek.set(weekOf(from), (byWeek.get(weekOf(from)) ?? 0) + ms);
  };
  // A message queued mid-turn is written late with its enqueue time, so timestamps can step back.
  // Measure every gap from the latest time seen, or that stretch is counted twice.
  let cursor = events[0]?.t ?? 0;
  for (let i = 1; i < events.length; i++) {
    const prev = events[i - 1];
    const next = events[i];
    if (!prev || !next) continue;
    const from = cursor;
    const gap = Math.max(0, next.t - from);
    cursor = Math.max(cursor, next.t);
    if (next.k === "prompt") promptWaitMs += gap;
    if (next.k === "prompt" || next.k === "notify") continue;
    if (next.k === "asst") {
      // A finished message followed by a new one: a background event woke the agent. Idle, not work.
      if (prev.k === "asst" && prev.id !== next.id && !prev.usesTool) continue;
      modelMs += Math.min(gap, MODEL_CAP);
      work(from, Math.min(gap, MODEL_CAP));
    } else if (!next.human && !next.delegated) work(from, Math.min(gap, TOOL_CAP));
  }
  return { crew, first, last, activeMs, modelMs, promptWaitMs, codeWritten, byWeek, commits };
}

function listTranscripts(root: string): { path: string; crew: boolean }[] {
  const out: { path: string; crew: boolean }[] = [];
  const walk = (dir: string, crew: boolean) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      const p = join(dir, n);
      if (n.endsWith(".jsonl")) out.push({ path: p, crew });
      else if (!n.includes(".") && statSync(p).isDirectory()) walk(p, crew || n === "subagents");
    }
  };
  walk(root, false);
  return out;
}

const git = (args: string[]): string | null => {
  try {
    return execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
};

interface Stat {
  ts: number;
  added: number;
  removed: number;
}
/** `--numstat` output with a `>sha<TAB>unix<TAB>email` header per commit → code lines per commit. */
function numstat(out: string, keep: (email: string) => boolean): Map<string, Stat> {
  const stats = new Map<string, Stat>();
  let cur: Stat | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith(">")) {
      const [sha, at, email] = line.slice(1).split("\t");
      cur = sha && keep(email ?? "") && !stats.has(sha) ? { ts: Number(at) * 1000, added: 0, removed: 0 } : null;
      if (cur && sha) stats.set(sha, cur);
    } else if (cur) {
      const [a, r, p] = line.split("\t");
      if (!p || a === "-" || !isCode(p)) continue;
      cur.added += Number(a) || 0;
      cur.removed += Number(r) || 0;
    }
  }
  return stats;
}
const typed = (s: Stat) => s.added <= TRIM && s.removed <= TRIM;

function sessionsHours(ts: number[], gapMin: number, leadMin: number): number {
  const sorted = [...ts].sort((a, b) => a - b);
  let ms = 0;
  let start = sorted[0] ?? 0;
  let prev = start;
  for (const t of sorted.slice(1)) {
    if (t - prev > gapMin * 60_000) {
      ms += prev - start + leadMin * 60_000;
      start = t;
    }
    prev = t;
  }
  if (sorted.length) ms += prev - start + leadMin * 60_000;
  return ms / H;
}

const quant = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0;
};
const r1 = (n: number) => Math.round(n * 10) / 10;

// ── Agents ───────────────────────────────────────────────────────────────────
const base = process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, "projects") : join(homedir(), ".claude", "projects");
const roots = (opt.root ?? [base]).map((r) => resolve(r));
const files = roots.flatMap(listTranscripts);
if (!files.length) {
  console.error(`No transcripts under ${roots.join(", ")}. Pass --root <dir>.`);
  process.exit(1);
}
const since = opt.since ? Date.parse(opt.since) : -Infinity;
const runs: Run[] = [];
for (const [i, f] of files.entries()) {
  if (!opt.json && i % 250 === 0) process.stderr.write(`\rparsing ${i}/${files.length} transcripts`);
  if (statSync(f.path).mtimeMs < since) continue;
  const r = await parseRun(f.path, f.crew);
  if (Number.isFinite(r.first) && r.first >= since) runs.push(r);
}
if (!opt.json) process.stderr.write("\r\x1b[K");

const lead = runs.filter((r) => !r.crew);
const crew = runs.filter((r) => r.crew && r.activeMs > 0);
const sumH = (rs: Run[], f: (r: Run) => number) => rs.reduce((s, r) => s + f(r), 0) / H;
const activeH = sumH(runs, (r) => r.activeMs);
const leadH = sumH(lead, (r) => r.activeMs);
const crewH = sumH(crew, (r) => r.activeMs);
const crewWallH = sumH(crew, (r) => r.last - r.first - r.promptWaitMs);
const written = runs.reduce((s, r) => s + r.codeWritten, 0);

const byMonth = new Map<string, { leadH: number; crewH: number; briefs: number[] }>();
for (const r of runs) {
  const m = new Date(r.first).toISOString().slice(0, 7);
  const b = byMonth.get(m) ?? { leadH: 0, crewH: 0, briefs: [] };
  if (r.crew) {
    b.crewH += r.activeMs / H;
    if (r.activeMs > 0) b.briefs.push(r.activeMs / H);
  } else b.leadH += r.activeMs / H;
  byMonth.set(m, b);
}
const months = [...byMonth].sort(([a], [b]) => a.localeCompare(b)).map(([month, b]) => ({
  month,
  leadAH: Math.round(b.leadH),
  crewAH: Math.round(b.crewH),
  subagents: b.briefs.length,
  briefMeanAH: r1(b.briefs.reduce((s, x) => s + x, 0) / Math.max(1, b.briefs.length)),
  briefMedianMin: Math.round(quant(b.briefs, 0.5) * 60),
}));

// Committed lines, from runs that committed their own work (git commit output in a Bash result).
let landed: { runs: number; activeH: number; commits: number; netPerAH: number; addedPerAH: number } | null = null;
if (!opt["no-git"]) {
  const top = new Map<string, string | null>();
  const toplevel = (cwd: string) => {
    if (!top.has(cwd)) top.set(cwd, cwd && existsSync(cwd) ? (git(["-C", cwd, "rev-parse", "--show-toplevel"])?.trim() ?? null) : null);
    return top.get(cwd) ?? null;
  };
  const wanted = new Map<string, Set<string>>();
  for (const r of runs) for (const c of r.commits) {
    const repo = toplevel(c.cwd);
    if (repo) wanted.set(repo, (wanted.get(repo) ?? new Set()).add(c.sha));
  }
  // Transcripts show abbreviated shas: key every commit by its first 7 characters.
  const stats = new Map<string, Stat>();
  const key = (repo: string, sha: string) => `${repo}\t${sha.slice(0, 7)}`;
  for (const [repo, shas] of wanted) {
    const list = [...shas];
    for (let i = 0; i < list.length; i += 200) {
      const out = git(["-C", repo, "log", "--no-walk=unsorted", "--ignore-missing", "--numstat", "--format=>%H%x09%ct%x09%ae", ...list.slice(i, i + 200)]);
      if (out) for (const [sha, s] of numstat(out, () => true)) stats.set(key(repo, sha), s);
    }
  }
  const find = (repo: string, sha: string) => stats.get(key(repo, sha));
  const seen = new Set<Stat>();
  let net = 0;
  let added = 0;
  let ms = 0;
  let n = 0;
  for (const r of runs) {
    const mine = r.commits.map((c) => {
      const repo = toplevel(c.cwd);
      return repo ? find(repo, c.sha) : undefined;
    });
    if (!mine.some(Boolean) || r.codeWritten === 0) continue;
    n++;
    ms += r.activeMs;
    for (const s of mine) {
      if (!s || seen.has(s)) continue;
      seen.add(s);
      if (!typed(s)) continue;
      net += s.added - s.removed;
      added += s.added;
    }
  }
  if (ms > 0) landed = { runs: n, activeH: Math.round(ms / H), commits: seen.size, netPerAH: Math.round(net / (ms / H)), addedPerAH: Math.round(added / (ms / H)) };
}

// ── You, before AI ───────────────────────────────────────────────────────────
let human: { repos: number; commits: number; first: string; last: string; hours: number; netPerH: number; addedPerH: number; keep: number; range: [number, number] } | null = null;
if (opt.repos) {
  const email = opt.author ?? git(["config", "user.email"])?.trim() ?? "";
  if (!email) {
    console.error("No --author and no git config user.email: pass --author <your email regex>.");
    process.exit(1);
  }
  const author = new RegExp(opt.author ?? email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const all = new Map<string, Stat>();
  let repos = 0;
  for (const raw of opt.repos.split(",").filter(Boolean)) {
    const repo = resolve(raw.trim().replace(/^~(?=$|[\\/])/, homedir()));
    const out = git(["-C", repo, "log", "--all", "--no-merges", `--before=${opt.before}`, "--numstat", "--format=>%H%x09%at%x09%ae"]);
    if (out === null) {
      console.error(`skipped ${repo}: not a git repo`);
      continue;
    }
    const mine = numstat(out, (e) => author.test(e));
    if (mine.size) repos++;
    for (const [sha, s] of mine) if (!all.has(sha)) all.set(sha, s);
  }
  const cs = [...all.values()];
  const keepers = cs.filter(typed);
  const net = keepers.reduce((s, c) => s + c.added - c.removed, 0);
  const added = keepers.reduce((s, c) => s + c.added, 0);
  const ts = cs.map((c) => c.ts);
  const hours = sessionsHours(ts, 120, 30);
  const rates = [sessionsHours(ts, 60, 15), sessionsHours(ts, 120, 60)].map((h) => Math.round(net / h));
  if (hours > 0)
    human = {
      repos,
      commits: cs.length,
      first: new Date(Math.min(...ts)).toISOString().slice(0, 10),
      last: new Date(Math.max(...ts)).toISOString().slice(0, 10),
      hours: Math.round(hours),
      netPerH: Math.round(net / hours),
      addedPerH: Math.round(added / hours),
      keep: Math.round((net / Math.max(1, added)) * 100),
      range: [Math.min(...rates), Math.max(...rates)],
    };
}

// ── Report ───────────────────────────────────────────────────────────────────
const result = {
  transcripts: runs.length,
  from: new Date(Math.min(...runs.map((r) => r.first))).toISOString().slice(0, 10),
  to: new Date(Math.max(...runs.map((r) => r.last))).toISOString().slice(0, 10),
  activeAH: Math.round(activeH),
  leadAH: Math.round(leadH),
  subagentAH: Math.round(crewH),
  subagents: crew.length,
  subagentBusyPct: Math.round((crewH / Math.max(crewWallH, 1e-9)) * 100),
  modelPct: Math.round((sumH(runs, (r) => r.modelMs) / Math.max(activeH, 1e-9)) * 100),
  leadPerSubagentAH: r1(leadH / Math.max(crewH, 1e-9)),
  codeWrittenPerAH: Math.round(written / Math.max(activeH, 1e-9)),
  landed,
  human,
  agentVsHumanNet: landed && human ? r1(landed.netPerAH / Math.max(1, human.netPerH)) : null,
  months,
};
if (opt.json) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}
const p = (label: string, value: string) => console.log(`${label.padEnd(34)}${value}`);
console.log(`\nAgent-hours, ${result.from} → ${result.to} (${result.transcripts} transcripts)\n`);
p("Active agent-hours", `${result.activeAH} (${result.leadAH} in your sessions, ${result.subagentAH} in ${result.subagents} subagents)`);
p("Subagents busy while alive", `${result.subagentBusyPct}%`);
p("Model vs tools", `${result.modelPct}% / ${100 - result.modelPct}%`);
p("Lead hours per subagent hour", `${result.leadPerSubagentAH}`);
p("Code lines written per AH", `${result.codeWrittenPerAH} (Edit/Write only)`);
if (landed) p("Committed code per AH", `${landed.netPerAH} net, ${landed.addedPerAH} added (${landed.commits} commits, ${landed.runs} runs)`);
console.log("\nBy month");
console.table(months);
if (human) {
  console.log(`\nYou before ${opt.before}: ${human.commits} commits in ${human.repos} repos, ${human.first} → ${human.last}`);
  p("Coding hours (2 h gap + 30 min)", `${human.hours}`);
  p("Committed code per hour", `${human.netPerH} net, ${human.addedPerH} added (${human.range[0]}–${human.range[1]} net across session rules)`);
  p("Kept of what you added", `${human.keep}%`);
  if (landed) {
    p("Agent-hour vs your hour", `${result.agentVsHumanNet}× net, ${r1(landed.addedPerAH / Math.max(1, human.addedPerH))}× added`);
    p("Agents kept of what they added", `${Math.round((landed.netPerAH / Math.max(1, landed.addedPerAH)) * 100)}%`);
  }
} else console.log("\nAdd --repos <your pre-AI repos> --author <your email> for the human comparison.");
