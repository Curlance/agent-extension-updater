# Claude Code 适配

## 核实状态

| 项 | 依据 | 状态 |
| --- | --- | --- |
| 技能 / 插件 / 市场入口 | 官方文档 URL | 已记录入口；**写作时网页抓取受阻、本机未安装 `claude`，因此不声称任何具体子命令已核实** |
| 安装目录 | 官方文档 + 通行约定 | `~/.claude/skills/`（用户级）、`<repo>/.claude/skills/`（项目级）；**安装前请以当前官方文档再确认** |
| 升级命令 | — | 未核实。不得猜 `claude update`、`plugin update` 是否存在 |

官方入口：

- <https://code.claude.com/docs/en/skills>
- <https://code.claude.com/docs/en/plugins>
- <https://code.claude.com/docs/en/plugin-marketplaces>
- <https://code.claude.com/docs/en/setup>

> Claude 网页聊天 ≠ Claude Code。前者没有本地 CLI 升级能力，不要声称能替用户升级。

本文件是**能力检测 + 执行流程**，不是命令清单。所有命令都必须在目标机器上用 `--help` 核实后才使用。

## 安装本技能

- 用户级：`~/.claude/skills/agent-extension-updater/`
- 项目级：`<repo>/.claude/skills/agent-extension-updater/`

装完重载或新开会话，让宿主重新发现技能。

## 操作流程

1. 在目标机器识别 Claude Code 的安装来源（原生安装、包管理器、桌面集成）、可执行文件与版本；先看**顶层** `--help`，只有它列出的子命令才能继续查询其帮助。
2. 按当前官方技能文档确认用户级 / 项目级技能目录，枚举授权范围，保留来源信息与本地修改。
3. 核实本地插件管理器的能力：列出、市场刷新、插件升级、安装 scope、验证接口。
   - **市场刷新 ≠ 插件升级**；
   - **不跨用户 / 项目 scope** 混用。
4. 插件按其安装来源走各自的官方升级流程。先检查是否有自动更新进程在跑，避免冲突；不混用另一渠道的重装命令。
5. 有交互确认工具就主动调用，否则在聊天里提出更新清单。**只有确认后才升级**。
6. 升级后验证实际版本、插件可用性与重载需求。
7. 拿不到官方文档、本机也没有 `claude` 时，**只输出"检查失败"报告**，不推测子命令是否存在。

> **Agent 本体不在本技能范围内**：Claude Code 本体（原生 / 包管理器 / 桌面集成）的升级请由用户走官方流程，本技能不代为检查或执行。
