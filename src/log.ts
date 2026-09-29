import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { LOG_PATH } from "./config.js";

export interface LogEntry {
  ts: string;
  tool: string;
  args: unknown;
  outcome: "ok" | "error" | "denied" | "blocked";
  detail?: string;
  approval?: string;
  previewFile?: string;
}

function shorten(v: unknown): unknown {
  if (typeof v === "string") return v.length > 300 ? `${v.slice(0, 300)}… (${v.length} chars)` : v;
  if (Array.isArray(v)) return v.map(shorten);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shorten(x)]));
  return v;
}

export function logAction(e: Omit<LogEntry, "ts">): void {
  mkdirSync(dirname(LOG_PATH), { recursive: true });
  const entry: LogEntry = { ts: new Date().toISOString(), ...e, args: shorten(e.args) };
  appendFileSync(LOG_PATH, JSON.stringify(entry) + "\n");
}

export function recentActions(n: number): LogEntry[] {
  if (!existsSync(LOG_PATH)) return [];
  const lines = readFileSync(LOG_PATH, "utf8").trim().split("\n").filter(Boolean);
  return lines.slice(-n).map((l) => JSON.parse(l) as LogEntry);
}
