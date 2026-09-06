> [!WARNING]
> **Synara Beta is not ready.** This repository is an early development preview: expect breaking changes, incomplete features, and instability. Do not use it for anything important yet.

<div align="center">
  <img src="./assets/prod/logo.svg" width="112" alt="Synara Beta logo">
  <h1>Synara Beta</h1>
  <p><strong>The fast-iteration preview channel for Synara.</strong></p>
  <p>
    <a href="https://www.trysynara.com/">Website</a>
    &nbsp;·&nbsp;
    <a href="https://www.trysynara.com/docs">Documentation</a>
    &nbsp;·&nbsp;
    <a href="./docs/external-mcp.md">MCP integration</a>
    &nbsp;·&nbsp;
    <a href="https://github.com/kartikkabadi/synara-beta/issues/new">Report an issue</a>
  </p>
</div>

> [!TIP]
> **Coexistence with Synara Stable:** Synara Beta is engineered to run side-by-side with Synara Stable on the same machine. It uses an isolated data directory (`~/.synara-beta`), separate ports, and dedicated bundle identifiers (`com.emanueledipietro.synara.beta`) with zero data collisions.

<details>
  <summary><strong>Table of contents</strong></summary>

| Workspace layer      | Responsibility                                                |
| -------------------- | ------------------------------------------------------------- |
| **Project**          | Repository context, settings, and related work.               |
| **Thread**           | Task-specific conversation, state, files, and history.        |
| **Provider session** | The authenticated coding-agent runtime executing the task.    |
| **Workspace tools**  | Changes, terminal, browser, files, editor, previews, and Git. |

> [!NOTE]
> Synara is early-stage software. APIs and interface details remain under active development.

## Capabilities

### 1. Projects, threads, and context

Organize work around projects and threads. Projects define the workspace; threads preserve the task-specific conversation, state, files, and history.

- Project-aware navigation and conversations
- Provider and model selection per task
- Thread history, status, recaps, notes, and side chats
- Search and quick access across active work

### 2. Integrated workspace tools

The tools surrounding an agent session remain available from the same task surface, keeping execution and review connected.

| Surface            | Purpose                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------- |
| **Changes**        | Inspect diffs, changed files, and review state.                                                   |
| **Terminal**       | Run commands in the project environment.                                                          |
| **Browser**        | Keep local previews next to the thread and let agents use semantic or page-declared WebMCP tools. |
| **Files / Editor** | Browse, inspect, and edit project files in context.                                               |
| **Git**            | Work with branches, commits, pushes, and pull requests.                                           |

### 3. Split views and previews

Keep an active conversation alongside the surface it is changing. Split views, browser previews, and device previews make the result part of the working context.

<p align="center">
  <img src="./assets/prod/readme-split-view-dark.png" width="900" alt="Synara split view with an agent thread and iOS simulator preview">
</p>

### 4. Provider-native integrations

Synara connects to coding-agent runtimes that are installed and authenticated locally. The current development build includes the following integrations:

| Runtime         | Local integration                           |
| --------------- | ------------------------------------------- |
| **Codex**       | Codex CLI / app-server                      |
| **Claude**      | Claude Code                                 |
| **Cursor**      | Cursor agent runtime                        |
| **Antigravity** | Antigravity CLI                             |
| **Grok**        | Grok Build                                  |
| **Droid**       | Factory Droid                               |
| **OpenCode**    | OpenCode and its configured model providers |
| **Pi**          | Pi and its configured model providers       |
| **Devin**       | Devin CLI                                   |

### 5. Isolated parallel work

Managed worktrees provide a boundary for parallel changes. Handoffs preserve project context when a task needs to continue with another provider or toolchain.

- Run work in a local checkout or an isolated managed worktree
- Keep parallel threads from modifying the same checkout unintentionally
- Hand off a task without losing its project context
- Review the resulting diff before it leaves the workspace

### 6. Automations and external MCP

Automations support recurring agent runs and keep their outcomes attached to projects and threads. External MCP integrations provide scoped, user-approved access for other local clients.

See [External MCP integrations](./docs/external-mcp.md) for setup, pairing, project access, and permission boundaries.

### 7. Appearance and workspace preferences

Configure the shell to match the way you work with light and dark themes, typography controls, density preferences, and workspace settings.

<p align="center">
  <img src="./assets/prod/readme-appearance-dark.png" width="900" alt="Synara Appearance settings with theme, typography, and density controls">
</p>

### Additional capabilities

| Workflow          | Included surfaces                                               |
| ----------------- | --------------------------------------------------------------- |
| **Workspace**     | Local projects, chats, history, and multiple provider runtimes. |
| **Execution**     | Terminals, browser previews, files, and editor.                 |
| **Delivery**      | Diffs, Git actions, managed worktrees, and pull requests.       |
| **Orchestration** | Provider handoffs, automations, and scoped external MCP.        |
| **Development**   | Desktop shell plus focused server and web modes.                |

## Installation

### Desktop application

Installers will be made available on [trysynara.com](https://www.trysynara.com/) and [GitHub Releases](https://github.com/kartikkabadi/synara-beta/releases).

Current native release targets are Windows x64, macOS Intel, macOS Apple Silicon, and Linux x64.

### Provider setup

Synara Beta uses the provider installations and subscriptions already configured on the local machine. Install and authenticate the runtime you intend to use before starting a session. For Codex sessions, follow the [Codex CLI setup](https://github.com/openai/codex).

### Run from source

The development checkout uses [Bun 1.3.12](https://bun.sh/) and [Node.js 24.13.1](https://nodejs.org/).

```console
git clone https://github.com/kartikkabadi/synara-beta.git
cd synara-beta
bun install
bun run dev
```

## Contributing & Feedback

Bug fixes, reliability improvements, performance work, and feedback on new Beta features are welcome.

For a reproducible problem, [open an issue](https://github.com/kartikkabadi/synara-beta/issues/new) with the Synara Beta version, operating system, runtime, and relevant logs.

## License

Synara is licensed under the [MIT License](./LICENSE).
