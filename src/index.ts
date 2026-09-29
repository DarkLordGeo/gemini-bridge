#!/usr/bin/env node
/**
 * Gemini Bridge — mac-agent
 * A small MCP server (stdio) that gives the Gemini web chat a SAFE execution layer on macOS:
 * workspace-restricted files, validated commands, native approval dialogs, and an action log.
 * It is launched by the MCP SuperAssistant proxy; the browser extension talks to the proxy.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CONFIG_PATH, LOG_PATH, loadConfig, loadState, saveState } from "./config.js";
import { PathGuard, isSensitive } from "./paths.js";
import { requestApproval, type ApprovalRequest } from "./approval.js";
import { logAction, recentActions } from "./log.js";
import { classify, runCommand } from "./commands.js";
import { fileTree, searchText } from "./context.js";
import { unifiedDiff } from "./diff.js";

const cfg = loadConfig();
for (const w of cfg.workspaces) mkdirSync(w, { recursive: true });
const state = loadState();
const guard = new PathGuard(cfg.workspaces, () => state.currentProject);
if (state.currentProject && !existsSync(state.currentProject)) delete state.currentProject;

class Denied extends Error {}
class Blocked extends Error {}

const clip = (s: string, max = cfg.maxOutputChars) =>
  s.length > max ? `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]` : s;

async function gate(req: ApprovalRequest): Promise<string> {
  const r = await requestApproval(req, cfg.approvalTimeoutSec);
  if (!r.approved) throw new Denied(`${r.reason}`);
  return r.reason;
}

function requireProject(): string {
  if (!state.currentProject) throw new Error("No project selected. Call set_project (or create_directory then set_project) first.");
  return state.currentProject;
}

function readText(p: string): string {
  const buf = readFileSync(p);
  if (buf.subarray(0, 8000).includes(0)) throw new Error(`${basename(p)} looks like a binary file; not reading it.`);
  return buf.toString("utf8");
}

const server = new McpServer(
  { name: "mac-agent", version: "0.1.0" },
  {
    instructions:
      "Local macOS execution layer. Call get_context before planning changes. Only paths inside the allowed workspaces work. " +
      "Deletes, overwrites, installs and most commands pop up an approval dialog for the user; if a result says DENIED, do not retry — ask the user.",
  },
);

type Shape = Record<string, z.ZodTypeAny>;
function tool<S extends Shape>(
  name: string,
  description: string,
  shape: S,
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<string>,
) {
  server.registerTool(name, { description, inputSchema: shape }, (async (args: z.infer<z.ZodObject<S>>) => {
    try {
      const text = await handler(args);
      logAction({ tool: name, args, outcome: "ok", detail: text.slice(0, 200) });
      return { content: [{ type: "text" as const, text: clip(text) }] };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (e instanceof Denied) {
        logAction({ tool: name, args, outcome: "denied", detail: msg });
        return {
          content: [{ type: "text" as const, text: `DENIED: ${msg}. Nothing was changed. Do not retry this action; ask the user how to proceed.` }],
          isError: true,
        };
      }
      const blocked = e instanceof Blocked || msg.startsWith("BLOCKED");
      logAction({ tool: name, args, outcome: blocked ? "blocked" : "error", detail: msg });
      return { content: [{ type: "text" as const, text: `${blocked ? "" : "ERROR: "}${msg}` }], isError: true };
    }
  }) as never);
}

// ---------------------------------------------------------------- info & context

tool("agent_info", "Show allowed workspaces, the current project, and the safety rules. Call this first in a new chat.", {}, async () => {
  return [
    `Allowed workspaces: ${guard.workspaceRoots.join(", ")}`,
    `Current project: ${state.currentProject ?? "(none — use set_project)"}`,
    "",
    "Rules:",
    "- Relative paths are relative to the current project. Paths outside the workspaces are refused.",
    "- Creating new files/folders: allowed. Overwriting/editing existing files: needs user approval" + (cfg.approveOverwrites ? "." : " (currently disabled in config)."),
    "- delete_path moves to the macOS Trash and always needs approval.",
    "- run_command takes an argv array (no shell, no pipes). Read-only commands run directly; installs and most programs need approval; admin/system/network tools are blocked.",
    "- Secrets (.env, keys) need approval to read, because their content would be sent to Gemini.",
  ].join("\n");
});

tool(
  "set_project",
  "Select the project folder all relative paths refer to. The folder must exist inside an allowed workspace.",
  { path: z.string().describe("Absolute path, ~/..., or a folder name inside the first workspace") },
  async ({ path }) => {
    // A bare name like "my-app" means <first workspace>/my-app.
    const input = path.startsWith("/") || path.startsWith("~") ? path : join(guard.workspaceRoots[0], path);
    const p = guard.resolve(input);
    if (!existsSync(p) || !statSync(p).isDirectory()) throw new Error(`Folder does not exist: ${p}. Create it with create_directory first.`);
    state.currentProject = p;
    saveState(state);
    return `Current project is now ${p}`;
  },
);

function git(args: string[], cwd: string): Promise<string> {
  return runCommand(["git", ...args], cwd, 20, cfg.maxOutputChars).then((r) => (r.exitCode === 0 ? r.stdout : ""));
}

tool(
  "get_context",
  "Everything needed before planning work: project path, notes file, file tree, git status and diff, and the most recent agent actions.",
  {
    treeDepth: z.number().int().min(1).max(8).optional().describe("Default 4"),
    includeDiff: z.boolean().optional().describe("Include the full git diff (default true)"),
  },
  async ({ treeDepth, includeDiff }) => {
    const project = requireProject();
    const parts: string[] = [`# Project: ${project}`];
    const notesPath = join(project, cfg.notesFile);
    parts.push(`\n## Notes (${cfg.notesFile})\n${existsSync(notesPath) ? clip(readText(notesPath), 6000) : "(none yet — use save_note to record decisions)"}`);
    const tree = fileTree(project, treeDepth ?? 4, 400);
    parts.push(`\n## File tree\n${tree.text}${tree.truncated ? "\n…(tree truncated)" : ""}`);
    if (existsSync(join(project, ".git"))) {
      parts.push(`\n## Git status\n${(await git(["status", "--short", "--branch"], project)) || "(clean)"}`);
      parts.push(`\n## Recent commits\n${(await git(["log", "--oneline", "-n", "8"], project)) || "(no commits)"}`);
      if (includeDiff !== false) {
        const diff = await git(["diff", "--no-ext-diff"], project);
        parts.push(`\n## Uncommitted diff\n${diff ? clip(diff, 8000) : "(none)"}`);
      }
    } else {
      parts.push("\n## Git\n(not a git repository)");
    }
    const acts = recentActions(15)
      .map((a) => `${a.ts.slice(0, 19)}  ${a.tool}  ${a.outcome}${a.detail ? `  — ${a.detail.split("\n")[0].slice(0, 100)}` : ""}`)
      .join("\n");
    parts.push(`\n## Recent agent actions\n${acts || "(none)"}`);
    return parts.join("\n");
  },
);

tool(
  "save_note",
  "Append a decision/plan note to the project's notes file so it survives across chats.",
  { text: z.string().min(1) },
  async ({ text }) => {
    const project = requireProject();
    const p = join(project, cfg.notesFile);
    const header = existsSync(p) ? "" : `# Project notes\n\n`;
    appendFileSync(p, `${header}## ${new Date().toISOString().slice(0, 16).replace("T", " ")}\n${text.trim()}\n\n`);
    return `Saved to ${p}`;
  },
);

// ---------------------------------------------------------------- read

tool(
  "list_dir",
  "List a folder as a tree (skips node_modules, .git, build output).",
  { path: z.string().optional().describe("Default: current project"), depth: z.number().int().min(1).max(8).optional() },
  async ({ path, depth }) => {
    const p = guard.resolve(path ?? requireProject());
    if (!existsSync(p) || !statSync(p).isDirectory()) throw new Error(`Not a folder: ${p}`);
    const t = fileTree(p, depth ?? 2, 500);
    return `${p}\n${t.text}${t.truncated ? "\n…(truncated)" : ""}`;
  },
);

tool(
  "read_file",
  "Read a text file (optionally a line range).",
  {
    path: z.string(),
    startLine: z.number().int().min(1).optional(),
    endLine: z.number().int().min(1).optional(),
  },
  async ({ path, startLine, endLine }) => {
    const p = guard.resolve(path);
    if (!existsSync(p)) throw new Error(`Not found: ${p}`);
    if (isSensitive(p)) {
      await gate({
        title: "Read a sensitive file",
        risk: "MAY CONTAIN SECRETS",
        summary: `Gemini wants to read ${p}.\nIts contents will be sent to Google.`,
        details: p,
      });
    }
    const text = readText(p);
    if (!startLine && !endLine) return text;
    const lines = text.split("\n");
    const s = (startLine ?? 1) - 1;
    const e = endLine ?? lines.length;
    return lines.slice(s, e).map((l, i) => `${s + i + 1}: ${l}`).join("\n");
  },
);

tool(
  "search_files",
  "Case-insensitive text search across the project (file names and contents).",
  { query: z.string().min(2), path: z.string().optional() },
  async ({ query, path }) => {
    const root = guard.resolve(path ?? requireProject());
    const hits = searchText(root, query, 100);
    return hits.length ? hits.join("\n") : "No matches.";
  },
);

// ---------------------------------------------------------------- write

tool(
  "create_directory",
  "Create a folder (and parents). Safe: no approval needed.",
  { path: z.string() },
  async ({ path }) => {
    const p = guard.resolve(path);
    mkdirSync(p, { recursive: true });
    return `Created ${p}`;
  },
);

tool(
  "write_files",
  "Create or replace one or more text files in ONE step (ideal for scaffolding a project). New files are created directly; replacing existing files shows the user a diff and needs approval.",
  {
    files: z
      .array(z.object({ path: z.string(), content: z.string() }))
      .min(1)
      .max(60),
  },
  async ({ files }) => {
    const resolved = files.map((f) => ({ ...f, abs: guard.resolve(f.path) }));
    const overwrites = resolved.filter((f) => existsSync(f.abs));
    const sensitive = resolved.filter((f) => isSensitive(f.abs));
    for (const f of overwrites) if (statSync(f.abs).isDirectory()) throw new Error(`${f.abs} is a folder, not a file.`);
    const changed = overwrites.filter((f) => readFileSync(f.abs, "utf8") !== f.content);
    if ((cfg.approveOverwrites && changed.length) || sensitive.length) {
      const details = [
        ...resolved.filter((f) => !existsSync(f.abs)).map((f) => `NEW   ${f.abs}  (${f.content.split("\n").length} lines)`),
        "",
        ...changed.map((f) => unifiedDiff(readFileSync(f.abs, "utf8"), f.content, f.abs)),
      ].join("\n");
      await gate({
        title: changed.length ? "Overwrite existing files" : "Write sensitive files",
        risk: sensitive.length ? "SENSITIVE FILE" : "OVERWRITES",
        summary: `${resolved.length - overwrites.length} new file(s), ${changed.length} changed existing file(s).`,
        details,
      });
    }
    const out: string[] = [];
    for (const f of resolved) {
      const existed = existsSync(f.abs);
      mkdirSync(dirname(f.abs), { recursive: true });
      writeFileSync(f.abs, f.content);
      out.push(`${existed ? "updated" : "created"} ${f.abs}`);
    }
    return out.join("\n");
  },
);

tool(
  "edit_file",
  "Edit an existing text file by exact find/replace. Each 'find' must match exactly once. Shows the user a diff for approval.",
  {
    path: z.string(),
    edits: z.array(z.object({ find: z.string().min(1), replace: z.string() })).min(1).max(50),
  },
  async ({ path, edits }) => {
    const p = guard.resolve(path);
    if (!existsSync(p)) throw new Error(`Not found: ${p}. Use write_files to create it.`);
    const before = readText(p);
    let after = before;
    for (const [i, e] of edits.entries()) {
      const count = after.split(e.find).length - 1;
      if (count !== 1) throw new Error(`Edit #${i + 1}: 'find' text matched ${count} times (must be exactly 1). Nothing was changed. Read the file and use a longer, unique snippet.`);
      after = after.replace(e.find, () => e.replace);
    }
    if (cfg.approveOverwrites || isSensitive(p)) {
      await gate({
        title: "Edit file",
        risk: isSensitive(p) ? "SENSITIVE FILE" : "MODIFIES FILE",
        summary: `${edits.length} change(s) to ${p}`,
        details: unifiedDiff(before, after, p),
      });
    }
    writeFileSync(p, after);
    return `Edited ${p} (${edits.length} change(s)).`;
  },
);

tool(
  "move_path",
  "Move or rename a file/folder inside the workspace. Needs approval only if the destination already exists.",
  { from: z.string(), to: z.string() },
  async ({ from, to }) => {
    const a = guard.resolve(from);
    const b = guard.resolve(to);
    if (!existsSync(a)) throw new Error(`Not found: ${a}`);
    if (guard.isWorkspaceRoot(a)) throw new Blocked("BLOCKED: cannot move a workspace root.");
    if (existsSync(b)) {
      await gate({ title: "Move and REPLACE", risk: "OVERWRITES", summary: `${b} already exists and will be replaced.`, details: `${a}\n  →\n${b}` });
      moveToTrash(b);
    }
    mkdirSync(dirname(b), { recursive: true });
    renameSync(a, b);
    return `Moved ${a} → ${b}`;
  },
);

function moveToTrash(p: string): string {
  const trash = join(homedir(), ".Trash");
  mkdirSync(trash, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = join(trash, `${basename(p)} (gemini-bridge ${stamp})`);
  renameSync(p, target);
  return target;
}

tool(
  "delete_path",
  "Delete a file or folder by moving it to the macOS Trash (recoverable). Always needs approval.",
  { path: z.string() },
  async ({ path }) => {
    const p = guard.resolve(path);
    if (!existsSync(p)) throw new Error(`Not found: ${p}`);
    if (guard.isWorkspaceRoot(p)) throw new Blocked("BLOCKED: cannot delete a workspace root.");
    const isDir = statSync(p).isDirectory();
    const listing = isDir ? fileTree(p, 3, 200).text : `${statSync(p).size} bytes`;
    await gate({ title: "Delete", risk: "DELETES", summary: `Move ${isDir ? "folder" : "file"} to Trash:\n${p}`, details: `${p}\n\n${listing}` });
    const t = moveToTrash(p);
    return `Moved to Trash: ${t}`;
  },
);

// ---------------------------------------------------------------- commands

tool(
  "run_command",
  'Run ONE program with arguments, e.g. ["git","status"] or ["npm","test"]. No shell: pipes, &&, >, $VARS do not work. Runs in the current project unless cwd is given. Read-only commands run immediately; installs and most programs ask the user; admin/system/network tools are refused.',
  {
    command: z.array(z.string()).min(1).describe('argv array, e.g. ["npm","run","build"]'),
    cwd: z.string().optional(),
  },
  async ({ command, cwd }) => {
    const dir = guard.resolve(cwd ?? requireProject());
    if (command.length === 1 && /\s/.test(command[0])) {
      throw new Error('Pass the command as an argv array, e.g. ["npm","run","build"], not a single string.');
    }
    const v = classify(command, cfg.extraSafeCommands);
    if (v.kind === "blocked") throw new Blocked(`BLOCKED: ${v.reason}`);
    let approval = "auto (safe command)";
    if (v.kind === "approve") {
      approval = await gate({
        title: v.label,
        risk: v.risk,
        summary: `Run in ${dir}:\n\n${command.map((a) => (/[\s"'$]/.test(a) ? JSON.stringify(a) : a)).join(" ")}`,
        details: `Folder: ${dir}\nProgram: ${command[0]}\nArguments (exact, one per line):\n${command.slice(1).map((a, i) => `  [${i + 1}] ${JSON.stringify(a)}`).join("\n") || "  (none)"}\nTimeout: ${cfg.commandTimeoutSec}s`,
      });
    }
    const r = await runCommand(command, dir, cfg.commandTimeoutSec, cfg.maxOutputChars);
    return [
      `$ ${command.join(" ")}   (in ${dir}; ${approval})`,
      `exit code: ${r.exitCode}${r.timedOut ? " (killed: timeout)" : ""}`,
      r.stdout ? `--- stdout ---\n${clip(r.stdout, cfg.maxOutputChars / 2)}` : "",
      r.stderr ? `--- stderr ---\n${clip(r.stderr, cfg.maxOutputChars / 2)}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  },
);

// ---------------------------------------------------------------- open things on the Mac

tool(
  "open_path",
  "Open a file/folder on the Mac: in Finder, in VS Code, or with its default app.",
  { path: z.string().optional(), app: z.enum(["finder", "vscode", "default"]).optional() },
  async ({ path, app }) => {
    const p = guard.resolve(path ?? requireProject());
    if (process.platform !== "darwin") return `(not macOS) would open ${p}`;
    const args = app === "vscode" ? ["-a", "Visual Studio Code", p] : app === "finder" ? ["-R", p] : [p];
    spawn("open", args, { stdio: "ignore", detached: true }).unref();
    return `Opened ${p}${app ? ` (${app})` : ""}`;
  },
);

tool(
  "open_url",
  "Open an http(s) URL in the user's default browser (view only — nothing is clicked or submitted).",
  { url: z.string().url() },
  async ({ url }) => {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Blocked("BLOCKED: only http/https URLs.");
    if (process.platform !== "darwin") return `(not macOS) would open ${u.href}`;
    spawn("open", [u.href], { stdio: "ignore", detached: true }).unref();
    return `Opened ${u.href}`;
  },
);

// ---------------------------------------------------------------- start

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`[mac-agent] ready. workspaces=${cfg.workspaces.join(",")} config=${CONFIG_PATH} log=${LOG_PATH}\n`);
