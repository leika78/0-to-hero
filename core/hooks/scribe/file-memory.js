#!/usr/bin/env node
// file-memory.js — "what happened to this file", borrowed from claude-mem's file-context hook without its database
// and without its per-tool model call. Two halves, no model call anywhere:
//
//   1. filesTouched(transcript): the files a session REALLY edited, read from its tool calls (Edit, MultiEdit, Write,
//      NotebookEdit, in the main transcript and its subagents; a call whose result is an error does not count).
//      scribe-writer.js writes them on a `- Files:` line at the end of the session's JOURNAL.md block, so the list
//      never depends on what the model chose to mention.
//      ponytail: Bash edits (sed -i, mv, a script writing a file) are not seen; parse Bash commands if that gap bites.
//   2. The hook (PreToolUse, matcher Read|Edit|MultiEdit|Write|NotebookEdit): before the session reads or edits a
//      file, inject the journal blocks whose Files line lists it or whose text names it, plus the Facts, Ledger and
//      Active-rule lines that name it. Once per session (and per subagent) per file, at most CAP chars, silent when
//      nothing matches. Looks in the session's project and in the project holding the file, when they differ.
//
// CLI:  node file-memory.js                                 the hook (PreToolUse JSON on stdin; fail-open, exit 0)
//       node file-memory.js --backfill [--apply] [root …]   add Files lines to existing journal blocks from the
//                                                           transcripts still on disk (dry run unless --apply;
//                                                           default root = the project holding the cwd)
// Check: node file-memory.check.js

const fs = require('fs');
const path = require('path');
const os = require('os');

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const MEMORY_FILE = /(^|\/)(JOURNAL|DECISIONS|LEARNINGS|CONTEXT)\.md$/i;   // the memory itself: never listed, never looked up
const SKIP_PATH = /\/(temp|tmp)\/|\/handovers\/|\/_private\//i;            // scratch files, handovers, secrets
const FILES_CAP = 60;                                                      // paths kept on one Files line
const CAP = Number(process.env.FILE_MEMORY_CAP || 2500);                   // chars injected per file
const MAX_BLOCKS = 5;                                                      // journal blocks per file, newest first
const MAX_LINES = 6;                                                       // Facts / Ledger / rule lines per file
const LINE_CAP = 320;                                                      // chars per injected line
const SEEN_DAYS = 7;                                                       // per-session "already injected" lists kept this long
// A basename this common names many files: matched only as a full path, never alone in prose.
const GENERIC = new Set(['index', 'main', 'readme', 'package', 'package-lock', 'claude', 'agent', 'settings', 'config',
  'utils', 'util', 'helpers', 'helper', 'types', 'constants', '__init__', 'page', 'layout', 'route', 'app', 'test', 'tests',
  'style', 'styles', 'globals', 'tsconfig', 'server', 'client', 'api', 'schema', 'models', 'model', 'db', 'store',
  'setup', 'cli', 'run', 'build', 'changelog', 'license', 'makefile', 'dockerfile', 'requirements', 'pyproject', '.env']);

