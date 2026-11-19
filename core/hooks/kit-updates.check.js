#!/usr/bin/env node
// kit-updates.check.js — run: node core/hooks/kit-updates.check.js
// The "kit update available" part of inject-journal.sh: KIT_VERSION matches UPDATES.md, newer entries are told once a day.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repo = path.join(__dirname, '..', '..');
const hook = fs.readFileSync(path.join(__dirname, 'inject-journal.sh'), 'utf8');
const version = hook.match(/^KIT_VERSION=(\S+)/m)[1];
const newest = fs.readFileSync(path.join(repo, 'UPDATES.md'), 'utf8').match(/^## (\d{4}-\d{2}-\d{2})/m)[1];
assert.strictEqual(version, newest, 'KIT_VERSION in inject-journal.sh must equal the newest UPDATES.md entry');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-updates-check-'));
const proj = path.join(tmp, 'proj'), upd = path.join(tmp, '.claude', 'kit-updates');
fs.mkdirSync(proj); fs.mkdirSync(upd, { recursive: true });
fs.writeFileSync(path.join(proj, 'CLAUDE.md'), '# p\n'); fs.writeFileSync(path.join(proj, 'DECISIONS.md'), '# d\n');
fs.writeFileSync(path.join(upd, 'UPDATES.md'), `# Updates\n\n## 2999-01-01\n- Something new for you.\n\n## ${version}\n- Already installed.\n`);
const run = () => spawnSync('bash', [path.join(__dirname, 'inject-journal.sh')], {
  env: { ...process.env, HOME: tmp, CLAUDE_PROJECT_DIR: proj, ZERO_TO_HERO_NO_UPDATE_CHECK: '1' }, encoding: 'utf8' }).stdout;

const first = run();
assert.ok(first.includes('Kit update available') && first.includes('Something new for you'), first);
assert.ok(!first.includes('Already installed'), 'an entry not newer than KIT_VERSION is not told');
assert.strictEqual(run(), '', 'told once a day, then silent (no journal here)');
fs.rmSync(tmp, { recursive: true, force: true });
console.log('kit-updates.check: ok');
