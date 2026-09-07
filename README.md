> [!WARNING]
> **Synara Beta is not ready.** This repository is an early development preview: expect breaking changes, incomplete features, and instability. Do not use it for anything important yet.

<div align="center">
  <img src="./assets/prod/logo.svg" width="112" alt="Synara Beta logo">
  <h1>Synara Beta</h1>
  <p><strong>The fast-iteration preview channel for Synara.</strong></p>
  <p>
    A native multi-agent GUI for coding models. Build, test, and orchestrate with Codex, Claude Code, Cursor, Antigravity, and your local AI runtimes.
  </p>
  <p>
    <a href="https://www.trysynara.com/">Website</a>
    &nbsp;·&nbsp;
    <a href="https://www.trysynara.com/docs">Documentation</a>
    &nbsp;·&nbsp;
    <a href="./docs/external-mcp.md">MCP Integration</a>
    &nbsp;·&nbsp;
    <a href="https://github.com/kartikkabadi/synara-beta/releases">Releases</a>
    &nbsp;·&nbsp;
    <a href="https://github.com/kartikkabadi/synara-beta/issues/new">Report an Issue</a>
  </p>
</div>

> [!TIP]
> **Coexistence with Synara Stable**
> Synara Beta is engineered to run seamlessly side-by-side with Synara Stable on the same machine. It uses an isolated data directory (`~/.synara-beta`), separate ports, and a dedicated bundle identifier (`com.emanueledipietro.synara.beta`) to guarantee zero config collisions or session overwrites.

<p align="center">
  <img src="./assets/prod/readme-hero-light.png" alt="Synara Beta Desktop Interface" width="100%">
</p>

---

## Overview

Synara Beta is the active preview channel of **Synara** — an open-source, multi-agent desktop GUI designed for developers orchestrating local coding models.

Instead of locking you into proprietary cloud proxies or web chat wrappers, Synara connects directly to the coding agent runtimes already installed and authenticated on your machine. Synara Beta delivers early access to experimental provider runtimes, high-throughput streaming optimizations, and cutting-edge workflow tooling before they graduate to the Stable release.

---

## Core Capabilities

### 1. Multi-Agent Provider Runtime

Synara Beta brings every local agent into a unified, focused workspace. Switch models on the fly, run different agents on different tasks, and harness your existing subscriptions directly.

<p align="center">
  <picture>
    <img src="./assets/prod/readme-provider-runtime.png" alt="Synara provider picker with Codex, Claude, Cursor, Antigravity, Grok, Droid, OpenCode, Pi, and Devin" width="100%">
  </picture>
</p>

| Runtime                | Integration Mechanism                                 | Key Strengths                                             |
| :--------------------- | :---------------------------------------------------- | :-------------------------------------------------------- |
| **OpenAI Codex**       | Native CLI / `codex app-server` (JSON-RPC over stdio) | High-reasoning agentic turns, structured diff proposals   |
| **Anthropic Claude**   | Claude Code CLI integration                           | Rapid tool use, deep refactoring, architectural planning  |
| **Cursor**             | Cursor Agent Runtime                                  | Deep codebase indexing, inline file edits                 |
| **Google Antigravity** | Antigravity CLI                                       | Multimodal workflows, tool execution, agent orchestration |
| **xAI Grok**           | Grok Build runtime                                    | Accelerated reasoning, rapid iterative development        |
| **Factory Droid**      | Factory Droid CLI                                     | Autonomous developer workflows and spec enforcement       |
| **OpenCode & Pi**      | Local & Open-Source LLMs                              | Self-hosted models via Ollama, vLLM, or custom endpoints  |
| **Devin**              | Devin CLI integration                                 | Autonomous multi-step software engineering workflows      |

---

### 2. Unified Workspace & Thread Orchestration

Keep the active conversation directly alongside the surfaces it modifies. Projects define the workspace context, while threads preserve task-specific history, environment state, and live execution diffs.

<p align="center">
  <img src="./assets/prod/readme-workspace-light.png" alt="Synara Multi-Agent Workspace" width="100%">
</p>

- **Project-Aware Context:** Seamlessly navigate between repositories and track related tasks without mixing uncommitted files.
- **Provider & Model Selection:** Choose the ideal provider runtime per task based on complexity and speed.
- **Persistent Goals:** Attach explicit multi-turn objectives with pause/resume, achievement history, and bounded autonomous continuation.

---

### 3. Dual-Thread Split Views & Live Previews

Compare model responses, run parallel investigations, or tackle front-end and back-end tasks simultaneously. Synara’s split-view system lets you pin and control two active agent threads side-by-side with independent context, tokens, and controls.

