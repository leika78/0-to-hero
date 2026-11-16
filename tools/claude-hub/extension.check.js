// node extension.check.js [--preview <dir>] — smallest check that fails if the hub breaks outside VS Code:
// "What Claude knows" reads the right sections (facts, rules per workspace, items to review, 3 sessions + an
// index, Files lines kept apart), a folder without memory gives null, both languages carry the same keys, and
// the webview script compiles. With --preview, also writes list.html / detail.html (VS Code stubbed) to look at.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const Module = require('module');

// The extension requires 'vscode', which only exists inside the editor: a stub is enough for these functions.
const realLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'vscode') return { env: { language: process.env.HUB_LANG || 'en' }, workspace: {}, window: {}, commands: {} };
  return realLoad.call(this, req, ...rest);
};
const hub = require('./extension.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-hub-check-'));
const root = path.join(tmp, 'proj');
fs.mkdirSync(path.join(root, 'web'), { recursive: true });
fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# p\n');
fs.writeFileSync(path.join(root, 'web', 'AGENT.md'), '# web\n');
fs.writeFileSync(path.join(root, 'DECISIONS.md'), '# D\r\n\r\n## Facts (current)\r\n<!-- c -->\r\n- **Prod host**: hetzner (since 2026-11-01)\r\n- **Domain**: example.org (since 2026-11-02)\r\n\r\n## Proposals\r\n- [fact] **Price**: 9 € (2026-11-10) [toolu_1]\r\n\r\n## Ledger (facts of record)\r\n- 2026-11-01 — not shown\r\n\r\n## Proposals archive\r\n- [fact] **Old**: x (declined)\r\n');
fs.writeFileSync(path.join(root, 'LEARNINGS.md'), '# L\n\n## Active Learnings\n- ALWAYS root rule (why)\n\n## Candidates\n');
fs.writeFileSync(path.join(root, 'web', 'LEARNINGS.md'), '# web\n\n## Active Learnings\n- NEVER web rule (why)\n\n## Candidates\n- ALWAYS candidate (why) (2026-11-12) [toolu_2]\n\n## Archived Learnings\n- NEVER archived (x)\n');
const j = ['# Journal', ''];
for (let i = 0; i < 20; i++) j.push(`### 2026-10-${String(30 - i).padStart(2, '0')} — session ${String(i).padStart(8, '0')}`, `- Did thing ${i}`, '- Next: n', `- 2026-10-01 — event ${i} [toolu_e]`, '- Files: `web/app.ts`, `core/x.js`', '');
fs.writeFileSync(path.join(root, 'JOURNAL.md'), j.join('\n'));

const d = hub.projectDetails(root);
assert.deepStrictEqual(d.facts, ['**Prod host**: hetzner (since 2026-11-01)', '**Domain**: example.org (since 2026-11-02)'], 'facts, CRLF file: ' + JSON.stringify(d.facts));
assert.deepStrictEqual(d.rules.map(r => [r.workspace, r.file, r.items]), [['.', 'LEARNINGS.md', ['ALWAYS root rule (why)']], ['web', 'web/LEARNINGS.md', ['NEVER web rule (why)']]], 'rules per workspace, archived left out: ' + JSON.stringify(d.rules));
assert.deepStrictEqual(d.review.map(r => r.text), ['[fact] **Price**: 9 € (2026-11-10) [toolu_1]', 'ALWAYS candidate (why) (2026-11-12) [toolu_2]'], 'proposals + candidates, never the archive: ' + JSON.stringify(d.review));
assert.strictEqual(d.sessions.length, 3, '3 full sessions');
assert.deepStrictEqual(d.sessions[0], { date: '2026-10-30', lines: ['Did thing 0', 'Next: n', '2026-10-01 — event 0 [toolu_e]'], files: ['web/app.ts', 'core/x.js'] }, 'session block, Files apart: ' + JSON.stringify(d.sessions[0]));
assert.strictEqual(d.older.length, 15, '15 index lines');
assert.deepStrictEqual(d.older[0], { date: '2026-10-27', line: 'Did thing 3' }, 'index = date + first summary line');
assert.strictEqual(hub.projectDetails(path.join(root, 'web')), null, 'no CLAUDE.md + DECISIONS.md: no memory page');

