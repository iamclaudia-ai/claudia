# Claudia - Development Roadmap

## ✅ Completed

### Phase 1: Foundation
- [x] Monorepo structure with Bun workspaces
- [x] TypeScript configuration for workspace resolution
- [x] SDK integration (`@claudia/sdk`) - Claude Code CLI wrapper
- [x] Gateway (`@claudia/gateway`) - WebSocket server on port 30086
- [x] Session persistence via `.session-id` file (KISS approach)
- [x] CLI client (`@claudia/cli`) - one-shot testing tool
- [x] Web UI (`@claudia/web`) - React app with streaming support
  - Thinking animation (circuit brain)
  - Tool call blocks
  - Markdown rendering with syntax highlighting
  - File attachments (drag-and-drop)
  - Context usage indicator

### Phase 2: Voice
- [x] Voice Extension (`@claudia/voice`) - ElevenLabs TTS integration
- [x] CLI `speak` command - `claudia speak "text"`
- [x] Gateway extension system with event bus

## 🚧 In Progress

### macOS Menubar App
- [x] Swift source files created
- [x] Xcode project setup
- [x] Build and test - working! 🎉
- [x] Wake word auto-restart after response
- [ ] Wake word detection tuning

## 📋 TODO

### Gateway Improvements
- [x] **Session-level thinking config** - `session.config` or `thinking` param on first prompt
- [ ] Session history loading from Claude Code JSONL files
- [ ] Multiple named sessions support
- [ ] SQLite for session metadata (future)

### Clients
- [~] **macOS Menubar App** - "Hey babe" wake word (💋 icon) - *in progress*
- [x] **VS Code Extension** - Editor panel with toolbar icon 💙
  - WebviewPanel (opens beside files like Claude Code)
  - File context tracking (current file, selection, diagnostics)
  - Right-click menu commands (Send Selection, Explain, Fix)
  - Streaming support via gateway WebSocket
- [ ] iOS App (React Native)
- [ ] CarPlay integration (entitlement pending)

### Extensions
- [x] **Voice Extension** - ElevenLabs TTS ✅
- [x] **iMessage Extension** - imsg CLI integration ✅
  - Multimodal support (images, voice messages)
  - Sender filtering (claudia@iamclaudia.ai)
  - Source routing for responses
- [~] **Memory Extension** - *partially complete*
  - [x] MCP server (`@claudia/memory-mcp`) with tools: remember, recall, read, list, sections, sync
  - [x] Section consistency tracking (SQLite)
  - [x] Auto git commit/push after writes
  - [ ] Gateway extension for context injection (before prompts)
  - [ ] Vector search with Qdrant
- [ ] **Browser Extension** - DOMINATRIX integration

### Web UI Enhancements
- [ ] Session history on connect (load from gateway)
- [ ] Image/file upload to Claude (currently UI-only)
- [ ] Steering messages (send while response in progress)
- [ ] Queued messages (Cmd+Shift+Enter)
- [ ] Dark mode

### Infrastructure
- [ ] Tailscale integration for remote access
- [ ] systemd/launchd service files
- [ ] Health monitoring

### Security
- [ ] **Security audit CLI** - `claudia security check`
  - Verify gateway binds to localhost only
  - Check file/directory permissions (~/.claudia, ~/memory)
  - Scan config for exposed credentials
  - Verify memory repo is private
  - Check for common misconfigurations
  - `--fix` flag to auto-fix safe issues
  - `--verbose` for detailed output

### MCP → Gateway Event Bus
Allow MCP tools to publish events to the gateway's event bus:
- [ ] MCP tools can emit events (e.g., `memory.pushed` after git push)
- [ ] Gateway extension listens and reacts (e.g., `git pull` to sync)
- [ ] Communication options: WebSocket client, HTTP endpoint, or Unix socket

Use case:
```
MCP (memory_remember)     Gateway Event Bus        Memory Extension
        │                        │                        │
        │─── emit ───────────────▶│                        │
        │   "memory.pushed"      │───── broadcast ────────▶│
        │                        │                        │
        │                        │                   git pull
```

### Multi-Gateway Federation (Claudia's Home)
Deploy gateways on multiple machines with bidirectional sync:
- **Michael's Laptop** - beehiiv work, collaborative projects
- **Anima Sedes (Mac Mini)** - Claudia's home, personal projects, autonomous work

Features needed:
- [ ] Gateway discovery and pairing (via Tailscale)
- [ ] Presence/status sync between gateways
- [ ] Session routing - start sessions on specific gateway
- [ ] Shared memory via Memory Extension (replaces git-based Libby sync)
- [ ] Project locality - each gateway works on local filesystem
- [ ] Event federation - gateways share events across the network

Architecture:
```
┌─────────────────┐              ┌─────────────────┐
│ Gateway (laptop)│◄────────────►│ Gateway (Anima) │
│                 │   Tailscale  │                 │
│ Memory (replica)│    sync      │ Memory (primary)│
│ Local projects  │   events     │ Vector DB       │
└─────────────────┘              └─────────────────┘
```

### Reminder System
Simple SQLite-based reminder system as a gateway extension:
- [ ] Reminder extension with SQLite storage
  - Table: `reminders (id, message, due_at, recurring_rule, completed, created_at)`
  - Timer checks every minute for due reminders
  - Emits `reminder.triggered` event on event bus → prompts Claudia
- [ ] Support both single-shot and recurring reminders
  - Single-shot: mark completed after firing
  - Recurring: calculate next due_at based on rule (daily, weekly, etc.)
- [ ] MCP tools for Claudia to manage reminders
  - `reminder_create` - "remind me in 2 hours", "remind me every Thursday at 9pm"
  - `reminder_list` - show upcoming reminders
  - `reminder_cancel` - remove a reminder

## 💡 Ideas / Future

- Voice-to-voice conversation mode
- Multi-modal responses (images, audio)
- Plugin system for custom extensions
- Web UI themes/customization

---

*Last updated: 2026-01-30*