- **Side-by-Side Comparison:** Evaluate how different models approach the same architectural challenge.
- **Dual Working Panes:** Inspect diffs in one pane while interacting with an agent prompt in the other.
- **Mobile & Device Simulators:** Place live iOS Simulator or Android device previews directly beside running agent threads.

---

### 4. Integrated Browser & WebMCP Execution

Never context-switch to test web apps. Synara embeds a full Chromium-based browser right next to your agent thread.

- **Live Local Previews:** Preview `http://localhost:3000` or local dev servers with automatic hot-reload.
- **WebMCP Tooling:** Agents can inspect the DOM, interact with buttons and forms, take screenshots, and invoke semantic or page-declared WebMCP actions.
- **Visual Feedback Loop:** Agents verify their own UI changes before marking tasks complete.

---

### 5. Seamless Cross-Agent Handoffs

Stuck on a tricky bug or want a second opinion? Pass active work between models with a single click.

Synara's handoff engine carries over conversation history, active project context, and uncommitted diffs to the target agent runtime without manual copying or re-prompting. Start an architectural plan with Claude, execute heavy edits with Codex, and review with Cursor.

---

### 6. Isolated Git Worktrees & Branch Management

Avoid dirty working trees and merge conflicts when running multiple concurrent tasks.

- **Managed Worktrees:** Spin up isolated, throwaway Git worktrees per thread so parallel agents can edit the same repository without colliding.
- **Full Review Surface:** Review diffs, stage files, discard hunks, and commit changes directly from the UI.
- **One-Click GitHub Integration:** Branch, push, and open pull requests right from your thread.

---

### 7. Appearance & Workspace Preferences

Tailor the environment to your setup and aesthetic preferences.

- **Themes:** Dark, Light, Synara, and Codex presets with high-contrast accessibility toggles.
- **Typography:** Custom UI and monospace coding fonts (e.g. JetBrains Mono, Inter, Fira Code).
- **Layout Ergonomics:** Adjustable density modes, translucent glass sidebars, and customizable keybindings.

---

## Workspace Architecture

Synara organizes your workflows into clear, modular layers:

| Layer                  | Purpose                                                                     |
| :--------------------- | :-------------------------------------------------------------------------- |
| **Project**            | Repository context, configuration, and workspace-level settings.            |
| **Thread**             | Task-specific conversation, ephemeral state, files, and transcript history. |
| **Provider Session**   | The local, authenticated coding-agent process executing the instructions.   |
| **Execution Surfaces** | Diff review, embedded terminal, Chromium browser, file tree, and Git tools. |

---

## Installation

### Fast one-line terminal install

Install Synara Beta with one verified, release-pinned command for your operating system:

**macOS (Apple Silicon & Intel)**

```bash
t=$(curl -fsSL "https://api.github.com/repos/kartikkabadi/synara-beta/releases?per_page=100" | grep '"tag_name"' | sed -n 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+-beta\.[0-9]+$' | head -1); if [ -z "$t" ]; then echo "Could not resolve the latest Synara Beta release." >&2; (exit 1); else f=$(mktemp /tmp/synara-beta-install.XXXXXX) && curl -fsSL -o "$f" "https://raw.githubusercontent.com/kartikkabadi/synara-beta/$t/scripts/install-macos.sh" && bash "$f" --tag "$t"; rc=$?; rm -f "${f:-/tmp/synara-beta-install-none}"; (exit $rc); fi
```

**Linux (x86_64)**

```bash
t=$(curl -fsSL "https://api.github.com/repos/kartikkabadi/synara-beta/releases?per_page=100" | grep '"tag_name"' | sed -n 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+-beta\.[0-9]+$' | head -1); if [ -z "$t" ]; then echo "Could not resolve the latest Synara Beta release." >&2; (exit 1); else f=$(mktemp /tmp/synara-beta-install.XXXXXX) && curl -fsSL -o "$f" "https://raw.githubusercontent.com/kartikkabadi/synara-beta/$t/scripts/install-linux.sh" && bash "$f" --tag "$t"; rc=$?; rm -f "${f:-/tmp/synara-beta-install-none}"; (exit $rc); fi
```

**Windows (PowerShell)**

```powershell
$t = ((Invoke-RestMethod "https://api.github.com/repos/kartikkabadi/synara-beta/releases?per_page=100" -UseBasicParsing -ErrorAction Stop) | Where-Object { $_.tag_name -match '^v\d+\.\d+\.\d+-beta\.\d+$' } | Select-Object -First 1).tag_name; if ($t) { $f = Join-Path $env:TEMP $("synara-beta-install-$([Guid]::NewGuid()).ps1"); Invoke-WebRequest "https://raw.githubusercontent.com/kartikkabadi/synara-beta/$t/scripts/install-windows.ps1" -UseBasicParsing -OutFile $f -ErrorAction Stop; Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force; Unblock-File -Path $f; try { & $f -Tag $t } finally { Remove-Item $f -Force -ErrorAction SilentlyContinue } } else { throw "Could not resolve the latest Synara Beta release." }
```

