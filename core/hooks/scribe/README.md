# Memory scribe (v0.5 — sorter, journal, no nag)

Background scribe that reads each session's transcript delta and writes the memory files while the session runs.
It writes **history** directly — `JOURNAL.md` (one block per session: did, next, and up to 8 notes per run: one dated line
each, typed `discovery` / `gotcha` / `bugfix` / `decision` / `change`, with its evidence id, no review), `<ws>/CONTEXT.md ## Current state`
(one block per recent session) and an `## Active Learnings` rule only when it quotes the owner's own correction — and queues
**every judgement** for the owner: a new `Facts` key or a changed value → `DECISIONS.md ## Proposals` (the Facts line gets
`⚠ disputed → new (date)`, never overwritten), a `[fix]` hypothesis → `## Proposals`, at most one rule candidate per run →
`<ws>/LEARNINGS.md ## Candidates`. Unreviewed proposals expire to `## Proposals archive` after 60 days, candidates to
`## Archived Learnings` after 30: the inbox is bounded without a human, and nothing in the session ever asks for `/memorise`.
Rationale and measured numbers: `core/decisions/adr-archive.md` (2026-11-08, 2026-11-09, 2026-11-11).

| File | Role |
|------|------|
| `scribe-trigger.js` | `Stop` + `SessionEnd` hook. Queues the turn, prints the previous run's report, spawns the worker (one run per project per 5 min; `SessionEnd` = flush). Fail-open, never blocks. Registered a second time on `Stop` as `--inbox` (synchronous): holds the turn once per attended session when the memory inbox is full, so the session drains it. |
| `scribe-worker.js` | Background worker. Trims the transcript delta from a durable cursor, one lean `claude -p` call per project, verifies every evidence id (a Read of a memory file is never evidence; a rule worded like a tool RESULT is dropped; one candidate per run), applies through the writer, runs the expiry pass, logs tokens, journals the run. |
| `scribe-writer.js` | Bounded, deterministic writes. Only the destinations above, atomic temp+rename, fuzzy dedup of candidates, a proposal the owner already settled is never queued again, `expire()` (30 / 60 days, plus lines already tagged with an outcome and leftover `[log]` proposals). `node scribe-writer.js --selftest`. |
| `scribe-worker.check.js` | Offline check of verify / signal filter / cursor / lock. `node scribe-worker.check.js`. |
| `root.check.js` | Offline check of project-root resolution (JS and the bash injector agree, a `cd` does not move it) and of the light-project `.` workspace. `node root.check.js`. |
| `../inject-journal.sh` | Second `SessionStart` hook: coverage line, 3 newest journal blocks (summary + next), the project's 30 newest notes whatever their session, one index line (date + first summary line) per older block (15), Current state per workspace, under its own 9k cap (index lines go first, then Current state, then the oldest notes). |
| `file-memory.js` | `PreToolUse` hook (`Read\|Edit\|MultiEdit\|Write\|NotebookEdit`): before the session touches a file, injects the journal blocks whose `- Files:` line lists it or whose text names it, plus the Facts / Ledger / Active-rule lines naming it. Once per session (and subagent) per file, ≤ 2.5k chars, silent when nothing matches. Also `filesTouched()`, which the worker uses to fill the `- Files:` line from the tool calls (main transcript + subagents, failed calls excluded), and `--backfill [--apply] <root>…` for blocks written before. |
| `file-memory.check.js` | Offline check of the files read from tool calls, the Files line, the hook, the startup index and the backfill. `node file-memory.check.js`. |

## Install (once per machine)

The injectors, the statusline and the scribe share one project-root rule, so install them together, same layout (the statusline loads `scribe/scribe-trigger.js` next to itself):

```
mkdir -p ~/.claude/hooks/scribe
cp core/hooks/scribe/*.js ~/.claude/hooks/scribe/
cp core/hooks/inject-learnings.sh core/hooks/inject-journal.sh core/hooks/claude-statusline.js ~/.claude/hooks/
# file-memory.js is in scribe/*.js: the worker, the writer and the PreToolUse hook all load it from there
```

The repo's `.claude/settings.json` calls `~/.claude/hooks/inject-learnings.sh`: it does nothing until this step is done.

`~/.claude/settings.json`: the trigger on both events (`async: true` so the session never waits), the journal injector on `SessionStart` (global: silent outside Durcir projects):

```json
"SessionStart": [{ "hooks": [{ "type": "command", "command": "bash ~/.claude/hooks/inject-journal.sh", "timeout": 10 }] }],
"Stop":         [{ "hooks": [{ "type": "command", "command": "node ~/.claude/hooks/scribe/scribe-trigger.js", "timeout": 10, "async": true },
                              { "type": "command", "command": "node ~/.claude/hooks/scribe/scribe-trigger.js --inbox", "timeout": 10 }] }],
"SessionEnd":   [{ "hooks": [{ "type": "command", "command": "node ~/.claude/hooks/scribe/scribe-trigger.js", "timeout": 10, "async": true }] }],
"PreToolUse":   [{ "matcher": "Read|Edit|MultiEdit|Write|NotebookEdit",
                   "hooks": [{ "type": "command", "command": "node ~/.claude/hooks/scribe/file-memory.js", "timeout": 5 }] }]
```

