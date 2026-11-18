// node file-memory.check.js — smallest check that fails if the file memory breaks: files read from the tool calls
// (errors and reads excluded, subagents included), the Files line (union, cap, written by the writer, hidden from the
// model and from the session start), the hook (match by Files line / by name / Ledger / rule, once per session, memory
// files and generic names left alone), the startup index, the backfill (dry run writes nothing, apply is idempotent).
// No model call; everything happens in a temp folder with a fake HOME / TEMP.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const fm = require('./file-memory.js');
const writer = require('./scribe-writer.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'file-memory-check-'));
const root = path.join(tmp, 'proj');
const other = path.join(tmp, 'other');
fs.mkdirSync(path.join(root, 'core', 'hooks'), { recursive: true });
fs.mkdirSync(path.join(root, 'web'), { recursive: true });
fs.mkdirSync(other, { recursive: true });
for (const d of [root, other]) { fs.writeFileSync(path.join(d, 'CLAUDE.md'), '# p\n'); fs.writeFileSync(path.join(d, 'DECISIONS.md'), '# D\n'); }
const P = (...a) => path.join(root, ...a);
const line = o => JSON.stringify(o);
const use = (id, name, input) => line({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const res = (id, isError) => line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'x', ...(isError ? { is_error: true } : {}) }] } });

// ---- 1. filesTouched ----
const home = path.join(tmp, 'home');
const pdir = path.join(home, '.claude', 'projects', 'd--proj');
fs.mkdirSync(path.join(pdir, 'aaaa1111-0000-0000-0000-000000000000', 'subagents'), { recursive: true });
const tr = path.join(pdir, 'aaaa1111-0000-0000-0000-000000000000.jsonl');
fs.writeFileSync(tr, [
  line({ type: 'api-request-shape', shape: { text: 'mentions "tool_use" and "name":"Edit" in a schema' } }),   // not a tool call
  use('t1', 'Edit', { file_path: P('core', 'hooks', 'scribe-worker.js') }), res('t1'),
  use('t2', 'Write', { file_path: P('web', 'broken.ts') }), res('t2', true),                    // failed → not counted
  use('t3', 'Read', { file_path: P('web', 'read-only.ts') }), res('t3'),                         // read → not counted
  use('t4', 'NotebookEdit', { notebook_path: P('web', 'nb.ipynb') }), res('t4'),
  use('t5', 'Edit', { file_path: P('JOURNAL.md') }), res('t5'),                                  // memory file → kept by filesTouched, dropped by journalFiles
  use('t6', 'Write', { file_path: path.join(tmp, 'Temp', 'scratch.txt') }), res('t6'),          // scratch → dropped
  use('t7', 'Edit', { file_path: P('core', 'hooks', 'scribe-worker.js').toUpperCase() }), res('t7'),   // same file, other case
  use('t8', 'Edit', { file_path: path.join(other, 'lib.py') }), res('t8'),                       // outside the root → absolute
  '{"broken json',
].join('\n'));
fs.writeFileSync(path.join(pdir, 'aaaa1111-0000-0000-0000-000000000000', 'subagents', 'agent-x.jsonl'), [use('s1', 'MultiEdit', { file_path: P('web', 'sub.ts') }), res('s1')].join('\n'));
const touched = fm.filesTouched(tr);
const names = fm.journalFiles(root, touched);
assert.strictEqual(touched.length, process.platform === 'win32' ? 6 : 7, 'edits counted once per file (case-folded on Windows): ' + JSON.stringify(touched));
// other/lib.py is outside the root, so it is written absolute — and this check runs under the OS temp dir, so that
// absolute path is a scratch path and is dropped like the scratchpad would be.
assert.deepStrictEqual(names.slice(0, 3), ['core/hooks/scribe-worker.js', 'web/nb.ipynb', 'web/sub.ts'], 'files really edited, subagents in, errors/reads/memory/scratch out: ' + JSON.stringify(names));
assert.strictEqual(names.length, 3, 'nothing else: ' + JSON.stringify(names));
assert.strictEqual(fm.display(root, path.resolve('/srv/other/lib.py')), path.resolve('/srv/other/lib.py').replace(/\\/g, '/'), 'outside the root: absolute, forward slashes');
assert.deepStrictEqual(fm.journalFiles(root, [path.resolve('/srv/other/lib.py'), path.resolve('/srv/x/handovers/h.md'), P('_private', '.env')]), [path.resolve('/srv/other/lib.py').replace(/\\/g, '/')], 'absolute kept; handovers and _private dropped');