For more options and script details, see the [Installation Guide](./docs/install.md).

### Desktop application downloads

Direct installer downloads will be available on [trysynara.com](https://www.trysynara.com/) and [GitHub Releases](https://github.com/kartikkabadi/synara-beta/releases).

Supported native platforms:

- **macOS:** Apple Silicon (`arm64`) & Intel (`x64`)
- **Windows:** x64
- **Linux:** x64 and arm64 (`.AppImage`)

#### Linux AppImage troubleshooting

Choose the asset that matches `uname -m`: `x86_64` uses the x64 AppImage and
`aarch64` uses the arm64 AppImage. The normal AppImage launch path requires
FUSE support; on Arch-based systems, install the `fuse2` package if it is
missing.

If FUSE is unavailable, run the AppImage in extraction mode:

```bash
chmod +x Synara-*-x86_64.AppImage
./Synara-*-x86_64.AppImage --appimage-extract-and-run
```

For nested VMs using Wayland, add Electron compatibility flags when needed:

```bash
./Synara-*-x86_64.AppImage \
  --appimage-extract-and-run \
  --no-sandbox \
  --disable-gpu \
  --ozone-platform=x11
```

### Running from Source

You can build and run Synara Beta locally using [Bun](https://bun.sh/) and [Node.js](https://nodejs.org/).

#### Prerequisites

- [Bun](https://bun.sh/) (v1.4.2 or newer)
- [Node.js](https://nodejs.org/) (v24.13.1 or newer recommended)
- [Git](https://git-scm.com/)
- Install and authenticate the agent runtime you intend to use before starting a session. For Codex sessions, follow the [Codex CLI setup](https://github.com/openai/codex).

```bash
# 1. Clone the repository
git clone https://github.com/kartikkabadi/synara-beta.git
cd synara-beta

# 2. Install workspace dependencies
bun install

# 3. Start the local development server (Web + Server)
bun run dev
```

To launch the native desktop shell during development:

```bash
bun run dev:desktop
```

`bun run typecheck` checks all seven workspaces with TypeScript 7 and the native
Effect checker. CI and each workspace's `typecheck` script use the same compiler.
`bun run typecheck:native` remains an alias for the default check.

The native Effect checker does not enforce every legacy rule: in particular,
`importFromBarrel` errors are currently missed. `bun run typecheck:legacy` keeps
the TypeScript 5 check available for explicit comparisons; it is not run by CI.
The existing compiler also remains installed for build and declaration tools
that require its JavaScript API. Native and legacy checks use separate caches.

Use these named scripts rather than a bare `tsc`, whose version depends on the
current directory. Normal installation patches the native compiler for Effect;
the root `typecheck` command also ensures that patch is applied before checking.

---

## Repository Structure

```text
synara-beta/
│   ├── desktop/          # Electron desktop application & native OS bridges
│   ├── marketing/        # Next.js marketing site and documentation
│   ├── server/           # Node.js WebSocket backend managing agent stdio runtimes
│   └── web/              # React 19 + Vite web interface and transcript streamer
├── packages/
│   ├── contracts/        # Shared Effect/Schema contracts and WebSocket protocol types
│   └── shared/           # Cross-package runtime utilities, git helpers, and diff logic
├── docs/                 # In-depth architectural guides and protocol specs
└── assets/               # Branding assets, vector icons, and screenshots
```

---

## External MCP Integration

Synara Beta includes a built-in Model Context Protocol (MCP) server, allowing external agent clients (such as Claude Desktop, Cursor, or external scripts) to securely interact with your active Synara projects, threads, and workspace tools.

For setup instructions and permission scopes, see [External MCP Documentation](./docs/external-mcp.md).

---

## Contributing & Community

Contributions, bug reports, and suggestions are warmly welcomed!

- **Found a bug?** [Open an issue](https://github.com/kartikkabadi/synara-beta/issues/new) with the Synara Beta version, operating system, agent runtime, and reproduction steps.
- **Want to contribute?** Feel free to submit a pull request against `main` — see [CONTRIBUTING.md](./CONTRIBUTING.md). Please ensure `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test` pass.
- **Stay updated:** Follow developments at [trysynara.com](https://www.trysynara.com/).

---

## License

Synara Beta is open-source software licensed under the [MIT License](./LICENSE).
