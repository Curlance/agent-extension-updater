#!/usr/bin/env node
// inventory.mjs —— 只读盘点：当前机器上各宿主的「技能 / 插件」有哪些更新、在哪里更新
//
// 用法：
//   node scripts/inventory.mjs                     # 本地盘点（不联网）
//   node scripts/inventory.mjs --check-updates     # 额外做上游版本探测（只读网络请求）
//   node scripts/inventory.mjs --json              # 机器可读输出
//   node scripts/inventory.mjs --all               # 连"无上游的本地技能"也逐条列出（默认折叠）
//   node scripts/inventory.mjs --hosts dsh,hermes  # 只看指定宿主
//   node scripts/inventory.mjs --project <dir>     # 指定"项目根"（用于 .dsh/skills 等）
//
// 范围：只盘点 skills 与 plugins。**Agent 本体不在本技能范围内**，不会被检查、也不会出现在清单里。
//
// 本脚本只读：不安装、不更新、不写任何文件、不改任何配置。
// 状态词表与 SKILL.md 一致：有更新 / 已最新 / 检查失败 / 无来源 / 待适配

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

const HAS_UPDATE = '有更新';
const LATEST = '已最新';
const CHECK_FAILED = '检查失败';
const NO_SOURCE = '无来源';
const UNADJUSTED = '待适配';

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const optValue = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : '';
};
const OPT = {
  check: argv.includes('--check-updates'),
  json: argv.includes('--json'),
  all: argv.includes('--all'),
  project: optValue('--project') || process.cwd(),
  hosts: optValue('--hosts').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
};
const wantHost = (h) => OPT.hosts.length === 0 || OPT.hosts.includes(h);

const items = [];
const notes = [];
const add = (item) => items.push({ latest: '', status: NO_SOURCE, ...item });

// ---------- 基础工具 ----------
const readText = (p) => { try { return readFileSync(p, 'utf8'); } catch { return undefined; } };
const readJson = (p) => { const t = readText(p); if (!t) return undefined; try { return JSON.parse(t.replace(/^\uFEFF/, '')); } catch { return undefined; } };
const isDir = (p) => { try { return existsSync(p) && readdirSync(p) !== undefined; } catch { return false; } };
const listDirs = (p) => { try { return readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; } };

function parseFrontmatter(text) {
  if (!text) return undefined;
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0] === undefined || lines[0].trim() !== '---') return undefined;
  let close = -1;
  for (let i = 1; i < lines.length; i += 1) if (lines[i].trim() === '---') { close = i; break; }
  if (close < 0) return undefined;
  const fm = {};
  const body = lines.slice(1, close);
  for (let i = 0; i < body.length; i += 1) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(body[i]);
    if (!m) continue;
    if (m[2] === '' || /^[>|][-+]?$/.test(m[2])) {
      const buf = [];
      for (let j = i + 1; j < body.length && /^\s+\S/.test(body[j]); j += 1) buf.push(body[j].trim());
      fm[m[1]] = buf.join(' ');
    } else fm[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return fm;
}

function skillEntriesIn(root, knownNames) {
  const out = [];
  if (!isDir(root)) return out;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      const fm = parseFrontmatter(readText(join(full, 'SKILL.md')));
      if (fm && fm.name) out.push({ name: fm.name, path: full, fm });
    } else if (entry.name.endsWith('.md')) {
      const fm = parseFrontmatter(readText(full));
      if (fm && fm.name) out.push({ name: fm.name, path: full, fm });
    }
  }
  return out;
}