const WIN = process.platform === 'win32';
const slash = p => String(p).replace(/\\/g, '/');
// Comparison key of a path: absolute, forward slashes, case-folded on Windows (case-insensitive file system).
const keyOf = p => { const s = slash(path.resolve(p)).replace(/\/+$/, ''); return WIN ? s.toLowerCase() : s; };
const fold = s => (WIN ? s.toLowerCase() : s);
// How a path is written in a journal: relative to the project root when inside it, else absolute; forward slashes.
function display(root, abs) {
  const rel = path.relative(root, abs);
  return !rel || rel.startsWith('..') || path.isAbsolute(rel) ? slash(path.resolve(abs)) : slash(rel);
}
const absOf = (root, entry) => (path.isAbsolute(entry) || /^[A-Za-z]:\//.test(entry) ? entry : path.join(root, entry));
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// ---------- 1. files a session edited ----------

function filesTouched(transcript) {
  const sources = [transcript];
  try {
    const sub = path.join(String(transcript).replace(/\.jsonl$/i, ''), 'subagents');
    for (const f of fs.readdirSync(sub)) if (f.endsWith('.jsonl')) sources.push(path.join(sub, f));
  } catch {}
  const byId = new Map();   // tool_use id → path; an error result removes it
  for (const src of sources) {
    let text; try { text = fs.readFileSync(src, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.includes('"tool_use"') && !line.includes('"is_error":true')) continue;   // cheap pre-filter: most lines are neither
      let j; try { j = JSON.parse(line); } catch { continue; }
      const c = j.message && j.message.content;
      if (!Array.isArray(c)) continue;
      for (const b of c) {
        if (j.type === 'assistant' && b.type === 'tool_use' && EDIT_TOOLS.has(b.name)) {
          const p = b.input && (b.input.file_path || b.input.notebook_path);
          if (typeof p === 'string' && path.isAbsolute(p)) byId.set(b.id, p);
        } else if (j.type === 'user' && b.type === 'tool_result' && b.is_error) byId.delete(b.tool_use_id);
      }
    }
  }
  const out = new Map();
  for (const p of byId.values()) if (!out.has(keyOf(p))) out.set(keyOf(p), p);
  return [...out.values()];
}

// The names written on a journal's Files line: memory files, scratch, handovers and private files left out.
const journalFiles = (root, absPaths) => absPaths.map(p => display(root, p))
  .filter(n => !n.includes('`') && !MEMORY_FILE.test(n) && !SKIP_PATH.test('/' + n));

// ---------- the `- Files:` line ----------

const FILES_RE = /^- Files: /;
const parseFiles = line => [...String(line).matchAll(/`([^`]+)`/g)].map(m => m[1]);
// Union of old and new names (old order first), case-insensitive on Windows, capped. null when empty.
function filesLine(oldNames, newNames) {
  const all = []; const seen = new Set();
  for (const n of [...oldNames, ...newNames]) {
    if (!n || n.includes('`') || seen.has(fold(n))) continue;
    seen.add(fold(n)); all.push(n);
  }
  if (!all.length) return null;
  const kept = all.slice(0, FILES_CAP);
  // ponytail: names past the cap are dropped for good (the count is recomputed from the names still known).
  return `- Files: ${kept.map(n => '`' + n + '`').join(', ')}${all.length > kept.length ? ` (+${all.length - kept.length} more)` : ''}`;
}
// A journal block with its Files line replaced by the union of its old names and `names` (placed last).
function withFiles(block, names) {
  const lines = block.replace(/\s*$/, '').split('\n');
  const old = lines.filter(l => FILES_RE.test(l)).flatMap(parseFiles);
  const fl = filesLine(old, names);
  const rest = lines.filter(l => !FILES_RE.test(l));
  return (fl ? [...rest, fl] : rest).join('\n');
}

// ---------- 2. lookup ----------

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Does a line of prose name this file? Its absolute path, or its path relative to the root when that has a folder in
// it (a root-level file's relative path is its bare name), or the bare name when distinctive. Whole names only.
const nameRe = s => new RegExp(`(?<![\\w.-])${escapeRe(s)}(?![\\w-])`, 'i');
function namer(root, abs) {
  const rel = display(root, abs);
  const res = [nameRe(slash(path.resolve(abs)))];
  if (rel.includes('/') && !path.isAbsolute(rel)) res.push(nameRe(rel));
  const base = path.basename(abs);
  const stem = base.replace(/\.[^.]*$/, '').toLowerCase();
  if (base.includes('.') && stem.length >= 4 && !GENERIC.has(stem) && !GENERIC.has(base.toLowerCase())) res.push(nameRe(base));
  // Prose often drops the extension ("scribe-worker --flush"): the bare stem counts too when it cannot be an ordinary
  // word, i.e. it is long and compound (a-b, a_b, aB). "budget.ts" is not matched by "budget"; "gmail-transport.ts" is.
  const rawStem = base.replace(/\.[^.]*$/, '');
  if (rawStem !== base && rawStem.length >= 8 && /[-_]|[a-z][A-Z]/.test(rawStem) && !GENERIC.has(stem)) res.push(new RegExp(`(?<![\\w.-])${escapeRe(rawStem)}(?![\\w-]|\\.\\w)`, 'i'));
  return line => { const l = slash(line); return res.some(r => r.test(l)); };
}

