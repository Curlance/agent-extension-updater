#!/usr/bin/env node
// Read-only discovery. Network checks never fetch or change installed extensions.
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { run, must, readJson, frontmatter, probeGit, compareVersions, identity, inside } from './lib.mjs';

export function collectInventory(options = {}) {
  const home = options.home || homedir();
  const env = options.env || process.env;
  const project = resolve(options.project || process.cwd());
  const runner = options.run || run;
  const hosts = (options.hosts || []).map((h) => h === 'claude-code' ? 'claude' : h.toLowerCase());
  if (hosts.some((h) => !['dsh', 'hermes', 'codex', 'claude'].includes(h))) throw new Error('未知宿主');
  const want = (host) => !hosts.length || hosts.includes(host);
  const items = [], notes = [], errors = [];
  const add = (item) => {
    const original = resolve(item.path);
    if (fs.existsSync(original)) {
      item.path = fs.realpathSync(original);
      if (item.path !== original) item.linked = true;
    } else item.path = original;
    item.id = identity(item);
    const existing = items.find((i) => i.id === item.id);
    if (existing) {
      existing.hosts = [...new Set([...existing.hosts, ...item.hosts])];
      existing.host = existing.hosts.join('+');
      return;
    }
    items.push({ current: '-', latest: '', status: '无来源', ...item, host: item.hosts.join('+') });
  };
  const directories = (path) => {
    try { return fs.readdirSync(path, { withFileTypes: true }).filter((e) => !e.name.startsWith('.')); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  const safe = (label, fn) => { try { fn(); } catch (error) { errors.push(`${label}：${error.message}`); } };
  const scanSkills = (root, owners, channel, classify = () => ({})) => {
    for (const entry of directories(root)) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const path = join(root, entry.name);
      const skillPath = join(path, 'SKILL.md');
      if (!fs.existsSync(skillPath)) continue;
      safe(path, () => {
        const fm = frontmatter(skillPath);
        if (!fm.name) throw new Error('技能缺少 name');
        add({ hosts: owners, kind: '技能', name: fm.name, path, channel, current: fm.version || '-', updateAt: '本地技能；识别 Git 来源后提供精确目标', ...classify(fm.name) });
      });
    }
  };

  const dshHome = env.DSH_HOME || join(home, '.dsh');
  const sharedHosts = fs.existsSync(dshHome) ? ['dsh', 'codex'] : ['codex'];
  if (want('codex') || (want('dsh') && fs.existsSync(dshHome))) safe('共享技能目录', () => {
    scanSkills(join(home, '.agents', 'skills'), sharedHosts, 'user-agents');
    scanSkills(join(project, '.agents', 'skills'), sharedHosts, 'project-agents');
  });

  if (want('dsh')) safe('DSH', () => {
    scanSkills(join(dshHome, 'skills'), ['dsh'], 'user-dsh');
    scanSkills(join(project, '.dsh', 'skills'), ['dsh'], 'project-dsh');
    if (env.DSH_AGENTS_HOME) scanSkills(join(env.DSH_AGENTS_HOME, 'skills'), ['dsh'], 'user-agents');
    const profile = env.DSH_PROFILE || 'desktop';
    const profileDir = env.DSH_PROFILE_DIR || join(dshHome, 'profiles', profile);
    const manifest = readJson(join(profileDir, 'package.json'), {});
    for (const [name, spec] of Object.entries(manifest.dependencies || {})) {
      if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name) || typeof spec !== 'string') throw new Error('无效的插件依赖声明');
      const local = /^(link:|file:)/.test(spec);
      const builtin = name.startsWith('@deepseek-ai/');
      const path = local ? resolve(profileDir, spec.slice(5)) : join(profileDir, 'node_modules', ...name.split('/'));
      const installed = readJson(join(path, 'package.json'), {});
      add({ hosts: ['dsh'], kind: '插件', name, path, profile, declared: spec,
        channel: builtin ? 'bundled' : local ? 'local' : 'npm', current: installed.version || '-',
        status: '待适配', repo: local ? path : undefined,
        updateAt: builtin ? '随本体，跳过' : local ? '按 Git 跟踪分支检查' : '退出 DSH 后通过官方插件入口更新',
        updateAction: !builtin && !local ? { type: 'manual', requiresAppQuit: true } : undefined });
    }
    for (const name of manifest.dsh?.profile?.bundles || []) {
      if (name in (manifest.dependencies || {})) continue;
      notes.push(`DSH bundle ${name} 未在 dependencies 中登记，可能随本体提供；未作为独立更新目标`);
    }
  });

  if (want('hermes')) safe('Hermes', () => {
    const hermesHome = env.HERMES_HOME || join(home, '.hermes');
    const root = join(hermesHome, 'skills');
    let bundled = new Set();
    try { bundled = new Set(fs.readFileSync(join(root, '.bundled_manifest'), 'utf8').split(/\r?\n/).map((line) => line.split(':')[0])); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const lock = readJson(join(root, '.hub', 'lock.json'), {});
    const hub = new Map(Object.entries(lock.installed || {}).map(([key, value]) => [value?.name || key, value]));
    const classify = (name) => hub.has(name)
      ? { channel: 'hub', status: '待适配', current: hub.get(name)?.version || '-', reason: '已识别 Hub 来源；远端协议待适配', updateAt: `通过 Hermes 官方技能入口检查 ${name}` }
      : bundled.has(name) ? { channel: 'bundled', status: '待适配', updateAt: '随宿主维护，跳过' } : {};
    scanSkills(root, ['hermes'], 'local', classify);
    for (const category of directories(root)) if (category.isDirectory() && !fs.existsSync(join(root, category.name, 'SKILL.md'))) scanSkills(join(root, category.name), ['hermes'], 'local', classify);
    for (const entry of directories(join(hermesHome, 'plugins'))) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const path = join(hermesHome, 'plugins', entry.name);
      const pkg = readJson(join(path, 'package.json'), {});
      add({ hosts: ['hermes'], kind: '插件', name: pkg.name || entry.name, path, channel: 'hermes-plugin', current: pkg.version || '-', status: '待适配', updateAt: '通过 Hermes 官方插件入口检查；协议待适配' });
    }
  });

  if (want('codex')) safe('Codex', () => {
    const root = join(env.CODEX_HOME || join(home, '.codex'), 'plugins');
    if (fs.existsSync(root)) notes.push('Codex 插件安装记录格式尚未适配；未把 cache/marketplaces 当成已安装插件');
  });
  if (want('claude')) safe('Claude Code', () => {
    const root = env.CLAUDE_CONFIG_DIR || join(home, '.claude');
    scanSkills(join(root, 'skills'), ['claude'], 'user');
    scanSkills(join(project, '.claude', 'skills'), ['claude'], 'project');
    if (fs.existsSync(join(root, 'plugins'))) notes.push('Claude Code 插件安装记录格式尚未适配');
  });

  const npmCache = new Map();
  for (const item of items) {
    try {
      if (item.linked) { item.status = '待适配'; item.reason = '符号链接或 junction，需确认真实路径的授权范围'; delete item.updateAction; continue; }
      if (item.channel === 'bundled') continue;
      if (item.channel === 'npm' && options.check) {
        if (!npmCache.has(item.name)) npmCache.set(item.name, runner(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['view', item.name, 'version', '--json']));
        const latest = JSON.parse(must(npmCache.get(item.name)));
        item.latest = latest;
        const comparison = compareVersions(item.current, latest);
        if (comparison === undefined) throw new Error('无法确定实际安装版本或远端版本');
        item.status = comparison < 0 ? '有更新' : '已最新';
        if (comparison > 0) item.reason = '本地版本领先于远端 latest，不执行降级';
      } else if (item.channel === 'local' || (item.kind === '技能' && !['hub', 'bundled'].includes(item.channel))) {
        const result = runner('git', ['-C', item.path, 'rev-parse', '--show-toplevel']);
        if (result.code !== 0) {
          if (item.repo || fs.existsSync(join(item.path, '.git'))) throw new Error(result.err || '无法读取 Git 来源');
          continue;
        }
        item.repo = fs.realpathSync(result.out);
        item.channel = 'git';
        item.status = '待适配';
        item.reason = '已识别 Git 来源；尚未检查上游';
        item.updateAt = '按当前分支的实际 upstream 检查，固定提交更新';
        if (!inside(item.repo, item.path)) throw new Error('Git 仓库与技能路径不一致');
        if (item.current === '-') item.current = readJson(join(item.path, 'package.json'), {})?.version || '-';
        if (options.check) probeGit(item, runner);
      }
    } catch (error) { item.status = '检查失败'; item.reason = error.message; delete item.updateAction; }
  }
  return { checkedUpstream: !!options.check, project, items, notes, errors };
}

