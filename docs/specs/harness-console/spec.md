# Aegis — harness console for Claude Code

Status: ready-for-agent

<!-- Template: references/aidlc.md §2. User story n is requirement AEGIS-n; tests reference it as AEGIS-n. -->

## Problem Statement

An engineer who runs Claude Code all day, across many repositories, with subagents, hooks, plugins, MCP servers and headless runs, cannot answer basic operating questions without opening raw JSONL files:

- What is running right now, and which session is waiting for me?
- What exactly did the agent execute on my machine last Tuesday, who allowed it, and was any of it dangerous?
- What did this week cost, and which project, model, skill or plugin spent it?
- Are my hooks, tools and MCP servers healthy, and is my configuration what I think it is?

The harness already records all of this (transcripts, the live-session registry, settings, the plugin registry), but nothing presents it as evidence. Tools that try usually get the numbers wrong (token usage is repeated once per content block in the transcript, so naive sums double-count) and copy sensitive transcript content around without care.

## Solution

Aegis is a local-first console that reads what Claude Code already writes and never changes it. It needs no hooks and no harness configuration, so history from before it was installed is visible on first start. One process on loopback serves six views:

- **Now**: live sessions, their state, and a queue of what needs the operator.
- **Sessions**: every session, searchable, each with a turn-by-turn timeline that pairs tool calls with their results, permission decisions, hooks, compactions and subagents.
- **Audit**: a cross-session ledger of every command, file write, fetch and MCP call, risk findings with triage, tamper evidence, export.
- **Cost**: spend and tokens by model, project, skill, plugin and agent, priced from the harness's own price table.
- **Ops**: hook, tool, MCP and API reliability; configuration inventory; doctor checks.
- **Run**: launch and stop headless runs, only when control mode is switched on at start.

Every number and every row links to the transcript record it came from.

## User Stories

### Indexing and accuracy

1. As an operator, I want every session recorded under the Claude home listed with no hook or harness configuration, so that history from before Aegis was installed is visible.
2. As an operator, I want an index pass to read only bytes appended since the last pass, so that the console stays current on a history of a gigabyte or more.
3. As an operator, I want token usage counted once per API response even though the transcript repeats it for each content block, so that totals are not inflated.
4. As an operator, I want cost computed from the harness's own price table with separate rates for input, output, cache read and both cache-write lifetimes, so that the figure matches what the harness would charge.
5. As an operator, I want a model that has no price shown as unpriced and excluded from the cost total with a visible count, so that no cost is ever guessed.
6. As an operator, I want the harness-reported session cost shown beside the estimate when the transcript carries one, so that I can see how far the estimate is from the harness's own figure.
7. As an operator, I want subagent transcripts rolled into their parent session with a per-agent breakdown, so that a session's total includes the work it delegated.
8. As an operator, I want a truncated last line of a transcript that is still being written skipped and read on the next pass, so that live sessions never corrupt the index.

### Live

9. As an operator, I want sessions whose process is alive shown as running with the harness's own status, and registry entries whose process is gone not shown as running, so that the Now view is true.
10. As an operator, I want changes pushed to the open console when a transcript grows or a session starts or ends, so that I do not have to reload.
11. As an operator, I want an attention queue that names each session that needs me and why (waiting for my answer, a tool pending for more than a minute, blocked by a hook, rate limited, an open high or critical finding, an integrity alert), so that I look only where I am needed.

### Sessions

12. As an operator, I want to filter sessions by project, model, entry point, time range, having errors and risk level, and search their prompts, replies and commands by text, so that I can find a session from what I remember of it.
13. As an operator, I want a session timeline of prompts, replies and tool calls where each tool call is paired with its result, duration, error state and permission decision, so that I can read what happened in order.
14. As an operator, I want the timeline to show context compactions, hook runs, API errors and permission-mode changes in place, so that I can see why a session behaved as it did.
15. As an auditor, I want every timeline item and ledger row to carry the transcript file and line it came from, and to open the raw record, so that any claim can be checked against the source.
16. As an operator, I want the context size of each API call across a session, so that I can see growth and what each compaction freed.
17. As an operator, I want the files a session read, edited and wrote with counts, so that I know its blast radius.

### Audit

