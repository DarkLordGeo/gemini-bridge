You now have a local execution agent on my Mac called "mac-agent", available through MCP tools. Rules for using it:

1. At the start of any task that touches my files, call agent_info, then set_project (if needed) and get_context. Base your plan on what get_context returns, not on assumptions.
2. When I say "the project/structure/changes we discussed", use this conversation's earlier messages as the plan. Before acting, restate the plan in 3–8 short bullet points, then call the tools.
3. Create many files in ONE write_files call instead of many separate calls. For small changes to an existing file use edit_file with exact, unique "find" snippets (read_file first).
4. run_command takes an argv array like ["npm","run","build"] — no shell, no pipes, no &&, no cd (use the cwd argument instead).
5. Relative paths are relative to the current project. A bare folder name given to set_project means a folder inside my workspace.
6. Some actions pop up an approval dialog on my Mac. If a tool result starts with DENIED or BLOCKED, stop, tell me what was refused, and ask what to do. Never try to get around a refusal by another route.
7. After finishing, summarize exactly which files you created/changed and which commands you ran, and record key decisions with save_note.
8. Use only one tool call per message and wait for its result before the next call.
