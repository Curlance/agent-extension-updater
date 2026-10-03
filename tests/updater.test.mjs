import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { collectInventory, parseArgs } from '../skills/agent-extension-updater/scripts/inventory.mjs';
import { runAuto, validateConfig } from '../skills/agent-extension-updater/scripts/auto-update.mjs';
import { compareVersions, probeGit, planUpdates, backupItem, restoreBackup, updateOne, executePinned, verifyItem, identity, run, samePath } from '../skills/agent-extension-updater/scripts/lib.mjs';

const scriptDir = resolve(dirname(fileURLToPath(import.meta.url)), '../skills/agent-extension-updater/scripts');
const config = { schema_version: 1, auto_update: { enabled: true, scope: { hosts: ['codex'], kinds: ['技能', '插件'] } } };
function temporary(t) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'extension-updater-test-')));
  t.after(() => {
    assert.ok(root.startsWith(fs.realpathSync(tmpdir())) && root.includes('extension-updater-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}
function write(path, value) { fs.mkdirSync(dirname(path), { recursive: true }); fs.writeFileSync(path, value); }
function json(path, value) { write(path, JSON.stringify(value)); }
function skill(path, name = 'demo', version = '1.0.0') { write(join(path, 'SKILL.md'), `---\nname: ${name}\nversion: ${version}\ndescription: Test skill\n---\nTest\n`); }
function git(repo, ...args) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}
function commit(repo, version) {
  skill(repo, 'demo', version);
  json(join(repo, 'package.json'), { name: 'demo', version });
  git(repo, 'add', '.');
  git(repo, '-c', 'user.name=Updater Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', version);
}
function fixture(t, targetVersion = '1.1.0') {
  const root = temporary(t), source = join(root, 'source'), path = join(root, 'home', '.agents', 'skills', 'demo');
  fs.mkdirSync(source);
  git(source, 'init', '-b', 'release');
  commit(source, '1.0.0');
  fs.mkdirSync(dirname(path), { recursive: true });
  git(root, 'clone', '--no-local', source, path);
  commit(source, targetVersion);
  git(source, '-c', 'user.name=Updater Test', '-c', 'user.email=test@example.invalid', 'tag', '-a', `v${targetVersion}`, '-m', targetVersion, '--no-sign', '--', 'HEAD');
  const item = { hosts: ['codex'], host: 'codex', kind: '技能', name: 'demo', path: fs.realpathSync(path), repo: fs.realpathSync(path), current: '1.0.0', status: '待适配' };
  item.id = identity(item);
  probeGit(item);
  return { root, source, path, item, home: join(root, 'state') };
}

test('SemVer handles ranges, missing versions, ordering and prereleases', () => {
  assert.equal(compareVersions('latest', '2.0.0'), undefined);
  assert.equal(compareVersions('^1.0.0', '1.0.0'), undefined);
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1);
  assert.equal(compareVersions('1.0.0-alpha.2', '1.0.0-alpha.10'), -1);
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), -1);
  assert.equal(compareVersions('1.0.0+build1', '1.0.0+build2'), 0);
});

test('inventory rejects mistyped or missing scope arguments', () => {
  assert.throws(() => parseArgs(['--host', 'codex']), /未知参数/);
  assert.throws(() => parseArgs(['--hosts']), /缺少值/);
  assert.deepEqual(parseArgs(['--hosts', 'codex', '--project', 'demo']).hosts, ['codex']);
});

