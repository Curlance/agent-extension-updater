# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的结构；版本号在发布前由维护者确定。

## [Unreleased]

## [0.1.0]

首个版本。技能可被支持 Agent Skills 的宿主加载，负责盘点并更新 **skills 与 plugins**。

### 新增

- `SKILL.md`：主流程（识别宿主 → 只读检查 → 主动确认 → 备份执行 → 验证报告），含六条红线与收尾自检清单。
- `references/dsh.md`：DeepSeek Harness 适配。基于本机源码与实测：技能扫描根与 rank、热加载边界、profile bundles 的自动登记与摘除、`link:` 插件不留源码副本、DSH 插件必须先退出桌面端。
- `references/hermes.md`：Hermes 适配。hub / bundled / local 三类技能的区分与各自更新方式；启动器"自动依赖修复重试耗尽"不等于检查成功。
- `references/codex.md`：Codex 适配。`~/.agents/skills` 与 `.agents/skills`；市场刷新 ≠ 插件升级。
- `references/claude-code.md`：Claude Code 适配。以能力检测为主，明确不声称任何子命令已核实。
- `references/generic-agent.md`：通用宿主适配与能力分级。
- `references/auto-update.md`：自动更新开关规范、四条硬护栏、备份与审计日志。
- `templates/confirmation.md`、`templates/report.md`：更新确认与结果报告模板。
- `scripts/inventory.mjs`：只读盘点器。按宿主列出技能/插件的实际路径、渠道、当前→最新版本、状态与**在哪里更新**；支持 `--check-updates` / `--all` / `--json` / `--hosts` / `--project`。
- `scripts/auto-update.mjs`：按开关自动更新。默认关闭；四条写死在代码里的硬护栏；备份与 JSONL 审计日志。
- `scripts/check-skill.mjs`：技能自检。frontmatter 合规、相对链接可解析、无机器专属绝对路径、规模提示。

### 设计取舍

- **不含 Agent 本体**：本体升级会中断运行时会话、可能影响共享 profile，且各宿主渠道差异极大，因此整体移出范围，只登记为"随本体、跳过"。
- **不提供安装器**：技能是流程指令而非程序；安装即复制目录。自动更新只通过显式开关启用，且不触碰本体。
- **判定规则与红线同源**：盘点器"读不到本机版本时记检查失败，绝不因为远端有版本号就报有更新"，与 `SKILL.md` 的红线一致。

### 验证情况

- `check-skill.mjs`：源目录与安装副本均 0 错误 0 警告。
- 硬护栏：用伪造盘点输出反向测试，四条护栏全部拦下（本体被拒 / 需退出宿主的不动 / 主版本跃迁需确认 / 排除名单生效）。
- 开关往返：`--enable` → `--status` → `--disable` 正常，审计日志记录两条。
- **未验证**：真实的"执行一次更新并复核"未发生（测试机器上所有条目均为已最新）；Codex / Claude Code 的插件更新接口未核实。