// ---- 2. Files line ----
assert.strictEqual(fm.filesLine([], []), null, 'no files, no line');
assert.strictEqual(fm.filesLine(['a.js'], ['b.js', 'A.js'.toLowerCase(), 'a`b']), '- Files: `a.js`, `b.js`', 'union, dedup, backtick names dropped');
const many = Array.from({ length: 70 }, (_, i) => `f${i}.js`);
assert(/^- Files: `f0\.js`.*`f59\.js` \(\+10 more\)$/.test(fm.filesLine([], many)), 'capped at 60 with a count');
assert.deepStrictEqual(fm.parseFiles('- Files: `a b/c.js`, `d.ts`'), ['a b/c.js', 'd.ts'], 'paths with spaces parse');

// ---- writer: the Files line is written, merged across runs, not duplicated ----
writer.apply(root, { summary: { did: ['scribe-worker.js: delta capped at 40k chars'], next: 'test it' }, files: names }, ['aaaa1111-0000']);
writer.apply(root, { summary: { did: ['scribe-worker.js: delta capped at 40k chars', 'web/extra.ts added'] }, files: ['web/extra.ts'] }, ['aaaa1111-0000']);
let jr = fs.readFileSync(P('JOURNAL.md'), 'utf8');
assert.strictEqual((jr.match(/^- Files: /gm) || []).length, 1, 'one Files line per block: ' + jr);
assert(/- Files: `core\/hooks\/scribe-worker\.js`.*`web\/extra\.ts`\n?$/i.test(jr.trim().split('\n').pop()) && /- web\/extra\.ts added\n- Files: /.test(jr), 'Files line last, union of both runs: ' + jr);
writer.apply(root, { summary: { did: ['Other session touched nothing'] } }, ['bbbb2222']);
jr = fs.readFileSync(P('JOURNAL.md'), 'utf8');
assert(/### [\d-]+ — session bbbb2222\n- Other session touched nothing\n/.test(jr) && (jr.match(/^- Files: /gm) || []).length === 1, 'a session with no edits gets no Files line: ' + jr);

// ---- worker: the model never sees the Files line ----
process.argv[2] = process.argv[2] || 'check';
const { memorySnapshot } = require('./scribe-worker.js');
const snap = memorySnapshot(root, ['.'], 'delta', ['aaaa1111-0000']);
assert(snap.includes('delta capped at 40k') && !snap.includes('- Files:'), 'snapshot shows the block without its Files line: ' + snap);

// ---- 3. hook ----
fs.writeFileSync(P('JOURNAL.md'), [
  '# Journal', '',
  '### 2026-11-16 — session cccc3333', '- Unrelated work on web/app.ts', '- Files: `web/app.ts`', '',
  '### 2026-11-15 — session aaaa1111', '- Capped the scribe delta', '- Next: test it', '- 2026-11-15 — cap chosen at 40k [toolu_x] why: budget', '- Files: `core/hooks/scribe-worker.js`', '',
  '### 2026-11-10 — session dddd4444', '- Fixed a regex in scribe-worker.js (CRLF)', '',
  '### 2026-11-05 — session gggg7777', '- Ran scribe-worker --flush by hand', '',
  '### 2026-11-04 — session hhhh8888', '- Only scribe-worker.check.js changed', '',
  '### 2026-11-03 — session iiii9999', '- Daily budget raised to 2M', '',
  '### 2026-11-01 — session eeee5555', '- Rewrote index.js and README.md', '',
].join('\n'));
fs.writeFileSync(P('DECISIONS.md'), '# D\n\n## Facts (current)\n- **Scribe cap**: scribe-worker.js reads 40k chars per run (since 2026-11-15)\n\n## Proposals\n- [fact] **Ignored**: scribe-worker.js proposal (2026-11-15) [toolu_p]\n\n## Ledger\n- 2026-11-09 — scribe-worker.js became the memory writer\n- 2026-11-08 — unrelated\n');
fs.writeFileSync(P('LEARNINGS.md'), '# L\n\n## Active Learnings\n- NEVER patch scribe-worker.js through a heredoc (escaping)\n\n## Candidates\n- NEVER candidate about scribe-worker.js (x)\n');
const temp = path.join(tmp, 'temp');
fs.mkdirSync(temp);
const runHook = (input, env = {}) => {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'file-memory.js')], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp, CLAUDE_PROJECT_DIR: root, ...env } });
  assert.strictEqual(r.status, 0, 'hook exits 0: ' + r.stderr);
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null;
};
const call = (file, session = 's1', extra = {}) => runHook({ session_id: session, cwd: root, tool_name: 'Read', tool_input: { file_path: file }, ...extra });
const out = call(P('core', 'hooks', 'scribe-worker.js'));
assert(out && out.hookEventName === 'PreToolUse', 'hook answers for a known file');
const ctx = out.additionalContext;
assert(ctx.startsWith('# File memory: core/hooks/scribe-worker.js'), 'header names the file relative to the root: ' + ctx);
assert(/- 2026-11-15 \(session aaaa1111, edited it\): Capped the scribe delta; 2026-11-15 — cap chosen at 40k — why: budget/.test(ctx), 'block found by its Files line, event kept, evidence id dropped: ' + ctx);
assert(/- 2026-11-10 \(session dddd4444, named it\): Fixed a regex in scribe-worker\.js/.test(ctx), 'old block found by name: ' + ctx);
assert(ctx.indexOf('2026-11-15') < ctx.indexOf('2026-11-10'), 'newest first');
assert(ctx.includes('gggg7777, named it): Ran scribe-worker --flush') && !ctx.includes('hhhh8888'), 'compound stem without extension matches; another file sharing the stem does not: ' + ctx);
assert(!ctx.includes('cccc3333') && !ctx.includes('Next:') && !ctx.includes('- Files:'), 'unrelated block, Next and Files lines left out: ' + ctx);
assert(ctx.includes('- Fact: **Scribe cap**') && ctx.includes('- Ledger: 2026-11-09 — scribe-worker.js became') && ctx.includes('- Rule: NEVER patch scribe-worker.js') && !ctx.includes('unrelated') && !ctx.includes('Ignored') && !ctx.includes('candidate about'), 'Facts, Ledger, Active rules; never Proposals or Candidates: ' + ctx);
assert.strictEqual(call(P('core', 'hooks', 'scribe-worker.js')), null, 'once per session and file');
assert(call(P('core', 'hooks', 'scribe-worker.js'), 's1', { agent_id: 'sub1' }), 'a subagent gets it once too');
assert(call(P('core', 'hooks', 'scribe-worker.js'), 's2'), 'another session gets it again');
assert.strictEqual(call(P('index.js'), 's1'), null, 'a generic basename is never matched in prose');
assert.strictEqual(call(P('web', 'budget.ts'), 's1'), null, 'a stem that is an ordinary word ("budget") is not matched without its extension');
assert.strictEqual(call(P('JOURNAL.md'), 's1'), null, 'memory files are not looked up');
assert.strictEqual(call(P('web', 'nothing.ts'), 's1'), null, 'no memory, no output');
assert.strictEqual(call('relative/path.js', 's1'), null, 'relative paths ignored');
assert.strictEqual(runHook({ session_id: 's1', tool_input: {} }), null, 'no path, no output');
const garbage = spawnSync(process.execPath, [path.join(__dirname, 'file-memory.js')], { input: 'not json', encoding: 'utf8', env: { ...process.env, TEMP: temp, TMP: temp } });
assert(garbage.status === 0 && garbage.stdout === '', 'garbage stdin: silent exit 0');
// A file of another project: its own memory is searched, under its project name.
fs.writeFileSync(path.join(other, 'JOURNAL.md'), '# Journal\n\n### 2026-11-12 — session ffff6666\n- Built lib.py loader\n- Files: `lib.py`\n');
const o2 = call(path.join(other, 'lib.py'), 's3');
assert(o2 && o2.additionalContext.includes('## other') && o2.additionalContext.includes('Built lib.py loader'), 'file of another project: that project memory, labelled: ' + (o2 && o2.additionalContext));
// Cap: a long history is cut on whole lines.
const big = ['# Journal', ''];
for (let i = 0; i < 40; i++) big.push(`### 2026-10-${String(1 + (i % 28)).padStart(2, '0')} — session ${String(i).padStart(8, '0')}`, `- ${'long line about scribe-worker.js '.repeat(12)}`, '');
fs.writeFileSync(P('JOURNAL.md'), big.join('\n'));
const o3 = call(P('core', 'hooks', 'scribe-worker.js'), 's4').additionalContext;
assert(o3.length <= 2600 && (o3.match(/^- 2026-10-/gm) || []).length === 5, 'at most 5 blocks and the char cap: ' + o3.length);