test('Windows batch commands resolve their own directory even through PATH with spaces', { skip: process.platform !== 'win32' }, (t) => {
  const root = temporary(t), bin = join(root, 'bin with spaces');
  write(join(bin, 'updater-fixture.cmd'), '@echo off\r\necho %~dp0\r\n');
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin};${originalPath}`;
  try {
    const result = run('updater-fixture.cmd', ['plain']);
    assert.equal(result.code, 0, result.err);
    // %~dp0 reports the long name while TEMP may hold the 8.3 short alias; the resolved
    // directory is what matters, not the spelling the shell happens to print.
    assert.ok(samePath(resolve(result.out), bin), `${resolve(result.out)} 与 ${bin} 应指向同一目录`);
    assert.notEqual(run('updater-fixture.cmd', ['unsafe&argument']).code, 0);
  } finally { process.env.PATH = originalPath; }
});

test('path identity tolerates Windows short names and letter case', { skip: process.platform !== 'win32' }, (t) => {
  const f = fixture(t), spelled = { ...f.item, path: f.item.path.toUpperCase() };
  delete spelled.updateAction;
  probeGit(spelled);
  // Windows resolves this spelling to the same directory, so it must still be planned;
  // before the fix it was misread as a shared repository subdirectory and silently skipped.
  assert.equal(spelled.updateAction?.type, 'git-pinned', spelled.reason);
  assert.ok(!samePath(f.item.path, join(f.root, 'somewhere else')));
});

test('Codex-only inventory finds user and project skills without DSH', (t) => {
  const root = temporary(t), home = join(root, 'home'), project = join(root, 'project');
  skill(join(home, '.agents', 'skills', 'user'), 'user');
  skill(join(project, '.agents', 'skills', 'project'), 'project');
  const result = collectInventory({ home, project, env: {}, hosts: ['codex'] });
  assert.deepEqual(result.items.map((i) => i.name).sort(), ['project', 'user']);
  assert.deepEqual(result.errors, []);
});

test('Hermes Hub remains a known source during upstream checking', (t) => {
  const home = temporary(t);
  skill(join(home, '.hermes', 'skills', 'tools', 'demo'));
  json(join(home, '.hermes', 'skills', '.hub', 'lock.json'), { installed: { demo: { name: 'demo', version: '1.0.0' } } });
  const result = collectInventory({ home, project: home, env: {}, hosts: ['hermes'], check: true });
  assert.equal(result.items[0].channel, 'hub');
  assert.equal(result.items[0].status, '待适配');
});

test('npm uses installed version and fails on unknown versions', (t) => {
  const home = temporary(t), profile = join(home, '.dsh', 'profiles', 'desktop');
  json(join(profile, 'package.json'), { dependencies: { demo: '^1.0.0' } });
  const options = { home, project: home, env: {}, hosts: ['dsh'], check: true, run: () => ({ code: 0, out: '"1.5.0"' }) };
  assert.equal(collectInventory(options).items[0].status, '检查失败');
  json(join(profile, 'node_modules', 'demo', 'package.json'), { version: '1.5.0' });
  assert.equal(collectInventory(options).items[0].status, '已最新');
  json(join(profile, 'node_modules', 'demo', 'package.json'), { version: '2.0.0' });
  assert.equal(collectInventory(options).items[0].status, '已最新');
  json(join(profile, 'node_modules', 'demo', 'package.json'), { version: '1.0.0' });
  assert.equal(collectInventory(options).items[0].status, '有更新');
});

test('fixed target follows release branch and verifies a real local Git update', (t) => {
  const f = fixture(t);
  assert.equal(f.item.git.ref, 'refs/heads/release');
  assert.equal(f.item.targetVersion, 'v1.1.0');
  assert.equal(planUpdates({ items: [f.item] }, config.auto_update.scope).planned.length, 1);
  const inventory = collectInventory({ home: join(f.root, 'home'), project: f.root, hosts: ['codex'], env: {}, check: true });
  assert.equal(inventory.items.length, 1);
  const batch = runAuto(config, { home: f.home }, { collect: () => inventory, output: () => {} });
  const result = batch.results[0];
  assert.equal(result.ok, true, result.error);
  assert.equal(result.state, '已落盘待重载');
  const logged = fs.readFileSync(join(f.home, 'auto-update.log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).find((e) => e.action === 'update');
  assert.equal(logged.ok, true);
  assert.equal(logged.commit, f.item.targetCommit);
  assert.equal(git(f.path, 'rev-parse', 'HEAD'), f.item.targetCommit);
  const restored = restoreBackup(result.backup, join(f.root, 'restored'));
  assert.equal(git(restored, 'rev-parse', 'HEAD'), f.item.currentCommit);
  assert.equal(JSON.parse(fs.readFileSync(join(restored, 'package.json'))).version, '1.0.0');
  assert.throws(() => restoreBackup(result.backup, f.path), /新目录/);
});

test('remote moving after inspection is rejected without changing installed HEAD', (t) => {
  const f = fixture(t);
  commit(f.source, '1.2.0');
  const result = updateOne(f.item, f.home);
  assert.equal(result.ok, false);
  assert.match(result.error, /上游目标已变化/);
  assert.equal(git(f.path, 'rev-parse', 'HEAD'), f.item.currentCommit);
});

test('unknown, major and dirty updates are never planned automatically', (t) => {
  const f = fixture(t, '2.0.0');
  assert.match(planUpdates({ items: [f.item] }).skipped[0].reason, /主版本/);
  const unknown = structuredClone(f.item);
  delete unknown.updateAction.targetVersion;
  assert.match(planUpdates({ items: [unknown] }).skipped[0].reason, /版本未知/);
  const dirty = structuredClone(f.item);
  dirty.updateAction.dirty = true;
  assert.match(planUpdates({ items: [dirty] }).skipped[0].reason, /本地修改/);
});

test('local edits after planning abort before fetch/merge', (t) => {
  const f = fixture(t);
  write(join(f.path, 'local.txt'), 'keep me');
  assert.throws(() => executePinned(f.item), /本地修改/);
  assert.equal(git(f.path, 'rev-parse', 'HEAD'), f.item.currentCommit);
});

test('a skill inside a larger repository never gets a whole-repo update action', (t) => {
  const f = fixture(t);
  skill(join(f.path, 'nested'), 'nested');
  const item = { ...f.item, path: fs.realpathSync(join(f.path, 'nested')), updateAction: undefined };
  probeGit(item);
  assert.equal(item.updateAction, undefined);
  assert.match(item.reason, /共享仓库/);
});

test('backup copy failure prevents execution', (t) => {
  const root = temporary(t), path = join(root, 'plugin');
  skill(path);
  const item = { path, kind: '插件', name: 'demo' };
  let executed = false;
  const result = updateOne(item, join(root, 'state'), {
    backup: (i, h) => backupItem(i, h, { ...fs, cpSync: () => { throw new Error('disk full'); } }),
    execute: () => { executed = true; },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /disk full/);
  assert.equal(executed, false);
});

test('verification failure cannot be reported as success', (t) => {
  const root = temporary(t);
  const result = updateOne({}, root, { backup: () => 'backup', execute: () => {}, verify: () => { throw new Error('wrong target'); } });
  assert.equal(result.ok, false);
  assert.equal(result.backup, 'backup');
  assert.equal(result.error, 'wrong target');
});

test('same names have distinct backup records and corruption blocks restore', (t) => {
  const root = temporary(t);
  const a = join(root, 'a'), b = join(root, 'b');
  skill(a); skill(b);
  const one = backupItem({ kind: '技能', name: 'demo', path: a }, join(root, 'state'));
  const two = backupItem({ kind: '技能', name: 'demo', path: b }, join(root, 'state'));
  assert.notEqual(one, two);
  assert.notEqual(identity({ kind: '技能', path: a }), identity({ kind: '技能', path: b }));
  const record = JSON.parse(fs.readFileSync(one));
  write(join(record.files, 'SKILL.md'), 'corrupted');
  assert.throws(() => restoreBackup(one, join(root, 'restore')), /损坏/);
});

test('partial inventory failure blocks all updates with a truthful report', (t) => {
  const home = join(temporary(t), 'state'), output = [];
  let updated = false;
  const result = runAuto(config, { home, dryRun: true }, {
    collect: () => ({ items: [{ name: 'broken', status: '检查失败', reason: 'offline' }], errors: [] }),
    update: () => { updated = true; }, output: (line) => output.push(line),
  });
  assert.equal(result.ok, false);
  assert.equal(updated, false);
  assert.match(output.join('\n'), /检查失败/);
  assert.equal(fs.existsSync(home), false);
});

test('batch stops after verification failure and audit records failure only', (t) => {
  const home = join(temporary(t), 'state'), audit = [], calls = [];
  const candidate = { name: 'demo', kind: '技能', hosts: ['codex'], status: '有更新', current: '1.0.0', updateAction: { type: 'git-pinned', targetVersion: '1.1.0', target: 'abc' } };
  const result = runAuto(config, { home }, {
    collect: () => ({ items: [candidate, { ...candidate, name: 'second' }], errors: [] }), output: () => {}, audit: (entry) => audit.push(entry),
    update: (item) => { calls.push(item.name); return { ok: false, state: '失败', error: 'verification failed' }; },
  });
  assert.deepEqual(calls, ['demo']);
  assert.equal(result.ok, false);
  assert.equal(audit.find((e) => e.action === 'update').ok, false);
  assert.equal(fs.existsSync(join(home, 'run.lock')), false);
});

test('existing lock and audit failure both prevent updates', (t) => {
  const home = temporary(t);
  write(join(home, 'run.lock'), 'other process');
  assert.throws(() => runAuto(config, { home }, { collect: () => { throw new Error('must not collect'); } }), /EEXIST/);
  assert.equal(fs.readFileSync(join(home, 'run.lock'), 'utf8'), 'other process');
  fs.unlinkSync(join(home, 'run.lock'));
  let updated = false;
  const item = { kind: '技能', hosts: ['codex'], current: '1.0.0', status: '有更新', updateAction: { type: 'git-pinned', targetVersion: '1.1.0' } };
  assert.throws(() => runAuto(config, { home }, { collect: () => ({ items: [item], errors: [] }), output: () => {}, audit: () => { throw new Error('log denied'); }, update: () => { updated = true; } }), /log denied/);
  assert.equal(updated, false);
});

test('shared skills are deduplicated and require all affected hosts in scope', (t) => {
  const home = temporary(t);
  fs.mkdirSync(join(home, '.dsh'));
  skill(join(home, '.agents', 'skills', 'demo'));
  const inventory = collectInventory({ home, env: {}, hosts: ['dsh', 'codex'], project: home });
  assert.equal(inventory.items.length, 1);
  assert.deepEqual(inventory.items[0].hosts, ['dsh', 'codex']);
  const item = { ...inventory.items[0], status: '有更新', updateAction: { type: 'git-pinned', targetVersion: '1.1.0' } };
  assert.match(planUpdates({ items: [item] }, { hosts: ['codex'] }).skipped[0].reason, /未授权宿主/);
});

test('malformed config fails closed and isolated CLI status writes nothing', (t) => {
  assert.throws(() => validateConfig({ schema_version: 1, auto_update: { enabled: 'false' } }), /无效配置/);
  const root = temporary(t), configPath = join(root, 'config.json');
  const result = spawnSync(process.execPath, [join(scriptDir, 'auto-update.mjs'), '--status'], { encoding: 'utf8', windowsHide: true, env: { ...process.env, AGENT_EXTENSION_UPDATER_CONFIG: configPath } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /已关闭/);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('dry run of an actionable update creates no backup, lock or audit file', (t) => {
  const home = join(temporary(t), 'state');
  const item = { kind: '技能', name: 'demo', hosts: ['codex'], status: '有更新', current: '1.0.0', updateAction: { type: 'git-pinned', targetVersion: '1.1.0' } };
  const result = runAuto(config, { home, dryRun: true }, { collect: () => ({ items: [item], errors: [] }), output: () => {}, update: () => assert.fail('must not update'), audit: () => assert.fail('must not audit') });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].state, '演练');
  assert.equal(fs.existsSync(home), false);
});

test('mislabelled version tag is rejected before installed files change', (t) => {
  const f = fixture(t, '2.0.0');
  git(f.source, 'tag', '-d', 'v2.0.0');
  git(f.source, 'tag', 'v1.1.0');
  probeGit(f.item);
  assert.equal(planUpdates({ items: [f.item] }).planned.length, 1);
  assert.throws(() => executePinned(f.item), /目标内容版本/);
  assert.equal(git(f.path, 'rev-parse', 'HEAD'), f.item.currentCommit);
});

test('divergent local commits cannot be merged or discarded', (t) => {
  const f = fixture(t);
  commit(f.path, '1.0.1');
  f.item.current = '1.0.1';
  probeGit(f.item);
  const before = git(f.path, 'rev-parse', 'HEAD');
  assert.throws(() => executePinned(f.item));
  assert.equal(git(f.path, 'rev-parse', 'HEAD'), before);
});

test('changed branch after checking aborts before updating', (t) => {
  const f = fixture(t);
  git(f.path, 'checkout', '-b', 'other');
  git(f.path, 'config', 'branch.other.remote', 'origin');
  git(f.path, 'config', 'branch.other.merge', 'refs/heads/release');
  assert.throws(() => executePinned(f.item), /branch 已变化/);
  assert.equal(git(f.path, 'rev-parse', 'HEAD'), f.item.currentCommit);
});

test('missing remote branch is a check failure, not latest', (t) => {
  const f = fixture(t);
  git(f.path, 'config', 'branch.release.merge', 'refs/heads/missing');
  const result = collectInventory({ home: join(f.root, 'home'), project: f.root, env: {}, hosts: ['codex'], check: true });
  assert.equal(result.items[0].status, '检查失败');
  assert.equal(result.items[0].updateAction, undefined);
});

test('malformed manifests produce inventory errors instead of disappearing', (t) => {
  const home = temporary(t);
  write(join(home, '.dsh', 'profiles', 'desktop', 'package.json'), '{broken');
  const result = collectInventory({ home, project: home, env: {}, hosts: ['dsh'] });
  assert.equal(result.errors.length, 1);
});

test('verification is tied to exact path, not another same-name extension', (t) => {
  const f = fixture(t);
  assert.throws(() => verifyItem(f.item), /验证失败/);
  executePinned(f.item);
  assert.equal(verifyItem(f.item).commit, f.item.targetCommit);
});
