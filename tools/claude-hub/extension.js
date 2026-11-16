// Claude Hub — VS Code sidebar for the 0-to-Hero memory stack.
// Shows, at the top of the Explorer: Claude usage, the recent projects under one root folder, and per project
// the memory state in plain words ("Memory up to date", "Behind · Update now", "2 items to review"), plus a
// "What Claude knows" page per project (facts, rules, last sessions, items to review) read from the project's
// own memory files. French or English, following VS Code's language. No model call, no network except the
// usage endpoint Claude Code itself uses. Everything is read from ~/.claude and the project folders.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');

// ---------- words (French when VS Code is in French, else English) ----------

const STRINGS = {
  en: {
    filter: 'Filter…', filterTip: '↑↓ navigate · Enter open · Ctrl+Enter new window', more: n => `+ ${n} more, type to search`,
    noProject: 'No project.', loadingUsage: 'Loading usage…', usageUnavailable: 'Usage unavailable: ', updated: 'updated ',
    newWindow: 'New window', upToDate: '✓ Memory up to date', upToDateTip: 'Claude has read everything: you can /clear or close safely.',
    behind: '↻ Behind', updateNow: 'Update now', behindTip: n => `${n} transcript lines not read yet. Nothing is lost; "Update now" reads them right away.`,
    running: '⏳ Updating memory…', unknown: '? Memory state unknown', toReview: n => `✉ ${n} to review`,
    toReviewTip: 'Facts or rules Claude noticed and wants confirmed. At 5 items the session sorts them by itself; or type /memorise in that project.',
    sheet: 'What Claude knows ›', back: '‹ Projects', openFile: 'open the file',
    review: 'To review', reviewHelp: 'Claude sorts these by itself once there are 5 (or one is 3 days old), and asks you only what it cannot decide. You can also type /memorise in this project.',
    facts: 'Facts', factsHelp: 'What is true about the project now. Given to Claude at the start of every session.',
    rules: 'Rules', rulesHelp: 'How Claude must work here, learned from your corrections. Given at every session start.',
    sessions: 'Last sessions', sessionsHelp: 'What the last sessions did, written by the memory scribe.', older: 'Earlier sessions',
    files: 'Files: ', empty: 'Nothing yet.', kindFact: 'Fact: ', kindFix: 'Fix: ', next: 'Next: ', week: 'Week', day: 'd', noMemory: 'This project has no memory files yet (CLAUDE.md + DECISIONS.md): run /bootstrap in it to start one.',
    welcomeTitle: 'How Claude remembers', ok: 'Got it',
    welcome: [
      'While you work, a background <b>scribe</b> writes down what was done and decided in each project.',
      '<b>✓ Memory up to date</b> means it has read everything: you can <code>/clear</code> or close safely. If it says <b>Behind</b>, click <b>Update now</b>, or just wait.',
      '<b>✉ to review</b> lists facts or rules Claude wants confirmed. It sorts them by itself; nothing is lost if you ignore them.',
      'Click <b>What Claude knows</b> under a project to see what Claude is told at the start of every session.',
    ],
  },
  fr: {
    filter: 'Filtrer…', filterTip: '↑↓ naviguer · Entrée ouvrir · Ctrl+Entrée nouvelle fenêtre', more: n => `+ ${n} autres, tape pour chercher`,
    noProject: 'Aucun projet.', loadingUsage: 'Chargement de l’usage…', usageUnavailable: 'Usage indisponible : ', updated: 'mis à jour ',
    newWindow: 'Nouvelle fenêtre', upToDate: '✓ Mémoire à jour', upToDateTip: 'Claude a tout lu : tu peux faire /clear ou fermer sans rien perdre.',
    behind: '↻ En retard', updateNow: 'Mettre à jour', behindTip: n => `${n} lignes de conversation pas encore lues. Rien n’est perdu ; « Mettre à jour » les lit tout de suite.`,
    running: '⏳ Mise à jour de la mémoire…', unknown: '? État de la mémoire inconnu', toReview: n => `✉ ${n} à valider`,
    toReviewTip: 'Des faits ou des règles que Claude a remarqués et veut faire confirmer. À 5, la session les trie toute seule ; ou tape /memorise dans ce projet.',
    sheet: 'Ce que Claude sait ›', back: '‹ Projets', openFile: 'ouvrir le fichier',
    review: 'À valider', reviewHelp: 'Claude les trie tout seul dès qu’il y en a 5 (ou que l’un a 3 jours), et ne te demande que ce qu’il ne peut pas trancher. Tu peux aussi taper /memorise dans ce projet.',
    facts: 'Faits', factsHelp: 'Ce qui est vrai sur le projet aujourd’hui. Donné à Claude au début de chaque session.',
    rules: 'Règles', rulesHelp: 'Comment Claude doit travailler ici, appris de tes corrections. Donné au début de chaque session.',
    sessions: 'Dernières sessions', sessionsHelp: 'Ce que les dernières sessions ont fait, écrit par le scribe de mémoire.', older: 'Sessions plus anciennes',
    files: 'Fichiers : ', empty: 'Rien pour l’instant.', kindFact: 'Fait : ', kindFix: 'Correctif : ', next: 'Ensuite : ', week: 'Semaine', day: 'j', noMemory: 'Ce projet n’a pas encore de fichiers de mémoire (CLAUDE.md + DECISIONS.md) : lance /bootstrap dedans pour en créer.',
    welcomeTitle: 'Comment Claude se souvient', ok: 'Compris',
    welcome: [
      'Pendant que tu travailles, un <b>scribe</b> en arrière-plan note ce qui a été fait et décidé dans chaque projet.',
      '<b>✓ Mémoire à jour</b> veut dire qu’il a tout lu : tu peux faire <code>/clear</code> ou fermer sans rien perdre. S’il affiche <b>En retard</b>, clique sur <b>Mettre à jour</b>, ou attends simplement.',
      '<b>✉ à valider</b> liste des faits ou des règles que Claude veut faire confirmer. Il les trie tout seul ; rien n’est perdu si tu les ignores.',
      'Clique sur <b>Ce que Claude sait</b> sous un projet pour voir ce qui est donné à Claude au début de chaque session.',
    ],
  },
};
const lang = () => (String(vscode.env.language || 'en').toLowerCase().startsWith('fr') ? 'fr' : 'en');
// Only plain strings travel to the webview (functions are rebuilt there from these templates).
function webStrings() {
  const s = STRINGS[lang()];
  const out = {};
  for (const [k, v] of Object.entries(s)) out[k] = typeof v === 'function' ? v('{n}') : v;
  return out;
}

