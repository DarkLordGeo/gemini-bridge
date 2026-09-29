# Gemini Bridge

A small, approval-gated local agent that lets the **Gemini web chat** (gemini.google.com, your normal Pro subscription — no API key) create files, edit projects, and run approved commands on your Mac.

```
Gemini web chat ──(MCP SuperAssistant extension: reads visible replies, detects tool calls)
      │  http://localhost:3006/sse
      ▼
MCP SuperAssistant proxy  (npm package, runs in Terminal)
      │  stdio
      ▼
mac-agent (this repo): workspace guard → command policy → macOS approval dialog → action log
```

## Quick start (macOS)

```bash
cd ~/gemini-bridge
npm install
npm run setup      # creates ~/.gemini-bridge/config.json and ~/Desktop/Gemini-Projects
npm run check      # harmless self-test, no Gemini needed
npm run check -- --dialog   # also shows one approval dialog
npm start          # keep this Terminal window open while using Gemini
```

Then in Chrome: install **MCP SuperAssistant** from the Chrome Web Store, open gemini.google.com, click the server status in the MCP sidebar, enter `http://localhost:3006/sse` (transport: SSE), Connect, press **Insert** on the MCP button, and paste `prompts/gemini-instructions.md` as your first message.

## What needs your approval (native macOS dialog, default button = Deny)

| Action | Behaviour |
|---|---|
| Create folders / new files inside a workspace | runs directly |
| Overwrite or edit an existing file | dialog with a diff |
| Delete / replace | dialog; items are moved to the Trash, never `rm` |
| Read/write `.env`, keys, credentials | dialog (contents would go to Google) |
| `ls`, `git status/diff/log`, `git init/add`, version checks | runs directly |
| `npm install`, `npx`, `pip install`, `brew install` | dialog marked INSTALLS SOFTWARE |
| `git commit/reset/checkout/push…`, any other program | dialog |
| `sudo`, shells, `rm`, `curl`, `osascript`, system settings tools… | always refused |
| Anything outside `workspaces` (symlinks included) | always refused |

Unanswered dialogs are denied after `approvalTimeoutSec` (50 s — the extension gives up on a tool call after 60 s).

Every call is logged to `~/.gemini-bridge/logs/actions.jsonl`; full approval previews are saved in `~/.gemini-bridge/previews/`.

## Config — `~/.gemini-bridge/config.json`

```json
{
  "workspaces": ["/Users/YOU/Desktop/Gemini-Projects"],
  "approveOverwrites": true,
  "approvalTimeoutSec": 50,
  "commandTimeoutSec": 120,
  "maxOutputChars": 20000,
  "extraSafeCommands": [["npm", "test"], ["npm", "run", "build"]],
  "notesFile": "PROJECT_NOTES.md"
}
```

Restart `npm start` after editing it.

## Files

```
src/index.ts      MCP server + all tools
src/paths.ts      workspace guard (resolves symlinks) + sensitive-file rules
src/commands.ts   command policy (blocked / safe / needs approval) + runner (no shell)
src/approval.ts   macOS approval dialog (osascript, text passed as argv)
src/context.ts    file tree + text search (never follows symlinks)
src/diff.ts       line diff for approval previews
src/log.ts        JSONL action log
src/config.ts     config + state paths
scripts/setup.mjs writes config + proxy-config.json with absolute paths
scripts/start.mjs starts the proxy on localhost:3006 with CORS limited to Gemini + extensions
scripts/check.mjs self-test
prompts/gemini-instructions.md   paste into Gemini once per chat
```
