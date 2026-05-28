# Integraded Workspace

**Integraded Workspace** is a desktop application that provides an integrated multi-agent development environment. It allows you to run multiple AI coding agent terminals side by side, orchestrate them through a central AI chat, browse local web servers in an embedded browser, edit files with inline diffing, and track workspace changes in real time.

Built with [Tauri v2](https://v2.tauri.app), React 19, TypeScript, and Rust.

---

## Features

- **Multi-Agent Terminal Grid** -- Run up to 16 simultaneous terminal sessions (Shell, Claude CLI, opencode.ai, Codex CLI, Antigravity CLI). Drag to reorder, resize the grid freely.
- **AI Orchestrator Chat** -- An orchestrator agent that parses your requests and dispatches sub-tasks across available CLI agents. Monitors output, detects prompts, summarizes completions.
- **Multi-LLM Support** -- Connect to OpenAI, Anthropic, DeepSeek, Mistral, Google Gemini, Grok, Together AI, OpenRouter, Ollama Cloud, LM Studio, and Ollama. API keys are encrypted at rest.
- **Integrated Browser** -- Browse localhost dev servers inside the app. Device presets (responsive, desktop, iPhone, Android, tablet), element picker, region selector. Send visual selections to chat as SVG.
- **File Explorer & Code Editor** -- Sidebar file tree with drag-and-drop, context menus. Built-in code editor with syntax highlighting (JS, TS, JSON, HTML, CSS, XML), search/replace, and diff view.
- **Real-Time Change Detection** -- Scans the workspace every 2.5 seconds comparing file contents to a baseline snapshot. Highlights new and modified files with inline LCS diffs.
- **Persistent Chat History** -- Chat sessions are saved to `~/chat-history/` with full history management.

---

## Technology Stack

| Component | Technology |
|-----------|-----------|
| Desktop Framework | Tauri v2 (Rust) |
| Frontend | React 19, TypeScript 5.8 |
| Build Tool | Vite 7 |
| Terminal Emulator | xterm.js 6 |
| PTY Backend | portable-pty 0.8 (Rust) |
| Icons | Boxicons 2.1.4 |

---

## Prerequisites

- **Node.js** 18 or later
- **Rust** (install via [rustup.rs](https://rustup.rs))
- **Tauri system dependencies**:
  - Windows 10+ (WebView2 is built in)
  - macOS: Xcode Command Line Tools
  - Linux: WebKitGTK, libappindicator, and others (see [Tauri docs](https://v2.tauri.app/start/prerequisites/))

---

## Quick Start

```bash
# Clone the repository
git clone https://github.com/S1ntr/integraded-workspace.git
cd integraded-workspace

# Install frontend dependencies
npm install

# Run in development mode (hot-reload)
npm run tauri dev
```

The Vite dev server starts on `http://localhost:1420`. Tauri launches a native window pointing to it.

---

## Build for Production

```bash
npm run tauri build
```

The bundled application will be placed in `src-tauri/target/release/bundle/`.

---

## Project Structure

```
integraded-workspace/
├── public/                  # Static assets (logos, icons)
├── src/                     # Frontend (React + TypeScript)
│   ├── components/
│   │   ├── Onboarding.tsx          # Workspace configuration screen
│   │   ├── WorkspaceLayout.tsx     # Main app shell
│   │   ├── Sidebar.tsx             # File explorer tree
│   │   ├── ChatPanel.tsx           # AI orchestrator chat UI
│   │   ├── TerminalGrid.tsx        # Resizable terminal grid
│   │   ├── TerminalPanel.tsx       # xterm.js PTY terminal
│   │   ├── BrowserOverlay.tsx      # Embedded browser overlay
│   │   ├── ChangesViewer.tsx       # File changes list with diffs
│   │   ├── FileViewerDialog.tsx    # Code editor modal
│   │   ├── SettingsDialog.tsx      # API keys & settings
│   │   └── Notification.tsx        # Toast notification system
│   ├── types/
│   │   └── browser.ts              # Browser & chat types
│   ├── assets/                     # Images, SVGs
│   ├── App.tsx                     # Root component
│   ├── main.tsx                    # Entry point
│   └── index.css                   # Complete design system
├── src-tauri/               # Backend (Rust)
│   ├── src/
│   │   ├── main.rs                 # Entry point
│   │   └── lib.rs                  # PTY, file system, config, webview
│   ├── capabilities/
│   │   └── default.json            # IPC permissions
│   ├── icons/                      # Application icons
│   ├── Cargo.toml                  # Rust dependencies
│   └── tauri.conf.json             # Tauri configuration
├── package.json             # npm dependencies & scripts
├── vite.config.ts           # Vite configuration
├── tsconfig.json            # TypeScript configuration
└── pnpm-workspace.yaml      # pnpm workspace config
```

---

## Configuration

The main application configuration is in `src-tauri/tauri.conf.json`:

- **Product name**: Integraded Workspace
- **Version**: 0.1.0
- **Identifier**: com.ondra.integraded-workspace
- **Default window**: 1280 x 850, min 800 x 560
- **Dev server**: http://localhost:1420

API keys and provider settings are managed through the in-app Settings dialog and stored encrypted on disk.

---

## License

This project is licensed under the MIT License. See [LICENSE](./LICENSE) for details.

**Disclaimer:** This software is provided "as is", without warranty of any kind. The authors are not responsible for any misuse, damages, or consequences arising from the use of this software. Users are expected to comply with all applicable laws and the terms of service of any third-party services (e.g., OpenAI, Anthropic, etc.) accessed through this application. The project is intended for legitimate development and educational purposes only.

---

## Contributing

Contributions are welcome. Feel free to open issues or submit pull requests on GitHub.

---

## Author

**Ondrej (S1ntr)** -- [GitHub](https://github.com/S1ntr)
