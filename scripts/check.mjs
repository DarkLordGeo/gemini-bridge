// Harmless self-test WITHOUT Gemini: starts mac-agent directly and calls its tools.
//   npm run check              → automatic checks (no dialogs)
//   npm run check -- --dialog  → also shows ONE approval dialog so you can see how approval looks
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const withDialog = process.argv.includes("--dialog");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(root, "dist", "index.js")],
  env: { ...process.env },
  stderr: "inherit",
});
const client = new Client({ name: "check", version: "1.0.0" });
await client.connect(transport);

let failures = 0;
const text = (r) => r.content.map((c) => c.text).join("\n");
async function call(name, args) {
  return client.callTool({ name, arguments: args });
}
async function expectOk(label, name, args, mustInclude) {
  const r = await call(name, args);
  const t = text(r);
  const ok = !r.isError && (!mustInclude || t.includes(mustInclude));
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got: ${t.slice(0, 300)}`}`);
  return t;
}
async function expectRefused(label, name, args) {
  const r = await call(name, args);
  const t = text(r);
  const ok = r.isError === true;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}  → ${t.split("\n")[0].slice(0, 110)}`);
}

const tools = await client.listTools();
console.log(`Tools available (${tools.tools.length}): ${tools.tools.map((t) => t.name).join(", ")}\n`);

console.log("— normal actions (no approval needed) —");
await expectOk("agent_info", "agent_info", {}, "Allowed workspaces");
await expectOk("create folder hello-test", "create_directory", { path: "hello-test" }, "Created");
await expectOk("select project hello-test", "set_project", { path: "hello-test" }, "Current project");
await expectOk("create files", "write_files", {
  files: [
    { path: "hello.txt", content: "Hello from Gemini Bridge!\n" },
    { path: "src/notes.md", content: "# Notes\n\nThis folder was created by the self-test.\n" },
  ],
});
await expectOk("read file back", "read_file", { path: "hello.txt" }, "Hello from Gemini Bridge!");
await expectOk("run safe command: ls", "run_command", { command: ["ls", "-la"] }, "hello.txt");
await expectOk("get_context", "get_context", {}, "## File tree");

console.log("\n— safety checks (these MUST be refused) —");
await expectRefused("read outside workspace (/etc/hosts)", "read_file", { path: "/etc/hosts" });
await expectRefused("escape with ../../", "read_file", { path: "../../../../.zshrc" });
await expectRefused("write into home folder", "write_files", { files: [{ path: "~/evil.txt", content: "x" }] });
await expectRefused("sudo", "run_command", { command: ["sudo", "ls"] });
await expectRefused("raw shell", "run_command", { command: ["bash", "-c", "echo hi"] });
await expectRefused("rm -rf", "run_command", { command: ["rm", "-rf", "."] });
await expectRefused("curl download", "run_command", { command: ["curl", "https://example.com"] });
await expectRefused("single-string command", "run_command", { command: ["ls -la && rm x"] });

if (withDialog) {
  console.log("\n— approval dialog demo: a dialog will appear. Try 'Show full', then Approve or Deny —");
  const r = await call("write_files", { files: [{ path: "hello.txt", content: "Hello from Gemini Bridge!\nThis line was added after approval.\n" }] });
  console.log(`      result: ${text(r).split("\n")[0]}`);
}

await client.close();
console.log(`\n${failures === 0 ? "ALL CHECKS PASSED ✅" : `${failures} CHECK(S) FAILED ❌`}`);
console.log("Test files are in the 'hello-test' folder of your workspace. Log: ~/.gemini-bridge/logs/actions.jsonl");
process.exit(failures ? 1 : 0);
