# Aperant (formerly Auto Claude)

Aperant is the current name of the product formerly called Auto Claude. Some file, directory and image names (`.auto-claude/`, `.auto-claude-allowlist`, `Auto-Claude-*.png`) keep the old name.

**Autonomous multi-agent coding framework that plans, builds, and validates software for you.**

![Aperant Kanban Board](.github/assets/Auto-Claude-Kanban.png)

[![License](https://img.shields.io/badge/license-AGPL--3.0-green?style=flat-square)](./LICENSE)
[![Discord](https://img.shields.io/badge/Discord-Join%20Community-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/KCXaPBr4Dj)
[![YouTube](https://img.shields.io/badge/YouTube-Subscribe-FF0000?style=flat-square&logo=youtube&logoColor=white)](https://www.youtube.com/@AndreMikalsen)
[![CI](https://img.shields.io/github/actions/workflow/status/elshazlyhefny/Aperant/ci.yml?branch=zeenha&style=flat-square&label=CI)](https://github.com/elshazlyhefny/Aperant/actions)
[![Mentioned in Awesome Claude Code](https://awesome.re/mentioned-badge-flat.svg)](https://github.com/hesreallyhim/awesome-claude-code)

---

## Install

This fork publishes no public binary releases, so there is nothing to download. Get it from source:

```bash
git clone https://github.com/elshazlyhefny/Aperant.git
cd Aperant
git checkout zeenha
```

Then either:

- **Run from source** - `npm run install:all`, then `npm start`. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full development setup.
- **Build and install** - run `scripts/zeenha-release.sh`. It tests, builds and installs the Linux AppImage as the running app. Use `scripts/zeenha-release.sh --rollback` to go back to the previous install.

---

## Requirements

- **Claude Pro/Max subscription** - [Get one here](https://claude.ai/upgrade)
- **Claude Code CLI** - `npm install -g @anthropic-ai/claude-code`
- **Git repository** - Your project must be initialized as a git repo

---

## Quick Start

1. **Install** the app - see [Install](#install)
2. **Open your project** - Select a git repository folder
3. **Connect Claude** - The app will guide you through OAuth setup
4. **Create a task** - Describe what you want to build
5. **Watch it work** - Agents plan, code, and validate autonomously

---

## Features

| Feature | Description |
|---------|-------------|
| **Autonomous Tasks** | Describe your goal; agents handle planning, implementation, and validation |
| **Parallel Execution** | Run multiple builds simultaneously with up to 12 agent terminals |
| **Isolated Workspaces** | All changes happen in git worktrees - your main branch stays safe |
| **Self-Validating QA** | Built-in quality assurance loop catches issues before you review |
| **AI-Powered Merge** | Automatic conflict resolution when integrating back to main |
| **Memory Layer** | Agents retain insights across sessions for smarter builds |
| **Recurring Schedules** | Run a task on a daily, weekly or interval cadence while the app is open; see [guides/recurring-tasks.md](guides/recurring-tasks.md) |
| **GitHub/GitLab Integration** | Import issues, investigate with AI, create merge requests |
| **Linear Integration** | Sync tasks with Linear for team progress tracking |
| **Jira Import** | Import Jira issues as tasks. Keys are set in the project's `.auto-claude/.env`, see [Jira configuration](guides/project-configuration.md#jira) |
| **Cross-Platform** | Native desktop apps for Windows, macOS, and Linux |
| **Controlled Updates** | In-app updates are disabled. An update is a deliberate pull of the `zeenha` branch plus a rebuild with `scripts/zeenha-release.sh`; `--rollback` restores the previous install |

---

## Interface

### Kanban Board
Visual task management from planning through completion. Create tasks and monitor agent progress in real-time.

### Agent Terminals
AI-powered terminals with one-click task context injection. Spawn multiple agents for parallel work.

![Agent Terminals](.github/assets/Auto-Claude-Agents-terminals.png)

### Roadmap
AI-assisted feature planning with competitor analysis and audience targeting.

![Roadmap](.github/assets/Auto-Claude-roadmap.png)

### Additional Features
- **Insights** - Chat interface for exploring your codebase. You can attach images (paste, drop or screenshot) and send them to vision-capable models; see [Attaching images](apps/desktop/src/main/insights/README.md#attaching-images)
- **Ideation** - Discover improvements, performance issues, and vulnerabilities
- **Changelog** - Generate release notes from completed tasks

---

## Project Structure

```
Aperant/
├── apps/
│   └── desktop/     # Electron desktop application (TypeScript AI agent layer + UI)
├── guides/          # Additional documentation
└── scripts/         # Build utilities
```

---

## Development

Want to build from source or contribute? See [CONTRIBUTING.md](CONTRIBUTING.md) for complete development setup instructions.

For Linux-specific builds (Flatpak, AppImage), see [guides/linux.md](guides/linux.md).

To run a task from a command line or CI without the app, see [guides/CLI-USAGE.md](guides/CLI-USAGE.md#running-a-task-headlessly).

---

## Security

Aperant runs AI agents that execute shell commands and edit files. What it enforces:

1. **Command denylist** - Some commands are always blocked: shutdown and reboot, disk formatting and `dd`, privilege escalation (`sudo`, `su`, `doas`, `chown`), firewall tools, `nmap`, `systemctl` and `service`, `crontab`, `mount` and `umount`, and user and group account management.
2. **Per-command validators** - Extra checks run for `rm`, `chmod`, `git`, process killing (`pkill`, `kill`, `killall`), shell `-c` (`bash`, `sh`, `zsh`), and database clients (`psql`, `mysql`, `mysqladmin`, `redis-cli`, `mongosh`, `dropdb`, `dropuser`).
3. **Path containment for file tools** - The Read, Write, Edit, Glob and Grep tools are limited to allowed paths.
4. **Git worktree isolation** - Code changes are made in a separate worktree, so your main branch stays untouched until you merge.

What it does **not** enforce:

- Unless you turn on the OS-level Bash sandbox, Bash commands are not isolated. See the sandbox modes below.
- Every command not on the denylist is allowed by default.
- Bash commands run in the task working directory with your user's permissions. They can reach outside the project unless a validator blocks them.
- The validators are a guardrail, not a sandbox. A script the agent writes and then runs, or an interpreter one-liner, is not inspected.

Only run agents on repositories and machines where that is acceptable.

The OS-level Bash sandbox is opt-in per project and is off by default. Pick a mode in the project settings:

| Mode | Platforms | What it does |
|---|---|---|
| `off` | All | Commands run with your full rights. |
| `home-hidden` | Linux (bubblewrap), macOS (`sandbox-exec`) | Hides your home directory. |
| `home-hidden-no-network` | Linux, macOS | Hides your home directory and also blocks the network. |
| `restricted-rights` | Windows only | Restricted token plus Job object: drops admin rights and privileges and kills leftover child processes. It does **not** hide your home folder and does **not** block the network. Commands still run as you. |

If you pick a mode the platform does not support, every agent shell command fails and the settings page shows "Mode not supported here". The home-hidden modes are refused on Windows, and `restricted-rights` is refused on Linux and macOS. For the Windows details, see [Testing the Bash sandbox](guides/windows-development.md#testing-the-bash-sandbox).

The `.auto-claude-allowlist` file is still read, but it no longer affects allow or deny decisions.

---

## Available Scripts

| Command | Description |
|---------|-------------|
| `npm run install:all` | Install all dependencies |
| `npm start` | Build and run the desktop app |
| `npm run dev` | Run in development mode with hot reload |
| `npm run package` | Package for current platform |
| `npm run package:mac` | Package for macOS |
| `npm run package:win` | Package for Windows |
| `npm run package:linux` | Package for Linux |
| `npm run package:flatpak` | Package as Flatpak (see [guides/linux.md](guides/linux.md)) |
| `npm run lint` | Run linter |
| `npm test` | Run frontend tests |

---

## Contributing

We welcome contributions! Please read [CONTRIBUTING.md](CONTRIBUTING.md) for:
- Development setup instructions
- Code style guidelines
- Testing requirements
- Pull request process

---

## Community

- **Discord** - [Join our community](https://discord.gg/KCXaPBr4Dj)
- **Issues** - [Report bugs or request features](https://github.com/elshazlyhefny/Aperant/issues)

---

## License

**AGPL-3.0** - GNU Affero General Public License v3.0

Aperant is free to use. If you modify and distribute it, or run it as a service, your code must also be open source under AGPL-3.0.

Commercial licensing available for closed-source use cases.
