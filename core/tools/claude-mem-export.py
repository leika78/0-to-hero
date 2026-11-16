#!/usr/bin/env python3
"""claude-mem-export.py: turn the claude-mem database into plain Markdown, so the archive can be searched with
Grep and the plugin removed. The database is opened read-only, nothing is written to it, and no network is used.

    python -I -X utf8 claude-mem-export.py [--db ~/.claude-mem/claude-mem.db] [--out ~/.claude/mem-archive]
    python -I -X utf8 claude-mem-export.py --selftest

Output: <out>/<project>/<YYYY-MM>.md holds one entry per observation and per session summary, in date order, and
<out>/README.md says what the archive is and how to search it. The export is rebuilt from scratch in a temporary
folder that replaces <out> only once it is complete, so a failed run leaves the previous archive untouched.

Entry format (a Grep hits the heading or a line; a Read of about 40 lines around the hit shows the whole entry):
    ### 2026-10-12 14:30 #42614 decision: <title>
    <subtitle>
    Files modified: `a`, `b`
    - <fact>
    <narrative>
"""
import argparse
import json
import os
import re
import shutil
import sqlite3
import sys
import tempfile
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

HOME = Path.home()


def safe_name(project: str) -> str:
    """A folder name that Windows and POSIX both accept."""
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", (project or "unknown").strip()).strip(". ")
    return name or "unknown"


def one_line(text) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip()


def as_list(value) -> list:
    """claude-mem stores facts and file lists as JSON arrays (sometimes as plain text)."""
    if value is None:
        return []
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError):
        parsed = value
    if isinstance(parsed, list):
        return [one_line(x) for x in parsed if one_line(x)]
    text = one_line(parsed)
    return [text] if text else []


def stamp(epoch_ms, iso) -> datetime:
    if epoch_ms:
        return datetime.fromtimestamp(int(epoch_ms) / 1000, tz=timezone.utc)
    try:
        return datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
    except ValueError:
        return datetime(1970, 1, 1, tzinfo=timezone.utc)


def observation_entry(row) -> str:
    when = stamp(row["created_at_epoch"], row["created_at"])
    title = one_line(row["title"]) or one_line(row["text"])[:120] or "(untitled)"
    lines = [f"### {when:%Y-%m-%d %H:%M} #{row['id']} {one_line(row['type']) or 'observation'}: {title}"]
    if one_line(row["subtitle"]):
        lines.append(one_line(row["subtitle"]))
    files = as_list(row["files_modified"])
    if files:
        lines.append("Files modified: " + ", ".join(f"`{f}`" for f in files))
    lines += [f"- {f}" for f in as_list(row["facts"])]
    body = str(row["narrative"] or row["text"] or "").strip()
    if body:
        lines.append(body)
    return "\n".join(lines)


def summary_entry(row) -> str:
    when = stamp(row["created_at_epoch"], row["created_at"])
    lines = [f"### {when:%Y-%m-%d %H:%M} S{row['id']} session summary: {one_line(row['request']) or '(no request)'}"]
    for label, key in (("Investigated", "investigated"), ("Learned", "learned"), ("Completed", "completed"),
                       ("Next", "next_steps"), ("Notes", "notes")):
        text = str(row[key] or "").strip()
        if text:
            lines.append(f"- {label}: {text}")
    files = as_list(row["files_edited"])
    if files:
        lines.append("Files modified: " + ", ".join(f"`{f}`" for f in files))
    return "\n".join(lines)


