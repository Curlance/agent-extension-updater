# agent-extension-updater

一个可被任何支持 **Agent Skills** 的客户端加载的通用维护技能：管理 **skills + plugins** 的版本（**Agent 本体不在范围内**），默认路径为

> 自动检查 → 主动确认 → 备份 → 官方渠道更新 → 逐项验证

不单独维护 MCP，不升级模型或操作系统，不替用户做未授权的改动。

- 技能入口：[SKILL.md](SKILL.md)（宿主 agent 读这个文件）
- 规则全文：[references/](references/)（按宿主选读一份）
- 交互模板：[templates/](templates/)

## 它解决什么问题

| 常见做法的问题 | 本技能的做法 |
| --- | --- |
| 模型凭印象编造 `xxx update` 命令 | 先用本机 help / 官方文档核实命令，核实不了标"未验证" |
| 一句"帮我更新"就动手，用户不知道会改什么 | 先出清单（名称、路径、来源、当前→目标版本、重启影响），再让用户逐项选 |
| 把网络失败报成"已是最新" | 状态词表区分 `有更新 / 已最新 / 检查失败 / 无来源 / 待适配` |
| 更新完就说成功 | 读回目标版本，区分"已验证生效"与"已落盘待重启" |
| 覆盖掉用户的本地修改 | 先备份、保留本地修改，禁止 `--force` |

## 安装

技能 = **一个文件夹**。必须整个复制（`SKILL.md` + `references/` + `templates/`），只复制 `SKILL.md` 会断掉文档链路。

| 宿主 | 用户级目录 | 项目级目录 |
| --- | --- | --- |
| DeepSeek Harness (DSH) | `$DSH_HOME/skills/agent-extension-updater/`（默认 `~/.dsh/skills`） | `<repo>/.dsh/skills/agent-extension-updater/` |
| Hermes | `$HERMES_HOME/skills/<分类>/agent-extension-updater/` | 按当前 profile 约定 |
| Codex | `~/.agents/skills/agent-extension-updater/` | `<repo>/.agents/skills/agent-extension-updater/` |
| Claude Code | `~/.claude/skills/agent-extension-updater/` | `<repo>/.claude/skills/agent-extension-updater/` |
| 其他宿主 | 按该宿主当前官方文档的技能目录 | 同左 |

装完多数宿主需要新会话或重启才生效；**DSH 例外**——它监视技能根目录，新增/删除无需重启即可被下一次目录刷新捕获。
注意 `~/.agents/skills` 是 **DSH 与 Codex 共用**的目录，放进去两个宿主都会看到。

安装后按宿主规则**重新发现**技能（通常需要新会话或重启客户端）。
目录以各宿主**当前**官方文档为准——版本间会变，安装前请再确认一次。

放置位置不影响技能内容本身：`agent-extension-updater/` 目录可以直接拷到任何上述位置。

## 调用示例

```text
使用 agent-extension-updater，检查当前宿主的 skills 和 plugins 的更新。
列出候选项并主动让我选择，确认后执行。
```

```text
只检查这个客户端，不更新、不重启。
```

```text
只更新刚才选中的那个插件，其他先不动。
```

```text
这个 skill 的更新是从哪来的？先给我来源和版本对比，别改任何东西。
```

## 各宿主的核实程度

本技能把"文档里写的"和"现场核实过的"分开标注，不把计划当结果：

| 宿主 | 依据 | 状态 |
| --- | --- | --- |
| DeepSeek Harness (DSH) | 本机源码 + 实测 | 插件 / 技能两条链路均已实测（见 [references/dsh.md](references/dsh.md)） |
| Hermes | 本机 CLI help + 官方更新文档 | 命令面已核实；真实升级未执行 |
| Codex | 官方 skills / plugins 文档 | 文档核实；本机未安装 CLI，接口待现场核实 |
| Claude Code | 官方文档入口 | 写作时抓取受阻、本机未安装，流程按能力检测编写，**未声称任何子命令已核实** |
| 通用 / 其他宿主 | 能力检测 + 通用协议 | 不预设客户端命令，按实际 help 与官方文档执行 |

每份 `references/*.md` 开头都有自己的核实状态，以那里为准。

## 边界

