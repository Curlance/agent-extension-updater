# agent-extension-updater

[中文](README.md) | **English**

A maintenance workflow for AI agent **skills and plugins**: inventory installed extensions, check for updates, back up files, apply updates, and verify the results.

The project includes a skill that clients supporting Agent Skills can load, plus standalone Node.js command-line tools. You can ask an agent to guide the maintenance process or run the scripts directly.

```text
Inventory → Check sources and versions → Confirm scope → Back up → Update → Verify and report
```

## What it does

- **Shows what is installed:** lists each extension's host, name, path, channel, current version, and check result.
- **Reports distinct outcomes:** separates available updates, up-to-date installations, failed checks, unknown sources, and unsupported integrations.
- **Updates eligible Git extensions:** pins the remote, tracking branch, and target commit, then checks them again before execution.
- **Preserves recovery data:** backs up the complete skill or plugin directory, verifies file hashes, and supports restoration to a new directory.
- **Records operations:** logs update targets, backup locations, and verification results.

The scope is limited to skills and plugins. It does not manage the agent application itself, standalone MCP services, models, or the operating system.

## Current support

The skill documentation provides guidance for several hosts. The table below describes what the scripts currently implement. **Discovering an extension does not mean its update channel is automated.**

| Host or channel | Inventory and checks | Automatic execution |
| --- | --- | --- |
| DeepSeek Harness (DSH) | User and project skills; profile plugin dependencies; installed and upstream npm versions | Eligible standalone Git skills and local Git plugins |
| Codex | User and project `.agents/skills` directories; Git source detection | Eligible standalone Git skills |
| Claude Code | User and project skills; Git source detection | Eligible standalone Git skills |
| Hermes | Classification of Hub, bundled, and local skills; plugin directory enumeration | Eligible standalone local Git skills; Hub and plugin protocols remain unsupported |
| Other hosts | General maintenance guidance; no dedicated scanner yet | Requires an adapter for the installation method |

The scripts explicitly report that Codex and Claude Code plugin installation records and update protocols are not yet supported. DSH npm plugins receive version checks only; updating them requires manual handling after the host exits.

### Eligibility for automatic updates

Automatic updating is disabled by default. Once enabled, an extension must still meet all of these conditions:

1. Its host and type are within the authorized scope, and it is not excluded.
2. Its directory is the root of a standalone Git repository with a clean working tree.
3. Its installed version is readable; the target commit has a unique semantic-version tag, and the version declared in its contents matches that tag.
4. The target is not a major-version upgrade, downgrade, or prerelease.
5. The backup passes verification; the remote, branch, and target remain unchanged; the update can fast-forward.

Subdirectories of shared repositories, Git worktrees, symbolic links/junctions, and unknown versions require manual handling. Version checks do not establish behavioral compatibility.

## Quick start

### Requirements

- **Node.js 18+:** the scripts use built-in modules only. No `npm install` is needed.
- **Git:** required for Git source detection, commit checks, and Git updates.
- **npm:** required when querying upstream versions of npm plugins.

Run the following commands from the repository root. The scripts currently display human-readable messages and status values in Chinese; this English README does not change their output language.

### 1. Inventory and check

```bash
# Local inventory, without network queries
node skills/agent-extension-updater/scripts/inventory.mjs --all

# Check upstream status for Codex skills only
node skills/agent-extension-updater/scripts/inventory.mjs --hosts codex --check-updates

# Choose a project directory and return JSON
node skills/agent-extension-updater/scripts/inventory.mjs --hosts codex --project "./your-project" --json
```

Without `--hosts`, the scanner checks all implemented hosts. Accepted values are `dsh`, `hermes`, `codex`, and `claude`, separated by commas. `--json` changes only the output format; add `--check-updates` to query upstream sources.

### 2. Set the scope and preview

```bash
# Inspect the switch; it is disabled by default
node skills/agent-extension-updater/scripts/auto-update.mjs --status

# Save the scope and enable the switch; this command does not update extensions
node skills/agent-extension-updater/scripts/auto-update.mjs --enable --hosts codex

# Preview the current plan without applying updates
node skills/agent-extension-updater/scripts/auto-update.mjs --run --dry-run
```

Use `--hosts` with `--enable` to save the scope. Actual runs and previews read that scope from the configuration. A shared skill directory requires all identified consuming hosts to be authorized, such as a directory used by both DSH and Codex.

A preview queries upstream sources but does not write extension files, backups, locks, or this tool's audit log. npm queries may update npm's own cache. Previews also work while the switch is disabled.

### 3. Apply updates and inspect results

