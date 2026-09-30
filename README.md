# Muse CLI Agent (`muse-ts`)

A native TypeScript CLI coding assistant supporting Meta Device Flow, Agent TUI, Headless exec, and JSON-RPC bridging. 

Built entirely OS-free, it relies exclusively on standard Node.js libraries, replacing the legacy Rust binaries while delivering a flawless, memory-safe execution architecture specifically optimized for Android Termux / Low-Memory Killer (LMK) environments.

## Features

- **Interactive TUI**: A rich CLI interface utilizing `inquirer` and `chalk`.
- **Headless Orchestration**: Native `exec` loops parity for external AI Swarms and sub-agents.
- **NodeOS / Leviathan Bridge**: Supports JSONL stdio integration (`watch`, `serve`, `bridge`).
- **Memory Safety (LMK)**: CWD-bound `tmp.json` serialization protects conversational state against unexpected Android OS kills.
- **Official Legacy Safety**: Integrates natively with `~/.config/muse/settings.json`, enforcing `bwrap` sandboxes and preventing infinite loop hallucinations.

## Installation

```bash
npm install -g muse-cli-agent
```

## Usage

**Interactive TUI:**
```bash
muse-ts
```

**Headless Mode:**
```bash
muse-ts exec --json "Refactor the authentication logic."
```

**Live Dashboard Stream:**
```bash
muse-ts watch
```

## Setup & Login
Authentication leverages Meta's Device Flow (`api.meta.ai`).
```bash
muse-ts login
```
