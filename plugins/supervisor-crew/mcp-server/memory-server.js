#!/usr/bin/env node
/**
 * Shared memory MCP server for the supervisor/worker crew.
 *
 * Exposes four tools over stdio: memory_write, memory_search, memory_read, memory_forget.
 * Zero third-party dependencies — implements just enough of the MCP stdio JSON-RPC
 * protocol to serve these tools.
 *
 * Design notes:
 *  - Append-only JSONL. Subagents may run concurrently; append is safe, rewrite is not.
 *    Updates and deletes are appended as partial revisions and folded at read time
 *    (last write wins, `status: "deleted"` acts as a tombstone).
 *  - Two scopes: "run" (this delegation tree, disposable) and "project" (durable, commit it).
 *  - "run" is keyed on a CURRENT_RUN pointer file so every subagent (each its own process/session)
 *    shares the same run without needing a common session id.
 *  - Provenance (`agent`, `session`) is supplied by the caller as tool arguments, since an MCP
 *    server has no built-in notion of which subagent persona is calling it.
 *  - search returns headers only; read returns bodies. Keeps the supervisor's context small.
 */

"use strict";

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const readline = require("readline");

const KINDS = ["task", "handoff", "finding", "decision", "convention", "risk", "artifact"];
const SCOPES = ["run", "project"];
const MAX_BODY = 8000;

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const SESSION_ID = `sess-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

/* ------------------------------------------------------------------ paths */

function memRoot() {
  return path.join(PROJECT_DIR, ".claude", "memory");
}

async function currentRun(rotate) {
  const pointer = path.join(memRoot(), "CURRENT_RUN");
  if (!rotate) {
    try {
      const id = (await fsp.readFile(pointer, "utf8")).trim();
      if (id) return id;
    } catch {
      /* fall through and create one */
    }
  }
  const id = `run-${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 8)}`;
  await fsp.mkdir(path.dirname(pointer), { recursive: true });
  await fsp.writeFile(pointer, id + "\n", "utf8");
  return id;
}

function logPath(scope, run) {
  return scope === "project"
    ? path.join(memRoot(), "project.jsonl")
    : path.join(memRoot(), "runs", `${run}.jsonl`);
}

/* ------------------------------------------------------------------- io */

async function readLog(file) {
  try {
    const raw = await fsp.readFile(file, "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((r) => r && r.id);
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }
}

/** Fold the append-only log into current state. */
function fold(recs) {
  const byId = new Map();
  for (const r of recs) byId.set(r.id, Object.assign({}, byId.get(r.id) || {}, r));
  return [...byId.values()].filter((r) => r.status !== "deleted");
}

async function append(file, rec) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.appendFile(file, JSON.stringify(rec) + "\n", "utf8");
}

async function load(scope, run) {
  const scopes = scope === "all" ? ["run", "project"] : [scope];
  const out = [];
  for (const s of scopes) out.push(...fold(await readLog(logPath(s, run))));
  return out;
}

/** Locate which log file already holds an id, so updates land in the right place. */
async function fileForId(id, run) {
  for (const s of ["run", "project"]) {
    const file = logPath(s, run);
    const recs = await readLog(file);
    if (recs.some((r) => r.id === id)) return file;
  }
  return null;
}

/* --------------------------------------------------------------- format */

function newId(kind) {
  return `${kind.slice(0, 4)}-${Math.random().toString(36).slice(2, 8)}`;
}

function header(r) {
  const who = r.for_agent ? `${r.agent} -> ${r.for_agent}` : r.agent;
  const tags = r.tags && r.tags.length ? `  #${r.tags.join(" #")}` : "";
  return `${r.id}  [${r.scope}/${r.kind}]  ${who}  ::  ${r.title}${tags}`;
}

function full(r) {
  const out = [];
  out.push(`--- ${r.id} ---`);
  out.push(`kind: ${r.kind}   scope: ${r.scope}   by: ${r.agent}${r.for_agent ? `   for: ${r.for_agent}` : ""}`);
  out.push(`title: ${r.title}`);
  if (r.tags && r.tags.length) out.push(`tags: ${r.tags.join(", ")}`);
  if (r.files && r.files.length) out.push(`files: ${r.files.join(", ")}`);
  out.push(`updated: ${r.updated}`);
  out.push("");
  out.push(r.body || "");
  return out.join("\n");
}

