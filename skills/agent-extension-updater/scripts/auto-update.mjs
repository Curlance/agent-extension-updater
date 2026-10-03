#!/usr/bin/env node
// auto-update.mjs —— 按开关配置自动更新【技能与插件】
//
// 本脚本永不触碰 Agent 本体：本体不在本技能范围内（见 SKILL.md）。
//
// 用法：
//   node scripts/auto-update.mjs --status                 # 看开关状态与作用域
//   node scripts/auto-update.mjs --enable                 # 打开开关（写入作用域与留痕时间）
//   node scripts/auto-update.mjs --disable                # 关闭开关
//   node scripts/auto-update.mjs --run --dry-run          # 演练：只列出会做什么，不改任何东西
//   node scripts/auto-update.mjs --run                    # 实际执行（需开关已打开）
//   node scripts/auto-update.mjs --report                 # 读审计日志摘要
//
// 开关文件：$AGENT_EXTENSION_UPDATER_CONFIG 或 ~/.agent-extension-updater/config.json
//
// 四条硬护栏（写死在代码里，配置改不动）：
//   1. 只处理【技能 / 插件】—— kind 为"本体"的项一律拒绝
//   2. 只处理状态为【有更新】且带结构化 updateAction 的项
//   3. requiresAppQuit 的项（如 DSH 插件）永不自动执行，只登记为"待手动"
//   4. 主版本跃迁（major 变化）不自动执行，登记为"需确认"

import { readFileSync, writeFileSync, mkdirSync, existsSync, cpSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const INVENTORY = join(HERE, 'inventory.mjs');
const HOME_DIR = join(homedir(), '.agent-extension-updater');
const CONFIG_PATH = process.env.AGENT_EXTENSION_UPDATER_CONFIG || join(HOME_DIR, 'config.json');

const DEFAULT_CONFIG = {
  schema_version: 1,
  auto_update: {
    enabled: false,
    enabled_at: null,
    note: '长期有效，直到手动 --disable。作用域内、无破坏性变更的技能与插件会被自动更新。',
    scope: { hosts: ['dsh', 'hermes', 'codex', 'claude'], kinds: ['技能', '插件'], exclude: [] },
  },
};

const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const value = (f) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : ''; };

