# agent-extension-updater

一个可被任何支持 **Agent Skills** 的客户端加载的通用维护技能：**盘点并更新 Agent 的 skills 与 plugins**。

> **Agent 本体不在范围内**——不检查、不升级、不列入清单。本体升级请走各宿主自己的官方入口。

```
自动检查 → 主动确认 → 备份 → 官方渠道更新 → 逐项验证
```

## 它解决什么问题

| 常见做法的问题 | 本技能的做法 |
| --- | --- |
| 模型凭印象编造 `xxx update` 命令 | 只用本机 `--help` 或官方文档确认过的命令；核实不了标"未验证" |
| 一句"帮我更新"就动手，不知道会改什么 | 先出清单（名称 / 路径 / 来源 / 当前→目标 / 重启影响），再逐项确认 |
| 把网络失败报成"已是最新" | 状态词表强制区分 `有更新 / 已最新 / 检查失败 / 无来源 / 待适配` |
| 更新完就宣布成功 | 读回目标版本，区分"已验证生效"与"已落盘待重启" |
| 覆盖掉用户的本地修改 | 先备份、保留本地修改，禁止 `--force` |

## 支持范围

| 宿主 | 技能 | 插件 | 核实程度 |
| --- | --- | --- | --- |
| **DeepSeek Harness (DSH)** | ✅ | ✅ `dsh plugin` / profile bundles | 本机源码 + 实测 |
| **Hermes** | ✅ hub / bundled / local 三类 | ✅ `hermes plugins` | 命令面已核实；真实升级未执行 |
| **Codex** | ✅ `.agents/skills` | ⚠️ 接口待现场核实 | 官方文档核实；本机未安装 CLI |
| **Claude Code** | ✅ | ⚠️ 接口未核实 | 只做能力检测，不声称子命令 |
| **其他宿主** | ✅ | ✅ | 按能力分级：仅网页 / 可读文件 / 可执行命令 / 可调度 |

明确**不**管理：Agent 本体、MCP 服务、模型、操作系统。

## 安装

技能 = 一个文件夹。**必须整个复制** `skills/agent-extension-updater/`（含 `SKILL.md` + `references/` + `templates/` + `scripts/`），只复制 `SKILL.md` 会断掉文档链路。

| 宿主 | 用户级目录 | 项目级目录 |
| --- | --- | --- |
| DeepSeek Harness | `$DSH_HOME/skills/agent-extension-updater/`（默认 `~/.dsh/skills`） | `<repo>/.dsh/skills/…` |
| Hermes | `$HERMES_HOME/skills/<分类>/agent-extension-updater/` | 按当前 profile 约定 |
| Codex | `~/.agents/skills/agent-extension-updater/` | `<repo>/.agents/skills/…` |
| Claude Code | `~/.claude/skills/agent-extension-updater/` | `<repo>/.claude/skills/…` |

装完多数宿主需要新会话或重启才生效；**DSH 例外**——它监视技能根目录，新增/删除无需重启。
注意 `~/.agents/skills` 是 **DSH 与 Codex 共用**目录，放进去两个宿主都会看到。

## 使用

自然语言触发即可（宿主按 `description` 匹配加载）：

```text
检查一下技能和插件的更新
哪些技能/插件有新版本？在哪里更新？
把自动更新开关打开
上次自动更新做了什么？
```

或在支持显式调用的宿主里直接点名（DSH / Claude Code 的 `/name` 手势）：

```text
/agent-extension-updater 只检查不更新，给我清单
```

### 三个脚本（可独立使用，不经过 Agent）

```bash
# 盘点：哪些有更新、在哪里更新（只读）
node skills/agent-extension-updater/scripts/inventory.mjs --check-updates
node skills/agent-extension-updater/scripts/inventory.mjs --all     # 展开无上游的本地技能
node skills/agent-extension-updater/scripts/inventory.mjs --json    # 机器可读

# 自动更新开关（默认关闭）
node skills/agent-extension-updater/scripts/auto-update.mjs --status
node skills/agent-extension-updater/scripts/auto-update.mjs --enable
node skills/agent-extension-updater/scripts/auto-update.mjs --run --dry-run
node skills/agent-extension-updater/scripts/auto-update.mjs --report

# 技能结构自检
node skills/agent-extension-updater/scripts/check-skill.mjs skills/agent-extension-updater
```