// ---- 4. startup index (inject-journal.sh) ----
// Git for Windows' bin/bash.exe sets up PATH (grep, sed, awk) even when launched from PowerShell; usr/bin/bash.exe does not.
const gitBash = 'C:/Program Files/Git/bin/bash.exe';
const bash = process.platform === 'win32' && fs.existsSync(gitBash) ? gitBash : 'bash';
if (spawnSync(bash, ['-c', 'command -v awk'], { encoding: 'utf8' }).status === 0) {
  const j = ['# Journal', ''];
  for (let i = 0; i < 25; i++) j.push(`### 2026-10-${String(25 - i).padStart(2, '0')} — session ${String(i).padStart(8, '0')}`, `- Summary number ${i} éàü ${'word '.repeat(i === 5 ? 60 : 3)}`, '- Next: n', `- 2026-10-01 — event ${i} [toolu_e]`, '- Files: `x.js`', '');
  fs.writeFileSync(P('JOURNAL.md'), j.join('\n'));
  const r = spawnSync(bash, [path.join(__dirname, '..', 'inject-journal.sh')], { encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root, HOME: home } });
  assert.strictEqual(r.status, 0, 'inject-journal exits 0: ' + r.stderr);
  const c = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  assert(!c.includes('- Files:'), 'Files lines never injected at start');
  assert(c.includes('### 2026-10-25') && c.includes('### 2026-10-23') && !c.includes('### 2026-10-22'), '3 full blocks');
  const idx = c.split('## Older sessions')[1] || '';
  assert(/^- 2026-10-22 — Summary number 3 /m.test(idx) && /^- 2026-10-08 — Summary number 17 /m.test(idx) && !/2026-10-07/.test(idx), '15 index lines, next 15 blocks: ' + idx);
  assert(!/Next:|event \d/.test(idx), 'index uses the summary line, not Next or events');
  const notes = (c.split('## Recent notes')[1] || '').split('\n## ')[0];
  assert(/^- 2026-10-01 — event 0$/m.test(notes) && /event 24$/m.test(notes) && !notes.includes('toolu_e'), 'notes: newest dated lines of every session, evidence id dropped: ' + notes);
  assert(!/event \d/.test(c.split('## Recent notes')[0]), 'a note is listed once, not again inside its full block');
  const long = idx.split('\n').find(l => l.includes('number 5 '));
  assert(long && long.length <= 160 + 20 && long.endsWith(' …'), 'long summary cut on a word: ' + long);
  const r2 = spawnSync(bash, [path.join(__dirname, '..', 'inject-journal.sh')], { encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root, HOME: home, JOURNAL_MAX_CHARS: '1500' } });
  const c2 = JSON.parse(r2.stdout).hookSpecificOutput.additionalContext;
  assert(c2.length <= 1500 && c2.includes('### 2026-10-25'), 'over the cap: index lines go before the newest block: ' + c2.length);
} else console.log('skip: bash not found, inject-journal.sh index not checked');

