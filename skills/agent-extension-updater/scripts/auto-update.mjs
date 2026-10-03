#!/usr/bin/env node
import * as fs from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { collectInventory } from './inventory.mjs';
import { readJson, planUpdates, updateOne, restoreBackup } from './lib.mjs';

const DEFAULT = { schema_version: 1, auto_update: { enabled: false, scope: { hosts: ['dsh', 'hermes', 'codex', 'claude'], kinds: ['技能', '插件'], exclude: [] } } };

export function validateConfig(config) {
  const a = config?.auto_update;
  if (config?.schema_version !== 1 || typeof a?.enabled !== 'boolean') throw new Error('无效配置：schema_version/enabled');
  for (const field of ['hosts', 'kinds', 'exclude']) if (a.scope?.[field] !== undefined && (!Array.isArray(a.scope[field]) || a.scope[field].some((x) => typeof x !== 'string'))) throw new Error(`无效配置：scope.${field}`);
  if (a.scope?.hosts?.some((h) => !['dsh', 'hermes', 'codex', 'claude', 'claude-code'].includes(h))) throw new Error('配置中存在未知宿主');
  if (a.scope?.kinds?.some((k) => !['技能', '插件'].includes(k))) throw new Error('配置只允许技能和插件');
  return config;
}

export function appendAudit(home, entry) {
  fs.mkdirSync(home, { recursive: true });
  fs.appendFileSync(join(home, 'auto-update.log.jsonl'), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', { mode: 0o600 });
}

export function runAuto(config, options = {}, dependencies = {}) {
  validateConfig(config);
  const home = options.home || join(homedir(), '.agent-extension-updater');
  const output = dependencies.output || console.log;
  const audit = dependencies.audit || ((entry) => appendAudit(home, entry));
  const collect = dependencies.collect || collectInventory;
  const update = dependencies.update || updateOne;
  if (!config.auto_update.enabled && !options.dryRun) {
    output('自动更新开关已关闭，本次不执行更新。');
    return { ok: true, state: 'disabled', results: [] };
  }
  let lock;
  const lockPath = join(home, 'run.lock');
  try {
    if (!options.dryRun) {
      fs.mkdirSync(home, { recursive: true });
      lock = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
    }
    const inventory = collect({ hosts: config.auto_update.scope?.hosts, project: options.project, check: true });
    const plan = planUpdates(inventory, config.auto_update.scope);
    const errors = [...(inventory.errors || []), ...plan.failed.map((item) => `${item.name}：${item.reason || '检查失败'}`)];
    if (errors.length) {
      output(`盘点存在检查失败，停止本轮全部更新：\n${errors.join('\n')}`);
      if (!options.dryRun) audit({ action: 'run', state: '检查失败', errors, ok: false });
      return { ok: false, state: '检查失败', results: [], errors };
    }
    output(`盘点 ${inventory.items.length} 项，待更新 ${plan.planned.length} 项，需人工处理 ${plan.skipped.length} 项。`);
    for (const note of inventory.notes || []) output(`注意：${note}`);
    for (const item of inventory.items.filter((i) => ['待适配', '无来源'].includes(i.status))) output(`${item.status}：${item.host}/${item.name}；${item.reason || item.updateAt}`);
    for (const { item, reason } of plan.skipped) output(`跳过：${item.host}/${item.name}；${reason}`);
    const results = [];
    for (const item of plan.planned) {
      if (options.dryRun) {
        output(`[演练] ${item.name} → ${item.updateAction.target}；跳过备份、更新与审计写入`);
        results.push({ id: item.id, state: '演练', ok: true });
        continue;
      }
      // Audit must be writable before making any mutation to an extension.
      audit({ action: 'update-start', id: item.id, name: item.name, path: item.path, target: item.updateAction.target });
      const result = update(item, home);
      const entry = { action: 'update', id: item.id, host: item.host, name: item.name, path: item.path, from: item.currentCommit, target: item.updateAction.target, ...result };
      audit(entry);
      results.push(entry);
      output(`${item.name}：${result.state}${result.error ? `；${result.error}` : ''}${result.backup ? `；备份记录：${result.backup}` : ''}`);
      // Dependency metadata is unavailable; stop the entire batch conservatively.
      if (!result.ok) { output('本项失败，停止后续更新；保留备份供恢复。'); break; }
    }
    if (!options.dryRun) audit({ action: 'run', ok: results.every((r) => r.ok), skipped: plan.skipped.map(({ item, reason }) => ({ id: item.id, name: item.name, reason })), completed: results.length, planned: plan.planned.length });
    return { ok: results.every((r) => r.ok), state: options.dryRun ? '演练' : '完成', results, skipped: plan.skipped };
  } finally {
    if (lock !== undefined) { fs.closeSync(lock); fs.unlinkSync(lockPath); }
  }
}

export function main(argv = process.argv.slice(2)) {
  const allowed = new Set(['--status', '--enable', '--disable', '--run', '--report', '--dry-run', '--hosts', '--project', '--lines', '--restore', '--to', '--help']);
  const withValue = new Set(['--hosts', '--project', '--lines', '--restore', '--to']);
  for (let i = 0; i < argv.length; i++) {
    if (!allowed.has(argv[i])) throw new Error(`未知参数：${argv[i]}`);
    if (withValue.has(argv[i]) && (!argv[++i] || argv[i].startsWith('--'))) throw new Error('参数缺少值');
  }
  const has = (key) => argv.includes(key);
  const value = (key) => has(key) ? argv[argv.indexOf(key) + 1] : undefined;
  const actions = ['--status', '--enable', '--disable', '--run', '--report', '--restore', '--help'].filter(has);
  if (actions.length > 1) throw new Error('每次只能指定一个操作');
  if (has('--hosts') && !has('--enable')) throw new Error('--hosts 只用于 --enable；运行范围来自已保存配置');
  if (has('--dry-run') && !has('--run')) throw new Error('--dry-run 需与 --run 一起使用');
  if (has('--to') !== has('--restore')) throw new Error('--restore 与 --to 必须同时使用');
  const configPath = process.env.AGENT_EXTENSION_UPDATER_CONFIG || join(homedir(), '.agent-extension-updater', 'config.json');
  // Custom configuration also isolates backup/log/lock storage.
  const home = dirname(resolve(configPath));
  const config = validateConfig(readJson(configPath, structuredClone(DEFAULT)));
  if (has('--enable') || has('--disable')) {
    config.auto_update.enabled = has('--enable');
    if (has('--enable')) config.auto_update.enabled_at = new Date().toISOString();
    if (has('--hosts')) config.auto_update.scope = { ...config.auto_update.scope, hosts: value('--hosts').split(',').map((s) => s.trim()) };
    validateConfig(config);
    fs.mkdirSync(home, { recursive: true });
    const temp = `${configPath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(temp, configPath);
    appendAudit(home, { action: has('--enable') ? 'enable' : 'disable', scope: config.auto_update.scope });
  }
  if (has('--status') || has('--enable') || has('--disable')) console.log(`自动更新开关：${config.auto_update.enabled ? '已打开' : '已关闭'}\n配置：${configPath}\n范围：${JSON.stringify(config.auto_update.scope)}\n备份与日志：${home}`);
  else if (has('--run')) { if (!runAuto(config, { home, dryRun: has('--dry-run'), project: value('--project') }).ok) process.exitCode = 1; }
  else if (has('--restore')) console.log(`备份已恢复到新目录：${restoreBackup(resolve(value('--restore')), value('--to'))}\n原安装目录未更改；请核对后通过宿主认可的方式恢复安装。`);
  else if (has('--report')) {
    const count = Number(value('--lines') || 20);
    if (!Number.isInteger(count) || count < 1) throw new Error('--lines 必须为正整数');
    const log = join(home, 'auto-update.log.jsonl');
    if (!fs.existsSync(log)) console.log('暂无审计日志');
    else for (const line of fs.readFileSync(log, 'utf8').trim().split(/\r?\n/).slice(-count)) console.log(line);
  } else console.log('auto-update.mjs\n  --status / --enable [--hosts dsh,codex] / --disable\n  --run [--dry-run] [--project <目录>]\n  --report [--lines 20]\n  --restore <record.json> --to <尚不存在的新目录>\n自动更新仅执行可备份、可验证且版本明确的独立 Git 扩展；不会自行定时运行。');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); } catch (error) { console.error(`失败：${error.message}`); process.exitCode = 1; }
}
