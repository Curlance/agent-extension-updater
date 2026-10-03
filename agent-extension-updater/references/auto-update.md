# 自动更新开关（可选模式）

默认关闭。打开后，**作用域内、无破坏性变更的技能与插件会被自动更新，不再逐项询问**；Agent 本体永远不在其中。

> 这是本技能唯一一处"长期授权"。它削弱了默认流程里的"每次都要确认"，因此边界必须写清楚——下面四条护栏**写死在代码里（`scripts/auto-update.mjs`），配置文件改不动**。

## 开关文件

位置：`$AGENT_EXTENSION_UPDATER_CONFIG`，缺省 `~/.agent-extension-updater/config.json`

```json
{
  "schema_version": 1,
  "auto_update": {
    "enabled": false,
    "enabled_at": null,
    "scope": {
      "hosts": ["dsh", "hermes", "codex", "claude"],
      "kinds": ["技能", "插件"],
      "exclude": []
    }
  }
}
```

- `enabled`：唯一的总开关，**默认 false**。
- `enabled_at`：打开时间，用于留痕与事后追溯。
- `scope.hosts`：允许自动更新的宿主；不写则全部已识别宿主。
- `scope.kinds`：允许的类型。**"本体"不在允许集合内，写进去也会被拒绝。**
- `scope.exclude`：明确排除的条目名（按名称匹配）。

有效期：**长期有效，直到手动 `--disable`**（这是使用者的明确选择）。开关打开这一动作本身会被记入审计日志。

## 四条硬护栏（不可配置）

| # | 护栏 | 行为 |
| --- | --- | --- |
| 1 | **本体永不涉及** | `kind` 为"本体"的条目一律拒绝，即使配置里误写也不行 |
| 2 | **只动有明确动作的项** | 状态必须是`有更新`，且带结构化 `updateAction`；`无来源 / 检查失败 / 待适配 / 已最新` 一律不动 |
| 3 | **需先退出宿主的不动** | `updateAction.requiresAppQuit` 为真（例如 DSH 插件）→ 登记为"待手动执行"，不自动跑 |
| 4 | **主版本跃迁不动** | 当前与目标的 major 不同（如 1.2.0 → 2.0.0）→ 登记为"需确认"，视为破坏性变更 |

此外，**盘点失败时不做任何更新**——按红线，检查失败不是"没有更新"，也不该被当成可以动手的信号。

## 操作

```bash
node scripts/auto-update.mjs --status          # 看状态与作用域
node scripts/auto-update.mjs --enable          # 打开（可加 --hosts dsh,hermes 限定宿主）
node scripts/auto-update.mjs --disable         # 关闭
node scripts/auto-update.mjs --run --dry-run   # 演练：只列出会做什么，不改任何东西
node scripts/auto-update.mjs --run             # 实际执行（开关关闭时会拒绝）
node scripts/auto-update.mjs --report          # 审计日志摘要
```

关闭状态下 `--run`（非演练）会直接拒绝执行并说明原因；`--dry-run` 在关闭状态下仍可用，方便先看清单。

## 备份与恢复

- 每次实际更新前，在 `~/.agent-extension-updater/backups/<时间戳>/` 写入：
  - 目录类（技能）的**整目录副本**；
  - 所有条目的**元数据记录**（`host/kind/name/path/channel/current/latest/repo`）。
- 记录文件同时是回滚依据：npm 项按 `current` 版本重装，Git `link:` 项按记录的提交回退。
- 目录备份只能覆盖备份范围内的事，**不能撤销全局依赖变更或配置迁移**。

## 审计日志

`~/.agent-extension-updater/auto-update.log.jsonl`，每行一条：

```json
{"ts":"...","action":"update","host":"DSH","kind":"插件","name":"...","from":"1.2.0","to":"1.2.1","ok":true,"command":"...","backup":"..."}
```

`action` 取 `enable` / `disable` / `update` / `run`。失败条目会带 `error`。

## 每条：文件更新 ≠ 已生效

自动更新只保证**文件落盘**。宿主是否加载了新版本，取决于它自己：

- **DSH**：`link:` 插件 `git pull` 后**重启桌面端**才生效；技能目录由宿主监视，通常无需重启。
- **Hermes**：技能/插件更新后按宿主要求重载。
- 报告里必须区分"已更新"与"已生效"，不能合并成一句"更新成功"。

## 定时运行（按宿主接入，本技能不自己调度）

本技能**不是常驻程序**，不会自行定时启动；定时检查要由宿主的调度能力另行接入：

| 宿主 | 可用方式 |
| --- | --- |
| DSH | 会话内调度能力（提醒/定时任务）；任务提示里让它跑 `inventory.mjs --check-updates`，若开关已打开再跑 `auto-update.mjs --run` |
| 其他 | 系统计划任务（Windows 任务计划 / cron）调用同一个脚本 |

调度器不能交互时：**只盘点、只排队**，更新仍交给开关与护栏判定。新一轮执行前重新核实开关状态与本地实际状态，**过期的批准不可复用**。