const readConfig = () => {
  try { return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); } catch { return JSON.parse(JSON.stringify(DEFAULT_CONFIG)); }
};
const writeConfig = (cfg) => {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
};
const run = (cmd, args, timeoutMs = 120000) => {
  const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd);
  const opts = { encoding: 'utf8', timeout: timeoutMs, windowsHide: true };
  let r;
  if (needsShell) {
    const q = (s) => (/[\s"]/.test(s) ? `"${String(s).replace(/"/g, '\\"')}"` : String(s));
    r = spawnSync([q(cmd), ...args.map(q)].join(' '), { ...opts, shell: true });
  } else r = spawnSync(cmd, args, opts);
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
};

const logPath = () => join(HOME_DIR, 'auto-update.log.jsonl');
const audit = (entry) => {
  mkdirSync(HOME_DIR, { recursive: true });
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  try { writeFileSync(logPath(), line + '\n', { flag: 'a' }); } catch { /* 日志失败不阻断，但在报告里说明 */ }
};

const major = (v) => { const m = /(\d+)\.\d+/.exec(String(v || '')); return m ? Number(m[1]) : undefined; };

// ---------- 状态 ----------
function cmdStatus() {
  const cfg = readConfig();
  const a = cfg.auto_update || {};
  console.log(`\n自动更新开关：${a.enabled ? '已打开 ●' : '已关闭 ○'}`);
  console.log(`  开关文件   ：${CONFIG_PATH}`);
  console.log(`  打开时间   ：${a.enabled_at || '-'}`);
  console.log(`  作用域宿主 ：${(a.scope?.hosts || []).join(', ') || '-'}`);
  console.log(`  作用域类型 ：${(a.scope?.kinds || []).join(', ') || '-'}（"本体"永远不在允许集合内）`);
  console.log(`  排除项     ：${(a.scope?.exclude || []).join(', ') || '（无）'}`);
  console.log(`  审计日志   ：${logPath()}`);
  if (a.enabled) console.log('\n  ⚠ 开关已打开：新的、无破坏性变更的技能与插件会被自动更新，不再逐项询问。');
  console.log('  打开：--enable    关闭：--disable    演练：--run --dry-run\n');
}

function cmdEnable() {
  const cfg = readConfig();
  const hosts = value('--hosts');
  cfg.auto_update = {
    ...(cfg.auto_update || {}),
    enabled: true,
    enabled_at: new Date().toISOString(),
    scope: {
      hosts: hosts ? hosts.split(',').map((s) => s.trim()) : (cfg.auto_update?.scope?.hosts || ['dsh', 'hermes', 'codex', 'claude']),
      kinds: ['技能', '插件'],
      exclude: cfg.auto_update?.scope?.exclude || [],
    },
  };
  writeConfig(cfg);
  audit({ action: 'enable', by: 'user', scope: cfg.auto_update.scope });
  cmdStatus();
}

function cmdDisable() {
  const cfg = readConfig();
  if (cfg.auto_update) cfg.auto_update.enabled = false;
  writeConfig(cfg);
  audit({ action: 'disable', by: 'user' });
  cmdStatus();
}

// ---------- 盘点 ----------
function inventory() {
  const r = run(process.execPath, [INVENTORY, '--json', '--check-updates'], 300000);
  if (r.code !== 0 || !r.out) return { items: [], error: r.err || `退出码 ${r.code}` };
  try {
    return JSON.parse(r.out.split('\n').find((l) => l.trim().startsWith('{')) ? r.out.slice(r.out.indexOf('{')) : r.out);
  } catch (e) {
    return { items: [], error: '解析盘点输出失败：' + String(e) };
  }
}

// ---------- 执行 ----------
function backupFor(item, cfg, stamp) {
  const dir = join(HOME_DIR, 'backups', stamp);
  mkdirSync(dir, { recursive: true });
  const record = { host: item.host, kind: item.kind, name: item.name, path: item.path, channel: item.channel, current: item.current, latest: item.latest, repo: item.repo };
  if (item.kind === '技能' && existsSync(item.path)) {
    const dest = join(dir, item.host.replace(/[^\w.-]+/g, '_'), item.name);
    try { cpSync(item.path, dest, { recursive: true }); record.file_backup = dest; } catch (e) { record.file_backup_error = String(e); }
  }
  const recPath = join(dir, `${item.name.replace(/[^\w.-]+/g, '_')}.json`);
  writeFileSync(recPath, JSON.stringify(record, null, 2) + '\n', 'utf8');
  record.record_path = recPath;
  return record;
}

function execute(item, dryRun) {
  const a = item.updateAction;
  if (!a) return { ok: false, reason: '无可执行动作' };
  if (dryRun) return { ok: true, dryRun: true, would: a.type === 'git-pull' ? `git -C "${a.repo}" pull --ff-only` : `${a.cmd} ${a.args.join(' ')}` };
  if (a.type === 'git-pull') {
    const r = run('git', ['-C', a.repo, 'pull', '--ff-only'], 180000);
    return { ok: r.code === 0, out: r.out || r.err, command: `git -C "${a.repo}" pull --ff-only` };
  }
  if (a.type === 'cmd') {
    const r = run(a.cmd, a.args, 600000);
    return { ok: r.code === 0, out: r.out || r.err, command: `${a.cmd} ${a.args.join(' ')}` };
  }
  return { ok: false, reason: '未知动作类型 ' + a.type };
}

// ---------- 主流程 ----------
function cmdRun() {
  const dryRun = flag('--dry-run');
  const cfg = readConfig();
  const a = cfg.auto_update || {};

  if (!a.enabled && !dryRun) {
    console.log('\n自动更新开关是关闭的 → 本次不做任何更新。');
    console.log('（演练可加 --dry-run；打开开关用 --enable）\n');
    return;
  }

  const inv = inventory();
  if (inv.error) {
    console.log(`\n盘点失败：${inv.error}\n→ 按红线记为"检查失败"，不做任何更新。\n`);
    audit({ action: 'run', result: 'inventory-failed', error: inv.error });
    return;
  }

  const scope = a.scope || {};
  const kinds = scope.kinds || ['技能', '插件'];
  const hosts = (scope.hosts || []).map((h) => h.toLowerCase());
  const exclude = scope.exclude || [];

  const planned = [];
  const skipped = [];
  for (const it of inv.items) {
    if (it.status !== '有更新') continue;
    // 硬护栏 1：本体永不涉及（即便配置里误写也拒绝）
    if (it.kind === '本体' || !kinds.includes(it.kind)) { skipped.push([it, '不在允许的类型内']); continue; }
    if (exclude.includes(it.name)) { skipped.push([it, '在排除名单']); continue; }
    if (hosts.length && !hosts.includes(String(it.host).split('+')[0].toLowerCase())) { skipped.push([it, '不在授权宿主内']); continue; }
    if (!it.updateAction) { skipped.push([it, '无可执行动作']); continue; }
    // 硬护栏 3：需要先退出宿主的项永不自动执行
    if (it.updateAction.requiresAppQuit) { skipped.push([it, '需先退出宿主，改为待手动执行']); continue; }
    // 硬护栏 4：主版本跃迁不自动
    const mj1 = major(it.current), mj2 = major(it.latest);
    if (mj1 !== undefined && mj2 !== undefined && mj1 !== mj2) { skipped.push([it, `主版本跃迁 ${mj1}→${mj2}，需确认`]); continue; }
    planned.push(it);
  }

  console.log(`\n自动更新${dryRun ? '（演练，不改动任何东西）' : ''}：盘点 ${inv.items.length} 项，待更新 ${planned.length} 项，跳过 ${skipped.length} 项\n`);
  if (planned.length === 0 && skipped.length === 0) console.log('没有需要更新的技能或插件。\n');

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const results = [];
  for (const it of planned) {
    const cmdText = it.updateAction.type === 'git-pull' ? `git -C "${it.updateAction.repo}" pull --ff-only` : `${it.updateAction.cmd} ${it.updateAction.args.join(' ')}`;
    console.log(`→ ${it.host} / ${it.kind} / ${it.name}`);
    console.log(`   ${it.current} → ${it.latest}`);
    console.log(`   ${cmdText}`);
    if (dryRun) { console.log('   [演练] 备份 + 执行 + 验证已跳过\n'); results.push({ item: it, ok: true, dryRun: true }); continue; }
    const backup = backupFor(it, cfg, stamp);
    const r = execute(it, false);
    console.log(`   ${r.ok ? '✔ 成功' : '✗ 失败'}：${String(r.out || r.reason || '').split('\n')[0]}`);
    console.log(`   备份记录：${backup.record_path}\n`);
    results.push({ item: it, ok: r.ok, out: r.out, reason: r.reason, command: r.command, backup });
    audit({ action: 'update', host: it.host, kind: it.kind, name: it.name, from: it.current, to: it.latest, ok: r.ok, command: r.command, error: r.ok ? undefined : (r.reason || r.out), backup: backup.record_path, dryRun: false });
    if (!r.ok) {
      console.log('   失败后停止后续依赖项；本次不再继续处理该项的后续动作。');
    }
  }

  for (const [it, why] of skipped) console.log(`⊘ 跳过 ${it.host} / ${it.name}：${why}`);

  if (!dryRun && results.some((r) => r.ok && !r.dryRun)) {
    console.log('\n复核（重新盘点，确认是否已到最新）：');
    const after = inventory();
    for (const r of results.filter((x) => x.ok && !x.dryRun)) {
      const now = (after.items || []).find((i) => i.name === r.item.name);
      console.log(`   ${r.item.name}：${now ? now.status : '未出现在新盘点中（需人工确认）'}`);
    }
    console.log('   注意：文件已更新 ≠ 已生效——宿主重启/新会话后才会加载新版本。');
  }
  console.log('');
}

function cmdReport() {
  const lines = Number(value('--lines') || 20);
  if (!existsSync(logPath())) { console.log(`\n暂无审计日志（${logPath()}）\n`); return; }
  const all = readFileSync(logPath(), 'utf8').trim().split(/\r?\n/).filter(Boolean);
  console.log(`\n审计日志 ${logPath()}（共 ${all.length} 条，显示最后 ${Math.min(lines, all.length)} 条）\n`);
  for (const l of all.slice(-lines)) {
    try {
      const e = JSON.parse(l);
      console.log(e.action === 'update'
        ? `${e.ts}  更新 ${e.host}/${e.name}  ${e.from} → ${e.to}  ${e.ok ? '成功' : '失败'}${e.error ? '  ' + String(e.error).split('\n')[0] : ''}`
        : `${e.ts}  ${e.action}${e.scope ? '  ' + JSON.stringify(e.scope) : ''}`);
    } catch { console.log(l); }
  }
  console.log('');
}

// ---------- 入口 ----------
if (flag('--status')) cmdStatus();
else if (flag('--enable')) cmdEnable();
else if (flag('--disable')) cmdDisable();
else if (flag('--run')) cmdRun();
else if (flag('--report')) cmdReport();
else {
  console.log(`
auto-update.mjs —— 按开关自动更新技能与插件（Agent 本体永不涉及）

  --status              看开关状态与作用域
  --enable              打开开关（默认覆盖 dsh/hermes/codex/claude 的技能与插件）
  --enable --hosts dsh  只对指定宿主生效
  --disable             关闭开关
  --run --dry-run       演练：列出会更新什么，不改动任何东西
  --run                 实际执行（需开关已打开）
  --report              读审计日志

硬护栏：本体永不涉及 / 无 updateAction 不动 / 需退出宿主的不动 / 主版本跃迁不动。
开关文件：${CONFIG_PATH}
`);
}
