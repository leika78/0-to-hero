#!/usr/bin/env node
// workspace-inject.js — PostToolUse hook (Read|Edit|Write): the workspace role reaches the session by mechanism.
//
// The first time a session touches a file inside a workspace (nearest folder above the file holding AGENT.md,
// itself directly under a folder holding CLAUDE.md), that workspace's AGENT.md is injected as additionalContext.
// Once per session (and per subagent) per workspace. Why: "read AGENT.md first" is a prose instruction and was
// followed in 0-8 % of sessions (measured 2026-11-13); SessionStart injection, by contrast, is always seen.
//
// Fail-open: any error or anything unexpected exits 0 silently.
// ponytail: the marker survives /compact, so a compacted session is not re-injected; clear the marker dir from a
// SessionStart(compact) hook if rules get lost in long sessions.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const MAX_CHARS = 9000; // Claude Code replaces a hook string over 10 000 chars with a file path + 2k preview
const SKIP = /^## (Pre-work checklist|Invocation scope|Skill creation)/i; // restates what CLAUDE.md and the hooks already do
const MARKERS = process.env.WORKSPACE_INJECT_STATE || path.join(os.tmpdir(), 'claude-workspace-inject');

function findWorkspace(file) {
  let dir = path.dirname(file);
  for (;;) {
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    // A nested AGENT.md whose parent lacks CLAUDE.md is not a workspace: keep walking up to the real one.
    if (fs.existsSync(path.join(dir, 'AGENT.md')) && fs.existsSync(path.join(parent, 'CLAUDE.md'))) return dir;
    dir = parent;
  }
}

function body(agentFile) {
  const parts = fs.readFileSync(agentFile, 'utf8').split(/^(?=## )/m);
  return parts.filter(p => !SKIP.test(p)).join('').trim();
}

let input = '';
const bail = setTimeout(() => process.exit(0), 3000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => (input += c));
process.stdin.on('end', () => {
  clearTimeout(bail);
  try {
    const data = JSON.parse(input);
    const fp = data.tool_input && data.tool_input.file_path;
    if (!fp || !data.session_id) return;
    const file = path.resolve(data.cwd || process.cwd(), fp);
    const ws = findWorkspace(file);
    if (!ws) return;

    const key = crypto.createHash('sha1').update(`${data.session_id}|${data.agent_id || ''}|${ws.toLowerCase()}`).digest('hex');
    const marker = path.join(MARKERS, key);
    if (fs.existsSync(marker)) return;
    const seen = () => { fs.mkdirSync(MARKERS, { recursive: true }); fs.writeFileSync(marker, ''); };
    // the session is reading it itself
    if (path.basename(file) === 'AGENT.md' && path.dirname(file) === ws && data.tool_name === 'Read') return seen();

    const name = path.basename(ws);
    let text = body(path.join(ws, 'AGENT.md'));
    if (!text) return;
    if (text.length > MAX_CHARS) {
      text = text.slice(0, MAX_CHARS) + `\n\n(truncated at ${MAX_CHARS} chars: Read ${name}/AGENT.md for the rest before editing here)`;
    }
    const context =
      `# Workspace \`${name}\` (from ${name}/AGENT.md)\n\n` +
      `You are now working in this workspace. Take this role, and apply its Process, Limits and Rules as binding ` +
      `constraints for every file under \`${name}/\`, together with its Active Learnings and Current state injected at session start.\n\n` +
      text;
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: context } }));
    seen(); // only once something was actually injected: a read error or an empty body retries on the next touch
  } catch {
    /* fail-open */
  }
});
