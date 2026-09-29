import { execFile, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PREVIEW_DIR } from "./config.js";

export interface ApprovalRequest {
  /** Short headline, e.g. "Run command". */
  title: string;
  /** One or two lines: what will happen. */
  summary: string;
  /** Exact details: full command, full diff, full path list. */
  details: string;
  /** Warning label, e.g. "INSTALLS SOFTWARE". */
  risk?: string;
}

export interface ApprovalResult {
  approved: boolean;
  reason: string;
  previewFile: string;
}

type Mode = "dialog" | "deny" | "approve";

function mode(): Mode {
  const m = process.env.GEMINI_BRIDGE_APPROVAL;
  // "approve" exists only for the automated self-test; it is ignored unless GEMINI_BRIDGE_SELFTEST=1.
  if (m === "approve" && process.env.GEMINI_BRIDGE_SELFTEST === "1") return "approve";
  if (m === "deny") return "deny";
  return process.platform === "darwin" ? "dialog" : "deny";
}

const DIALOG_PREVIEW_CHARS = 1400;

function osascript(args: string[]): Promise<{ out: string; code: number }> {
  return new Promise((res) => {
    execFile("osascript", args, { timeout: 15 * 60 * 1000 }, (err, stdout) => {
      res({ out: String(stdout ?? ""), code: err ? 1 : 0 });
    });
  });
}

// Only one dialog at a time.
let queue: Promise<unknown> = Promise.resolve();

export function requestApproval(req: ApprovalRequest, timeoutSec: number): Promise<ApprovalResult> {
  const run = async (): Promise<ApprovalResult> => {
    mkdirSync(PREVIEW_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const previewFile = join(PREVIEW_DIR, `${stamp}.txt`);
    const full = [
      `${req.title}${req.risk ? `   [${req.risk}]` : ""}`,
      "",
      req.summary,
      "",
      "----- exact details -----",
      req.details,
      "",
    ].join("\n");
    writeFileSync(previewFile, full);

    const m = mode();
    if (m === "approve") return { approved: true, reason: "self-test auto-approve", previewFile };
    if (m === "deny") return { approved: false, reason: "no approval UI available (non-macOS or deny mode)", previewFile };

    const truncated = req.details.length > DIALOG_PREVIEW_CHARS;
    const body =
      `${req.summary}\n\n` +
      (truncated ? req.details.slice(0, DIALOG_PREVIEW_CHARS) + "\n…\n[Preview cut off — click “Show full” to see everything]" : req.details);

    // Text is passed as argv, never interpolated into the script, so it can't inject AppleScript.
    const script = [
      "on run argv",
      "activate",
      "beep",
      "set theTitle to item 1 of argv",
      "set theBody to item 2 of argv",
      "set secs to (item 3 of argv) as integer",
      'set r to display dialog theBody with title theTitle buttons {"Deny", "Show full", "Approve"} default button "Deny" cancel button "Deny" with icon caution giving up after secs',
      'if gave up of r then return "TIMEOUT"',
      "return button returned of r",
      "end run",
    ];
    const args = script.flatMap((l) => ["-e", l]);
    const title = `Gemini Bridge — ${req.title}${req.risk ? ` [${req.risk}]` : ""}`;

    for (let i = 0; i < 20; i++) {
      const { out, code } = await osascript([...args, title, body, String(timeoutSec)]);
      const answer = out.trim();
      if (code !== 0 || answer === "Deny") return { approved: false, reason: "denied by user", previewFile };
      if (answer === "TIMEOUT") return { approved: false, reason: `no answer within ${timeoutSec}s (treated as deny)`, previewFile };
      if (answer === "Approve") return { approved: true, reason: "approved by user", previewFile };
      if (answer === "Show full") {
        spawn("open", ["-a", "TextEdit", previewFile], { stdio: "ignore", detached: true }).unref();
        continue;
      }
      return { approved: false, reason: `unexpected dialog result: ${answer}`, previewFile };
    }
    return { approved: false, reason: "too many retries", previewFile };
  };
  const p = queue.then(run, run);
  queue = p.catch(() => undefined);
  return p;
}