The `PreToolUse` entry is the file memory: synchronous (its output must reach the turn), about 0.1 s per call, nothing printed when the file has no history. Once installed, give the existing journals their `- Files:` lines: `node ~/.claude/hooks/scribe/file-memory.js --backfill <root>…` (dry run, one report line per project), then the same with `--apply`. Only blocks whose transcript is still in `~/.claude/projects` can be filled (`cleanupPeriodDays`); older blocks are still found by name.

The second `Stop` entry (`--inbox`, synchronous, optional) makes the review automatic: when a project's inbox reaches 5 items, or its oldest item has waited 3 days, the hook holds the turn once per session and the session drains the inbox itself — a background subagent follows `/memorise`, decides from reading, and the owner is asked only about what it could not settle and about fixes to apply. Attended sessions only (`CLAUDE_CODE_SESSION_ATTENDED=1`); without that entry `/memorise` stays a manual command.

On Windows use the full `node.exe` path (and a hidden-console launcher if the Stop hook flashes a window).

## Environment (all optional, `env` block of `settings.json`)

| Variable | Default | Meaning |
|----------|---------|---------|
| `SCRIBE_ROOTS` | unset = every Durcir project | `;`-separated folders whose projects are watched |
| `SCRIBE_MODEL` | `sonnet` | model for the one call per run |
| `SCRIBE_DAILY_TOKENS` | 4 000 000 | machine-wide daily cap, all projects |
| `SCRIBE_SESSION_TOKENS` | 600 000 | per-session cap; raise one session by writing a number into `~/.claude/scribe/<slug>/budget-<session_id>` |
| `MAX_APPLY_FAILURES` (constant) | 3 | a delta whose apply reports an error (missing destination, race) is re-sent up to 3 times, then dropped with an alert naming the loss |
| `CANDIDATE_DAYS` / `PROPOSAL_DAYS` (constants) | 30 / 60 | expiry of an unreviewed candidate / proposal to its archive section |
| `JOURNAL_BLOCKS`, `JOURNAL_BLOCK_CAP`, `JOURNAL_STATE_CAP`, `JOURNAL_MAX_CHARS` | 3, 1800, 500, 9000 | `inject-journal.sh` budgets (chars, whole lines only) |
| `JOURNAL_INDEX`, `JOURNAL_INDEX_CAP` | 15, 160 | older blocks listed as one index line each (0 = none), chars of summary per line |
| `JOURNAL_NOTES`, `JOURNAL_NOTE_CAP` | 30, 170 | newest notes of the project injected at start (0 = none), chars per note |
| `MAX_NOTES` (constant) | 8 | notes the scribe may write per run |
| `FILE_MEMORY_CAP` | 2500 | chars injected by `file-memory.js` per file |
| `SCRIBE_DISCORD_WEBHOOK` | unset | webhook URL for budget / failure alerts |
| `SCRIBE_DISCORD_ENV` | unset | alternative: a `KEY=VALUE` file holding `DISCORD_WEBHOOK_AUDIT` or `DISCORD_WEBHOOK_SESSIONS` |

Project root = the nearest folder at or above `CLAUDE_PROJECT_DIR` (the session's start folder, set by Claude Code, unaffected by `cd`) holding both `CLAUDE.md` and `DECISIONS.md`; none → the turn is ignored. State, slug and writes all use that root. A project with no `<workspace>/AGENT.md` is a light project: its rule candidates go to the root `LEARNINGS.md` (workspace `.`), no Current state is written, the journal still is.

## State (`~/.claude/scribe/<slug>/`)

`queue.jsonl` turns waiting · `cursors/<session>.json` last transcript line read · `journal.jsonl` one line per run (sessions, cursor ranges, applied, rejected) · `usage.jsonl` tokens per run · `report.txt` one-line report printed at the next Stop · `worker.lock` while a run is in progress · `pending.json` memory inbox (`proposals`, `candidates`, `oldest`, `alert` = any pending) read by the statusline and the hub — rewritten at each worker run, deleted by `/memorise` after a review.

## Seeing where the scribe is

The question the owner asks is "can I `/clear` without losing anything?". The answer is always yes (the queue keeps the old session, the next run drains it). Three passive surfaces read the same state, none calls a model, none asks for anything:

- `claude-statusline.js` (terminal): `✍✓` up to date · `✍ N` N transcript lines not yet read · `✍⏳` running · `✉ N` items waiting for review, whenever you feel like `/memorise`.
- `tools/claude-hub/` (VS Code sidebar, for people who never open a terminal): the same badge per project, the inbox count, a "run the scribe now" button, and a click on `✉` that opens `DECISIONS.md ## Proposals`.
- Stop hook `systemMessage` (every host, VS Code included): `scribe: journal +1 block · web state updated · … · 446k tokens today` after each run.
- SessionStart (`inject-journal.sh`): "History covered up to <date>; N turn(s) queued, not yet read" — a dead or late worker is visible as a gap, never mistaken for silence.
