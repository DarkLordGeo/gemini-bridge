import { spawn } from "node:child_process";

export type Verdict =
  | { kind: "safe"; label: string }
  | { kind: "approve"; label: string; risk: string }
  | { kind: "blocked"; reason: string };

/** Never run, even with approval. The user can run these by hand in Terminal if really needed. */
const BLOCKED: Record<string, string> = {
  sudo: "admin rights", su: "admin rights", doas: "admin rights",
  sh: "raw shell", bash: "raw shell", zsh: "raw shell", fish: "raw shell", dash: "raw shell", csh: "raw shell", tcsh: "raw shell",
  env: "can run arbitrary programs", xargs: "can run arbitrary programs", eval: "raw shell", exec: "raw shell", nohup: "background process",
  rm: "use the delete_path tool (moves to Trash with approval)", rmdir: "use delete_path", unlink: "use delete_path", shred: "destructive",
  dd: "disk access", mkfs: "disk format", diskutil: "disk management", fdisk: "disk management", hdiutil: "disk images",
  shutdown: "system power", reboot: "system power", halt: "system power", pmset: "system power",
  launchctl: "system services", defaults: "system settings", systemsetup: "system settings", networksetup: "system settings",
  scutil: "system settings", csrutil: "system security", spctl: "system security", security: "keychain access",
  tccutil: "privacy permissions", softwareupdate: "system updates", crontab: "scheduled jobs", at: "scheduled jobs",
  osascript: "desktop automation (not enabled yet)", open: "use open_path / open_url tools",
  ssh: "remote access", scp: "remote access", sftp: "remote access", rsync: "remote copy", nc: "raw network", ncat: "raw network",
  telnet: "raw network", ftp: "raw network", curl: "network download — ask the user to run it manually", wget: "network download",
  chown: "ownership change", passwd: "accounts", dscl: "accounts", sysadminctl: "accounts",
  killall: "kills processes", pkill: "kills processes", kill: "kills processes", mail: "sends email", sendmail: "sends email",
};

/** Program + leading args that run without a dialog (read-only or trivially reversible). */
const SAFE_PREFIXES: string[][] = [
  ["pwd"], ["ls"], ["tree"], ["wc"], ["head"], ["tail"], ["cat"], ["grep"], ["rg"], ["which"], ["file"], ["du"], ["date"], ["echo"],
  ["git", "status"], ["git", "diff"], ["git", "log"], ["git", "show"], ["git", "branch", "--list"], ["git", "branch", "-a"],
  ["git", "rev-parse"], ["git", "ls-files"], ["git", "init"], ["git", "add"], ["git", "stash", "list"], ["git", "remote", "-v"],
  ["node", "--version"], ["node", "-v"], ["npm", "--version"], ["npm", "-v"], ["npm", "ls"], ["npx", "--version"],
  ["python3", "--version"], ["pip3", "--version"], ["pip3", "list"], ["tsc", "--version"], ["brew", "--version"], ["brew", "list"],
];

const INSTALL_PATTERNS: string[][] = [
  ["npm", "install"], ["npm", "i"], ["npm", "ci"], ["npm", "add"], ["npm", "update"], ["npm", "uninstall"], ["npm", "remove"],
  ["npm", "exec"], ["npx"], ["pnpm", "add"], ["pnpm", "install"], ["pnpm", "i"], ["pnpm", "dlx"], ["yarn", "add"], ["yarn", "install"], ["yarn"],
  ["bun", "add"], ["bun", "install"], ["bunx"], ["pip", "install"], ["pip3", "install"], ["python3", "-m", "pip"], ["brew", "install"],
  ["brew", "upgrade"], ["brew", "uninstall"], ["gem", "install"], ["cargo", "install"], ["go", "install"], ["pipx"], ["uv", "add"], ["uv", "pip"],
];

const GIT_REMOTE = ["push", "pull", "fetch", "clone", "remote"];
const GIT_DESTRUCTIVE = ["reset", "clean", "checkout", "restore", "rebase", "merge", "cherry-pick", "revert", "stash", "branch", "tag", "rm", "mv", "switch", "commit", "config", "filter-branch", "gc", "prune", "reflog"];

/** Args that turn otherwise-safe commands into writers/executors. */
const DANGEROUS_ARG = /^(-c$|-C$|--output|--exec|--upload-pack|--receive-pack|--ext-diff|--config|-exec$|-delete$|-ok$|--pre=|--pre$)/;

function startsWith(argv: string[], prefix: string[]): boolean {
  return prefix.length <= argv.length && prefix.every((p, i) => argv[i] === p);
}

function argsStayLocal(args: string[]): boolean {
  // Relative paths only; no absolute paths, home paths or parent-directory escapes in auto-run commands.
  return args.every((a) => !a.startsWith("/") && !a.startsWith("~") && !a.split("/").includes("..") && !DANGEROUS_ARG.test(a));
}

export function classify(argv: string[], extraSafe: string[][]): Verdict {
  if (argv.length === 0 || !argv[0]) return { kind: "blocked", reason: "empty command" };
  const prog = argv[0];
  if (prog.includes("/")) {
    return { kind: "blocked", reason: "run programs by name (e.g. \"npm\"), not by path" };
  }
  if (BLOCKED[prog]) return { kind: "blocked", reason: `"${prog}" is not allowed (${BLOCKED[prog]}).` };
  if (argv.some((a) => a.includes("\0"))) return { kind: "blocked", reason: "invalid characters" };

  if (prog === "find" && argv.some((a) => /^-(exec|execdir|delete|ok|okdir|fprint)/.test(a))) {
    return { kind: "blocked", reason: "find with -exec/-delete is not allowed" };
  }

  if (INSTALL_PATTERNS.some((p) => startsWith(argv, p))) {
    return { kind: "approve", label: "Install / download software", risk: "INSTALLS SOFTWARE" };
  }

  if (prog === "git") {
    const sub = argv[1] ?? "";
    if (GIT_REMOTE.includes(sub)) return { kind: "approve", label: `git ${sub} (talks to a remote server)`, risk: "NETWORK / REMOTE" };
    if (GIT_DESTRUCTIVE.includes(sub) && !SAFE_PREFIXES.some((p) => startsWith(argv, p))) {
      return { kind: "approve", label: `git ${sub} (changes history or files)`, risk: "CHANGES GIT STATE" };
    }
  }

  const safe = [...SAFE_PREFIXES, ...extraSafe].some((p) => startsWith(argv, p));
  if (safe && argsStayLocal(argv.slice(1))) return { kind: "safe", label: "read-only / low-risk command" };

  return { kind: "approve", label: "Run a program in the project", risk: "RUNS CODE" };
}

export interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function runCommand(argv: string[], cwd: string, timeoutSec: number, maxChars: number): Promise<RunResult> {
  return new Promise((res) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      shell: false,
      env: { ...process.env, CI: "1", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", PAGER: "cat" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const cap = (s: string, add: string) => (s.length > maxChars * 2 ? s : s + add);
    child.stdout.on("data", (d) => (stdout = cap(stdout, String(d))));
    child.stderr.on("data", (d) => (stderr = cap(stderr, String(d))));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3000);
    }, timeoutSec * 1000);
    child.on("error", (e) => {
      clearTimeout(timer);
      res({ exitCode: null, stdout, stderr: stderr + String(e.message), timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      res({ exitCode: code, stdout, stderr, timedOut });
    });
  });
}