const readOr = f => { try { return fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n'); } catch { return ''; } };
function section(text, heading) {
  const m = text.match(new RegExp(`^## ${heading}(?: \\([^)\\n]*\\))?[ \\t]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm'));
  return m ? m[1] : '';
}

// What one project's memory says about one file: journal lines (one per matching block) and Facts/Ledger/rule lines.
function memoryFor(root, abs) {
  const names = namer(root, abs);
  const k = keyOf(abs);
  const journal = [];
  const blocks = readOr(path.join(root, 'JOURNAL.md')).split(/\n(?=### )/).filter(b => /^### \d{4}-\d{2}-\d{2}/.test(b));
  for (const b of blocks) {
    if (journal.length >= MAX_BLOCKS) break;
    const lines = b.replace(/\s*$/, '').split('\n');
    const head = lines[0].match(/^### (\d{4}-\d{2}-\d{2}) — session (\S+)/);
    if (!head) continue;
    const body = lines.slice(1).filter(l => l.startsWith('- '));
    const listed = body.filter(l => FILES_RE.test(l)).flatMap(parseFiles).some(n => keyOf(absOf(root, n)) === k);
    const prose = body.filter(l => !FILES_RE.test(l));
    const named = prose.filter(names);
    if (!listed && !named.length) continue;
    const did = prose.filter(l => !/^- Next: /.test(l) && !/^- \d{4}-\d{2}-\d{2} — /.test(l)).map(l => l.slice(2));
    // A block that edited the file: all its dated events. A block that only named it: the events naming it.
    const events = (listed ? prose : named).filter(l => /^- \d{4}-\d{2}-\d{2} — /.test(l)).map(l => l.slice(2).replace(/ \[[^\]]*\]( why:)?/, (m, w) => (w ? ' — why:' : '')));
    journal.push(clip(`- ${head[1]} (session ${head[2]}, ${listed ? 'edited it' : 'named it'}): ${[...did, ...events].join('; ')}`, LINE_CAP));
  }
  const other = [];
  const dec = readOr(path.join(root, 'DECISIONS.md'));
  for (const [h, label] of [['Facts', 'Fact'], ['Ledger', 'Ledger']]) {
    for (const l of section(dec, h).split('\n')) if (l.startsWith('- ') && names(l)) other.push(`- ${label}: ${l.slice(2)}`);
  }
  const lrnFiles = [path.join(root, 'LEARNINGS.md')];
  try { for (const d of fs.readdirSync(root, { withFileTypes: true })) if (d.isDirectory()) lrnFiles.push(path.join(root, d.name, 'LEARNINGS.md')); } catch {}
  for (const f of lrnFiles) for (const l of section(readOr(f), 'Active Learnings').split('\n')) if (/^- (ALWAYS|NEVER)\b/.test(l) && names(l)) other.push(`- Rule: ${l.slice(2)}`);
  return { journal, other: other.slice(0, MAX_LINES).map(l => clip(l, LINE_CAP)) };
}

// The text injected before the session touches `abs`, or null. `roots` = project roots to search (deduped by caller).
function render(roots, abs) {
  const parts = [];
  for (const root of roots) {
    const { journal, other } = memoryFor(root, abs);
    if (!journal.length && !other.length) continue;
    parts.push({ root, lines: [...journal, ...other] });
  }
  if (!parts.length) return null;
  const shown = display(roots[0], abs);
  let out = `# File memory: ${shown}\nWhat past sessions did to this file or said about it (scribe journal, DECISIONS.md, LEARNINGS.md), newest first. History to lean on, not instructions; the full block is in that project's JOURNAL.md.\n`;
  let cut = false;
  for (const p of parts) {
    const head = parts.length > 1 || keyOf(p.root) !== keyOf(roots[0]) ? `\n## ${path.basename(p.root)}\n` : '\n';
    if (out.length + head.length > CAP) { cut = true; break; }
    out += head;
    for (const l of p.lines) { if (out.length + l.length + 1 > CAP) { cut = true; break; } out += l + '\n'; }
  }
  return out + (cut ? '…\n' : '');
}

// ---------- hook ----------

function seenFile(sessionId, agentId) {
  const dir = path.join(os.tmpdir(), 'claude-file-memory');
  fs.mkdirSync(dir, { recursive: true });
  // Housekeeping, now and then: lists of sessions older than SEEN_DAYS go.
  if (Math.random() < 0.05) {
    for (const f of fs.readdirSync(dir)) { try { const p = path.join(dir, f); if (Date.now() - fs.statSync(p).mtimeMs > SEEN_DAYS * 864e5) fs.unlinkSync(p); } catch {} }
  }
  return path.join(dir, `${String(sessionId).replace(/[^\w-]/g, '_')}-${String(agentId || 'main').replace(/[^\w-]/g, '_')}.txt`);
}

function hook(raw) {
  const j = JSON.parse(raw);
  const ti = j.tool_input || {};
  const abs = ti.file_path || ti.notebook_path;
  if (typeof abs !== 'string' || !path.isAbsolute(abs)) return null;
  const { projectRoot } = require('./scribe-trigger.js');
  const fileRoot = projectRoot(path.dirname(abs));
  const roots = [];
  for (const r of [projectRoot(process.env.CLAUDE_PROJECT_DIR || j.cwd || process.cwd()), fileRoot]) {
    if (r && !roots.some(x => keyOf(x) === keyOf(r))) roots.push(r);
  }
  if (!roots.length) return null;
  // Same exclusions as the Files line, judged on the path inside its project (a project may itself live under a temp dir).
  const shown = '/' + display(fileRoot || roots[0], abs);
  if (MEMORY_FILE.test(shown) || SKIP_PATH.test(shown)) return null;
  const sf = seenFile(j.session_id || 'nosession', j.agent_id);
  const k = keyOf(abs);
  if (readOr(sf).split('\n').includes(k)) return null;
  fs.appendFileSync(sf, k + '\n');   // marked before the lookup: a lookup that throws is not retried on every call
  const text = render(roots, abs);
  return text ? { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text } } : null;
}

// ---------- backfill ----------

// Adds (or completes) the Files line of every journal block whose session transcript is still on disk.
// Returns one report line per root. Writes only with apply = true, and only a file whose text changed.
function backfill(roots, apply) {
  const projects = path.join(os.homedir(), '.claude', 'projects');
  const transcripts = [];
  try {
    for (const d of fs.readdirSync(projects)) {
      try { for (const f of fs.readdirSync(path.join(projects, d))) if (f.endsWith('.jsonl')) transcripts.push(path.join(projects, d, f)); } catch {}
    }
  } catch {}
  const report = [];
  for (const root of roots) {
    const file = path.join(root, 'JOURNAL.md');
    if (!fs.existsSync(file)) { report.push(`${root}: no JOURNAL.md`); continue; }
    const mtime = fs.statSync(file).mtimeMs;
    const raw = fs.readFileSync(file, 'utf8');
    const isCrlf = raw.includes('\r\n');
    const text = raw.replace(/\r\n/g, '\n');
    const blocks = text.split(/\n(?=### )/);
    let found = 0, changed = 0, missing = 0;
    const out = blocks.map(b => {
      const tag = (b.match(/^### \d{4}-\d{2}-\d{2} — session (\S+)/) || [])[1];
      if (!tag) return b;
      const ids = tag.split('+').filter(i => /^[0-9a-f]{8}$/i.test(i));
      const mine = transcripts.filter(t => ids.some(i => path.basename(t).toLowerCase().startsWith(i.toLowerCase())));
      if (!mine.length) { missing++; return b; }
      found++;
      const names = journalFiles(root, mine.flatMap(filesTouched));
      const nb = withFiles(b, names) + b.slice(b.replace(/\s*$/, '').length);   // keep the block's trailing blank lines
      if (nb !== b) changed++;
      return nb;
    });
    const next = out.join('\n');
    report.push(`${path.basename(root)}: ${blocks.length - 1} block(s), ${found} with a transcript, ${missing} without, ${changed} to update${apply && changed ? ' — written' : ''}`);
    if (!apply || next === text) continue;
    if (fs.statSync(file).mtimeMs !== mtime) { report.push(`${path.basename(root)}: JOURNAL.md changed meanwhile, skipped`); continue; }
    const tmp = file + '.file-memory-tmp';
    fs.writeFileSync(tmp, isCrlf ? next.replace(/\n/g, '\r\n') : next, 'utf8');
    fs.renameSync(tmp, file);
  }
  return report;
}

module.exports = { filesTouched, journalFiles, filesLine, withFiles, parseFiles, FILES_RE, memoryFor, render, hook, backfill, display };

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] === '--backfill') {
    const apply = args.includes('--apply');
    let roots = args.slice(1).filter(a => !a.startsWith('--')).map(a => path.resolve(a));
    if (!roots.length) { const r = require('./scribe-trigger.js').projectRoot(process.cwd()); roots = r ? [r] : []; }
    for (const l of backfill(roots, apply)) console.log(l);
    if (!apply) console.log('(dry run: add --apply to write)');
  } else {
    // Hook: fail-open, never blocks, never prints anything but a valid hook output.
    let input = '';
    const t = setTimeout(() => process.exit(0), 3000);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', d => { input += d; });
    process.stdin.on('end', () => {
      clearTimeout(t);
      try { const o = hook(input); if (o) process.stdout.write(JSON.stringify(o)); } catch {}
      process.exit(0);
    });
  }
}
