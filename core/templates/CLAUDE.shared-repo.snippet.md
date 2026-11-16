## Shared repo
<!-- shared-repo -->

Several people work on this repo, each with their own Claude Code. `JOURNAL.md` and the file-memory hook only know the sessions run on **this machine** unless the journal is versioned — the handoff is the versioned memory files.

- **Resume**: before working in a workspace, read the root `JOURNAL.md` (newest blocks first, one per session) and the workspace `CONTEXT.md ## Current state`, and say in one line what the other person last did there.
- **Close**: commit the memory files (`JOURNAL.md`, `CONTEXT.md`, `LEARNINGS.md`, `DECISIONS.md`) with the session's work → push. Pull before starting. `/memorise` is optional, as everywhere.
- **Journal conflict on merge**: keep both session blocks, newest first; `## Current state` keeps one block per session, so blocks never collide.
