# supervisor-crew (Claude Code plugin)

Claude Code port of the `supervisor-oc-plugin` opencode plugin. Independent of the `.opencode`
directory — self-contained, zero npm dependencies.

## Layout

- `.claude-plugin/plugin.json` — plugin manifest, registers the `memory` MCP server.
- `mcp-server/memory-server.js` — shared crew memory (`memory_write`, `memory_search`,
  `memory_read`, `memory_forget`), stdio JSON-RPC, no dependencies. Storage is append-only JSONL
  under `.claude/memory/` in the project you run Claude Code from (`run` scope under
  `.claude/memory/runs/`, `project` scope in `.claude/memory/project.jsonl` — commit the latter).
- `agents/` — the five workers: `repository-explorer`, `advisor`, `implementer`, `reviewer`,
  `verifier`. Each is scoped to the tools its opencode counterpart had (e.g. `repository-explorer`
  and `advisor` have no `Bash`/`Edit`; `reviewer`/`verifier` cannot `Edit`).
- `commands/supervisor.md` — `/supervisor <task>`. Claude Code has no "primary agent" override, so
  the supervisor role is a slash command that puts the main thread into supervisor mode: it plans,
  writes memory briefs, and dispatches workers via the `Task` tool, but never edits or greps itself.

## Use

1. Install the plugin (`/plugin install` or point Claude Code at this directory).
2. Run `/supervisor <describe the objective>` to kick off a run.
3. The supervisor dispatches `repository-explorer`, `advisor`, `implementer`, `reviewer`, `verifier`
   as needed, coordinating exclusively through the `memory_*` MCP tools.

## Differences from the opencode original

- opencode's per-command bash allow/ask/deny rules (e.g. `implementer` may run `git diff` but not
  `git commit`) aren't expressible in Claude Code agent frontmatter. Each agent's system prompt
  states which commands are in-bounds instead; enforce via `.claude/settings.json` permissions if
  you need a hard gate.
- opencode's `supervisor` was a primary agent; here it's the `/supervisor` slash command driving the
  main thread, since Claude Code subagents are always dispatched, never the main loop.
- Memory tool provenance (`agent`, `session`) was implicit context in opencode; here each subagent's
  prompt tells it to pass its own name as the `agent` argument on every `memory_*` call.