```bash
# Apply eligible updates within the saved scope
node skills/agent-extension-updater/scripts/auto-update.mjs --run

# Read recent audit records
node skills/agent-extension-updater/scripts/auto-update.mjs --report

# Disable automatic-update authorization
node skills/agent-extension-updater/scripts/auto-update.mjs --disable
```

Enabling the switch does not create a scheduled task or start a background service. Each update requires a `--run` invocation, either manually or through a scheduler you configure. For project skills, select the directory with `--run --project "./your-project"`.

## Install as an Agent Skill

Copy the entire [`skills/agent-extension-updater/`](skills/agent-extension-updater/) directory into the host's skill directory. Keep `SKILL.md`, `references/`, `templates/`, and `scripts/`, including the shared `lib.mjs` module.

| Host | User-level installation location |
| --- | --- |
| DeepSeek Harness | `$DSH_HOME/skills/agent-extension-updater/`, under `~/.dsh/skills/` by default |
| Hermes | `$HERMES_HOME/skills/<category>/agent-extension-updater/` |
| Codex | `~/.agents/skills/agent-extension-updater/` |
| Claude Code | `~/.claude/skills/agent-extension-updater/` |

Use the host's actual configuration to determine installation paths and reload behavior. Start a new session or reload skills when needed. The installed skill needs local file access and command execution capabilities to maintain local extensions.

You can then ask:

> Use agent-extension-updater to check skills and plugins for the current host only. List update sources, target versions, and items that need manual handling.

Or:

> Review the last update log and tell me which files were updated and which extensions still need to be reloaded.

## Backup, recovery, and verification

The default configuration file is `~/.agent-extension-updater/config.json`. Set `AGENT_EXTENSION_UPDATER_CONFIG` to use a different location. Backups, logs, and the lock file are stored alongside the configuration.

```text
.agent-extension-updater/
├── config.json
├── auto-update.log.jsonl
├── run.lock                  # Exclusive lock during an actual run
└── backups/
    └── <run-id>/<extension-id>/
        ├── files/            # Complete directory snapshot
        └── record.json       # Original path, commits, and file hashes
```

Restore a backup to a new directory that does not already exist:

```bash
node skills/agent-extension-updater/scripts/auto-update.mjs --restore "./path/to/record.json" --to "./recovered-extension"
```

File hashes are checked before and after restoration. The command does not overwrite the current installation. Inspect the restored contents, then reconnect them using the host's supported installation process.

The update workflow follows these rules:

- Any failed item check or directory scan stops the entire update run and returns a nonzero exit code.
- A failed backup or an unwritable audit log before an update prevents that item from executing.
- Verification reads the exact path, commit, version, and skill name before recording success. Execution or verification failures stop the remaining updates in the run.
- Success is recorded as **“已落盘待重载” — files updated, reload pending**. This does not confirm that the host has loaded the extension or that its behavior is compatible.
- The lock coordinates only processes using the same configuration directory. A lock left behind after a crash requires manual inspection before removal.

See the [automatic-update specification](skills/agent-extension-updater/references/auto-update.md) for the full rules. Supporting technical documents are currently in Chinese.

## Development and tests

```bash
# Check skill structure, frontmatter, and documentation links
node skills/agent-extension-updater/scripts/check-skill.mjs skills/agent-extension-updater

# Run isolated regression tests
node --test tests/updater.test.mjs
```

Tests use temporary directories and local Git repositories. They cover complete update and recovery flows, branch and remote changes, version detection, local edits, backup failures, verification failures, and audit errors. They require neither a real host installation nor network access.

CI is configured for Windows/Linux and Node.js 18/22. Local Git tests do not replace upgrade testing and runtime validation in real hosts.

## Project layout and documentation

```text
skills/agent-extension-updater/
├── SKILL.md
├── README.md
├── references/              # Host guidance and automatic-update rules
├── templates/               # Confirmation and result-report templates
└── scripts/
    ├── inventory.mjs        # Inventory and upstream checks
    ├── auto-update.mjs      # Configuration, execution, audit, and recovery entry point
    ├── lib.mjs              # Versions, Git, backups, and verification
    └── check-skill.mjs      # Skill structure checks
tests/updater.test.mjs
docs/DESIGN.md
README.md
README.en.md
CHANGELOG.md
```

- [Skill entry point](skills/agent-extension-updater/SKILL.md)
- [Design notes](docs/DESIGN.md)
- [Changelog](CHANGELOG.md)

The project is under development and is released under the [PolyForm Noncommercial License 1.0.0](LICENSE): **noncommercial use only**. Personal study, research, education, charity and government use need no permission; any commercial use, including internal business use, requires separate authorization.

Required Notice: Copyright Curlance (https://github.com/Curlance)
