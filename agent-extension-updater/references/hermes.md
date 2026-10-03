# Hermes 适配

## 核实状态

| 项 | 依据 | 状态 |
| --- | --- | --- |
| 插件 / 技能命令面 | `hermes` CLI help | 已核实：`plugins list --json`、`plugins check-updates --json`、`plugins update <name>`、`skills check [name]`、`skills update [name]` |
| 真实升级演练 | — | 未执行。本文件描述的是如何可靠维护，不是已完成的维护记录 |

官方文档：<https://hermes-agent.nousresearch.com/docs/getting-started/updating>

**在目标机器上先跑一遍 `hermes --help` 与对应子命令的 `--help`**，以该版本实际列出的接口为准；不要照搬本文的命令清单。

## 安装本技能

放到当前 profile 的技能目录：`$HERMES_HOME/skills/<分类>/agent-extension-updater/`。
`HERMES_HOME` 从环境变量读取（不要写死用户路径）；当前 profile 与技能目录以宿主实际配置为准。复制后让宿主重新发现技能。

## 操作流程

1. 识别 `HERMES_HOME`、当前 profile 和实际安装渠道（源码 / MSIX / Store / macOS bundle / Docker / Nix / Termux）。
2. 枚举与检查：`hermes plugins list --json`、`hermes skills check [name]`；先看 `hermes plugins check-updates --help`，按它支持的方式做只读检查。
   - `plugins check-updates --json` 面向已安装插件，支持来源标签 `update_url`（含地址变化保护）、Git 远端和 pip entry-point 插件。
   - 其 JSON 为 receipt-section 结构；**按实际返回值解析，不预设 schema**，解析不了就原样保留输出，不假定格式。
   - 远端检查可能刷新缓存或 Git 引用，属于只读检查的固有副作用，需与"安装更新"区分开。
3. 执行更新：批准后逐项运行 `hermes plugins update <name>` 或 `hermes skills update <name>`。
   - 不用 `--force` 覆盖用户技能；
   - 不自行 `adopt` 或 `trust-update-url`；
   - 涉及共享安装或其他 profile 的副作用，先扩大确认范围。
4. 验证：用**新进程**确认技能被宿主发现、插件被加载；旧进程仍在加载旧代码不算验证通过。

> **Agent 本体不在本技能范围内**：`hermes update`（会迁移配置并重启网关）请由用户走官方入口自行执行，本技能不代为检查或执行。

## 已知限制

- 曾观察到 CLI 启动器在启动时报告"自动依赖修复重试耗尽""安装不同步""旧网关未重启"。**这类信息是环境阻塞或警告，不是插件检查成功**；不要顺手运行 `pm repair` / `install` 当作更新流程的一部分（那属于会改动环境的修复操作，须单独授权）。
- 本适配核实过帮助接口，未执行真实扩展升级。