三个脚本均为**零依赖、Node 18+**，除 `--check-updates` / `--run` 外不联网、不写盘。

## 安全模型

### 默认流程的六条红线

不猜命令 / 不静默改动 / 不掩盖失败 / 不越权 / 不破坏 / 不假装运行。
其中最关键的一条：**检查失败不等于"已最新"**，也不等于可以动手。

### 自动更新开关的四条硬护栏

开关**默认关闭**；打开后作用域内、无破坏性变更的技能与插件会被自动更新。以下四条**写死在代码里，配置文件改不动**：

1. **Agent 本体永不涉及**（配置里误写也拒绝）
2. 只处理状态为`有更新`且带明确更新动作的项
3. 需要先退出宿主的项（如 DSH 插件）不动，只登记为"待手动"
4. 主版本跃迁（1.x → 2.x）不动，登记为"需确认"

盘点失败时不做任何更新。每次自动更新都写审计日志与备份，见 `references/auto-update.md`。

## 目录结构

```
skills/                           # ← 可安装单元都在这里，一个目录 = 一个技能
└── agent-extension-updater/      #    复制这个目录到宿主的技能目录即可安装
    ├── SKILL.md                  #    主流程（宿主 Agent 的入口）
    ├── README.md                 #    技能自述
    ├── references/               #    按宿主选读
    │   ├── dsh.md                #      DeepSeek Harness 适配
    │   ├── hermes.md             #      Hermes 适配
    │   ├── codex.md              #      Codex 适配
    │   ├── claude-code.md        #      Claude Code 适配
    │   ├── generic-agent.md      #      通用宿主 / 能力分级
    │   └── auto-update.md        #      自动更新开关规范
    ├── templates/
    │   ├── confirmation.md       #      更新确认清单模板
    │   └── report.md             #      更新结果报告模板
    └── scripts/
        ├── inventory.mjs         #      只读盘点：哪些有更新、在哪里更新
        ├── auto-update.mjs       #      按开关自动更新（本体永不涉及）
        └── check-skill.mjs       #      技能自检：frontmatter、相对链接、可移植性

README.md                         # 本文件：项目说明
CHANGELOG.md                      # 版本变更记录
docs/DESIGN.md                    # 设计说明：范围 / 支持矩阵 / 护栏 / 限制
.github/workflows/ci.yml          # CI
```

## 开发

```bash
# 与 CI 相同的检查
node --check skills/agent-extension-updater/scripts/inventory.mjs
node --check skills/agent-extension-updater/scripts/auto-update.mjs
node --check skills/agent-extension-updater/scripts/check-skill.mjs
node skills/agent-extension-updater/scripts/check-skill.mjs skills/agent-extension-updater
node skills/agent-extension-updater/scripts/inventory.mjs --json
```

新增一个技能：在 `skills/` 下建 `<skill-name>/` 并放入 `SKILL.md`（frontmatter 必填 `name` 与 `description`，`name` 需与目录名一致且为小写连字符）。CI 会自动检查每个技能目录都有 `SKILL.md`。提交前用 `check-skill.mjs` 自检一次。

改技能内容后务必跑一次 `check-skill.mjs`：宿主的技能发现会因为 frontmatter 非法而**静默丢弃**整个技能，模型侧看不到诊断。

## 已知限制

- **DSH 的 npm 插件无法在运行中的会话里自动更新**（`dsh plugin` 要求先完全退出桌面端），这类项只会被登记为"待手动"。DSH 上能自动的目前只有 Git `link:` 类插件。
- 技能更新后**文件落盘 ≠ 已生效**，多数宿主需要重启或新会话才会加载新版本。
- Codex / Claude Code 的插件更新接口**尚未在真实环境核实**，只做盘点与能力检测。
- 本技能**不是常驻程序**，不自行定时运行；定时检查需由宿主的调度能力另行接入（见 `references/auto-update.md`）。

## 状态

本地项目，**尚未发布**（无远程仓库）。许可证待定。
