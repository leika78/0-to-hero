// node scribe-trigger.check.js — the --inbox mode counts the memory files, never a stale pending.json.
// Synthetic project + HOME in a temp dir, nothing outside it touched.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trigger-check-'));
const proj = path.join(tmp, 'proj');
fs.mkdirSync(proj);
fs.writeFileSync(path.join(proj, 'CLAUDE.md'), '# p\n');
const decisions = n => fs.writeFileSync(path.join(proj, 'DECISIONS.md'),
  '# D\n\n## Facts (current)\n\n## Proposals\n' + Array.from({ length: n }, (_, i) => `- 2026-11-0${i + 1} fix: item ${i}\n`).join('') + '\n## Ledger (facts of record)\n');
const state = path.join(tmp, 'home', '.claude', 'scribe', proj.replace(/[^a-zA-Z0-9]/g, '-').replace(/^-+|-+$/g, '').toLowerCase());
fs.mkdirSync(state, { recursive: true });
fs.writeFileSync(path.join(state, 'pending.json'), JSON.stringify({ proposals: 5, candidates: 0, total: 5, oldest: '2026-01-01' }));

const env = { ...process.env, HOME: path.join(tmp, 'home'), USERPROFILE: path.join(tmp, 'home'), CLAUDE_PROJECT_DIR: proj, CLAUDE_CODE_SESSION_ATTENDED: '1' };
delete env.SCRIBE_ROOTS;
const run = session => spawnSync(process.execPath, [path.join(__dirname, 'scribe-trigger.js'), '--inbox'], {
  input: JSON.stringify({ hook_event_name: 'Stop', session_id: session, transcript_path: 'x' }), env, encoding: 'utf8' }).stdout;

decisions(0);
assert.strictEqual(run('s1'), '', 'stale pending.json (total 5) but 0 pending in the files: no block');
decisions(5);
const out = JSON.parse(run('s2'));
assert.strictEqual(out.decision, 'block', '5 pending proposals: block');
assert.ok(out.reason.startsWith('Memory inbox: 5 item(s) waiting'), out.reason);
assert.strictEqual(run('s2'), '', 'once per session');

// --settle (SessionStart): an ended session of another id in the queue → the worker is launched and the hook waits for it;
// the current session's own entries and an empty queue → no wait; a live lock → wait, bounded by SCRIBE_SETTLE_MS.
const settle = (source, ms = 20000) => { const t = Date.now(); spawnSync(process.execPath, [path.join(__dirname, 'scribe-trigger.js'), '--settle'], {
  input: JSON.stringify({ hook_event_name: 'SessionStart', source, session_id: 'new', transcript_path: 'x' }), env: { ...env, SCRIBE_SETTLE_MS: String(ms), SCRIBE_CLAUDE_BIN: path.join(tmp, 'no-claude') } }); return Date.now() - t; };
const qf = path.join(state, 'queue.jsonl');
fs.writeFileSync(qf, JSON.stringify({ session_id: 'new', transcript_path: path.join(tmp, 'none.jsonl'), cwd: proj, flush: true, ts: Date.now() }) + '\n');
assert.ok(settle('startup') < 1500, 'own session entry only: no wait');
fs.writeFileSync(qf, JSON.stringify({ session_id: 'old', transcript_path: path.join(tmp, 'none.jsonl'), cwd: proj, flush: true, ts: Date.now() }) + '\n');
settle('clear');
assert.strictEqual(fs.existsSync(qf) ? fs.readFileSync(qf, 'utf8') : '', '', 'ended session drained by the worker the hook launched, before it returns');
fs.writeFileSync(path.join(state, 'worker.lock'), '1');
const waited = settle('startup', 1500);
assert.ok(waited >= 1500 && waited < 5000, 'live lock: waits, bounded: ' + waited);
fs.rmSync(tmp, { recursive: true, force: true });
console.log('scribe-trigger.check: ok');
