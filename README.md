# Aegis

A local console to use, monitor, audit and operate Claude Code, built from the records the harness already writes.

```bash
npm install
npm run build       # builds the web client once
npm start           # prints a link with a one-time token; open it
```

Aegis needs Node 22.18 or newer and nothing else at run time. It reads `~/.claude` and `~/.claude.json`, keeps its own index in `~/.aegis`, listens on `127.0.0.1:4317` and never writes inside the Claude home.

| View | Answers |
|---|---|
| **Now** | The harness drawn as a machine with its real traffic (you, the sessions, the models, the gate of permissions and hooks, the tools), which session needs me, and every running session on a board. |
| **Sessions** | Every session, searchable by what was said or run, under a calendar of spend per day; each row carries the shape of its session (prompts, tool calls, failures, in order). Each opens as a replay (step through it and watch which part of the harness every row touched, with running cost and context), as its path (the instruction files, hooks, skills, permission decisions, subagents and MCP servers it went through, in order) or as a tape: prompts, replies and tool calls in order, every call paired with its result, duration, outcome and how it was allowed. |
| **Audit** | Findings drawn day by day; a map of the folders and files the agent read and changed most; a ledger of every command, file write, fetch, MCP call and subagent dispatch; risk findings with triage; tamper evidence; CSV and JSON Lines export; a log of what was done through the console. |
| **Cost** | Spend flowing from projects through models to the main thread and each kind of subagent; spend and tokens by model, project, skill, plugin or agent type, with the share of input served from cache. |
| **Ops** | Hook events drawn as gates along the life of a session, with what did not pass at each; reliability of hooks, tools, MCP servers and the API; the configuration as it is on disk; doctor checks. |
| **Run** | Launch and stop headless runs. Off unless started with `npm run start:control`. |

Keyboard: `Ctrl K` palette and search, `g` then `n s a c o r` to jump, `/` to filter, `j` `k` `Enter` over rows, `Esc` to close.

## What it is built on

**The harness already writes the truth, so Aegis instruments nothing.** There are no hooks to install and no proxy in front of the agent. History from before Aegis was installed is there on first start, and Aegis cannot slow down or break a session.

**Numbers are derived the way the harness derives them.**

- A transcript repeats token usage on every content block of one API response. Aegis counts usage once per response id, with the last record winning. Summing lines roughly doubles the figure.
- Prices come from the table the harness itself caches (`additionalModelCostsCache` in `~/.claude.json`), with separate rates for input, output, cache read and the two cache-write lifetimes. Nothing is hard-coded. A model with no price is shown as unpriced and counted, never guessed.
- Where the transcript carries the harness's own running cost, it is shown beside the estimate. On this machine the two agree within about 2% for sessions that ran in one process.

**Every row is evidence.** Each timeline item, ledger row and finding carries the transcript file and line it came from and opens the raw record.

**The index is a cache.** It holds derived facts and pointers; timelines and records are read from the transcript on demand. Deleting `~/.aegis` loses only triage notes and acknowledgements.

**Unknown is shown as unknown.** The transcript format is not a published contract. Record types Aegis does not know are counted and listed in Ops, so a change in the harness is visible instead of silent. A tool call with no result is shown as "no result", not as "awaiting approval", because the transcript cannot tell the two apart.

## Trust

- Loopback only. Every request needs the per-start token (exchanged once for an HttpOnly, SameSite=Strict cookie), a loopback `Host`, and for anything that changes state the same `Origin` plus a custom header. No CORS. A strict content security policy; the client loads nothing from a remote host.
- Read-only towards the harness. Transcripts are opened read-only and selected only through ids resolved by the index; symbolic links out of the Claude home are never followed.
- Secrets are masked before anything is stored or shown: private keys, cloud and vendor tokens, JWTs, bearer values, credentials in URLs, and values under credential-like names. Tool output is never copied into the index. One record at a time can be revealed, after a confirmation, and each reveal is logged. Masking is by pattern and cannot be complete; the export dialog says so.
- A transcript should only grow. Aegis alerts when an indexed transcript is truncated or rewritten, and can re-hash every transcript on request.
- Control mode is a start-time switch. Without it the run routes do not exist. With it, a run is `claude -p` started without a shell, in a project the index already knows, with the prompt on standard input and a permission mode from a list that has no bypass mode.

Transcripts can hold source code, credentials and personal data pasted during work. Aegis keeps derived copies of prompts, replies and commands (masked) in `~/.aegis`, readable only by you. Treat that directory and any export with the care the transcripts themselves need.

## Risk rules

Sixteen built-in rules flag tool calls: recursive forced deletes of root-like paths, forced pushes, discarded history, skipped verification, downloads piped into a shell, privilege escalation, world-writable modes, credential-store reads, environment dumps, verification switched off, uploads to remote hosts, destructive infrastructure and database commands, publishing, writes outside the session's project, and sessions run with permission checks bypassed. The matcher reads shell quoting and here-documents: the text of a commit message or of a file being written is not a command, while a here-document fed to a shell or a database client is. The Audit view lists every rule with what it fires on.

## Development

```bash
npm test            # server tests through the HTTP API against a synthetic Claude home
npm run typecheck
npm run dev         # client dev server on :5173, proxying /api to a running Aegis
```

Options: `bin/aegis --help`. The server (`server/src`) is TypeScript run directly by Node with no package dependency; it uses Node's bundled SQLite with full-text search. The client (`web/src`) is React, built by Vite, with hand-drawn SVG charts.

The specification, tickets and gate evidence are in `docs/specs/harness-console/`. Out of scope for now: changing harness configuration from the console, approving a pending permission request, remote machines and teams, OpenTelemetry ingestion, and harnesses other than Claude Code.