function run(cmd, args, timeoutMs = 30000) {
  // Windows 上 .cmd/.bat 必须经 shell 执行；且含空格的路径要引号包裹，否则会被拆断
  const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd);
  const opts = { encoding: 'utf8', timeout: timeoutMs, windowsHide: true };
  let r;
  if (needsShell) {
    const q = (s) => (/[\s"]/.test(s) ? `"${String(s).replace(/"/g, '\\"')}"` : String(s));
    r = spawnSync([q(cmd), ...args.map(q)].join(' '), { ...opts, shell: true });
  } else {
    r = spawnSync(cmd, args, opts);
  }
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim(), failed: r.error !== undefined };
}

const hasCmd = (name) => {
  const probe = process.platform === 'win32' ? run('where', [name], 8000) : run('which', [name], 8000);
  return probe.code === 0 && probe.out.length > 0;
};
void hasCmd; // 保留：宿主 CLI 可用性探测工具函数

// ---------- DSH ----------
function scanDsh() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  if (!existsSync(home)) return;
  const profile = process.env.DSH_PROFILE || 'desktop';
  const profileDir = process.env.DSH_PROFILE_DIR || join(home, 'profiles', profile);

  // 技能根（rank 见 references/dsh.md）
  const roots = [
    ['project-dsh', join(OPT.project, '.dsh/skills')],
    ['project-agents', join(OPT.project, '.agents/skills')],
    ['user-dsh', join(home, 'skills')],
    ['user-agents', join(process.env.DSH_AGENTS_HOME || join(homedir(), '.agents'), 'skills')],
  ];
  const seen = new Set();
  for (const [rank, root] of roots) {
    for (const s of skillEntriesIn(root)) {
      const key = `${s.name}|${s.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const shared = root.includes(`${join(homedir(), '.agents')}`);
      add({
        host: shared ? 'DSH+Codex' : 'DSH',
        kind: '技能',
        name: s.name,
        path: s.path,
        channel: rank,
        current: '-',
        updateAt: '本地目录：有上游则按上游方式；本地自定义则手工替换（整棵目录）',
      });
    }
  }

  // 插件：profile 的 dependencies + bundles
  const manifest = readJson(join(profileDir, 'package.json'));
  if (manifest) {
    const deps = manifest.dependencies || {};
    const bundles = (manifest.dsh && manifest.dsh.profile && manifest.dsh.profile.bundles) || [];
    for (const [name, spec] of Object.entries(deps)) {
      const builtin = name.startsWith('@deepseek-ai/');
      let channel = 'npm';
      let repo = '';
      if (spec.startsWith('link:') || spec.startsWith('file:')) {
        channel = 'local';
        repo = resolve(profileDir, spec.slice(5));
      } else if (builtin) channel = 'bundled';
      add({
        host: 'DSH',
        kind: '插件',
        name,
        path: channel === 'local' ? repo : join(profileDir, 'node_modules', ...name.split('/')),
        channel,
        current: channel === 'local' ? (readJson(join(repo, 'package.json'))?.version || '-') : spec,
        updateAt: builtin
          ? '随本体：桌面端官方更新入口'
          : channel === 'local'
            ? `git -C "${repo}" pull（link: 安装；重启 DSH 生效）`
            : `dsh plugin --profile ${profile} add ${name}@latest`,
        updateAction: builtin
          ? undefined
          : channel === 'local'
            ? { type: 'git-pull', repo }
            // DSH 官方要求：执行 dsh plugin 前必须完全退出桌面端
            : { type: 'cmd', cmd: 'dsh', args: ['plugin', '--profile', profile, 'add', `${name}@latest`], requiresAppQuit: true },
        repo,
        profile,
        status: UNADJUSTED,
      });
    }
    for (const b of bundles) {
      if (b in deps) continue;
      if (b.startsWith('@deepseek-ai/')) {
        // 随本体内置的组合包：由应用提供，不出现在 profile 依赖里（正常，不是异常）
        add({
          host: 'DSH', kind: '插件', name: b,
          path: '（随本体内置，不由 profile 依赖提供）', channel: 'bundled',
          current: '-', updateAt: '随本体：桌面端官方更新入口', status: UNADJUSTED,
        });
      } else {
        notes.push(`DSH 插件 "${b}" 在 dsh.profile.bundles 中登记但不在 dependencies 里（可能是登记残留，供人工核对）`);
      }
    }
  }
}

// ---------- Hermes ----------
function scanHermes() {
  const home = process.env.HERMES_HOME || join(homedir(), '.hermes');
  const skillsDir = existsSync(join(home, 'skills')) ? join(home, 'skills') : join(homedir(), '.hermes', 'skills');
  if (!existsSync(home) && !existsSync(skillsDir)) return;

  const bundled = new Set((readText(join(skillsDir, '.bundled_manifest')) || '').split(/\r?\n/).map((l) => l.split(':')[0]).filter(Boolean));
  const lock = readJson(join(skillsDir, '.hub', 'lock.json')) || {};
  const hub = new Set(Object.values(lock.installed || {}).map((e) => e && e.name).filter(Boolean));

  for (const category of listDirs(skillsDir)) {
    if (category.startsWith('.')) continue;
    for (const s of skillEntriesIn(join(skillsDir, category))) {
      let type = 'local';
      let updateAt = '本地自定义：无上游，手工替换整棵目录';
      let status = NO_SOURCE;
      let updateAction;
      if (hub.has(s.name)) { type = 'hub'; updateAt = `hermes skills update ${s.name}`; status = UNADJUSTED; updateAction = { type: 'cmd', cmd: 'hermes', args: ['skills', 'update', s.name] }; }
      else if (bundled.has(s.name)) { type = 'bundled'; updateAt = `hermes skills reset ${s.name} --restore`; status = UNADJUSTED; }
      add({ host: 'Hermes', kind: '技能', name: s.name, path: s.path, channel: type, current: '-', updateAt, status, updateAction });
    }
  }

  for (const p of listDirs(join(home, 'plugins'))) {
    if (p.startsWith('.')) continue;
    const pj = readJson(join(home, 'plugins', p, 'package.json'));
    add({
      host: 'Hermes', kind: '插件', name: (pj && pj.name) || p,
      path: join(home, 'plugins', p), channel: 'hermes-plugin',
      current: (pj && pj.version) || '-',
      updateAt: `hermes plugins update ${p}`,
      updateAction: { type: 'cmd', cmd: 'hermes', args: ['plugins', 'update', p] },
      status: UNADJUSTED,
    });
  }
}

// ---------- Codex / Claude Code ----------
function scanCodex() {
  const home = join(homedir(), '.codex');
  if (!existsSync(home)) return;
  for (const p of listDirs(join(home, 'plugins'))) {
    if (p.startsWith('.') || p === 'cache') continue; // 内部目录不是插件
    add({ host: 'Codex', kind: '插件', name: p, path: join(home, 'plugins', p), channel: 'codex-plugin', current: '-', updateAt: '按官方插件管理入口（市场刷新 ≠ 插件升级）', status: UNADJUSTED });
  }
}

function scanClaude() {
  const home = join(homedir(), '.claude');
  const roots = [[join(home, 'skills'), 'user'], [join(OPT.project, '.claude/skills'), 'project']];
  if (!existsSync(home) && !existsSync(roots[1][0])) {
    notes.push('Claude Code 未安装或未初始化（~/.claude 与项目 .claude/skills 都不存在）→ 不适用');
    return;
  }
  for (const [root, scope] of roots) {
    for (const s of skillEntriesIn(root)) {
      add({ host: 'Claude Code', kind: '技能', name: s.name, path: s.path, channel: scope, current: '-', updateAt: scope === 'user' ? '本地目录；若来自插件则卸插件' : '项目内目录，随仓库管理' });
    }
  }
}

// ---------- 上游探测（--check-updates）----------
function probeUpstream() {
  const npmCache = new Map();
  const npmLatest = (pkg) => {
    if (!npmCache.has(pkg)) {
      const r = run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['view', pkg, 'version'], 60000);
      npmCache.set(pkg, r.code === 0 && r.out ? r.out.split(/\r?\n/).pop().trim() : undefined);
    }
    return npmCache.get(pkg);
  };

  for (const it of items) {
    // npm 托管的插件
    if (it.kind === '插件' && it.channel === 'npm') {
      const latest = npmLatest(it.name);
      if (!latest) { it.status = CHECK_FAILED; continue; }
      it.latest = latest;
      const cur = (/[\d.]+(?:-[\w.]+)?/.exec(it.current) || [])[0];
      it.status = cur && cur === latest ? LATEST : HAS_UPDATE;
      continue;
    }
    // Git link 插件：只读比较远端提交，不写本地 refs
    if (it.kind === '插件' && it.channel === 'local' && it.repo && isDir(join(it.repo, '.git'))) {
      const local = run('git', ['-C', it.repo, 'rev-parse', 'HEAD'], 20000).out;
      const remote = run('git', ['-C', it.repo, 'ls-remote', 'origin', 'refs/heads/main'], 40000).out.split(/\s+/)[0];
      if (!local || !remote) { it.status = CHECK_FAILED; continue; }
      it.current = `${it.current} / ${local.slice(0, 7)}`;
      it.latest = `${remote.slice(0, 7)} (main)`;
      it.status = local === remote ? LATEST : HAS_UPDATE;
      continue;
    }
    // 其余：本地技能 / 内置 / 未核实渠道
    if (it.kind === '技能') it.status = NO_SOURCE;
    else if (it.status === NO_SOURCE) it.status = UNADJUSTED;
  }
}

// ---------- 输出 ----------
const dispWidth = (s) => [...String(s)].reduce((w, ch) => w + (/[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1), 0);
const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - dispWidth(s)));

function main() {
  if (wantHost('dsh')) scanDsh();
  if (wantHost('hermes')) scanHermes();
  if (wantHost('codex')) scanCodex();
  if (wantHost('claude') || wantHost('claude-code')) scanClaude();
  if (OPT.check) probeUpstream();

  if (OPT.json) {
    console.log(JSON.stringify({ checkedUpstream: OPT.check, items, notes }, null, 2));
    return;
  }

  // 默认折叠"没有可执行动作"的项：无上游的本地技能、随本体的内置技能与插件
  const collapsed = (i) => (i.kind === '技能' && (i.status === NO_SOURCE || i.channel === 'bundled'))
    || (i.kind === '插件' && i.channel === 'bundled');
  const shown = OPT.all ? items : items.filter((i) => !collapsed(i));
  const hidden = items.length - shown.length;

  const cols = [
    ['宿主', (i) => i.host], ['类型', (i) => i.kind], ['名称', (i) => i.name],
    ['渠道', (i) => i.channel], ['当前', (i) => i.current], ['最新', (i) => i.latest],
    ['状态', (i) => i.status], ['在哪里更新', (i) => i.updateAt], ['位置', (i) => i.path],
  ];
  const widths = cols.map(([h, f]) => Math.max(dispWidth(h), ...shown.map((i) => Math.min(dispWidth(f(i)), h === '在哪里更新' || h === '位置' ? 46 : 22)), 4));
  console.log('\n宿主扩展盘点' + (OPT.check ? '（含上游探测）' : '（本地盘点，未联网）') + `\n项目根：${OPT.project}\n`);
  console.log(cols.map(([h], i) => pad(h, widths[i])).join('  '));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const it of shown) console.log(cols.map(([, f], i) => pad(String(f(it)).slice(0, 90), widths[i])).join('  '));

  const tally = items.reduce((m, i) => ((m[i.status] = (m[i.status] || 0) + 1), m), {});
  console.log('\n合计 ' + items.length + ' 项：' + Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(' / '));
  if (hidden > 0) {
    const byHost = {};
    for (const i of items) if (collapsed(i)) byHost[i.host] = (byHost[i.host] || 0) + 1;
    console.log(`已折叠 ${hidden} 项"无可执行动作的条目"（${Object.entries(byHost).map(([h, n]) => `${h} ${n}`).join(' / ')}）：加 --all 全部列出。`);
  }
  if (!OPT.check) console.log('提示：加 --check-updates 才会联网探测上游版本（只读请求）。');
  for (const n of notes) console.log('注意：' + n);
  console.log('');
}

main();