// ---- 5. backfill ----
fs.writeFileSync(P('JOURNAL.md'), '# Journal\r\n\r\n### 2026-11-15 — session aaaa1111\r\n- Capped the delta\r\n\r\n### 2026-11-01 — session 99999999\r\n- No transcript left\r\n');
const env = { ...process.env, HOME: home, USERPROFILE: home };
const bf = a => spawnSync(process.execPath, [path.join(__dirname, 'file-memory.js'), '--backfill', ...a, root], { encoding: 'utf8', env });
const before = fs.readFileSync(P('JOURNAL.md'), 'utf8');
const dry = bf([]);
assert(dry.status === 0 && /2 block\(s\), 1 with a transcript, 1 without, 1 to update/.test(dry.stdout) && fs.readFileSync(P('JOURNAL.md'), 'utf8') === before, 'dry run reports and writes nothing: ' + dry.stdout + dry.stderr);
bf(['--apply']);
const after = fs.readFileSync(P('JOURNAL.md'), 'utf8');
assert(/- Capped the delta\r\n- Files: `core\/hooks\/scribe-worker\.js`/i.test(after) && after.includes('- No transcript left') && !/(?<!\r)\n/.test(after),'apply adds the Files line, keeps CRLF: ' + JSON.stringify(after));
assert(/### 2026-11-15[^#]*- Files:[^\n]*\r\n\r\n### 2026-11-01/.test(after), 'blank line between blocks kept: ' + JSON.stringify(after));
const again = bf(['--apply']);
assert(/0 to update/.test(again.stdout) && fs.readFileSync(P('JOURNAL.md'), 'utf8') === after, 'backfill is idempotent: ' + again.stdout);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('file-memory.check.js: all checks passed');