18. As an auditor, I want a ledger across sessions of every command run, file written, URL fetched and MCP tool called, filterable by tool, project, time and outcome, showing how each was allowed (rule, mode, classifier or the user) or how it was denied, so that I can answer "what ran and who let it".
19. As an auditor, I want tool calls matched against risk rules (destructive deletion, history rewrite and forced push, piping a download into a shell, privilege escalation, reading credential stores, disabling verification, destructive infrastructure and database commands, writes outside the session's project) and recorded as findings with a severity and the matched evidence, so that dangerous actions surface without reading every session.
20. As an auditor, I want to acknowledge a finding with a note, and have that survive re-indexing, so that triage is not lost.
21. As an auditor, I want to export the filtered ledger and the findings as CSV and as JSON Lines, so that evidence can leave the console in a standard form.
22. As an auditor, I want an integrity alert when a transcript that was already indexed is rewritten or truncated instead of appended to, so that edited history is detected.
23. As an operator, I want secrets (API keys, tokens, private keys, credentials in URLs, bearer headers) masked in everything the console shows and stores, and the unmasked record available only through an explicit per-record reveal, so that screens and exports do not leak them.

### Cost

24. As an operator, I want spend and tokens over time grouped by model, project, skill, plugin or agent type, with the share of input served from cache, so that I know where the money goes.
25. As an operator, I want the most expensive sessions of a period, so that I can open the outliers.

### Ops

26. As an operator, I want each hook's runs, failures, blocks and median and 95th-percentile duration, so that a slow or failing hook is obvious.
27. As an operator, I want each tool's calls, error rate, denial rate and 95th-percentile duration, with MCP tools grouped by server, so that an unreliable tool or server is obvious.
28. As an operator, I want API errors and compactions over time, so that I can see rate limiting and context pressure.
29. As an operator, I want an inventory of the effective configuration: settings by scope, permission rules, hooks, plugins with version and scope, and MCP servers, with every environment value and credential masked, so that I can see what the harness is set up to do.
30. As an operator, I want doctor checks that flag a permissive default mode, over-broad allow rules, credentials stored in settings, an enabled plugin that is not installed, and hooks that fail often, each with its evidence, so that configuration risks are named.

### Run

31. As an operator, I want to launch a headless run in a project the harness already knows, with a prompt, a model and a permission mode, and see it appear among the live sessions, so that I can start work from the console.
32. As an operator, I want to stop a run I launched from the console, so that I keep control of it.
33. As an operator, I want launching and stopping refused unless Aegis was started in control mode, and a mode that bypasses permission checks never offered, so that a read-only console cannot be turned into a way to run code.

### Trust

34. As an operator, I want the console reachable only on loopback, with every request needing the access token issued at start and a matching Host, and state-changing requests needing a matching Origin, so that another site in my browser or another machine cannot read my transcripts or launch runs.
35. As an operator, I want Aegis never to create, change or delete anything under the Claude home, so that it cannot damage the harness's records.

### Interface

36. As an operator, I want every view usable from the keyboard with a command palette for navigation and search, so that the console is as fast as the terminal it sits beside. (Verify: manual — driven in a real browser, screenshots in review.md)
37. As an operator, I want a light and a dark theme that follow the system and a layout that works from a laptop split-screen to a wide monitor, so that it is comfortable all day. (Verify: manual — driven in a real browser in both themes and at three widths)

## Implementation Decisions

- **Read what the harness writes; instrument nothing.** Sources are the transcript files (main and subagent), the live-session registry, the settings files of each scope, the plugin registry, the user configuration file (price table, MCP servers) and the project list. Aegis opens all of them read-only.
- **One process, two modules.** A server (indexer, query API, live push, static files) and a single-page web client built ahead of time and served by the server. The server has no runtime dependency beyond the platform's standard library, including its bundled SQLite with full-text search; the client's dependencies are the UI library and its build tool only.
- **The index is a cache, not a record.** It holds derived facts (sessions, API calls, tool calls, events, findings, search text) plus a pointer (file, line, byte offset) to each source record. Deleting it loses only triage notes, which is why those are kept in a separate table that re-indexing never drops. Session timelines and raw records are read from the transcript on demand.
- **Incremental indexing.** Per file the index keeps the byte offset reached and a hash of the bytes before it. A pass reads from the offset to the last complete line. A file that is shorter than its offset, or whose prefix hash differs, raises an integrity alert and is re-indexed from the start. Request-body records (the harness's API request log) are skipped without parsing.
- **Usage is keyed by API response id.** For one response id the last record wins; usage is never summed across its content blocks. A session's totals are the sum over distinct response ids of the main transcript and its subagent transcripts.
- **Price provenance.** Rates come from the price table the harness caches in the user configuration file, read at start and on change; nothing is hard-coded. A model resolves by exact id, then by the longest priced id it starts with; no match means unpriced. Every cost figure states its basis (`estimated from tokens`, `harness-reported`) and the count of unpriced responses.
- **Risk rules are data.** Each rule has an id, a severity (`critical`, `high`, `medium`, `low`), the tools it applies to and a matcher; findings store the rule id, the matched text (masked) and the tool call they point to. A finding's identity is the tool call id plus the rule id, so re-indexing recreates the same finding and keeps its triage state.
- **Attention is derived, not stored.** The queue is computed from live state and the index at request time with fixed, documented thresholds (a tool pending for more than 60 seconds; a rate-limit error in the last 15 minutes; open high or critical findings from the last 24 hours).
- **Masking happens at the edge of the index and of the API.** Search text, previews and finding evidence are masked before they are stored; timeline and raw-record responses are masked unless the request asks for one record to be revealed.
- **Control mode is a start-time switch.** Without it the run endpoints do not exist. With it, a run is the harness's own headless mode started as a child process in a project directory the index already knows, with the permission mode limited to the non-bypassing modes; Aegis observes it through its transcript like any other session and can signal only children it started.
- **Aegis state lives in its own directory** in the user's home, created with owner-only permissions; the access token is generated per start and never written to disk.
- **Time** is stored as UTC milliseconds and shown in the browser's zone; a day in charts is a local day of the browser, sent as an offset.

### Behaviour details

**Start, locations, state**
- The Claude home is `~/.claude` unless overridden at start; the user configuration file is `~/.claude.json` unless overridden. The Aegis state directory is `~/.aegis` unless overridden; it holds the index database and the console's own activity log, nothing else, and may never be inside the Claude home (start is refused).
- The port is 4317 unless given at start; a taken port fails the start. The start prints one URL that carries the access token; nothing else prints it.
- A missing or unreadable Claude home, price table, settings file or registry is not an error: the affected data is empty, and the Ops doctor lists the source as unreadable. Malformed JSON in a configuration source is treated the same way.
- The index carries a schema version; a different version on disk drops and rebuilds the derived tables (triage and integrity acknowledgements are kept). A second Aegis process on the same state directory fails to start.

**Indexing**
- A pass runs at start for every transcript, then for files reported changed by the filesystem watcher (coalesced over one second), and every 15 seconds for any file whose size changed (the fallback when the watcher misses an event).
- A line is complete when it ends in a newline. Bytes after the last newline are left for the next pass. A complete line that is not valid JSON, or is larger than 32 MB, is counted per file as skipped and never stops the pass; the count is reported in Ops.
- The per-pass check compares the file size with the stored offset and a SHA-256 of the 4096 bytes before the offset (fewer when the offset is smaller). The deep check, run at start for files whose size or modification time changed and on request, hashes the whole indexed prefix and compares it with the hash stored at the previous deep check. Index status reports the bytes read by the last pass.
- An integrity alert stores the file, session, time, reason (`truncated`, `rewritten`), and the old and new sizes; it persists across re-indexing and restarts until acknowledged with a note. A first index is never an alert. A transcript that disappears keeps its indexed rows and is marked `source removed`, which is not an alert (the harness deletes old transcripts by design).
- A session is one main transcript; its id is the transcript's file name. Subagent transcripts live in the session's own subagent folder and take the parent's id plus their agent id; a subagent file whose parent transcript is absent still produces a session row marked as having no main transcript.
- Unknown record types are counted per type across the index and listed in Ops.

**Usage and cost**
- "Last record wins" is by line order within a file. A response id seen in a second file keeps the first file's row (forked sessions copy history). Records without a response id, synthetic responses (model `<synthetic>`) and API-error records carry no usage and are not counted as API calls; API errors are events.
- Cost of a response = input x input rate + output x output rate + cache read x cache-read rate + 5-minute cache write x cache-write rate + 1-hour cache write x 1-hour rate, rates in USD per million tokens. When a usage record does not split cache writes, all are 5-minute. A priced model that lacks the 1-hour rate uses the 5-minute rate. Costs are stored unrounded and shown to the cent (four decimals under one dollar).
- An empty or missing model id is unpriced. Tokens of unpriced responses are included in token totals; their count is returned wherever a cost total is returned (session, series bucket, top list, overview).
- Costs are stored per response when indexed. When the price table's content changes, every stored cost is recomputed and a re-pricing event (time, models changed) is recorded and shown in Cost.
- A `cost-state` record carries the process's running total and its start time. The harness-reported cost of a session is the sum, over distinct process start times, of the last total for that start time; it is shown with the number of process runs it covers and labelled a lower bound (a killed process writes none).
- Context size of a response = input + cache read + cache write tokens. A compaction's freed amount is the pre-compaction token count minus the post-compaction count, both taken from the compaction record.
- Share of input served from cache = cache read / (input + cache read + cache writes); shown as "n/a" when the denominator is zero.
- Attribution uses the fields the harness writes on each response: skill, plugin; agent type comes from the subagent's metadata file (`main` for the main transcript). Responses with no value group under `(none)`.

**Live and attention**
- Running = a registry entry whose process id exists. An entry with a missing or malformed process id, or a dead one, is not running. A running entry with no transcript yet appears with zero counts. Sessions without a registry entry are never shown as running.
- The push channel is server-sent events with two event names, `index` (ids of sessions whose data changed) and `live` (registry changed), sent at most once per second; there is no replay, the client refetches on reconnect.
- Attention reasons, in display order: `integrity` (unacknowledged alert), `question` (running; last tool call is the question tool with no result), `blocked` (running; the last hook event of the session is a blocking error), `tool_pending` (running; last tool call has no result for more than 60 seconds), `rate_limited` (an API rate-limit error, status 429, in the last 15 minutes with no later successful response), `finding` (open high or critical findings whose tool call ran in the last 24 hours). One row per session and reason; findings collapse into one row per session with a count.
- A finding is `open` or `acknowledged`; only acknowledging closes it, and it can be reopened.

**Sessions**
- Filters combine with AND. Time range selects sessions whose activity interval overlaps it. `errors` selects sessions with at least one failed tool call, API error or hook failure. Risk level selects sessions whose highest finding severity is at least the level. Sort: last activity (default), cost, duration.
- Search is over masked text only: prompts, replies and tool targets (command, file path, URL, pattern). Tool output is never stored in the index. The query is split into words, each matched as a prefix, all required; a query under 2 characters is rejected. Results are sessions ordered by last activity, each with up to three matching snippets in which the match is delimited by marker characters, never markup.
- Lists return at most 200 rows by default and 1000 at most, with a total count and an offset.
- Tool calls pair with results by tool-call id. Duration is the result's time minus the call's time; a call with no result has status `pending` and no duration; a result with no call is ignored. Outcome values: `ok`, `error`, `denied`, `pending`. How-allowed values come from the permission record (`decision`, `source`, `reason type`) and are shown verbatim; with no record the value is `not recorded`. Denial kinds are shown verbatim.
- The timeline is paged (default 300 items, maximum 1000) and each text field is cut at 4000 characters with a flag; a raw record response is cut at 256 KB with a flag.
- Files touched come from the file tools only (read, edit, write, notebook edit), by the absolute path in the call, counted per call; files changed by shell commands are not inferred.

**Audit**
- The ledger holds tool calls of the categories `exec` (shell), `write` (edit, write, notebook edit), `fetch` (web fetch, web search), `mcp` (any MCP tool) and `agent` (subagent dispatch). Read-only file tools are not in the ledger.
- The MCP server of a tool is the part of its name between the `mcp__` prefix and the last `__`.
- Risk rules are built in and versioned with the code; changing them takes effect on re-index, which removes findings that no longer match. One finding per rule per tool call, even when the rule matches twice. Rules (id, severity, applies to):
  `fs.destructive-delete` high, shell: recursive forced deletion of `/`, `~`, `$HOME`, a parent path or a wildcard root (critical when the target is `/`, `~` or `$HOME`) ·
  `git.force-push` high, shell: push with force (`--force-with-lease` is medium) ·
  `git.history-rewrite` medium, shell: hard reset, `clean -fd`, `filter-branch`, `filter-repo`, `reflog expire`, `checkout -- .` ·
  `git.no-verify` medium, shell: commit or push with verification skipped ·
  `exec.pipe-to-shell` high, shell: a download piped into a shell or interpreter ·
  `priv.sudo` high, shell: `sudo`, `doas`, `su -` ·
  `priv.chmod-open` medium, shell: mode 777 or world-writable recursive chmod ·
  `secret.credential-read` high, shell and read: reading `.env` files, SSH private keys, cloud credential files, keychains, `.netrc`, token caches ·
  `secret.env-dump` medium, shell: printing the whole environment ·
  `net.tls-off` medium, shell: certificate or host-key verification switched off ·
  `net.exfil` high, shell: uploading a file or command output to a remote host with an HTTP client or `nc` ·
  `infra.destroy` critical, shell: `terraform destroy`, `cdk destroy`, `kubectl delete` of namespaces or with `--all`, cloud CLI calls that delete or terminate resources, `docker system prune` (medium) ·
  `db.destructive` critical, shell: `DROP` of a database, schema or table, `TRUNCATE`, `DELETE FROM` without `WHERE`, `FLUSHALL` ·
  `pkg.publish` medium, shell: publishing a package or pushing an image ·
  `fs.write-outside-project` medium, write: an absolute target path that is not under the session's working directory of that record, the system temp directories, or the Claude home's plans and scratch areas ·
  `perm.bypass-mode` high, session: a permission mode of `bypassPermissions` recorded in the transcript (one finding per session).
- Acknowledging takes a state and a note of at most 2000 characters (an empty note is allowed), is masked before storage, and records the time. Triage is keyed by the finding's identity and is kept when its finding disappears or the derived tables are rebuilt; deleting the state directory is the only way to lose it.
- Exports apply the same filters as the list they export, contain masked data only, stream up to 100,000 rows and say in a trailer header when cut. CSV follows RFC 4180 with CRLF line ends and a header row; a cell starting with `=`, `+`, `-`, `@`, tab or carriage return is prefixed with a single quote. Ledger columns: time (ISO 8601 UTC), session, project, agent, tool, category, target, outcome, denial kind, allowed by, duration ms, file, line. Finding columns: time, severity, rule, title, evidence, state, note, session, project, tool call, file, line. JSON Lines uses the same names in camel case.
- Masked forms: `[masked:<kind>]`. Kinds: private key blocks; AWS access key ids and secret keys; tokens with known prefixes (Anthropic, OpenAI, GitHub, GitLab, Slack, Stripe, Google, npm, Atlassian); JSON Web Tokens; bearer and basic authorization values; credentials in URLs; values assigned to names containing `password`, `passwd`, `secret`, `token`, `api key`, `access key`, `private key`, `authorization` or `credential` in JSON, environment assignments and command flags. Masking is per field, on at most the first 64 KB of the field. In the inventory every environment value, header value and URL credential is masked whatever its shape; key names are kept. Masking by pattern is incomplete by nature; the export dialog says so. Changed masking rules take effect on re-index.
- Reveal returns one record (one transcript line) unmasked, only to a state-changing request, and is written to the activity log. Stored evidence and exports cannot be revealed.
- The activity log is an append-only JSON Lines file of the console's own actions: reveals, exports, triage changes, integrity acknowledgements, run launches and stops, each with UTC time and identifiers but no transcript text; it is shown in Audit.

**Cost and Ops**
- Series buckets are `hour` or `day`; a day is a local day defined by the browser's UTC offset in minutes sent with the request (one offset for the whole range). Top sessions take a time range and a limit (default 10, maximum 100), ranked by estimated cost of responses inside the range.
- Hook runs are grouped by hook event name plus command. Failure = a non-blocking error record; block = a blocking error record; success otherwise. Percentiles use the nearest-rank method over recorded durations and are empty when there are no durations.
- Tool error rate = failed / finished calls; denial rate = denied / all calls; duration percentile over finished calls.
- API errors and compactions are counted per bucket like cost; a rate-limit error is an API error with status 429.
- Inventory lists each settings file found (user, project and local for every known project, managed) with its own content summarised, not a merged view: permission rules, default mode, hooks, enabled plugins, environment key names; the plugin registry (name, marketplace, version, scope, enabled where); MCP servers from the user configuration file and plugin-enabled projects (name, transport, command name or host; arguments, headers and environment values masked).
- Doctor checks, each `pass`, `warn` or `fail` with evidence: default mode is `bypassPermissions` (fail); an allow rule that allows every shell command or every tool (warn); a settings environment key whose name looks like a credential (warn: stored in plain text); an enabled plugin missing from the registry (warn); a hook with at least 5 runs and a failure share over 20% in the last 7 days (warn); a source that could not be read (warn); transcript lines skipped (warn); unacknowledged integrity alerts (fail).

**Run**
- Allowed permission modes: `plan`, `manual`, `acceptEdits`, `auto`, `dontAsk`. Anything else, including `bypassPermissions`, is refused with 400. The model is optional and must be an alias or id of letters, digits, dot, dash, underscore, colon or brackets, at most 100 characters. The prompt is 1 to 100,000 characters. The project is the id of a project in the index whose directory still exists.
- The harness binary is resolved once at start (a start option, else the search path); a start in control mode without one fails. The child is started without a shell, with a fixed argument list plus the validated fields, a session id chosen by Aegis, the prompt on standard input, and Aegis's own environment minus any variable whose name starts with `AEGIS_`. Its output is discarded apart from the last 4 KB of standard error, kept in memory for the run's status.
- At most 4 runs are active; a fifth is refused with 429. A run's state is `starting`, `running`, `exited` (with exit code) or `failed` (spawn error). Stop sends an interrupt, then a kill after 5 seconds; stopping a finished run returns its state; an unknown run id is 404. When Aegis exits it interrupts its active runs.
- Without control mode every run route answers 404 and the overview says control is off; the client then shows how to enable it instead of the form.

**Interface contract** (JSON over HTTP; errors are `{"error":{"code","message"}}` with no internals)
- Access: the start URL carries the token once; the server exchanges it for an HttpOnly, SameSite=Strict cookie named for the port and redirects to the bare URL. Every other request needs the cookie: 401 otherwise. A Host other than `127.0.0.1`, `localhost` or `[::1]` with the listening port: 403, checked first. A request that is not GET or HEAD needs an `Origin` equal to the server's origin and the header `X-Aegis: 1`: 403 otherwise. After 10 failed token attempts within a minute, token attempts are refused with 429 for 30 seconds.
- `GET /api/overview` (version, control flag, index status, price status, totals) · `GET /api/live` (running sessions, attention) · `GET /api/events` (push) · `GET /api/projects`
- `GET /api/sessions` · `GET /api/sessions/{id}` · `GET /api/sessions/{id}/timeline` · `GET /api/sessions/{id}/context` · `GET /api/sessions/{id}/files`
- `GET /api/records/{file}/{line}` · `POST /api/records/{file}/{line}/reveal`
- `GET /api/audit/ledger` · `GET /api/audit/ledger/export` · `GET /api/audit/findings` · `GET /api/audit/findings/export` · `POST /api/audit/findings/{id}/triage` · `GET /api/audit/integrity` · `POST /api/audit/integrity/{id}/ack` · `POST /api/audit/verify` · `GET /api/audit/activity`
- `GET /api/cost/series` · `GET /api/cost/top`
- `GET /api/ops/hooks` · `GET /api/ops/tools` · `GET /api/ops/series` · `GET /api/ops/inventory` · `GET /api/ops/doctor` · `GET /api/ops/records`
- `POST /api/runs` · `GET /api/runs` · `POST /api/runs/{id}/stop`
- Invalid parameters: 400. Unknown id or route: 404. The contract is internal to this repository (one client, shipped together), so it is not versioned.

**Interface criteria (stories 36 and 37)**
- Keyboard: a palette on Cmd/Ctrl+K that lists every view and searches sessions; `g` then a view's letter jumps to it; `/` focuses the current list's filter; `j`/`k` and Enter move through and open rows; Escape closes panels; every control reachable by Tab with a visible focus ring.
- Layout holds without horizontal page scroll at 900, 1280 and 1920 pixels wide. Themes: light and dark follow the system and can be forced.

### Security

Assets: transcripts and their derived index (source code, commands and output, secrets, incidental personal data) · the access token · triage notes and exports · the launcher (code execution as the user) · the Claude home's integrity. Boundaries: any browser origin → the loopback server · other local processes → the port and the state directory · transcript content (untrusted) → indexer, renderer, exporter · server → harness child process. OWASP edition: 2025. No formal compliance regime applies to a single-user local tool; transcripts can still hold data covered by the operator's own obligations, which the README states.

| # | Element | STRIDE | Threat | OWASP | Rules |
|---|---|---|---|---|---|
| T1 | Listener and access | S | another page or process reaches the API by port guessing, DNS rebinding or a leaked token | A07:2025, A01:2025 | AUTH-01..03, NET-01, NET-02, SECRET-01, RATE-02 |
| T2 | Cross-origin pages | S, I | a foreign page reads responses, frames the console or sends state-changing requests | A01:2025 | AUTH-04, NET-03, NET-04 |
| T3 | Transcript text in the client | T, E | stored script in tool output or prompts runs in the console's origin | A05:2025 | INPUT-01, INPUT-02, NET-04 |
| T4 | Record and session selectors | T, I | a crafted id or path reads files outside the Claude home | A01:2025 | INPUT-03, AUTHZ-01 |
| T5 | Indexer, rule and mask matchers | D | a huge line or a crafted command exhausts memory or CPU | A10:2025 | INPUT-04, INPUT-05, RATE-01 |
| T6 | Masking and the index | I | secrets stored or shown unmasked; reveal unguarded | A04:2025 | DATA-01..04 |
| T7 | Exports | T, I | spreadsheet formula execution; unmasked secrets in a file | A05:2025 | INPUT-06, DATA-05 |
| T8 | Run endpoints and the child | E, T | option injection, a bypass mode smuggled in, unrelated processes signalled | A05:2025, A01:2025 | AUTHZ-02..04, INPUT-07, INPUT-08, SECRET-02 |
| T9 | State directory | I, T | another local user reads or edits the index and notes | A02:2025 | DATA-06, DATA-07 |
| T10 | Claude home | T | a bug writes to or deletes harness records | A08:2025 | AUTHZ-05 |
| T11 | History and accountability | R, T | rewritten transcripts or changed prices alter history silently; console actions leave no trace | A08:2025, A09:2025 | LOG-01, LOG-02 |
| T12 | Logs and errors | I | transcript text, tokens or paths leak into logs and error bodies | A09:2025 | LOG-03 |
| T13 | Client toolchain | T | third-party code runs in the origin that holds the session | A03:2025 | DEP-01 |

Controls:
1. AUTH-01 (CRITICAL): every route except the one-time token exchange refuses a request without the per-start token with 401; the token is 256 bits from a CSPRNG, compared in constant time, new on every start and never written to disk.
2. AUTH-02 (CRITICAL): a request whose Host is not a loopback authority with the listening port is refused before routing and before any token handling.
3. AUTH-03 (HIGH): the token appears in a URL only in the start URL, is exchanged once for an HttpOnly, SameSite=Strict, port-named cookie, and the browser is redirected to a token-free URL; every response sets `Referrer-Policy: no-referrer`.
4. AUTH-04 (HIGH): every request that is not GET or HEAD needs an Origin equal to the server's own and the `X-Aegis` header; GET and HEAD never change state.
5. NET-01 (CRITICAL): the listener binds to loopback only; there is no option to bind elsewhere.
6. NET-02 (MEDIUM): a taken port fails the start; an unknown path returns 404 without echoing input.
7. NET-03 (HIGH): no response carries a CORS allow header; preflights are refused.
8. NET-04 (HIGH): every response sets a content security policy of `default-src 'self'` with no inline or evaluated script, `frame-ancestors 'none'`, `object-src 'none'`, plus `X-Content-Type-Options: nosniff`; API responses set `Cache-Control: no-store`.
9. INPUT-01 (CRITICAL): transcript-derived text reaches the page only as text through the UI library's escaping; the client source contains no raw-HTML sink, checked by a test.
10. INPUT-02 (HIGH): search matches are marked with delimiter characters in escaped text; links built from transcript values allow only `http` and `https` and carry `rel="noopener noreferrer"`.
11. INPUT-03 (CRITICAL): a session, file or record is selected only by an id resolved through the index to a path whose real location is under the Claude home's project folder; no request value is joined into a path. Traversal, absolute paths, encoded separators and a symlink escape are refused with 404.
12. INPUT-04 (HIGH): a transcript line over 32 MB is skipped without being buffered whole, and a record that fails to parse is skipped; both are counted and shown in Ops.
13. INPUT-05 (HIGH): rule and mask patterns run on at most the first 64 KB of a field and contain no nested unbounded quantifier or backreference; a test runs every pattern on 64 KB adversarial inputs within a fixed time budget.
14. INPUT-06 (HIGH): CSV cells are neutralised against formulas and quoted per RFC 4180; exports are sent as attachments with a server-chosen file name.
15. INPUT-07 (CRITICAL): the launcher starts the harness binary directly with an argument list, never through a shell; the prompt goes on standard input; model and permission mode are validated against a strict pattern and an allow-list before anything is started.
16. INPUT-08 (HIGH): the run's working directory comes only from a project id in the index that resolves to an existing real directory; the binary path comes only from start-time configuration.
17. AUTHZ-01 (HIGH): raw and revealed records are served only for a file id and a line inside that file's indexed range.
18. AUTHZ-02 (CRITICAL): without control mode the run routes answer 404 even to an authenticated request.
19. AUTHZ-03 (CRITICAL): no request or start option can make the child receive a bypass permission mode or a skip-permissions flag; a test asserts the exact argument list of a launch.
20. AUTHZ-04 (HIGH): stop signals only a child this server process started, addressed by Aegis's own run id; no process id is accepted from a request.
21. AUTHZ-05 (CRITICAL): nothing under the Claude home is opened for writing, renamed, re-moded or deleted; tests assert the synthetic Claude home is byte-identical with unchanged modification times after use; the state directory may not be inside the Claude home.
22. DATA-01 (CRITICAL): masking runs before text is stored, so the index never holds a recognised secret; a test seeds known secret formats and finds none in any API response, export or in the bytes of the database files.
23. DATA-02 (HIGH): values under credential-like names are masked whatever their shape, and every environment and header value in the inventory is masked; no request parameter turns masking off.
24. DATA-03 (HIGH): reveal serves one record per request, only to a state-changing request, with `no-store`, and is recorded in the activity log without content.
25. DATA-04 (MEDIUM): search runs on masked text only, so a secret cannot be recovered by probing search.
26. DATA-05 (HIGH): exports hold masked data only and are streamed, never written to disk by the server; the client states that masking is pattern-based before an export.
27. DATA-06 (HIGH): the state directory is owner-only (0700) and its files 0600; at start a directory that is a symbolic link or owned by another user is refused, and wider modes are tightened.
28. DATA-07 (MEDIUM): triage holds only identity, state, masked length-capped note and time, and no rebuild path drops it.
29. SECRET-01 (HIGH): the token is printed once in the start URL and appears in no log, error, API response or child environment.
30. SECRET-02 (HIGH): the child receives no Aegis variable; its output is not stored beyond a bounded tail of standard error held in memory.
31. LOG-01 (MEDIUM): integrity alerts and re-pricing events persist with their before and after values until acknowledged (alerts) or indefinitely (re-pricing).
32. LOG-02 (HIGH): reveals, exports, triage changes, acknowledgements, run launches and stops are appended to the activity log with UTC time and identifiers; a launch records prompt length and hash, never the prompt.
33. LOG-03 (HIGH): server output and error bodies contain no transcript text, prompt, token, absolute path or stack trace; an unexpected failure returns 500 with a correlation id; the request log omits query strings.
34. RATE-01 (MEDIUM): list and export sizes are capped as stated above; search text reaches the database only as a bound parameter of a sanitised expression.
35. RATE-02 (MEDIUM): the push channel allows 8 connections and coalesces events; repeated failed token attempts are throttled as stated above.
36. DEP-01 (MEDIUM): the server has no runtime package dependency (a test checks the manifest); client dependencies are pinned by a committed lockfile; the built client loads nothing from a remote host.

Open decisions (settled by delegation, recorded as assumptions): exposure beyond loopback is not supported; the session credential is a cookie; a secret that no pattern recognises can remain in indexed prompts, replies and commands (residual risk, stated in the client, reduced by never indexing tool output); reveal stays available with a confirmation step.

## Testing Decisions

- **One seam for the server: its HTTP API**, exercised in-process against a synthetic Claude home built by the tests (transcripts, subagents, registry, settings, price table). Tests assert what an API consumer sees: session lists, totals, timelines, ledger rows, findings, exports, status codes. No test reads the index database directly.
- **A second, narrow seam for the launcher**: the run endpoints with the harness binary replaced by a stub executable that writes a transcript, so no test spends tokens.
- Good tests: usage counted once for a response split across three records; an appended line indexed without re-reading the prefix; a rewritten file raising an integrity alert; a forced push producing a `high` finding whose triage note survives a full re-index; a request with a foreign Host refused; the synthetic Claude home byte-identical after every test.
- Expected values are written by hand in the fixtures (token counts, costs from a fixture price table), never computed by the code under test.
- The web client is checked by type-checking and a production build in the suite, and by driving the real application in a browser against real data (stories 36 and 37, and a pass over every view) with screenshots recorded in the review.
- Prior art: none in this repository (new project).

## Out of Scope

- Changing harness configuration from the console (editing settings, permissions, hooks, plugins).
- An interactive chat or terminal emulator in the browser; interactive work stays in the terminal, and the console gives the resume command.
- Remote machines, teams, cloud sessions and multi-user access; one user, one machine.
- Harnesses other than Claude Code (the index is shaped so another transcript reader can be added, but none is built).
- OpenTelemetry ingestion; alerts delivered outside the console (push, chat, e-mail).
- Approving or denying a pending permission request from the console.

## Further Notes

Sources:
- The transcript, registry, settings and plugin-registry formats were read from this machine's Claude home (Claude Code 2.1.319) on 2026-11-22: record types, the per-block repetition of usage, `cost-state`, permission decisions, denial kinds, hook attachments, compaction metadata, attribution fields.
- The price table is `additionalModelCostsCache` in the user configuration file, in USD per million tokens.

Assumptions:
- The transcript format is not a published contract and can change between harness versions. Unknown record types are counted and ignored, and the Ops view reports the count per type, so drift is visible instead of silent.
- The live-session registry's `status` values seen so far are `busy` and `idle`; any other value is shown verbatim.
- A pending tool call cannot be told apart from one awaiting a permission prompt from the transcript alone; the attention queue says "tool pending" and does not claim which.
- Accepted by delegation: the request was "build it until you are proud of it", with no approval stop.
