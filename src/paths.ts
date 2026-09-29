import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { expandHome, HOME_DIR } from "./config.js";

/** Resolve symlinks for the longest existing part of the path, so a symlink can't point outside the workspace. */
function realish(p: string): string {
  let existing = p;
  const rest: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    rest.unshift(basename(existing));
    existing = parent;
  }
  const real = existsSync(existing) ? realpathSync(existing) : existing;
  return rest.length ? resolve(real, ...rest) : real;
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export class PathGuard {
  private roots: string[];
  constructor(workspaces: string[], private getProject: () => string | undefined) {
    this.roots = workspaces.map((w) => realish(resolve(expandHome(w))));
  }

  get workspaceRoots(): string[] {
    return [...this.roots];
  }

  /**
   * Turn user/Gemini input into a safe absolute path.
   * Relative paths are relative to the current project. Throws if the result is outside every workspace.
   */
  resolve(input: string): string {
    if (!input || typeof input !== "string") throw new Error("Path is required.");
    if (input.includes("\0")) throw new Error("Invalid path.");
    let p = expandHome(input.trim());
    if (!isAbsolute(p)) {
      // Relative to the current project, or to the first workspace if no project is selected yet.
      p = resolve(this.getProject() ?? this.roots[0], p);
    }
    const real = realish(resolve(p));
    if (isInside(real, HOME_DIR)) throw new Error("The agent's own config/log folder is off-limits.");
    if (!this.roots.some((r) => isInside(real, r))) {
      throw new Error(
        `BLOCKED: "${real}" is outside the allowed workspaces (${this.roots.join(", ")}). Ask the user to add the folder to ~/.gemini-bridge/config.json if needed.`,
      );
    }
    return real;
  }

  isWorkspaceRoot(p: string): boolean {
    return this.roots.includes(p);
  }

  display(p: string): string {
    for (const r of this.roots) if (isInside(p, r)) return p.replace(r, `<${basename(r)}>`) || p;
    return p;
  }
}

const SENSITIVE = [
  /(^|\/)\.env(\.|$)/i,
  /\.(pem|key|p12|pfx|keychain|kdbx)$/i,
  /(^|\/)id_(rsa|ed25519|ecdsa|dsa)/i,
  /(^|\/)\.(npmrc|netrc|pypirc)$/i,
  /(^|\/)\.git\/(config|hooks\/)/,
  /(^|\/)\.ssh\//,
  /credentials|secrets?\.(json|ya?ml|toml)$/i,
];

/** Files whose contents may be secrets (reading sends them to Google) or whose change can run code. */
export function isSensitive(p: string): boolean {
  const norm = p.split(sep).join("/");
  return SENSITIVE.some((re) => re.test(norm));
}