function score(r, query) {
  if (!query) return 1;
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const title = (r.title || "").toLowerCase();
  const tags = (r.tags || []).join(" ").toLowerCase();
  const files = (r.files || []).join(" ").toLowerCase();
  const body = (r.body || "").toLowerCase();
  let s = 0;
  for (const t of terms) {
    if (title.includes(t)) s += 3;
    if (tags.includes(t)) s += 2;
    if (files.includes(t)) s += 2;
    if (body.includes(t)) s += 1;
  }
  return s;
}

/* ---------------------------------------------------------------- tools */

const TOOLS = [
  {
    name: "memory_write",
    description:
      "Record or update an entry in shared crew memory. Use this to persist a plan, a brief for another " +
      "agent, a finding, a decision, or a convention. Returns the entry id — hand that id to other agents " +
      "instead of pasting content. Store pointers (file paths, line ranges, symbols), not large file contents.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "One-line summary. This is what other agents see when searching." },
        body: { type: "string", description: "The content. Markdown. Be dense; no preamble." },
        kind: {
          type: "string",
          enum: KINDS,
          description:
            "task = the overall objective | handoff = a brief for a specific agent | finding = something discovered | " +
            "decision = a choice made and why | convention = a project rule to obey | risk = a hazard | artifact = a produced thing",
        },
        scope: {
          type: "string",
          enum: SCOPES,
          default: "run",
          description: "run = scratch for this task, discarded later. project = durable, survives across sessions.",
        },
        tags: { type: "array", items: { type: "string" }, description: "Lowercase keywords for retrieval." },
        files: { type: "array", items: { type: "string" }, description: "Related repo-relative paths, optionally with :line ranges." },
        for_agent: { type: "string", description: "Target agent name when kind=handoff, e.g. 'implementer'." },
        id: { type: "string", description: "Existing entry id to revise. Omit to create a new entry." },
        new_run: {
          type: "boolean",
          default: false,
          description: "Supervisor only: start a fresh run before writing. Use once when a new objective begins.",
        },
        agent: { type: "string", description: "Your own agent/persona name (e.g. 'implementer'). Stamped as provenance." },
      },
      required: ["title", "body", "kind"],
    },
  },
  {
    name: "memory_search",
    description:
      "Search shared crew memory. Returns headers only (id, kind, author, title, tags) — cheap to call. " +
      "Call this BEFORE exploring the repo or making a plan, to reuse what the crew already knows. " +
      "Use memory_read to pull full bodies for the ids that matter. With no query it lists the index.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free text. Matches title, tags, file paths and body." },
        scope: { type: "string", enum: ["run", "project", "all"], default: "all", description: "Which store to search." },
        kind: { type: "string", enum: KINDS, description: "Filter by entry kind." },
        tags: { type: "array", items: { type: "string" }, description: "Only entries carrying all of these tags." },
        agent: { type: "string", description: "Only entries written by this agent." },
        for_agent: {
          type: "string",
          description: "Only entries addressed to this agent. Workers: pass your own name to find your brief.",
        },
        limit: { type: "number", default: 25, description: "Max results." },
      },
    },
  },
  {
    name: "memory_read",
    description:
      "Fetch the full body of one or more memory entries by id. Read only the ids you actually need — " +
      "bodies cost context. Find ids with memory_search first.",
    inputSchema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" }, description: "Entry ids, e.g. ['hand-a1b2c3']." },
      },
      required: ["ids"],
    },
  },
  {
    name: "memory_forget",
    description:
      "Retire memory entries that are stale, wrong, or superseded. Appends a tombstone; the audit trail is " +
      "preserved. Prefer revising an entry (memory_write with id) over forgetting it.",
    inputSchema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" }, description: "Entry ids to retire." },
        reason: { type: "string", description: "Why this is no longer true. Recorded for the audit trail." },
      },
      required: ["ids", "reason"],
    },
  },
];