// ---------- sessions and scribe state ----------

// Claude Code stores sessions in ~/.claude/projects/<path with every non-alnum char -> '-'>
const sessionKey = p => p.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();

// Per project key: when its newest transcript was written, and which one it is.
function lastActivityByKey() {
  const map = new Map();
  const dir = path.join(CLAUDE_DIR, 'projects');
  for (const d of safeReaddir(dir)) {
    let latest = 0, transcript = null;
    for (const f of safeReaddir(path.join(dir, d))) {
      if (!f.endsWith('.jsonl')) continue;
      try { const m = fs.statSync(path.join(dir, d, f)).mtimeMs; if (m > latest) { latest = m; transcript = path.join(dir, d, f); } } catch {}
    }
    if (latest) map.set(d.toLowerCase(), { latest, transcript });
  }
  return map;
}

// Memory scribe (~/.claude/hooks/scribe): has it read the project's newest session?
// lag = transcript lines past the scribe's cursor (same count as scribe-worker). null = project not watched.
// inbox = proposals + candidates waiting for /memorise (pending.json, written by the worker after each run).
const SCRIBE_STATE = path.join(CLAUDE_DIR, 'scribe');
const SCRIBE_TRIGGER = path.join(CLAUDE_DIR, 'hooks', 'scribe', 'scribe-trigger.js');
const scribeSlug = p => p.replace(/[^a-zA-Z0-9]/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
function scribeState(projectPath, transcript) {
  const dirName = safeReaddir(SCRIBE_STATE).find(d => d.toLowerCase() === scribeSlug(projectPath)); // slug keeps the cwd's case on disk
  if (!dirName) return null;
  const st = path.join(SCRIBE_STATE, dirName);
  let inbox = null;
  try { inbox = JSON.parse(fs.readFileSync(path.join(st, 'pending.json'), 'utf8')); } catch {}
  if (!transcript) return { lag: null, running: false, session: null, transcript: null, inbox };
  const session = path.basename(transcript, '.jsonl');
  let cursor = 0;
  try { cursor = JSON.parse(fs.readFileSync(path.join(st, 'cursors', `${session}.json`), 'utf8')).line || 0; } catch {}
  let lag = null;
  try {
    const txt = fs.readFileSync(transcript, 'utf8'); // ponytail: full read, the hub refreshes at most every few seconds
    lag = Math.max(0, (txt.match(/\n/g) || []).length + (txt.endsWith('\n') || !txt ? 0 : 1) - cursor);
  } catch {}
  let running = false;
  try { running = Date.now() - fs.statSync(path.join(st, 'worker.lock')).mtimeMs < 600000; } catch {}
  return { lag, running, session, transcript, inbox };
}

// Flush this project's newest session through the scribe now: same stdin the SessionEnd hook gets.
function runScribe(p) {
  if (!p.scribe || !p.scribe.session) return;
  // process.execPath is VS Code itself here, not node
  const nodeExe = [path.join(process.env.ProgramFiles || 'C:/Program Files', 'nodejs', 'node.exe'), '/usr/local/bin/node', '/usr/bin/node'].find(fs.existsSync) || 'node';
  const child = require('child_process').spawn(nodeExe, [SCRIBE_TRIGGER], { cwd: p.path, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true, detached: true });
  child.stdin.end(JSON.stringify({ session_id: p.scribe.session, transcript_path: p.scribe.transcript, cwd: p.path, hook_event_name: 'SessionEnd' }));
  child.unref();
}

// ---------- "What Claude knows": the project's memory files, read as they are ----------

const readText = f => { try { return fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n'); } catch { return ''; } };
// Body of `## <heading>` (an optional "(…)" note after the heading is allowed), up to the next "## ".
function section(text, heading) {
  const m = text.match(new RegExp(`^## ${heading}(?: \\([^)\\n]*\\))?[ \\t]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm'));
  return m ? m[1] : '';
}
const bullets = body => body.split('\n').filter(l => l.startsWith('- ')).map(l => l.slice(2).trim());
// Workspaces = direct sub-folders with an AGENT.md; the root counts as "." (light projects and leftover root rules).
function workspaceDirs(root) {
  const ws = safeReaddir(root).filter(d => !d.startsWith('.') && fs.existsSync(path.join(root, d, 'AGENT.md')));
  return ['.', ...ws];
}

// Everything the "What Claude knows" page shows, from the memory files only. null when the folder has no memory.
function projectDetails(root) {
  const dec = readText(path.join(root, 'DECISIONS.md'));
  if (!dec || !fs.existsSync(path.join(root, 'CLAUDE.md'))) return null;
  const facts = bullets(section(dec, 'Facts'));
  const review = bullets(section(dec, 'Proposals')).map(t => ({ text: t, file: 'DECISIONS.md', heading: 'Proposals' }));
  const rules = [];
  for (const ws of workspaceDirs(root)) {
    const rel = ws === '.' ? 'LEARNINGS.md' : `${ws}/LEARNINGS.md`;
    const t = readText(path.join(root, rel));
    if (!t) continue;
    const active = bullets(section(t, 'Active Learnings'));
    if (active.length) rules.push({ workspace: ws, file: rel, items: active });
    for (const c of bullets(section(t, 'Candidates'))) review.push({ text: c, file: rel, heading: 'Candidates', workspace: ws });
  }
  // JOURNAL.md: blocks newest first; the 3 newest in full, the next 15 as one line each (same split as inject-journal.sh).
  const blocks = readText(path.join(root, 'JOURNAL.md')).split(/\n(?=### )/).filter(b => /^### \d{4}-\d{2}-\d{2}/.test(b));
  const parse = b => {
    const lines = b.replace(/\s*$/, '').split('\n');
    const date = lines[0].slice(4, 14);
    const body = lines.slice(1).filter(l => l.startsWith('- ')).map(l => l.slice(2));
    const files = body.filter(l => l.startsWith('Files: ')).flatMap(l => [...l.matchAll(/`([^`]+)`/g)].map(m => m[1]));
    return { date, lines: body.filter(l => !l.startsWith('Files: ')), files };
  };
  const sessions = blocks.slice(0, 3).map(parse);
  const older = blocks.slice(3, 18).map(parse).map(s => ({ date: s.date, line: (s.lines.find(l => !/^Next: |^\d{4}-\d{2}-\d{2} — /.test(l)) || s.lines[0] || '') }));
  return { facts, rules, review, sessions, older };
}

// Open a memory file at a heading (or at the top).
async function openAt(root, rel, heading) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) return;
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  const line = heading ? Math.max(0, doc.getText().split('\n').findIndex(l => l.startsWith(`## ${heading}`))) : 0;
  await vscode.window.showTextDocument(doc, { selection: new vscode.Range(line, 0, line, 0) });
}

function safeReaddir(p) {
  try { return fs.readdirSync(p); } catch { return []; }
}

const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const hasClaudeFiles = p => fs.existsSync(path.join(p, 'CLAUDE.md')) || isDir(path.join(p, '.claude'));

// Root = claudeHub.root setting, else the parent folder of the opened workspace.
function projectsRoot() {
  const cfg = vscode.workspace.getConfiguration('claudeHub').get('root');
  if (cfg) return cfg;
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return ws ? path.dirname(ws) : os.homedir();
}

// A folder is a project if it has CLAUDE.md/.claude or a session history; a container folder
// one level down only contributes its sub-projects.
function getProjects() {
  const root = projectsRoot();
  const activity = lastActivityByKey();
  const out = [];
  const add = (p, parent) => {
    const a = activity.get(sessionKey(p));
    const last = a?.latest || 0;
    if (last || hasClaudeFiles(p)) out.push({ name: path.basename(p), parent, path: p, last, scribe: scribeState(p, a?.transcript) });
  };
  for (const top of safeReaddir(root).filter(n => !n.startsWith('.')).map(n => path.join(root, n)).filter(isDir)) {
    add(top, '');
    for (const sub of safeReaddir(top).filter(n => !n.startsWith('.')).map(n => path.join(top, n)).filter(isDir)) {
      add(sub, path.basename(top));
    }
  }
  return out.sort((a, b) => b.last - a.last);
}

// ---------- usage ----------

// Same endpoint Claude Code's /usage uses. The token is refreshed by Claude Code itself;
// we only read it (refreshing here would rotate the refresh token under Claude Code's feet).
async function fetchUsage() {
  const creds = JSON.parse(fs.readFileSync(path.join(CLAUDE_DIR, '.credentials.json'), 'utf8')).claudeAiOauth;
  const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
    headers: { Authorization: `Bearer ${creds.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' },
  });
  if (!res.ok) {
    const e = new Error(res.status === 401 ? 'token expired, restart Claude Code' : res.status === 429 ? 'rate limited' : `HTTP ${res.status}`);
    e.retryAfter = res.status === 429 ? (+res.headers.get('retry-after') || 300) : 60;
    throw e;
  }
  return res.json();
}

// Shared by every VS Code window through a temp file: N windows still make at most one call
// per 5 minutes, and a 429 backs them all off until retryAt.
const USAGE_CACHE = path.join(os.tmpdir(), 'claude-hub-usage.json');
const MIN_INTERVAL = 300000;

async function loadUsage() {
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(USAGE_CACHE, 'utf8')); } catch {}
  const now = Date.now();
  if ((cache.usage && now - cache.fetchedAt < MIN_INTERVAL) || now < (cache.retryAt || 0)) return cache;
  try {
    cache = { ...cache, usage: summarize(await fetchUsage()), fetchedAt: now, error: null, retryAt: 0 };
  } catch (e) {
    const retryAt = now + (e.retryAfter || 60) * 1000;
    cache = { ...cache, error: `${e.message}, retry at ${new Date(retryAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`, retryAt };
  }
  try { fs.writeFileSync(USAGE_CACHE, JSON.stringify(cache)); } catch {}
  return cache;
}

const resetIn = iso => {
  const m = Math.max(0, Math.round((new Date(iso) - Date.now()) / 60000));
  return m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}` : `${Math.floor(m / 1440)} ${STRINGS[lang()].day} ${Math.round((m % 1440) / 60)} h`;
};

const LIMIT_NAMES = () => ({ session: 'Session (5h)', weekly_all: STRINGS[lang()].week, weekly_scoped: STRINGS[lang()].week });

// Usage limits reduced to what both the status bar and the hub display.
function summarize(u) {
  return {
    limits: (u.limits || []).map(l => ({
      name: (LIMIT_NAMES()[l.kind] || l.kind) + (l.scope?.model?.display_name ? ` (${l.scope.model.display_name})` : ''),
      percent: Math.round(l.percent),
      reset: resetIn(l.resets_at),
    })),
    breakdown: (u.seven_day_breakdown?.rows || []).filter(r => r.percent).map(r => `${r.display_name} ${r.percent}%`).join(' · '),
    session: Math.round(u.five_hour?.utilization ?? 0),
    week: Math.round(u.seven_day?.utilization ?? 0),
    at: new Date().toLocaleTimeString(),
  };
}

function renderStatus(item, usage, error) {
  if (!usage) {
    item.text = '$(sparkle) usage ?';
    item.tooltip = `Usage unavailable: ${error}`;
    item.backgroundColor = undefined;
    return;
  }
  item.text = `$(sparkle) 5h ${usage.session}% · 7d ${usage.week}%`;
  const worst = Math.max(usage.session, usage.week);
  item.backgroundColor = worst >= 90 ? new vscode.ThemeColor('statusBarItem.errorBackground')
    : worst >= 70 ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  const md = new vscode.MarkdownString('**Claude usage**\n\n');
  for (const l of usage.limits) md.appendMarkdown(`- ${l.name}: **${l.percent}%**, resets in ${l.reset}\n`);
  if (usage.breakdown) md.appendMarkdown(`\n7d: ${usage.breakdown}\n`);
  md.appendMarkdown(`\n_updated ${usage.at}, click to open the hub_`);
  if (error) md.appendMarkdown(`\n\n⚠ ${error}`);
  item.tooltip = md;
}

// ---------- webview ----------

function hubHtml(webview, data) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="${data.lang || 'en'}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 8px 12px 16px; }
  .lim { margin-bottom: 8px; }
  .lim-top { display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 3px; }
  .pct { font-variant-numeric: tabular-nums; font-weight: 600; }
  .bar { height: 5px; border-radius: 3px; background: var(--vscode-editorWidget-border, #8884); overflow: hidden; }
  .fill { height: 100%; border-radius: 3px; background: var(--vscode-charts-green, #3fb950); transition: width .4s; }
  .fill.warn { background: var(--vscode-charts-orange, #d29922); }
  .fill.crit { background: var(--vscode-charts-red, #f85149); }
  .muted { color: var(--vscode-descriptionForeground); font-size: 11px; }
  .err { color: var(--vscode-errorForeground); font-size: 12px; }
  #projects { margin-top: 6px; }
  input { width: 100%; box-sizing: border-box; padding: 4px 6px; margin-top: 10px; font: inherit; color: var(--vscode-input-foreground);
    background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; outline: none; }
  input:focus { border-color: var(--vscode-focusBorder); }
  .proj { padding: 4px 6px; margin: 0 -6px; border-radius: 3px; }
  .proj.sel { background: var(--vscode-list-inactiveSelectionBackground); }
  .row { display: flex; align-items: center; gap: 8px; cursor: pointer; }
  .proj:hover { background: var(--vscode-list-hoverBackground); }
  .dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--vscode-descriptionForeground); opacity: .35; }
  .dot.today { background: var(--vscode-charts-green, #3fb950); opacity: 1; }
  .dot.week { background: var(--vscode-charts-blue, #3794ff); opacity: 1; }
  .label { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .parent { color: var(--vscode-descriptionForeground); font-size: 11px; }
  .when { flex: none; font-size: 11px; color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
  .nw { flex: none; display: none; border: none; background: none; color: inherit; cursor: pointer; padding: 0 2px; border-radius: 3px; }
  .proj:hover .nw, .proj.sel .nw { display: block; }
  .proj:hover .when, .proj.sel .when { display: none; }
  .nw:hover { background: var(--vscode-toolbar-hoverBackground); }
  .mem { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px; margin: 1px 0 0 15px; font-size: 11px; }
  .st { color: var(--vscode-charts-orange, #d29922); }
  .st.ok { color: var(--vscode-charts-green, #3fb950); }
  .st.run, .st.unk { color: var(--vscode-descriptionForeground); }
  .rv { color: var(--vscode-charts-blue, #3794ff); }
  a, .link { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; }
  a:hover, .link:hover { text-decoration: underline; }
  .sheet { margin-left: auto; }
  .card { margin: 10px 0 4px; padding: 8px 10px; border-radius: 4px; border: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border, #8884));
    background: var(--vscode-editorWidget-background, transparent); font-size: 12px; line-height: 1.45; }
  .card h3 { margin: 0 0 6px; font-size: 12px; }
  .card p { margin: 0 0 6px; }
  .card button { font: inherit; padding: 3px 10px; border: none; border-radius: 2px; cursor: pointer;
    color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  .card button:hover { background: var(--vscode-button-hoverBackground); }
  code { font-family: var(--vscode-editor-font-family); font-size: 0.95em; }
  #detail h2 { font-size: 13px; margin: 8px 0 2px; }
  #detail details { margin-top: 10px; }
  #detail summary { cursor: pointer; font-weight: 600; font-size: 12px; }
  #detail .help { margin: 3px 0 4px; }
  #detail ul { margin: 4px 0; padding-left: 16px; }
  #detail li { margin: 3px 0; font-size: 12px; line-height: 1.4; overflow-wrap: anywhere; }
  #detail .ws { font-size: 11px; margin-top: 6px; color: var(--vscode-descriptionForeground); }
  #detail .date { font-weight: 600; font-size: 12px; margin-top: 8px; }
  #detail .files { font-size: 11px; color: var(--vscode-descriptionForeground); overflow-wrap: anywhere; }
  .hidden { display: none; }
</style></head><body>
<div id="list">
  <div id="usage"></div>
  <div id="welcome"></div>
  <input id="q">
  <div id="projects"></div>
</div>
<div id="detail" class="hidden"></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
let data = ${json}, sel = 0, list = [], detailPath = null;
const T = data.t;
const n = (s, k) => String(s).replace('{n}', k);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// Markdown kept to what the memory files use: **bold** and \`code\`, everything else escaped.
const md = s => esc(s).replace(/\\*\\*([^*]+)\\*\\*/g, '<b>$1</b>').replace(/\`([^\`]+)\`/g, '<code>$1</code>');
// The files keep their evidence ids and tags for the scribe; a reader needs neither.
const clean = s => String(s).replace(/\\s*\\[(toolu_|call_)[^\\]]*\\]/g, '').replace(/^\\[fact\\] /, T.kindFact).replace(/^\\[fix\\] /, T.kindFix).replace(/^Next: /, T.next);
function ago(ms) {
  if (!ms) return '—';
  const m = Math.round((Date.now() - ms) / 6e4);
  return m < 60 ? m + ' min' : m < 1440 ? Math.round(m / 60) + ' h' : Math.round(m / 1440) + ' ' + T.day;
}
function bucket(ms) {
  if (ms && new Date(ms).toDateString() === new Date().toDateString()) return 'today';
  return ms && Date.now() - ms < 7 * 864e5 ? 'week' : 'old';
}
function renderUsage() {
  const el = document.getElementById('usage');
  const u = data.usage;
  if (!u) { el.innerHTML = data.usageError ? '<div class="err">' + esc(T.usageUnavailable + data.usageError) + '</div>' : '<div class="muted">' + esc(T.loadingUsage) + '</div>'; return; }
  el.innerHTML = u.limits.map(l =>
    '<div class="lim"><div class="lim-top"><span>' + esc(l.name) + '</span><span><span class="pct">' + l.percent + '%</span> <span class="muted">· ' + esc(l.reset) + '</span></span></div>' +
    '<div class="bar"><div class="fill ' + (l.percent >= 90 ? 'crit' : l.percent >= 70 ? 'warn' : '') + '" style="width:' + Math.min(100, l.percent) + '%"></div></div></div>'
  ).join('') + '<div class="muted">' + esc(u.breakdown ? '7d: ' + u.breakdown + ' · ' : '') + esc(T.updated + u.at) + '</div>' +
    (data.usageError ? '<div class="muted">⚠ ' + esc(data.usageError) + '</div>' : '');
}
function renderWelcome() {
  const el = document.getElementById('welcome');
  if (data.welcomeDismissed) { el.innerHTML = ''; return; }
  el.innerHTML = '<div class="card"><h3>' + esc(T.welcomeTitle) + '</h3>' + T.welcome.map(p => '<p>' + p + '</p>').join('') +
    '<button id="ok">' + esc(T.ok) + '</button></div>';
}
// Second line of a project: the memory state in words, its one action, the inbox, the sheet link.
function memLine(p, i) {
  const s = p.scribe;
  if (!s && !p.hasMemory) return '';
  let st = '';
  if (s) {
    st = s.running ? '<span class="st run">' + esc(T.running) + '</span>'
      : s.lag === 0 ? '<span class="st ok" title="' + esc(T.upToDateTip) + '">' + esc(T.upToDate) + '</span>'
      : s.lag === null ? '<span class="st unk">' + esc(T.unknown) + '</span>'
      : '<span class="st" title="' + esc(n(T.behindTip, s.lag)) + '">' + esc(T.behind) + '</span>' + (s.session ? ' <a data-sc="' + i + '">' + esc(T.updateNow) + '</a>' : '');
  }
  const ib = s && s.inbox && s.inbox.total ? '<a class="rv" data-rv="' + i + '" title="' + esc(T.toReviewTip) + '">' + esc(n(T.toReview, s.inbox.total)) + '</a>' : '';
  const sheet = p.hasMemory ? '<a class="sheet" data-sh="' + i + '">' + esc(T.sheet) + '</a>' : '';
  return '<div class="mem">' + st + ib + sheet + '</div>';
}
function renderProjects() {
  const q = document.getElementById('q').value.toLowerCase();
  // projects arrive sorted by last activity: empty filter = the 5 most recent, typing searches them all
  const match = data.projects.filter(p => (p.parent + ' ' + p.name).toLowerCase().includes(q));
  list = q ? match : match.slice(0, 5);
  sel = Math.min(sel, Math.max(0, list.length - 1));
  let html = '';
  list.forEach((p, i) => {
    html += '<div class="proj' + (i === sel ? ' sel' : '') + '"><div class="row" data-i="' + i + '" title="' + esc(p.path) + '"><span class="dot ' + bucket(p.last) + '"></span>' +
      '<span class="label">' + esc(p.name) + (p.parent ? ' <span class="parent">' + esc(p.parent) + '</span>' : '') + '</span>' +
      '<span class="when">' + ago(p.last) + '</span><button class="nw" data-nw="' + i + '" title="' + esc(T.newWindow) + '">⧉</button></div>' +
      memLine(p, i) + '</div>';
  });
  if (!q && data.projects.length > 5) html += '<div class="muted" style="margin-top:4px">' + esc(n(T.more, data.projects.length - 5)) + '</div>';
  document.getElementById('projects').innerHTML = html || '<div class="muted" style="margin-top:8px">' + esc(T.noProject) + '</div>';
}
function section(id, title, help, file, heading, inner, open) {
  return '<details id="' + id + '"' + (open ? ' open' : '') + '><summary>' + esc(title) + '</summary><div class="muted help">' + esc(help) +
    (file ? ' <a data-open="' + esc(file) + '" data-h="' + esc(heading || '') + '">' + esc(T.openFile) + '</a>' : '') + '</div>' + inner + '</details>';
}
const ul = items => items.length ? '<ul>' + items.map(t => '<li>' + md(clean(t)) + '</li>').join('') + '</ul>' : '<div class="muted">' + esc(T.empty) + '</div>';
function renderDetail(d, focus) {
  const el = document.getElementById('detail');
  const p = data.projects.find(x => x.path === detailPath) || { name: '' };
  let html = '<a id="back">' + esc(T.back) + '</a><h2>' + esc(p.name) + '</h2>';
  if (!d) { el.innerHTML = html + '<div class="muted">' + esc(T.noMemory) + '</div>'; return; }
  if (d.review.length) html += section('s-review', T.review + ' (' + d.review.length + ')', T.reviewHelp, 'DECISIONS.md', 'Proposals', ul(d.review.map(r => (r.workspace && r.workspace !== '.' ? '[' + r.workspace + '] ' : '') + r.text)), true);
  html += section('s-facts', T.facts + ' (' + d.facts.length + ')', T.factsHelp, 'DECISIONS.md', 'Facts', ul(d.facts), focus !== 'review');
  html += section('s-rules', T.rules + ' (' + d.rules.reduce((a, r) => a + r.items.length, 0) + ')', T.rulesHelp, null, null,
    d.rules.length ? d.rules.map(r => '<div class="ws">' + esc(r.workspace === '.' ? r.file : r.workspace) + ' · <a data-open="' + esc(r.file) + '" data-h="Active Learnings">' + esc(T.openFile) + '</a></div>' + ul(r.items)).join('') : ul([]), focus !== 'review');
  html += section('s-sessions', T.sessions, T.sessionsHelp, 'JOURNAL.md', '',
    (d.sessions.length ? d.sessions.map(s => '<div class="date">' + esc(s.date) + '</div>' + ul(s.lines) + (s.files.length ? '<div class="files">' + esc(T.files + s.files.join(', ')) + '</div>' : '')).join('') : ul([])) +
    (d.older.length ? '<div class="date">' + esc(T.older) + '</div>' + ul(d.older.map(o => o.date + ' — ' + o.line)) : ''), focus !== 'review');
  el.innerHTML = html;
  if (focus === 'review') document.getElementById('s-review')?.scrollIntoView();
}
function showList() { detailPath = null; document.getElementById('detail').classList.add('hidden'); document.getElementById('list').classList.remove('hidden'); }
function showDetail(p, focus) {
  detailPath = p.path;
  document.getElementById('list').classList.add('hidden');
  const el = document.getElementById('detail');
  el.classList.remove('hidden'); el.innerHTML = '<div class="muted">…</div>'; el.dataset.focus = focus || '';
  vscode.postMessage({ type: 'details', path: p.path });
}
const open = (p, newWindow) => p && vscode.postMessage({ type: 'open', path: p.path, newWindow });
document.getElementById('projects').addEventListener('click', e => {
  const t = e.target.closest('[data-nw],[data-sc],[data-rv],[data-sh],.row');
  if (!t) return;
  if (t.dataset.nw) return open(list[+t.dataset.nw], true);
  if (t.dataset.sc) { const p = list[+t.dataset.sc]; p.scribe.running = true; renderProjects(); return vscode.postMessage({ type: 'scribe', path: p.path }); }
  if (t.dataset.rv) return showDetail(list[+t.dataset.rv], 'review');
  if (t.dataset.sh) return showDetail(list[+t.dataset.sh]);
  open(list[+t.dataset.i], e.ctrlKey || e.metaKey);
});
document.getElementById('welcome').addEventListener('click', e => {
  if (e.target.id === 'ok') { data.welcomeDismissed = true; renderWelcome(); vscode.postMessage({ type: 'dismissWelcome' }); }
});
document.getElementById('detail').addEventListener('click', e => {
  if (e.target.id === 'back') return showList();
  const o = e.target.closest('[data-open]');
  if (o) vscode.postMessage({ type: 'openFile', path: detailPath, file: o.dataset.open, heading: o.dataset.h });
});
const qEl = document.getElementById('q');
qEl.placeholder = T.filter; qEl.title = T.filterTip;
qEl.addEventListener('input', () => { sel = 0; renderProjects(); });
document.addEventListener('keydown', e => {
  if (detailPath) { if (e.key === 'Escape' || e.key === 'Backspace') showList(); return; }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    sel = Math.max(0, Math.min(list.length - 1, sel + (e.key === 'ArrowDown' ? 1 : -1)));
    renderProjects();
    document.querySelector('.proj.sel')?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') open(list[sel], e.ctrlKey || e.metaKey);
});
window.addEventListener('message', e => {
  const m = e.data;
  if (m.type === 'details') { if (m.path === detailPath) renderDetail(m.details, document.getElementById('detail').dataset.focus); return; }
  Object.assign(data, m); renderUsage();
  if ('welcomeDismissed' in m) renderWelcome();
  if (m.projects && !detailPath) renderProjects();
});
// keep the relative times fresh while the view stays open
setInterval(() => { if (!detailPath) renderProjects(); }, 6e4);
renderUsage(); renderWelcome(); renderProjects();
// the view's html is reloaded each time it's shown again: ask for fresh data instead of trusting the embedded copy
vscode.postMessage({ type: 'ready' });
</script></body></html>`;
}

// A project's list entry, plus whether it has memory files (the "What Claude knows" link).
const withMemoryFlag = projects => projects.map(p => ({ ...p, hasMemory: fs.existsSync(path.join(p.path, 'CLAUDE.md')) && fs.existsSync(path.join(p.path, 'DECISIONS.md')) }));

function activate(context) {
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = 'claudeHub.openHub';
  status.show();

  let usage = null, usageError = null, view = null, lastFetch = 0, pending = null;
  const projects = () => withMemoryFlag(getProjects());

  async function refreshUsage() {
    lastFetch = Date.now();
    ({ usage = null, error: usageError = null } = await loadUsage());
    renderStatus(status, usage, usageError);
    view?.webview.postMessage({ usage, usageError });
  }

  // Live mode: every Claude Code session write triggers a refresh, throttled to one per 5 minutes.
  function refreshSoon() {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      view?.webview.postMessage({ projects: projects() });
      refreshUsage();
    }, Math.max(0, lastFetch + MIN_INTERVAL - Date.now()));
  }
  try {
    const watcher = fs.watch(path.join(CLAUDE_DIR, 'projects'), { recursive: true }, (_, file) => {
      if (file?.endsWith('.jsonl')) refreshSoon();
    });
    context.subscriptions.push({ dispose: () => watcher.close() });
  } catch { /* no sessions folder yet: the 5-min timer still runs */ }
  // Memory state: cursors, lock, queue and pending.json change under ~/.claude/scribe; cheap, so no 5-min throttle (2 s debounce).
  let scribeTimer = null;
  try {
    const w = fs.watch(SCRIBE_STATE, { recursive: true }, () => {
      clearTimeout(scribeTimer);
      scribeTimer = setTimeout(() => view?.webview.postMessage({ projects: projects() }), 2000);
    });
    context.subscriptions.push({ dispose: () => { w.close(); clearTimeout(scribeTimer); } });
  } catch { /* no scribe on this machine */ }

  const WELCOME_KEY = 'claudeHub.welcomeDismissed';
  const provider = {
    // Called each time the sidebar view is shown again, so the project list is always fresh.
    resolveWebviewView(v) {
      view = v;
      v.webview.options = { enableScripts: true };
      v.webview.html = hubHtml(v.webview, { projects: projects(), usage, usageError, t: webStrings(), lang: lang(), welcomeDismissed: !!context.globalState.get(WELCOME_KEY) });
      v.webview.onDidReceiveMessage(m => {
        if (m.type === 'open') vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(m.path), { forceNewWindow: !!m.newWindow });
        if (m.type === 'ready') v.webview.postMessage({ projects: projects(), usage, usageError });
        if (m.type === 'scribe') runScribe(getProjects().find(p => p.path === m.path) || {});
        if (m.type === 'details') v.webview.postMessage({ type: 'details', path: m.path, details: projectDetails(m.path) });
        if (m.type === 'openFile') openAt(m.path, m.file, m.heading);
        if (m.type === 'dismissWelcome') context.globalState.update(WELCOME_KEY, true);
      });
      v.onDidDispose(() => { view = null; });
    },
  };

  const minutes = vscode.workspace.getConfiguration('claudeHub').get('usageRefreshMinutes');
  const timer = setInterval(refreshUsage, minutes * 60000);
  refreshUsage();

  context.subscriptions.push(
    status,
    { dispose: () => { clearInterval(timer); clearTimeout(pending); } },
    vscode.window.registerWebviewViewProvider('claudeHub.hub', provider),
    vscode.commands.registerCommand('claudeHub.openHub', () => vscode.commands.executeCommand('claudeHub.hub.focus')),
    vscode.commands.registerCommand('claudeHub.refresh', () => {
      view?.webview.postMessage({ projects: projects() });
      refreshUsage();
    }),
    vscode.commands.registerCommand('claudeHub.showWelcome', async () => {
      await context.globalState.update(WELCOME_KEY, false);
      view?.webview.postMessage({ welcomeDismissed: false });
      vscode.commands.executeCommand('claudeHub.hub.focus');
    }),
  );

  // Start screen: only in a window with no folder, so opening a project keeps its explorer.
  if (!vscode.workspace.workspaceFolders?.length) vscode.commands.executeCommand('claudeHub.hub.focus');
}

module.exports = { activate, deactivate() {}, projectDetails, hubHtml, webStrings, STRINGS };
