// Starts the MCP SuperAssistant proxy on http://localhost:3006/sse, which launches mac-agent.
// Keep this Terminal window open while you use Gemini. Stop with Ctrl+C.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cfg = join(root, "proxy-config.json");
if (!existsSync(cfg) || !existsSync(join(root, "dist", "index.js"))) {
  console.error("Not set up yet. Run:  npm run setup");
  process.exit(1);
}
const bin = join(root, "node_modules", ".bin", "mcp-superassistant-proxy");
if (!existsSync(bin)) {
  console.error("Proxy not installed. Run:  npm install");
  process.exit(1);
}

const port = process.env.PORT ?? "3006";
const args = ["--config", cfg, "--outputTransport", "sse", "--port", port, "--host", "localhost"];
// Only the Gemini page and browser extensions may talk to the proxy (other websites are refused by CORS).
// Set OPEN_CORS=1 to disable this restriction while troubleshooting.
if (process.env.OPEN_CORS !== "1") {
  args.push("--cors", "https://gemini.google.com", "/^chrome-extension:\\/\\/[a-z]{32}$/");
}

console.log(`Starting proxy → http://localhost:${port}/sse  (Ctrl+C to stop)\n`);
const child = spawn(bin, args, { stdio: "inherit", cwd: root });
child.on("exit", (code) => process.exit(code ?? 0));
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
