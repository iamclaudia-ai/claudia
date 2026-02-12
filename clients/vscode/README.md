# Claudia VS Code Extension

Claudia AI assistant integrated directly into VS Code.

## Features

- **Sidebar Chat**: Chat with Claudia directly in the VS Code sidebar
- **File Context**: Automatically includes current file information in conversations
- **Right-Click Menu**: Send selection, explain code, or fix code with one click
- **Diagnostics Integration**: See and fix TypeScript/ESLint errors with AI assistance

## Requirements

- Claudia Gateway running locally (`ws://localhost:30086/ws`)

## Commands

| Command                      | Keybinding       | Description                                             |
| ---------------------------- | ---------------- | ------------------------------------------------------- |
| `Claudia: Open Chat`         | `Cmd+Shift+C`    | Open the Claudia chat panel                             |
| `Claudia: Send Selection`    | Right-click menu | Send selected code to Claudia                           |
| `Claudia: Explain This Code` | Right-click menu | Ask Claudia to explain the selection                    |
| `Claudia: Fix This Code`     | Right-click menu | Ask Claudia to fix the selection (includes diagnostics) |

## Configuration

| Setting                      | Default                   | Description                      |
| ---------------------------- | ------------------------- | -------------------------------- |
| `claudia.gatewayUrl`         | `ws://localhost:30086/ws` | Gateway WebSocket URL            |
| `claudia.webUiUrl`           | `http://localhost:3034`   | Web UI URL (for iframe mode)     |
| `claudia.includeFileContext` | `true`                    | Include file context in messages |

## Development

```bash
# Install dependencies
npm install

# Compile
npm run compile

# Watch mode
npm run watch

# Package for distribution
npm run package
```

## Architecture

```
┌─────────────────────────────────────────┐
│  VS Code Extension                      │
│                                         │
│  ┌─────────────┐   ┌─────────────────┐  │
│  │  Webview    │   │  Context API    │  │
│  │  (Chat UI)  │   │  (Editor state) │  │
│  └──────┬──────┘   └────────┬────────┘  │
│         │                   │           │
│         └─────────┬─────────┘           │
│                   │                     │
└───────────────────┼─────────────────────┘
                    │ WebSocket
                    ▼
┌─────────────────────────────────────────┐
│  Claudia Gateway (localhost:30086)       │
└─────────────────────────────────────────┘
```

The extension creates a webview in the sidebar that connects directly to the Claudia Gateway. It also tracks the active editor and selection, passing that context to the chat.

## Future Enhancements

- [ ] Inline code suggestions (ghost text)
- [ ] Apply edits directly from chat
- [ ] Full web UI in iframe mode
- [ ] Multi-file context
- [ ] Git integration
