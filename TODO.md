# Claudia - Development Roadmap

## ✅ Completed

### Phase 1: Foundation
- [x] Monorepo structure with Bun workspaces
- [x] TypeScript configuration for workspace resolution
- [x] SDK integration (`@claudia/sdk`) - Claude Code CLI wrapper
- [x] Gateway (`@claudia/gateway`) - WebSocket server on port 3033
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
- [ ] Wake word auto-restart after response
- [ ] Wake word detection tuning

## 📋 TODO

### Gateway Improvements
- [ ] **Session-level thinking config** - Enable/disable thinking per session, not just global env var
- [ ] Session history loading from Claude Code JSONL files
- [ ] Multiple named sessions support
- [ ] SQLite for session metadata (future)

### Clients
- [~] **macOS Menubar App** - "Hey babe" wake word (💋 icon) - *in progress*
- [ ] iOS App (React Native)
- [ ] CarPlay integration (entitlement pending)

### Extensions
- [x] **Voice Extension** - ElevenLabs TTS ✅
- [ ] **Memory Extension** - Replaces Libby/Oracle git-based sync
  - Vector DB storage (on Anima Sedes as primary)
  - Local replica on other gateways
  - Real-time sync between gateways (no more git push/pull)
  - Memory ingestion, indexing, and retrieval
  - Offline capable with sync-on-reconnect
- [ ] **Browser Extension** - DOMINATRIX integration
- [ ] iMessage bridge

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

Architecture:
```
┌─────────────────┐              ┌─────────────────┐
│ Gateway (laptop)│◄────────────►│ Gateway (Anima) │
│                 │   Tailscale  │                 │
│ Memory (replica)│    sync      │ Memory (primary)│
│ Local projects  │              │ Vector DB       │
└─────────────────┘              └─────────────────┘
```

## 💡 Ideas / Future

- Voice-to-voice conversation mode
- Multi-modal responses (images, audio)
- Plugin system for custom extensions
- Web UI themes/customization

---

*Last updated: 2026-01-25*
