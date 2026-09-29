// One-time setup: creates ~/.gemini-bridge/config.json, the workspace folder, and proxy-config.json
// (the file the MCP SuperAssistant proxy reads to launch the agent).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const home = process.env.GEMINI_BRIDGE_HOME ?? join(homedir(), ".gemini-bridge");
const configPath = join(home, "config.json");

mkdirSync(home, { recursive: true });
if (!existsSync(configPath)) {
  const cfg = {
    workspaces: [join(homedir(), "Desktop", "Gemini-Projects")],
    approveOverwrites: true,
    approvalTimeoutSec: 50,
    commandTimeoutSec: 120,
    maxOutputChars: 20000,
    extraSafeCommands: [],
    notesFile: "PROJECT_NOTES.md",
  };
  writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n");
  console.log(`✔ Created ${configPath}`);
} else {
  console.log(`✔ Kept existing ${configPath}`);
}
const cfg = JSON.parse(readFileSync(configPath, "utf8"));
for (const w of cfg.workspaces) {
  const p = w.startsWith("~/") ? join(homedir(), w.slice(2)) : w;
  mkdirSync(p, { recursive: true });
  console.log(`✔ Workspace folder: ${p}`);
}

// Absolute paths, because the proxy starts the agent from its own working directory.
const proxyConfig = {
  mcpServers: {
    "mac-agent": {
      command: process.execPath,
      args: [join(root, "dist", "index.js")],
    },
  },
};
writeFileSync(join(root, "proxy-config.json"), JSON.stringify(proxyConfig, null, 2) + "\n");
console.log(`✔ Wrote ${join(root, "proxy-config.json")}`);
console.log(`  (agent will run with: ${process.execPath} ${join(root, "dist", "index.js")})`);
console.log("\nSetup complete. Next:  npm run check   then   npm start");
