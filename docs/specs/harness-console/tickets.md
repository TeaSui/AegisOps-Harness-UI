# Tickets — harness-console

The server slices (T1–T8) each end at the HTTP API, the spec's seam; the client slices (T9–T10) put a face on them. A client slice is demoable against the real Claude home.

## T1: Index the Claude home and list sessions with true usage and cost
Blocked by: none
Covers: AEGIS-1..AEGIS-8, AEGIS-35
Status: done
What to build: starting the server against a Claude home indexes every transcript incrementally and serves the session list and session summary with tokens counted once per response, cost from the harness price table, unpriced models flagged, the harness-reported cost beside the estimate, and subagents rolled into their parent; nothing under the Claude home changes.
- [x] Every main transcript in the synthetic home is listed as a session with no configuration
- [x] A second pass after an append reads only the appended bytes and updates the session
- [x] A response repeated over three records is counted once, with the last record's usage
- [x] Cost equals the hand-computed figure for input, output, cache read and both cache-write lifetimes
- [x] An unpriced model adds tokens, no cost, and one unpriced response to the count
- [x] The harness-reported cost sums the last total of each process run
- [x] A subagent's usage is in its parent's total and in the per-agent breakdown
- [x] A truncated last line is skipped, then indexed once completed; a corrupt complete line is counted and skipped
- [x] The synthetic home is byte-identical with unchanged modification times afterwards
Test: node --test server/test/index.test.ts

## T2: Loopback-only access with a per-start token
Blocked by: T1
Covers: AEGIS-34
Status: done
What to build: the console answers only to its own origin on loopback: the start URL's token is exchanged for a cookie, every other request needs it, a foreign Host is refused first, state-changing requests need the right Origin and header, and responses carry the security headers.
- [x] A request without the token gets 401; with the cookie from the exchange it gets 200
- [x] A foreign Host gets 403 even with a valid token
- [x] A state-changing request without the matching Origin or without the header gets 403
- [x] No response has a CORS allow header; every response has the content security policy, nosniff and no-referrer
- [x] Repeated failed token attempts are throttled with 429
Test: node --test server/test/access.test.ts

## T3: Find a session and read what happened in it
Blocked by: T1
Covers: AEGIS-12..AEGIS-17, AEGIS-23
Status: done
What to build: sessions can be filtered and searched by text; a session opens as a paged timeline that pairs tool calls with results, durations, outcomes and permission decisions and shows compactions, hooks, API errors and mode changes in place; every item cites its transcript file and line and opens the raw record; context size per response and files touched are served; secrets are masked everywhere and one record can be revealed deliberately.
- [x] Filters by project, model, entry point, time range, errors and risk combine with AND
- [x] A text search finds a session by a word of its prompt, reply or command and returns marked snippets
- [x] A tool call appears once with its result, duration, outcome and how it was allowed; a call with no result is pending
- [x] Compaction, hook, API-error and permission-mode items appear in order in the timeline
- [x] Every timeline item has a file id and line whose raw record matches the transcript line
- [x] The context series gives each response's context size and each compaction's freed tokens
- [x] Files read, edited and written are listed with counts
- [x] Seeded secrets appear in no list, timeline, record, search result or database file; reveal returns the original line and is logged
- [x] Record selectors with traversal, bad ids or lines outside the indexed range get 404
Test: node --test server/test/sessions.test.ts

## T4: Audit ledger, risk findings, triage, export, tamper evidence
Blocked by: T3
Covers: AEGIS-18..AEGIS-22
Status: done
What to build: an auditor sees every command, write, fetch, MCP call and subagent dispatch across sessions with outcome and how it was allowed, risk findings with severity and evidence, can acknowledge a finding with a note that survives a full rebuild, export both lists as CSV and JSON Lines, and is alerted when an indexed transcript is rewritten or truncated.
- [x] The ledger lists the fixture's shell, write, fetch and MCP calls and filters by tool, category, project, time and outcome
- [x] Each built-in rule fires on its fixture command with its severity, and does not fire on the benign look-alike
- [x] An acknowledgement with a note survives a rebuild of the index
- [x] CSV export has the header, CRLF line ends, quoting and formula neutralisation; JSON Lines has one object per line
- [x] A truncated and a rewritten transcript each raise an alert that persists until acknowledged; a removed transcript is marked and raises none
- [x] Every rule and mask pattern finishes a 64 KB adversarial input inside the time budget
Test: node --test server/test/audit.test.ts