// Both languages: same keys, same {n} placeholders.
const en = hub.STRINGS.en, fr = hub.STRINGS.fr;
assert.deepStrictEqual(Object.keys(fr).sort(), Object.keys(en).sort(), 'fr and en carry the same strings');
assert.strictEqual(fr.welcome.length, en.welcome.length, 'same welcome length');

// The webview script compiles (a syntax error there is a blank panel in VS Code, with no message).
const data = { projects: [], usage: null, usageError: null, t: hub.webStrings(), lang: 'en', welcomeDismissed: false };
const html = hub.hubHtml({ cspSource: 'vscode-resource:' }, data);
const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
new vm.Script(script);
assert(!/\$\{/.test(script.replace(/\\\$\{/g, '')), 'no unresolved template placeholder in the webview script');

// --preview <dir>: the panel as HTML files, VS Code stubbed, for a screenshot.
const pi = process.argv.indexOf('--preview');
if (pi > 0) {
  const out = path.resolve(process.argv[pi + 1]);
  fs.mkdirSync(out, { recursive: true });
  const now = Date.now();
  const scribe = (lag, total, running) => ({ lag, running: !!running, session: 's', transcript: 't', inbox: total ? { total, alert: true } : null });
  const projects = [
    { name: 'project 0 to Hero', parent: '', path: root, last: now - 5 * 6e4, scribe: scribe(12, 1), hasMemory: true },
    { name: 'mypb-saas', parent: '__Le_projet_a_1M', path: '/x/mypb', last: now - 2 * 36e5, scribe: scribe(0, 0), hasMemory: true },
    { name: 'Agents Marketing', parent: '__Le_projet_a_1M', path: '/x/am', last: now - 2 * 36e5, scribe: scribe(0, 0, true), hasMemory: true },
    { name: 'John OS', parent: 'Jonh Bot', path: '/x/john', last: now - 26 * 36e5, scribe: scribe(0, 2), hasMemory: true },
    { name: 'Equipe Marketing', parent: '', path: '/x/em', last: now - 3 * 864e5, scribe: null, hasMemory: false },
  ];
  const usage = { limits: [{ name: 'Session (5h)', percent: 34, reset: '2 h 10' }, { name: 'Week', percent: 72, reset: '3 d 4 h' }], breakdown: '', at: '14:02' };
  const theme = `<style>:root{--vscode-font-family:Segoe UI,sans-serif;--vscode-font-size:13px;--vscode-foreground:#ccc;--vscode-descriptionForeground:#9d9d9d;
    --vscode-charts-green:#3fb950;--vscode-charts-orange:#d29922;--vscode-charts-blue:#3794ff;--vscode-charts-red:#f85149;--vscode-textLink-foreground:#4daafc;
    --vscode-input-background:#313131;--vscode-list-hoverBackground:#2a2d2e;--vscode-list-inactiveSelectionBackground:#37373d;--vscode-widget-border:#454545;
    --vscode-editorWidget-background:#202020;--vscode-button-background:#0078d4;--vscode-button-foreground:#fff;--vscode-editor-font-family:Consolas,monospace}
    body{background:#181818;width:280px}</style>`;
  const page = (extra, welcome) => {
    let h = hub.hubHtml({ cspSource: '' }, { ...data, projects, usage, welcomeDismissed: !welcome });
    const nonce = h.match(/nonce="([^"]+)"/)[1];
    h = h.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '').replace('</head>', theme + '</head>')
      .replace('const vscode = acquireVsCodeApi();', 'const vscode = { postMessage(m) { window.__last = m; } };');
    return h.replace('</body>', `<script nonce="${nonce}">${extra}</script></body>`);
  };
  fs.writeFileSync(path.join(out, 'list.html'), page('', true));
  fs.writeFileSync(path.join(out, 'detail.html'), page(`showDetail(list[0]); window.postMessage({ type: 'details', path: list[0].path, details: ${JSON.stringify(d).replace(/</g, '\\u003c')} }, '*');`, false));
  console.log('preview written to ' + out);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('claude-hub extension.check.js: all checks passed');
