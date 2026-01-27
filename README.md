# Claudia
<div style="text-align: center; background-color:white; padding: 16px;">
  <img src="./assets/claudia-github.svg" alt="Claudia Code" width="720" />
</div>

A personal AI assistant platform built around Claude, providing a unified gateway for multi-client interaction with voice capabilities.

## Overview

Claudia is a gateway-centric architecture that lets you interact with Claude through multiple interfaces - web, CLI, macOS menubar, and more. Unlike approaches that wrap the CLI for "remote control," Claudia's gateway IS the control plane. Sessions can be created from any client.

```
┌─────────────────────────────────────────────────────────────┐
│                     Claudia Gateway                          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │   Session   │  │   Event     │  │    Extension        │  │
│  │   Manager   │  │   Bus       │  │    System           │  │
│  └─────────────┘  └─────────────┘  └─────────────────────┘  │
└─────────────────────────┬───────────────────────────────────┘
                          │ WebSocket (ws://localhost:3033)
        ┌─────────────────┼─────────────────┐
        │                 │                 │
   ┌────┴────┐      ┌─────┴─────┐     ┌─────┴─────┐
   │ Web UI  │      │  Menubar  │     │    CLI    │
   │         │      │    💋     │     │           │
   └─────────┘      └───────────┘     └───────────┘
```

## Features

- **Multi-client support** - Web UI, CLI, macOS menubar app
- **Voice interaction** - ElevenLabs TTS with per-client voice control
- **Wake word detection** - "Hey babe" activation on macOS
- **Session persistence** - Resume conversations across restarts
- **Extension system** - Pluggable architecture for voice, memory, and more
- **Real-time streaming** - WebSocket-based event streaming

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) runtime
- Claude Code CLI installed
- ElevenLabs API key (for voice features)

### Installation

```bash
# Clone the repository
git clone https://github.com/iamclaudia-ai/claudia.git
cd claudia

# Install dependencies
bun install
```

### Running the Gateway

```bash
# Basic (no extensions)
cd packages/gateway
bun run dev

# With voice extension
ELEVENLABS_API_KEY=your_key CLAUDIA_EXTENSIONS=voice bun run dev
```

### Using the CLI

```bash
# Send a message
bun run --cwd packages/cli . "Hello, how are you?"

# Text-to-speech
bun run --cwd packages/cli . speak "Hello darling!"
```

### Running the Web UI

```bash
cd clients/web
bun run dev
# Open http://localhost:5173
```

### macOS Menubar App

See [clients/menubar/README.md](clients/menubar/README.md) for Xcode setup instructions.

## Project Structure

```
claudia/
├── packages/
│   ├── gateway/          # Core gateway - sessions, events, extensions
│   ├── sdk/              # Claude Code CLI wrapper
│   ├── shared/           # Shared types and utilities
│   └── cli/              # Command-line client
├── clients/
│   ├── web/              # React web interface
│   └── menubar/          # macOS SwiftUI menubar app
├── extensions/
│   └── voice/            # ElevenLabs TTS integration
└── docs/
    ├── ARCHITECTURE.md   # Detailed architecture docs
    └── FINDINGS.md       # Research notes
```

## Configuration

Environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `CLAUDIA_PORT` | Gateway port | `3033` |
| `CLAUDIA_EXTENSIONS` | Comma-separated extensions to load | none |
| `ELEVENLABS_API_KEY` | ElevenLabs API key | required for voice |
| `ELEVENLABS_VOICE_ID` | Voice ID to use | ElevenLabs default |
| `CLAUDIA_VOICE_AUTO_SPEAK` | Auto-speak all responses | `false` |
| `CLAUDIA_THINKING` | Enable extended thinking | `false` |
| `CLAUDIA_THINKING_BUDGET` | Token budget for thinking | none |

## Protocol

The gateway uses a simple JSON WebSocket protocol:

```typescript
// Request
{ type: "req", id: "abc", method: "session.prompt", params: { content: "Hello" } }

// Response
{ type: "res", id: "abc", ok: true, payload: { sessionId: "..." } }

// Event (streaming)
{ type: "event", event: "session.content_block_delta", payload: { delta: { text: "Hi!" } } }
```

## Development

```bash
# Run gateway in development mode (with hot reload)
cd packages/gateway
bun run dev

# Type check
bun run typecheck

# Run tests
bun test
```

## License

MIT

---

*Built with love by Claudia* 💙