## T5: What is running now and what needs me
Blocked by: T4
Covers: AEGIS-9..AEGIS-11
Status: done
What to build: the Now data shows sessions whose process is alive with the harness's status, hides registry entries of dead processes, pushes an event when a transcript grows or the registry changes, and lists the attention reasons per session.
- [x] A registry entry with a live process is running; one with a dead or malformed process id is not
- [x] An append to a transcript produces an `index` push event naming the session
- [x] Each attention reason appears for its fixture session and not for the others
Test: node --test server/test/live.test.ts

## T6: Where the money goes
Blocked by: T1
Covers: AEGIS-24, AEGIS-25
Status: done
What to build: spend and tokens per hour or local day grouped by model, project, skill, plugin or agent type with the cache share and unpriced counts, and the most expensive sessions of a period.
- [x] Day buckets follow the offset sent by the client; groups sum to the hand-computed totals
- [x] Cache share is cache read over all input, and "n/a" for an empty bucket
- [x] Top sessions are ranked by cost inside the range with the limit applied
- [x] A changed price table re-prices stored costs and records a re-pricing event
Test: node --test server/test/cost.test.ts

## T7: Is the harness healthy and configured as I think
Blocked by: T1
Covers: AEGIS-26..AEGIS-30
Status: ready-for-agent
What to build: per-hook and per-tool reliability with nearest-rank percentiles, MCP tools grouped by server, API errors and compactions over time, the configuration inventory with every credential masked, the unknown-record counts and the doctor checks with evidence.
- [ ] A hook's runs, failures, blocks, median and 95th percentile match the fixture
- [ ] A tool's calls, error rate, denial rate and 95th percentile match the fixture; MCP tools group by server
- [ ] API errors and compactions are bucketed over time
- [ ] The inventory lists settings by scope, rules, hooks, plugins and MCP servers and no environment or header value
- [ ] Each doctor check reports pass, warn or fail with its evidence on the fixture
Test: node --test server/test/ops.test.ts

## T8: Launch and stop a headless run, only in control mode
Blocked by: T2, T5
Covers: AEGIS-31..AEGIS-33
Status: ready-for-agent
What to build: in control mode a run starts the harness binary in a known project with the validated prompt, model and permission mode and can be stopped; without control mode the run routes do not exist; a bypass mode is never accepted.
- [ ] A launch starts the stub binary with the exact expected argument list, the prompt on standard input and no Aegis variable in its environment
- [ ] The launched session appears in the session list after the stub writes its transcript
- [ ] Stop ends a running child; an unknown run id is 404
- [ ] A bypass mode, a bad model, an unknown project and an empty prompt are each refused with 400 and nothing is started
- [ ] Without control mode launch, list and stop answer 404
Test: node --test server/test/runs.test.ts

## T9: The console shell with Now, Sessions and the session timeline
Blocked by: T3, T5
Covers: AEGIS-36
Status: ready-for-agent
What to build: the web client served by the server: navigation, command palette and keyboard movement, the Now view with live sessions and the attention queue updating by push, the session list with filters and search, and the session page with timeline, context chart, files, agents and the raw-record drawer with reveal.
- [ ] The client type-checks and builds, and the server serves it with the security headers
- [ ] The client source has no raw-HTML sink and loads nothing from a remote host
- [ ] Driven in a browser against the real Claude home: Now, Sessions, a session timeline and a raw record open and are correct against the transcript
- [ ] The palette and the keyboard criteria of the spec work
Test: node --test server/test/client.test.ts

## T10: Audit, Cost, Ops and Run views in both themes
Blocked by: T4, T6, T7, T8, T9
Covers: AEGIS-37
Status: ready-for-agent
What to build: the remaining views on the same shell: the audit ledger and findings with triage and export, integrity alerts and the activity log; cost charts by group with top sessions; hook, tool and API reliability with inventory and doctor; the run form and run list or the instructions to enable control mode; light and dark themes and the three layout widths.
- [ ] Driven in a browser against the real Claude home: every view renders real data with no console error
- [ ] Triage, export and reveal work end to end from the client
- [ ] Light and dark themes and the widths 900, 1280 and 1920 show no overflow or unreadable contrast
Test: node --test server/test/client.test.ts
