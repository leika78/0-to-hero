# Claude Hub — VS Code sidebar for the memory stack

For people who never open a terminal. A small panel at the top of the Explorer, in French or English (it follows VS Code's language), shows:

- **Claude usage** (5h and 7-day limits), same data as `/usage`.
- **Your recent projects** under one root folder (the parent of the opened workspace by default, or `claudeHub.root`). Click to open, Ctrl+click or ⧉ for a new window, type to filter.
- Under each project, **the memory in words**:
  - `✓ Memory up to date`: the scribe has read everything, `/clear` or closing is safe.
  - `↻ Behind · Update now`: some of the conversation is not read yet; the link runs the scribe right away (nothing is lost if you wait).
  - `⏳ Updating memory…` while it runs.
  - `✉ N to review`: facts or rules Claude wants confirmed. The session sorts them by itself at 5 items (or when one is 3 days old); `/memorise` does it by hand.
- **What Claude knows ›**, per project: a page with the items to review, the **facts** (`DECISIONS.md ## Facts`), the **rules** (`## Active Learnings` of each `LEARNINGS.md`), and the **last sessions** (3 newest `JOURNAL.md` blocks with the files they edited, then one line for each of the 15 before). Each part links to its file. Evidence ids and tags are hidden; the files are not changed.
- A **welcome card** the first time, four lines on how the memory works; the `?` button in the panel's title bar shows it again.

No model call. Reads `~/.claude/projects` (session activity), `~/.claude/scribe/<project>/` (cursor, lock, `pending.json`) and the project's own memory files. For the usage panel it also reads the Claude Code OAuth access token from `~/.claude/.credentials.json` (never refreshed here).

## Install

The bootstrap installs it when the `code` command exists. By hand:

```
code --install-extension tools/claude-hub/claude-hub-2.0.0.vsix
```

Then reload the window (`Developer: Reload Window`). The panel appears in the Explorer as "Claude". Requires the memory scribe installed globally (`core/hooks/scribe/README.md`); without it the panel still lists projects and usage, without the memory line.

Rebuild after a change: `npx @vscode/vsce package --allow-missing-repository --skip-license` in this folder. Check: `node extension.check.js` (add `--preview <dir>` to write the panel as HTML pages with VS Code stubbed).

## How it fits

The scribe writes directly only history (`JOURNAL.md`, `CONTEXT.md ## Current state`) and a rule quoting the owner's own correction. Everything else it finds (a new or changed fact, a fix hypothesis, a rule candidate) goes to `DECISIONS.md ## Proposals` and `LEARNINGS.md ## Candidates`, never injected; unreviewed items archive themselves (60 / 30 days). `/memorise` is the only door from there to durable memory: it decides from reading the code and asks only about what it cannot settle. The hub and the terminal statusline show the same count; with the `--inbox` hook the session runs `/memorise` by itself when the inbox fills.