export function parseArgs(argv) {
  const allowed = new Set(['--check-updates', '--json', '--all', '--hosts', '--project']);
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!allowed.has(key)) throw new Error(`未知参数：${key}`);
    if (['--hosts', '--project'].includes(key) && (!argv[++i] || argv[i].startsWith('--'))) throw new Error(`${key} 缺少值`);
  }
  const value = (key) => { const i = argv.indexOf(key); if (i < 0) return undefined; if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`${key} 缺少值`); return argv[i + 1]; };
  return { check: argv.includes('--check-updates'), json: argv.includes('--json'), all: argv.includes('--all'), hosts: value('--hosts')?.split(',').map((s) => s.trim()), project: value('--project') };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = collectInventory(options);
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`宿主扩展盘点（${options.check ? '含上游探测' : '本地盘点，未联网'}）\n项目根：${result.project}`);
      for (const item of result.items.filter((i) => options.all || i.status !== '无来源')) console.log(`${item.host} / ${item.kind} / ${item.name}\n  ${item.current} → ${item.latest || '-'}：${item.status}\n  ${item.path}\n  ${item.reason || item.updateAt}`);
      console.log(`共 ${result.items.length} 项；无来源项可用 --all 展开。`);
      for (const note of result.notes) console.log(`注意：${note}`);
      for (const error of result.errors) console.error(`检查失败：${error}`);
    }
    if (result.errors.length || result.items.some((i) => i.status === '检查失败')) process.exitCode = 1;
  } catch (error) { console.error(`盘点失败：${error.message}`); process.exitCode = 1; }
}
