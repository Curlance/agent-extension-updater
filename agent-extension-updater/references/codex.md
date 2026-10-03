# Codex 适配

## 核实状态

| 项 | 依据 | 状态 |
| --- | --- | --- |
| 技能位置 | 官方文档 | 已核实：技能使用 `SKILL.md`；项目技能可放 `.agents/skills`，用户级作者技能可放 `~/.agents/skills` |
| 插件机制 | 官方文档 | 插件是分发单位，可捆绑技能；**插件支持范围依客户端而异**（CLI / IDE / 桌面不是同一套安装） |
| 更新接口 | 官方文档 | `codex plugin marketplace list/upgrade` 属**市场目录**操作，不能证明已安装插件被更新；插件本身的升级入口须现场核实 |
| 本机实测 | — | 未执行；请在目标机器上跑 `codex --help` 及子命令帮助后再使用任何命令 |

官方依据：

- <https://developers.openai.com/codex/skills>
- <https://developers.openai.com/codex/concepts/customization>
- <https://developers.openai.com/codex/plugins>
- <https://developers.openai.com/plugins/build/plugins>

## 安装本技能

- 用户级：`~/.agents/skills/agent-extension-updater/`
- 项目级：`<repo>/.agents/skills/agent-extension-updater/`

装完按宿主要求重新发现技能。

## 操作流程

1. 识别形态与渠道：Codex CLI、桌面端还是 IDE 扩展，以及安装来源（npm / 桌面发布包 / 扩展市场）。查看本地版本与 `--help`。
   **不要假设 npm 更新会升级桌面内置的 Codex**——它们是不同安装。
2. 枚举授权范围内的技能，按上游来源管理；**没有统一的 `skill update` 命令依据，禁止编造**。
3. 插件携带的技能**随插件包整体更新**，不要去改缓存里的副本。
4. 查询与更新走当前官方的插件管理入口。注意区分两件事：
   - 市场刷新 / marketplace upgrade = 更新**目录索引**；
   - 已安装插件的升级 = 另一条入口，必须先核实存在、再使用。
5. 若本机 help 中不存在插件更新接口，**只报告限制**或使用已验证的 UI，不通过"卸载重装"伪装成更新。
6. 更新后验证插件与技能的**发现结果**（插件是否被加载、技能是否进入目录）。

> **Agent 本体不在本技能范围内**：Codex 本体分 npm / 桌面 / IDE 三条渠道，各有官方更新流程，请由用户自行执行；本技能不代为检查或升级。

## 交互与重载

使用当前宿主可用的用户输入工具或聊天确认；**独立开新会话不是本适配已验证的能力**。若需要新会话才能生效，报告"已落盘待重启"并询问用户，不擅自结束当前工作。