- **不替代安装器**：本技能没有安装脚本，也不会自行常驻或定时运行。
- **不自动开新窗口**：只有宿主提供已验证的会话接口且用户授权时才会这么做；否则就在当前对话里确认。
- **不保证可回滚**：只对已备份的范围负责，目录备份无法撤销全局依赖变更或配置迁移。
- **不扫描全部软件**：只处理当前宿主和用户明确授权的目录，不因"支持多平台"就去扫其他安装。
- **运行时限制**：模型只有本地执行能力时才能升级本地扩展；纯网页/API 模型做不到，会如实说明。

## 目录结构

```
agent-extension-updater/
├── SKILL.md                  # 主流程（宿主 agent 的入口）
├── README.md                 # 本文件（给人看的）
├── references/
│   ├── dsh.md                # DeepSeek Harness 适配
│   ├── hermes.md             # Hermes 适配
│   ├── codex.md              # Codex 适配
│   ├── claude-code.md        # Claude Code 适配
│   ├── generic-agent.md      # 通用宿主 / 能力分级
│   └── auto-update.md        # 自动更新开关：作用域、硬护栏、审计
├── templates/
│   ├── confirmation.md       # 更新确认清单模板
│   └── report.md             # 更新结果报告模板
└── scripts/
    ├── check-skill.mjs       # 技能自检：frontmatter、相对链接、可移植性
    ├── inventory.mjs         # 只读盘点：各宿主的技能/插件有哪些更新、在哪里更新
    └── auto-update.mjs       # 按开关自动更新技能与插件（本体永不涉及）
```

## 脚本

### 盘点：哪些有更新、在哪里更新

```bash
node scripts/inventory.mjs --check-updates   # 联网探测上游版本（只读请求）
node scripts/inventory.mjs                   # 纯本地盘点（不联网）
node scripts/inventory.mjs --all             # 连"无上游的本地技能"也逐条列出
node scripts/inventory.mjs --json            # 机器可读
node scripts/inventory.mjs --hosts dsh,hermes --dsh-install "<DSH 安装目录>"
```

输出一张表：**宿主 / 类型 / 名称 / 渠道 / 当前 / 最新 / 状态 / 在哪里更新 / 位置**。
默认只显示"有可执行动作"的条目，无上游的本地技能与随包内置项会被折叠计数。

覆盖的检查渠道：

| 类型 | 检查方式 |
| --- | --- |
| DSH 插件（npm） | `npm view <pkg> version` |
| DSH 插件（`link:` Git） | `git ls-remote`（只读，不写本地 refs） |
| Hermes 技能 / 插件 | 按 `.bundled_manifest`、`.hub/lock.json` 分类，给出对应更新命令 |
| Codex / Claude Code | 扫描各自技能与插件目录 |

### 自动更新（可选开关，默认关闭）

打开后，作用域内、**无破坏性变更**的技能与插件会被自动更新，不再逐项询问：

```bash
node scripts/auto-update.mjs --status          # 看状态与作用域
node scripts/auto-update.mjs --enable          # 打开（长期有效，直到 --disable）
node scripts/auto-update.mjs --run --dry-run   # 演练：只列清单，不改动
node scripts/auto-update.mjs --run             # 实际执行
node scripts/auto-update.mjs --report          # 审计日志摘要
```

四条**写死在代码里、配置改不动**的硬护栏：

1. **Agent 本体永不涉及**（配置里误写也拒绝）
2. 只动状态为`有更新`且带明确更新动作的项
3. 需要先退出宿主的项（如 DSH 插件）不动，只登记为"待手动"
4. 主版本跃迁（1.x → 2.x）不动，登记为"需确认"

开关文件 `~/.agent-extension-updater/config.json`，审计日志 `~/.agent-extension-updater/auto-update.log.jsonl`，
备份在 `~/.agent-extension-updater/backups/<时间戳>/`。详见 [references/auto-update.md](references/auto-update.md)。

### 技能自检

改完技能内容后跑一次（零依赖、只读、不联网）：

```bash
node scripts/check-skill.mjs
```

它会检查 `SKILL.md` 的 frontmatter（`name` 是否与目录名一致、`description` 是否非空且在长度限制内）、所有相对链接能否解析、是否混入了机器专属绝对路径，并报告各文件规模。
