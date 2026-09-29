import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Everything the agent stores lives here — OUTSIDE any workspace, so Gemini can never edit it. */
export const HOME_DIR = process.env.GEMINI_BRIDGE_HOME ?? join(homedir(), ".gemini-bridge");
export const CONFIG_PATH = join(HOME_DIR, "config.json");
export const STATE_PATH = join(HOME_DIR, "state.json");
export const LOG_PATH = join(HOME_DIR, "logs", "actions.jsonl");
export const PREVIEW_DIR = join(HOME_DIR, "previews");

export interface Config {
  /** Only paths inside these folders can be read or written. */
  workspaces: string[];
  /** Ask before overwriting/editing an existing file (recommended: true). */
  approveOverwrites: boolean;
  /** Seconds before an unanswered approval dialog counts as "Deny". */
  approvalTimeoutSec: number;
  /** Seconds before a running command is killed. */
  commandTimeoutSec: number;
  /** Max characters of output returned to Gemini per tool call. */
  maxOutputChars: number;
  /** Extra command prefixes that may run WITHOUT approval, e.g. [["npm","test"]]. */
  extraSafeCommands: string[][];
  /** Name of the notes file kept in each project root. */
  notesFile: string;
}

export const DEFAULT_CONFIG: Config = {
  workspaces: [join(homedir(), "Desktop", "Gemini-Projects")],
  approveOverwrites: true,
  approvalTimeoutSec: 50,
  commandTimeoutSec: 120,
  maxOutputChars: 20000,
  extraSafeCommands: [],
  notesFile: "PROJECT_NOTES.md",
};

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

export function loadConfig(): Config {
  mkdirSync(HOME_DIR, { recursive: true });
  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
  }
  const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<Config>;
  const cfg: Config = { ...DEFAULT_CONFIG, ...raw };
  cfg.workspaces = cfg.workspaces.map(expandHome);
  if (cfg.workspaces.length === 0) throw new Error(`No workspaces configured in ${CONFIG_PATH}`);
  return cfg;
}

interface State {
  currentProject?: string;
}

export function loadState(): State {
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8")) as State;
  } catch {
    return {};
  }
}

export function saveState(s: State): void {
  mkdirSync(HOME_DIR, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(s, null, 2) + "\n");
}
