#!/usr/bin/env node
// workspace-inject.check.js — run: node core/hooks/workspace-inject.check.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-inject-check-'));
const proj = path.join(tmp, 'proj');
fs.mkdirSync(path.join(proj, 'web', 'code_next'), { recursive: true });
fs.mkdirSync(path.join(proj, 'docs'), { recursive: true });
fs.writeFileSync(path.join(proj, 'CLAUDE.md'), '# proj\n');
fs.writeFileSync(path.join(proj, 'docs', 'x.md'), 'x');
fs.writeFileSync(path.join(proj, 'web', 'code_next', 'a.ts'), 'x');
fs.writeFileSync(
  path.join(proj, 'web', 'AGENT.md'),
  '# Web — Engineer\n\n## Pre-work checklist\n1. boilerplate\n\n## Role\nBuild the app.\n\n## Rules\n- NEVER leak emails\n'
);

const run = (file, session = 's1', tool = 'Edit') => {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'workspace-inject.js')], {
    input: JSON.stringify({ session_id: session, cwd: proj, tool_name: tool, tool_input: { file_path: file } }),
    env: { ...process.env, WORKSPACE_INJECT_STATE: path.join(tmp, 'state') },
    encoding: 'utf8',
  });
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext : '';
};

const first = run(path.join(proj, 'web', 'code_next', 'a.ts'));
assert(first.includes('NEVER leak emails') && first.includes('Build the app.'), 'first touch injects role and rules');
assert(!first.includes('boilerplate'), 'pre-work checklist is stripped');
assert.strictEqual(run('web/code_next/a.ts'), '', 'second touch in the same session is silent (relative path too)');
assert(run(path.join(proj, 'web', 'code_next', 'a.ts'), 's2').includes('NEVER leak emails'), 'a new session is injected again');
assert.strictEqual(run(path.join(proj, 'docs', 'x.md'), 's3'), '', 'a support folder injects nothing');
assert.strictEqual(run(path.join(proj, 'web', 'AGENT.md'), 's4', 'Read'), '', 'reading AGENT.md itself injects nothing');
assert.strictEqual(run(path.join(proj, 'web', 'code_next', 'a.ts'), 's4'), '', '...and counts as seen');

// A nested AGENT.md (its parent has no CLAUDE.md) does not hide the real workspace above it.
fs.writeFileSync(path.join(proj, 'web', 'code_next', 'AGENT.md'), '# nested\n');
assert.strictEqual(run(path.join(proj, 'web', 'code_next', 'a.ts'), 's6').split('\n')[0], '# Workspace `web` (from web/AGENT.md)', 'nested AGENT.md: walks up to web');
fs.rmSync(path.join(proj, 'web', 'code_next', 'AGENT.md'));

// An empty body (only skipped sections) injects nothing and does not mark the workspace seen.
fs.mkdirSync(path.join(proj, 'api'));
fs.writeFileSync(path.join(proj, 'api', 'AGENT.md'), '## Pre-work checklist\n1. x\n');
assert.strictEqual(run(path.join(proj, 'api', 'b.ts'), 's7'), '', 'empty body: nothing injected');
fs.writeFileSync(path.join(proj, 'api', 'AGENT.md'), '## Rules\n- NEVER drop tables\n');
assert.ok(run(path.join(proj, 'api', 'b.ts'), 's7').endsWith('## Rules\n- NEVER drop tables'), 'same session, body now filled: injected');

fs.writeFileSync(path.join(proj, 'web', 'AGENT.md'), '# Web\n\n## Rules\n' + '- ALWAYS x\n'.repeat(2000));
const big = run(path.join(proj, 'web', 'code_next', 'a.ts'), 's5');
assert(big.length < 10000 && big.includes('truncated'), 'oversized AGENT.md is cut under the 10k cap and says so');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('workspace-inject: 11 checks ok');