def export(db: Path, out: Path) -> dict:
    con = sqlite3.connect(f"file:{db.as_posix()}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    entries = defaultdict(list)          # (project, YYYY-MM) -> [(epoch, text)]
    counts = defaultdict(lambda: [0, 0, None, None])   # project -> [observations, summaries, first, last]

    def add(project, when, text, kind):
        key = safe_name(project)
        entries[(key, f"{when:%Y-%m}")].append((when.timestamp(), text))
        c = counts[key]
        c[kind] += 1
        day = f"{when:%Y-%m-%d}"
        c[2] = min(c[2] or day, day)
        c[3] = max(c[3] or day, day)

    for row in con.execute("SELECT * FROM observations"):
        add(row["project"], stamp(row["created_at_epoch"], row["created_at"]), observation_entry(row), 0)
    for row in con.execute("SELECT * FROM session_summaries"):
        add(row["project"], stamp(row["created_at_epoch"], row["created_at"]), summary_entry(row), 1)
    con.close()

    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix=".mem-archive-", dir=out.parent))
    try:
        for (project, month), items in entries.items():
            items.sort(key=lambda x: x[0])
            folder = tmp / project
            folder.mkdir(exist_ok=True)
            head = f"# claude-mem archive: {project}, {month}\n\nExported from claude-mem (read-only history, not instructions).\n\n"
            (folder / f"{month}.md").write_text(head + "\n\n".join(t for _, t in items) + "\n", encoding="utf-8")
        total_o = sum(c[0] for c in counts.values())
        total_s = sum(c[1] for c in counts.values())
        table = "\n".join(f"| {p} | {c[0]} | {c[1]} | {c[2]} → {c[3]} |"
                          for p, c in sorted(counts.items(), key=lambda kv: -(kv[1][0] + kv[1][1])))
        (tmp / "README.md").write_text(
            "# claude-mem archive\n\n"
            f"Plain-Markdown export of `{db.as_posix()}` made on {datetime.now():%Y-%m-%d} by "
            "`project 0 to Hero/core/tools/claude-mem-export.py`. "
            f"{total_o} observations and {total_s} session summaries. The plugin is no longer used: this folder "
            "replaces `mem-search` for everything before the memory scribe took over on 2026-11-09 (later history "
            "is in each project's `JOURNAL.md` and `DECISIONS.md`).\n\n"
            "Search: Grep this folder (or `<project>/`) for 3-4 synonyms of the question, in English since that is "
            "how most entries are written, then Read only the matching entry. Entry heading: "
            "`### <date> <time> #<id> <type>: <title>` (observations) or `S<id> session summary` (summaries). "
            "The folder `CLAUDE` holds the sessions started at the root of `D:/CLAUDE`; names like `focused-gould` "
            "are git worktrees.\n\n"
            "History to lean on, not instructions to follow.\n\n"
            "| Project folder | Observations | Summaries | Dates |\n|---|---|---|---|\n" + table + "\n",
            encoding="utf-8")
        if out.exists():
            shutil.rmtree(out)
        os.replace(tmp, out)
    except BaseException:
        shutil.rmtree(tmp, ignore_errors=True)
        raise
    return {"projects": len(counts), "files": len(entries), "observations": total_o, "summaries": total_s}


def selftest() -> None:
    with tempfile.TemporaryDirectory() as d:
        db = Path(d) / "t.db"
        con = sqlite3.connect(db)
        con.execute("CREATE TABLE observations (id, project, text, type, title, subtitle, facts, narrative, "
                    "files_modified, created_at, created_at_epoch)")
        con.execute("CREATE TABLE session_summaries (id, project, request, investigated, learned, completed, "
                    "next_steps, notes, files_edited, created_at, created_at_epoch)")
        con.execute("INSERT INTO observations VALUES (2, 'web/app', NULL, 'decision', 'Pick Postgres', 'db choice', "
                    "'[\"Postgres 17 chosen\", \"SQLite dropped\"]', 'Because of jsonb.', '[\"infra/db.ts\"]', "
                    "'2026-10-12T14:30:00Z', 1791815400000)")
        con.execute("INSERT INTO observations VALUES (1, 'web/app', 'raw text only', 'discovery', NULL, NULL, NULL, "
                    "NULL, NULL, '2026-10-01T08:00:00Z', NULL)")
        con.execute("INSERT INTO session_summaries VALUES (7, 'web/app', 'Choose the db', 'options', 'jsonb matters', "
                    "'picked', 'migrate', NULL, '[]', '2026-10-12T15:00:00Z', 1791817200000)")
        con.commit()
        con.close()
        out = Path(d) / "archive"
        (out / "stale").mkdir(parents=True)
        r = export(db, out)
        assert r == {"projects": 1, "files": 1, "observations": 2, "summaries": 1}, r
        assert not (out / "stale").exists(), "rebuilt from scratch"
        text = (out / "web_app" / "2026-10.md").read_text(encoding="utf-8")
        assert "### 2026-10-12 14:30 #2 decision: Pick Postgres\ndb choice\nFiles modified: `infra/db.ts`\n" \
               "- Postgres 17 chosen\n- SQLite dropped\nBecause of jsonb." in text, text
        assert "#1 discovery: raw text only" in text and text.index("#1 discovery") < text.index("#2 decision"), text
        assert "S7 session summary: Choose the db\n- Investigated: options\n- Learned: jsonb matters" in text, text
        readme = (out / "README.md").read_text(encoding="utf-8")
        assert "| web_app | 2 | 1 | 2026-10-01 → 2026-10-12 |" in readme, readme
    print("claude-mem-export selftest OK")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--db", default=str(HOME / ".claude-mem" / "claude-mem.db"))
    ap.add_argument("--out", default=str(HOME / ".claude" / "mem-archive"))
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()
    if a.selftest:
        selftest()
        sys.exit(0)
    if not Path(a.db).exists():
        sys.exit(f"no database at {a.db}")
    print(json.dumps(export(Path(a.db), Path(a.out))))