async function callTool(name, args) {
  args = args || {};
  const agent = args.agent || "unknown";

  if (name === "memory_write") {
    const run = await currentRun(args.new_run === true);
    const now = new Date().toISOString();
    const bodyText = args.body.length > MAX_BODY ? args.body.slice(0, MAX_BODY) + "\n\n[truncated]" : args.body;

    if (args.id) {
      const file = (await fileForId(args.id, run)) || logPath(args.scope || "run", run);
      const patch = {
        id: args.id,
        title: args.title,
        body: bodyText,
        kind: args.kind,
        agent,
        session: SESSION_ID,
        updated: now,
      };
      if (args.tags) patch.tags = args.tags;
      if (args.files) patch.files = args.files;
      if (args.for_agent) patch.for_agent = args.for_agent;
      await append(file, patch);
      return `memory: revised ${args.id} (run=${run})`;
    }

    const rec = {
      id: newId(args.kind),
      scope: args.scope || "run",
      kind: args.kind,
      title: args.title,
      body: bodyText,
      tags: args.tags || [],
      files: args.files || [],
      for_agent: args.for_agent,
      agent,
      session: SESSION_ID,
      run,
      status: "active",
      created: now,
      updated: now,
    };
    await append(logPath(rec.scope, run), rec);
    return [
      `memory: wrote ${rec.id}  [${rec.scope}/${rec.kind}]  run=${run}`,
      args.new_run ? `memory: started new run ${run}` : "",
      `Reference ${rec.id} when delegating — do not paste the body.`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (name === "memory_search") {
    const run = await currentRun(false);
    let recs = await load(args.scope || "all", run);

    if (args.kind) recs = recs.filter((r) => r.kind === args.kind);
    if (args.agent) recs = recs.filter((r) => r.agent === args.agent);
    if (args.for_agent) recs = recs.filter((r) => r.for_agent === args.for_agent);
    if (args.tags && args.tags.length) recs = recs.filter((r) => args.tags.every((t) => (r.tags || []).includes(t)));

    const ranked = recs
      .map((r) => ({ r, s: score(r, args.query) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || String(b.r.updated).localeCompare(String(a.r.updated)))
      .slice(0, args.limit || 25)
      .map((x) => x.r);

    if (!ranked.length) return `memory: no entries matched (run=${run}). Nothing has been recorded for this yet.`;

    return [
      `memory: ${ranked.length} entr${ranked.length === 1 ? "y" : "ies"}  (run=${run})`,
      ...ranked.map(header),
      "",
      "Use memory_read with the ids you need.",
    ].join("\n");
  }

  if (name === "memory_read") {
    const run = await currentRun(false);
    const all = await load("all", run);
    const found = [];
    const missing = [];
    for (const id of args.ids) {
      const rec = all.find((r) => r.id === id);
      if (rec) found.push(full(rec));
      else missing.push(id);
    }
    const parts = [];
    if (found.length) parts.push(found.join("\n\n"));
    if (missing.length) parts.push(`memory: not found -> ${missing.join(", ")}`);
    return parts.join("\n\n") || "memory: nothing to read";
  }

  if (name === "memory_forget") {
    const run = await currentRun(false);
    const now = new Date().toISOString();
    const done = [];
    const missing = [];
    for (const id of args.ids) {
      const file = await fileForId(id, run);
      if (!file) {
        missing.push(id);
        continue;
      }
      await append(file, {
        id,
        status: "deleted",
        agent,
        session: SESSION_ID,
        updated: now,
        body: `[retired by ${agent}] ${args.reason}`,
      });
      done.push(id);
    }
    return [done.length ? `memory: retired ${done.join(", ")}` : "", missing.length ? `memory: not found -> ${missing.join(", ")}` : ""]
      .filter(Boolean)
      .join("\n");
  }

  throw new Error(`unknown tool: ${name}`);
}

/* ----------------------------------------------------------- MCP stdio */

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on("line", async (line) => {
  line = line.trim();
  if (!line) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  const { id, method, params } = msg;

  try {
    if (method === "initialize") {
      respond(id, {
        protocolVersion: (params && params.protocolVersion) || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "supervisor-crew-memory", version: "1.0.0" },
      });
      return;
    }

    if (method === "notifications/initialized" || method === "initialized") {
      return; // notification, no response
    }

    if (method === "tools/list") {
      respond(id, { tools: TOOLS });
      return;
    }

    if (method === "tools/call") {
      const name = params && params.name;
      const args = params && params.arguments;
      try {
        const text = await callTool(name, args);
        respond(id, { content: [{ type: "text", text }], isError: false });
      } catch (err) {
        respond(id, { content: [{ type: "text", text: `error: ${err.message}` }], isError: true });
      }
      return;
    }

    if (method === "ping") {
      respond(id, {});
      return;
    }

    // Unknown method
    if (id !== undefined) respondError(id, -32601, `method not found: ${method}`);
  } catch (err) {
    if (id !== undefined) respondError(id, -32603, err.message);
  }
});

process.stdin.resume();
