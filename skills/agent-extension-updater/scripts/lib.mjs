// Shared, dependency-free primitives. Importing this module performs no IO.
import * as fs from 'node:fs';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export function run(cmd, args, timeout = 60000) {
  const options = { encoding: 'utf8', timeout, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } };
  let result;
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd)) {
    if (!isAbsolute(cmd)) {
      const located = spawnSync('where.exe', [cmd], options);
      if (located.status !== 0) return { code: 1, out: '', err: `找不到命令：${cmd}` };
      cmd = located.stdout.trim().split(/\r?\n/)[0];
    }
    // cmd.exe metacharacters cannot safely be escaped with JSON/backslash quoting.
    if ([cmd, ...args].some((s) => /[%!&|<>^"\r\n]/.test(s))) return { code: 1, out: '', err: '不支持的 shell 参数字符' };
    result = spawnSync([cmd, ...args].map((s) => `"${s}"`).join(' '), { ...options, shell: true });
  } else result = spawnSync(cmd, args, options);
  return { code: result.status, out: (result.stdout || '').trim(), err: result.error?.message || (result.stderr || '').trim() };
}

export function must(result) {
  if (result.code !== 0) throw new Error(result.err || result.out || `命令失败 (${result.code})`);
  return result.out;
}

export function readJson(path, fallback = undefined) {
  try { return JSON.parse(fs.readFileSync(path, 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

export function frontmatter(path) {
  return parseFrontmatter(fs.readFileSync(path, 'utf8'), path);
}

export function parseFrontmatter(source, label = 'SKILL.md') {
  const text = source.replace(/^\uFEFF/, '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) throw new Error(`无效的技能 frontmatter：${label}`);
  return Object.fromEntries([...match[1].matchAll(/^([\w-]+):[ \t]*([^\r\n]*)/gm)].map((m) => [m[1], m[2].trim().replace(/^["']|["']$/g, '')]));
}

export function version(value) {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(value || ''));
  if (!match) return undefined;
  const pre = match[4]?.split('.') || [];
  if (pre.some((s) => !s || (/^\d+$/.test(s) && s.length > 1 && s[0] === '0'))) return undefined;
  return { numbers: match.slice(1, 4).map(BigInt), pre };
}

export function compareVersions(a, b) {
  const x = version(a), y = version(b);
  if (!x || !y) return undefined;
  for (let i = 0; i < 3; i++) if (x.numbers[i] !== y.numbers[i]) return x.numbers[i] < y.numbers[i] ? -1 : 1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    if (x.pre[i] === undefined || y.pre[i] === undefined) return x.pre[i] === undefined ? -1 : 1;
    if (x.pre[i] === y.pre[i]) continue;
    const xn = /^\d+$/.test(x.pre[i]), yn = /^\d+$/.test(y.pre[i]);
    if (xn && yn) return BigInt(x.pre[i]) < BigInt(y.pre[i]) ? -1 : 1;
    if (xn !== yn) return xn ? -1 : 1;
    return x.pre[i] < y.pre[i] ? -1 : 1;
  }
  return 0;
}

export function identity(item) {
  return createHash('sha256').update(JSON.stringify([item.kind, item.path])).digest('hex').slice(0, 24);
}

export function inside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`));
}

const git = (repo, args, runner) => runner('git', ['-C', repo, ...args]);

export function gitState(repo, runner = run) {
  const get = (...args) => must(git(repo, args, runner));
  const root = fs.realpathSync(get('rev-parse', '--show-toplevel'));
  const branch = get('symbolic-ref', '--quiet', '--short', 'HEAD');
  const remote = get('config', '--get', `branch.${branch}.remote`);
  const ref = get('config', '--get', `branch.${branch}.merge`);
  if (remote === '.' || remote.startsWith('-') || !/^refs\/heads\/.+/.test(ref)) throw new Error('需要明确的远端跟踪分支');
  return { root, branch, remote, ref, url: get('remote', 'get-url', remote), head: get('rev-parse', 'HEAD'), dirty: !!get('status', '--porcelain', '--untracked-files=all') };
}

export function probeGit(item, runner = run) {
  delete item.updateAction;
  delete item.targetVersion;
  const state = gitState(item.repo, runner);
  const lines = must(git(item.repo, ['ls-remote', state.remote, state.ref, 'refs/tags/*'], runner)).split(/\r?\n/).map((l) => l.split(/\s+/));
  const target = lines.find(([, ref]) => ref === state.ref)?.[0];
  if (!target || !/^[a-f0-9]{40,64}$/.test(target)) throw new Error('上游分支没有可验证的提交');
  item.currentCommit = state.head;
  item.targetCommit = target;
  item.latest = `${target.slice(0, 12)} (${state.ref.slice(11)})`;
  item.git = state;
  // Compare peeled annotated tags; never infer a version from a hash.
  const versions = lines.filter(([sha, ref]) => sha === target && ref?.startsWith('refs/tags/') && (ref.endsWith('^{}') || !lines.some(([, r]) => r === `${ref}^{}`)))
    .map(([, ref]) => ref.slice(10).replace(/\^\{\}$/, '')).filter(version);
  if (versions.length === 1) item.targetVersion = versions[0];
  item.status = state.head === target ? '已最新' : '有更新';
  item.reason = state.head === target ? '' : '远端提交不同；执行前还会检查祖先关系';
  if (state.head !== target) {
    const ancestor = git(item.repo, ['merge-base', '--is-ancestor', state.head, target], runner);
    if (ancestor.code === 1) { item.status = '待适配'; item.reason = '本地领先或已分叉，需人工确认'; }
  }
  if (state.root !== item.path || !fs.lstatSync(join(state.root, '.git')).isDirectory()) {
    item.reason = '共享仓库子目录或 Git worktree：需隔离 staging/人工更新，禁止整仓自动更新';
    return;
  }
  item.updateAction = { type: 'git-pinned', repo: state.root, ...state, target, targetVersion: item.targetVersion };
}

export function planUpdates(inventory, scope = {}) {
  const planned = [], skipped = [];
  const hosts = (scope.hosts || []).map((h) => h === 'claude-code' ? 'claude' : h.toLowerCase());
  for (const item of inventory.items) {
    if (item.status !== '有更新') continue;
    let reason;
    const action = item.updateAction;
    if (!['技能', '插件'].includes(item.kind) || (scope.kinds && !scope.kinds.includes(item.kind))) reason = '不在允许的类型内';
    else if ((scope.exclude || []).includes(item.name)) reason = '在排除名单';
    else if (hosts.length && !(item.hosts || []).every((host) => hosts.includes(host))) reason = '包含未授权宿主的共享目录';
    else if (!action) reason = item.reason || '无可执行动作';
    else if (action.requiresAppQuit) reason = '需先退出宿主，待手动';
    else if (action.type !== 'git-pinned') reason = '此渠道尚无完整的固定目标、备份与验证实现';
    else if (action.dirty) reason = '存在本地修改，需确认';
    else {
      const current = version(item.current), target = version(action.targetVersion);
      if (!current || !target) reason = '当前或目标版本未知，需确认（Git 目标需唯一版本标签）';
      else if (current.numbers[0] !== target.numbers[0]) reason = '主版本跃迁，需确认';
      else if (compareVersions(item.current, action.targetVersion) > 0) reason = '目标版本更低，需确认';
      else if (target.pre.length) reason = '预发布版本，需确认';
    }
    (reason ? skipped : planned).push(reason ? { item, reason } : item);
  }
  return { planned, skipped, failed: inventory.items.filter((i) => i.status === '检查失败') };
}

function treeManifest(root) {
  const entries = [];
  function visit(path) {
    const stat = fs.lstatSync(path);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error('备份范围含链接或特殊文件，需人工处理');
    const name = relative(root, path).split('\\').join('/');
    if (stat.isDirectory()) {
      entries.push([name, 'dir']);
      for (const file of fs.readdirSync(path).sort()) visit(join(path, file));
    } else entries.push([name, createHash('sha256').update(fs.readFileSync(path)).digest('hex')]);
  }
  visit(root);
  return entries;
}

export function backupItem(item, home, io = fs) {
  if (inside(item.path, home)) throw new Error('备份目录不能位于更新目标内部');
  const before = treeManifest(item.path);
  const dir = join(home, 'backups', `${Date.now()}-${randomUUID()}`, identity(item));
  io.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const files = join(dir, 'files');
  io.cpSync(item.path, files, { recursive: true, errorOnExist: true, force: false });
  if (JSON.stringify(before) !== JSON.stringify(treeManifest(files)) || JSON.stringify(before) !== JSON.stringify(treeManifest(item.path))) throw new Error('备份验证失败或源文件在备份时发生变化');
  const record = { schema_version: 1, item, files, manifest: before };
  const path = join(dir, 'record.json');
  io.writeFileSync(path, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return path;
}

export function restoreBackup(recordPath, destination) {
  const record = readJson(recordPath);
  if (!record || record.schema_version !== 1 || !record.files || !Array.isArray(record.manifest)) throw new Error('无效备份记录');
  const target = resolve(destination);
  if (fs.existsSync(target) || inside(record.files, target)) throw new Error('恢复目标必须是尚不存在的新目录，且不能位于备份内部');
  if (JSON.stringify(treeManifest(record.files)) !== JSON.stringify(record.manifest)) throw new Error('备份内容损坏，停止恢复');
  fs.cpSync(record.files, target, { recursive: true, force: false, errorOnExist: true });
  if (JSON.stringify(treeManifest(target)) !== JSON.stringify(record.manifest)) throw new Error('恢复验证失败');
  return target;
}

export function executePinned(item, runner = run) {
  const a = item.updateAction;
  const assertState = () => {
    const state = gitState(a.repo, runner);
    for (const key of ['root', 'head', 'branch', 'remote', 'ref', 'url']) if (state[key] !== a[key]) throw new Error(`检查后 Git ${key} 已变化，停止更新`);
    if (state.dirty) throw new Error('存在本地修改，停止更新');
  };
  assertState();
  must(git(a.repo, ['fetch', '--no-tags', '--', a.remote, a.ref], runner));
  if (must(git(a.repo, ['rev-parse', 'FETCH_HEAD'], runner)) !== a.target) throw new Error('上游目标已变化，需重新盘点');
  assertState();
  must(git(a.repo, ['merge-base', '--is-ancestor', a.head, a.target], runner));
  // Inspect fetched content before replacing installed files: a tag is not
  // sufficient evidence of the actual version declared by the extension.
  let targetVersion;
  if (item.kind === '技能') {
    const fm = parseFrontmatter(must(git(a.repo, ['show', `${a.target}:SKILL.md`], runner)));
    if (fm.name !== item.name) throw new Error('目标技能名称不匹配');
    targetVersion = fm.version;
  }
  if (!targetVersion) targetVersion = JSON.parse(must(git(a.repo, ['show', `${a.target}:package.json`], runner))).version;
  if (compareVersions(targetVersion, a.targetVersion) !== 0) throw new Error('目标内容版本与版本标签不一致，停止更新');
  must(git(a.repo, ['-c', 'merge.autostash=false', 'merge', '--ff-only', '--no-edit', a.target], runner));
}

export function verifyItem(item, runner = run) {
  const a = item.updateAction;
  const state = gitState(item.path, runner);
  if (state.head !== a.target || state.branch !== a.branch || state.root !== a.root || state.remote !== a.remote || state.ref !== a.ref || state.url !== a.url || state.dirty) throw new Error('更新后提交、分支、路径或工作区验证失败');
  let installedVersion;
  if (item.kind === '技能') {
    const fm = frontmatter(join(item.path, 'SKILL.md'));
    if (fm.name !== item.name) throw new Error('更新后技能名称或 frontmatter 不匹配');
    installedVersion = fm.version;
  }
  installedVersion ||= readJson(join(item.path, 'package.json'), {})?.version;
  if (compareVersions(installedVersion, a.targetVersion) !== 0) throw new Error('更新后实际版本与目标版本标签不一致');
  return { state: '已落盘待重载', commit: state.head };
}

export function updateOne(item, home, dependencies = {}) {
  const backup = dependencies.backup || backupItem;
  const execute = dependencies.execute || executePinned;
  const verify = dependencies.verify || verifyItem;
  let backupPath;
  try {
    backupPath = backup(item, home);
    execute(item);
    return { ok: true, backup: backupPath, ...verify(item) };
  } catch (error) { return { ok: false, state: '失败', backup: backupPath, error: error.message }; }
}
