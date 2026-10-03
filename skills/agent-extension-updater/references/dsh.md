# DeepSeek Harness (DSH) 适配

DSH 是 Electron 桌面客户端 + 内置 cordis 插件运行时的组合（`@deepseek-ai/*`）。本技能在 DSH 上管理**两个面**：插件（profile bundles）与技能（文件系统根）。

**Agent 本体（桌面应用）不在本技能范围内**——不检查、不升级、不列入清单；桌面端升级请走它自己的官方更新入口。

## 核实状态

| 项 | 依据 | 状态 |
| --- | --- | --- |
| `dsh plugin` 行为 | 本机 CLI 实跑 + 读 `dsh` / `dsh-plugin-manager` 源码 | 已实测 |
| plugin bundle 自动登记与摘除 | 读 `dsh-plugin-manager/lib/types/operations.js` 源码 | 已核实（未做破坏性实测） |
| 技能扫描根与热加载 | 读 `dsh-skill-filesystem` 源码 + 本机实测 | 已实测 |
| 应用升级后 profile 是否被重播种 | 第三方插件文档提及 | **未核实** |

## 识别

| 信号 | 说明 |
| --- | --- |
| `DSH_HOME` 环境变量 | 默认 `~/.dsh`；本机另有 `DSH_PROFILE` / `DSH_PROFILE_DIR` 可直接读取 |
| `dsh` 可执行文件 | 桌面版位于 `<安装目录>\resources\runtime\cli\bin\dsh.cmd` |
| `~/.dsh/profiles/<name>` | profile 目录；桌面端通常为 `desktop` |
| `DSH_AGENTS_HOME` | 默认 `~/.agents`（**与 Codex 共享**，不是 DSH 专属） |

`dsh` CLI 是"Desktop 安装携带的不可变运行时"，不是全局 npm 包。

## 1) 插件（profile bundles）

插件登记在 `<profile>/package.json`：

```json
{
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "...", "@dsh-external/dsh-normify"] } },
  "dependencies": { "@dsh-external/dsh-normify": "link:C:/path/to/checkout" }
}
```

操作命令（`dsh plugin` 的**非 DSH 子命令会原样转给 pnpm**）：

```bash
dsh plugin --profile <profile> add <spec>       # 安装；成功后自动追加到 bundles
dsh plugin --profile <profile> remove <name>    # 卸载；成功后自动从 bundles 摘除
dsh plugin --profile <profile> list             # 即 pnpm list
```

要点：

1. **先完全退出桌面端再执行**。CLI 自身会提示："Open DeepSeek Harness Desktop once to initialize its profile, then fully quit it before running dsh plugin --profile desktop."
   → 因此**运行中的会话不能自动执行 DSH 插件更新**；这类项只能标"需退出宿主后手动执行"。
2. **bundle 登记是自动的**（读源码 `reconcile()` 确认）：安装后按 `dsh.bundle.patch` 追加进 `bundles`；卸载后按当前 `dependencies` 过滤掉。**不要手改 `bundles`** 去"补登记"或"清残留"。
3. **`link:` 的链接目标在 profile 之外**，`pnpm remove` 只删链接，**不会删源码目录**，需要单独处理。
4. **peer 依赖由宿主提供**：`<profile>/node_modules/@deepseek-ai` 可能是空的，插件运行时从宿主解析 `@deepseek-ai/*`。不要去"补装"这些 peer。
5. **版本豁免**：不兼容的版本会被拒绝，CLI 给出
   `dsh plugin --profile <p> allow-version <name>@<version> --dsh-version <runtimeVersion> --accept-risk`
   这会放宽安全边界，**属于需要用户明确知情同意的操作**，不要在检查阶段执行。
6. 检查更新按渠道分别做（只读）：

| 渠道 | 检查方式 |
| --- | --- |
| npm 托管（`^x.y.z`） | `npm view <pkg> version` |
| Git `link:` | `git -C <repo> ls-remote origin refs/heads/main`（不写本地 refs）+ `gh api repos/<o>/<r>/releases/latest` |
| 随本体内置（`@deepseek-ai/*`） | 无独立上游 → 登记为"随本体"，本技能跳过 |

7. `link:` 插件的更新方式是 `git -C <repo> pull`（可-fast-forward 时），**重启 DSH 后生效**。它不要求退出桌面端，是本技能在 DSH 上唯一能安全自动执行的更新类型。

## 2) 技能（文件系统根）

`dsh-skill-filesystem` 按 rank 扫描（默认开启）：

| rank | 来源 | 路径 |
| --- | --- | --- |
| 100 | project-dsh | `<项目根>/.dsh/skills` |
| 200 | project-agents | `<项目根>/.agents/skills` |
| 400 | user-dsh | `<DSH_HOME>/skills`（跳过其 `.system` 子目录） |
| 500 | user-agents | `<DSH_AGENTS_HOME 或 ~/.agents>/skills` |
| 600 | bundled | `$DSH_BUNDLED_SKILL_DIR`（随包，第一方） |

- **项目根** = 最近含 `.git` 的祖先目录；没有则用 cwd。
- **只扫深度 1**：`<name>/SKILL.md` 目录包，或平铺 `<name>.md`；**刻意不支持嵌套 `**/SKILL.md`**。bundle 内的 `references/`、`scripts/` 是资源，不会被当成独立技能。
- **frontmatter**：必填 `name`（kebab-case）与 `description`；可选 `whenToUse`、`metadata`、`disable-model-invocation`、`user-invocable`。**格式非法会让整个技能连同警告一起消失**，模型侧看不到逐技能诊断——改完技能一定要自检，可用本技能自带的 `scripts/check-skill.mjs`。
- **热加载**：根目录被 Chokidar 监视（深度 1），新增/改名/删除技能与 frontmatter 变更**无需重启**即进入下一次目录；第一方 `write`/`edit` 会直接让提供方失效。**只改 `references/` 里的正文不会刷新目录**（目录只依赖 frontmatter），但加载技能时会重新读取文件正文。
- 随包技能（如 `@deepseek-ai/dsh-skill-office`、`@deepseek-ai/dsh-sandbox-windows-acl` 的 `assets/`）没有独立上游，登记为"随本体"并跳过。

安装 / 卸载：把技能文件夹放进上述任一根（用户级推荐 `<DSH_HOME>/skills`），删掉即卸载，无需其它登记。放在 `~/.agents/skills` 会让 **DSH 与 Codex 同时看到**该技能。

## 已知限制

- **`dsh plugin` 需要 profile 已被桌面端初始化过**；没有 `package.json` 的 profile 会直接报错。
- **DSH 插件更新无法在运行中的会话里自动完成**（必须先退出桌面端），因此自动更新模式下这类项只会被列成"待手动执行"。
- 桌面端升级可能按 `resources/profile-seed` 重播种 profile，外部插件登记可能丢失（第三方插件文档所述，**本次未核实**）——升级后先复核 `dsh.profile.bundles`。
- 在受限文件沙箱下，CLI 触发的 git/网络通道可能被拦（本机曾在 workspace-write 模式下无法 `git clone`），这时按"检查失败"如实报告，不要绕过沙箱。
- 本文件记录的是本机 DSH **0.2.0-rc.2** 上的实测行为；DSH 迭代较快，**执行前先用 `dsh --help` 和对应子命令 `--help` 复核**。
