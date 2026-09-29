import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { isSensitive } from "./paths.js";

export const IGNORED_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".nuxt", ".turbo", ".cache", "coverage", "__pycache__",
  ".venv", "venv", ".idea", ".DS_Store", "Pods", "DerivedData", ".gradle", "target", "out",
]);

export function fileTree(root: string, maxDepth: number, maxEntries: number): { text: string; truncated: boolean } {
  const lines: string[] = [];
  let truncated = false;
  const walk = (dir: string, depth: number, indent: string) => {
    if (lines.length >= maxEntries) {
      truncated = true;
      return;
    }
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      if (lines.length >= maxEntries) {
        truncated = true;
        return;
      }
      if (name === ".DS_Store") continue;
      const full = join(dir, name);
      let isDir = false;
      let size = 0;
      try {
        // lstat: symlinks are listed but never followed (they could point outside the workspace).
        const st = lstatSync(full);
        if (st.isSymbolicLink()) {
          lines.push(`${indent}${name}  (symlink — not followed)`);
          continue;
        }
        isDir = st.isDirectory();
        size = st.size;
      } catch {
        continue;
      }
      if (isDir) {
        const skipped = IGNORED_DIRS.has(name);
        lines.push(`${indent}${name}/${skipped ? "  (skipped)" : ""}`);
        if (!skipped && depth < maxDepth) walk(full, depth + 1, indent + "  ");
      } else {
        lines.push(`${indent}${name}  (${size < 1024 ? size + " B" : Math.round(size / 1024) + " KB"})`);
      }
    }
  };
  walk(root, 1, "");
  return { text: lines.join("\n") || "(empty folder)", truncated };
}

/** Simple recursive text search (no shell). */
export function searchText(root: string, query: string, maxHits: number): string[] {
  const hits: string[] = [];
  const q = query.toLowerCase();
  const walk = (dir: string) => {
    if (hits.length >= maxHits) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (hits.length >= maxHits) return;
      if (IGNORED_DIRS.has(name)) continue;
      const full = join(dir, name);
      if (isSensitive(full)) continue;
      let st;
      try {
        st = lstatSync(full);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(full);
      else if (st.size < 1_000_000) {
        if (name.toLowerCase().includes(q)) hits.push(`${relative(root, full)}  (file name match)`);
        let text: string;
        try {
          text = requireText(full);
        } catch {
          continue;
        }
        const lines = text.split("\n");
        for (let i = 0; i < lines.length && hits.length < maxHits; i++) {
          if (lines[i].toLowerCase().includes(q)) hits.push(`${relative(root, full)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
        }
      }
    }
  };
  walk(root);
  return hits;
}

function requireText(p: string): string {
  const buf = readFileSync(p);
  if (buf.subarray(0, 8000).includes(0)) throw new Error("binary");
  return buf.toString("utf8");
}
