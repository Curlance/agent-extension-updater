#!/usr/bin/env node
// check-skill.mjs —— Agent Skill 目录自检（零依赖、只读、不联网）
//
// 用法：node scripts/check-skill.mjs [技能目录]
// 默认检查本脚本所在技能目录。退出码 0 = 无错误，1 = 有错误。
//
// 检查项：
//   1. SKILL.md 存在、无 BOM、frontmatter 可解析，name/description 合规
//   2. name 与目录名一致，且符合小写连字符命名
//   3. 必需文件与目录齐全（README.md / references/ / templates/）
//   4. 所有 Markdown 相对链接可解析
//   5. 不混入机器专属绝对路径（可移植性）
//   6. 规模提示（SKILL.md 行数、文件体积）

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = resolve(process.argv[2] ?? join(HERE, '..'));

const errors = [];
const warnings = [];
const info = [];
const err = (m) => errors.push(m);
const warn = (m) => warnings.push(m);
const say = (m) => info.push(m);

const rel = (p) => relative(SKILL_DIR, p).split('\\').join('/');

if (!existsSync(SKILL_DIR) || !statSync(SKILL_DIR).isDirectory()) {
  console.error(`✗ 不是目录：${SKILL_DIR}`);
  process.exit(1);
}

// ---------- 1/2. SKILL.md 与 frontmatter ----------
const skillPath = join(SKILL_DIR, 'SKILL.md');
if (!existsSync(skillPath)) {
  err('缺少 SKILL.md（技能入口，必需）');
} else {
  const raw = readFileSync(skillPath, 'utf8');
  if (raw.charCodeAt(0) === 0xfeff) err('SKILL.md 带 UTF-8 BOM：frontmatter 必须从第 0 字节开始，请保存为无 BOM');
  const lines = raw.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0].trim() !== '---') {
    err('SKILL.md 第 1 行不是 "---"：缺少 YAML frontmatter');
  } else {
    let close = -1;
    for (let i = 1; i < lines.length; i += 1) {
      if (lines[i].trim() === '---') { close = i; break; }
    }
    if (close < 0) {
      err('SKILL.md frontmatter 未闭合（找不到第二个 "---"）');
    } else {
      const fm = lines.slice(1, close);
      const fields = {};
      for (let i = 0; i < fm.length; i += 1) {
        const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(fm[i]);
        if (!m) continue;
        const [, key, rest] = m;
        if (rest === '' || /^[>|][-+]?$/.test(rest)) {
          const buf = [];
          for (let j = i + 1; j < fm.length; j += 1) {
            if (/^\s+\S/.test(fm[j])) buf.push(fm[j].trim());
            else break;
          }
          fields[key] = buf.join(' ');
        } else {
          fields[key] = rest.replace(/^["']|["']$/g, '');
        }
      }
      const dirName = SKILL_DIR.split(/[\\/]/).filter(Boolean).pop();
      if (!fields.name) err('frontmatter 缺少 name');
      else {
        if (fields.name !== dirName) err(`frontmatter name "${fields.name}" 与目录名 "${dirName}" 不一致（多数宿主按目录名发现技能）`);
        if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(fields.name)) warn(`name "${fields.name}" 不是小写连字符形式，部分宿主会拒绝`);
      }
      if (!fields.description) err('frontmatter 缺少 description（宿主靠它决定何时加载技能）');
      else {
        if (fields.description.length > 1024) err(`description 过长（${fields.description.length} > 1024 字符），Claude Code 等宿主会截断或拒绝`);
        else if (fields.description.length < 40) warn(`description 偏短（${fields.description.length} 字符），建议写清"何时使用"`);
      }
      say(`name=${fields.name ?? '(缺失)'} description=${(fields.description ?? '').length} 字符`);
    }
  }
  const lineCount = readFileSync(skillPath, 'utf8').split(/\r?\n/).length;
  say(`SKILL.md ${lineCount} 行 / ${(statSync(skillPath).size / 1024).toFixed(1)} KB`);
  if (lineCount > 500) warn(`SKILL.md 超过 500 行（${lineCount}）：建议把细节下沉到 references/（渐进披露）`);
}

// ---------- 3. 必需结构 ----------
for (const p of ['README.md', 'references', 'templates']) {
  if (!existsSync(join(SKILL_DIR, p))) err(`缺少 ${p}${p.includes('.') ? '' : '/'}`);
}
if (existsSync(join(SKILL_DIR, 'references'))) {
  const refs = readdirSync(join(SKILL_DIR, 'references')).filter((f) => extname(f) === '.md');
  if (refs.length === 0) warn('references/ 目录为空');
  say(`references/: ${refs.join(', ') || '(空)'}`);
}

// ---------- 4/5. 链接与可移植性 ----------
const mdFiles = [];
(function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (extname(entry.name) === '.md') mdFiles.push(full);
  }
})(SKILL_DIR);

const ABS = /(^|[\s("'`])([A-Za-z]:[\\/]|\/Users\/|\/home\/)/;
for (const file of mdFiles) {
  const text = readFileSync(file, 'utf8');
  text.split(/\r?\n/).forEach((line, i) => {
    if (!/^\s*(<!--|```)/.test(line) && ABS.test(line)) {
      warn(`${rel(file)}:${i + 1} 出现机器专属绝对路径，可能影响可移植性`);
    }
    for (const m of line.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const target = m[1].replace(/^<|>$/g, '');
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      const clean = target.split('#')[0];
      if (!clean) continue;
      if (!existsSync(resolve(dirname(file), clean))) {
        err(`${rel(file)}:${i + 1} 相对链接失效 → ${target}`);
      }
    }
  });
}
say(`扫描 ${mdFiles.length} 个 Markdown 文件`);

// ---------- 输出 ----------
const line = '─'.repeat(60);
console.log(`\nAgent Skill 自检：${SKILL_DIR}\n${line}`);
for (const s of info) console.log(`  · ${s}`);
if (warnings.length) {
  console.log(`\n警告 ${warnings.length} 条：`);
  for (const w of warnings) console.log(`  ! ${w}`);
}
if (errors.length) {
  console.log(`\n错误 ${errors.length} 条：`);
  for (const e of errors) console.log(`  ✗ ${e}`);
  console.log(`\n结论：不通过（${errors.length} 个错误，${warnings.length} 个警告）`);
  process.exit(1);
}
console.log(`\n结论：通过 ✔（0 个错误，${warnings.length} 个警告）`);
