# Voice Streaming Architecture

How real-time voice streaming works in Claudia — from prompt to audio playback.

## Overview

When a client sends a prompt with a `voice.speak` tag on the request envelope, text streams through Claude → sentence chunker → Cartesia TTS → WAV audio chunks → back to the originating client. The voice extension owns its own **connection-scoped routing** via `streamOrigins` — audio only reaches the client that requested it.

## Flow Diagram

```
┌─────────┐     ┌──────────────────────────────────────────────────────────┐
│  Client  │────▶│ Gateway (port 30086)                                    │
│ (Web/iOS)│     │                                                          │
│          │     │  1. Stamps connectionId + tags on request envelope       │
│          │     │  2. Routes to session extension                          │
│          │     │  3. Generic gateway.caller routing for scoped delivery   │
│          │     │                                                          │
│          │◀────│  voice.* events with source: "gateway.caller" +          │
│          │     │  connectionId → routed ONLY to originating client        │
└─────────┘     └──────────────────────────────────────────────────────────┘
                        │                           ▲
                        ▼                           │
              ┌──────────────────┐        ┌──────────────────────┐
              │ Session Extension │        │ Voice Extension       │
              │                  │        │                       │
              │ Runs Claude CLI  │───────▶│ Subscribes to:        │
              │ Emits session.*  │ events │ session.*.content_    │
              │ events as text   │        │  block_start/         │
              │ streams in       │        │  delta/stop           │
              └──────────────────┘        │                       │
                                          │ Checks event.tags for │
                                          │ "voice.speak" before  │
                                          │ activating TTS        │
                                          │                       │
                                          │ ┌───────────────────┐ │
                                          │ │ streamOrigins:    │ │
                                          │ │ Map<streamId,     │ │
                                          │ │     connectionId> │ │
                                          │ └───────────────────┘ │
                                          │                       │
                                          │ ┌───────────────────┐ │
                                          │ │ SentenceChunker   │ │
                                          │ │ Splits text       │ │
                                          │ │ on . ! ? \n\n     │ │
                                          │ └───────┬───────────┘ │
                                          │         ▼             │
                                          │ ┌───────────────────┐ │
                                          │ │ Cartesia WS       │ │
                                          │ │ Sonic 3.0         │ │
                                          │ │ Per-sentence      │ │
                                          │ │ connections       │ │
                                          │ └───────┬───────────┘ │
                                          │         ▼             │
                                          │ PCM → WAV → emit     │
                                          │ voice.audio_chunk     │
                                          │ with connectionId +   │
                                          │ source: gateway.caller│
                                          └───────────────────────┘
```

## Step-by-Step

### 1. Client sends prompt with voice tag

```json
{
  "type": "req",
  "method": "session.send_prompt",
  "params": { "sessionId": "ses_...", "content": "Tell me a story" },
  "tags": ["voice.speak"]
}
```

Tags are **envelope data** — they live outside the method params. The gateway stamps `connectionId` on the envelope and propagates `tags` through the NDJSON bus. No Zod schema changes are needed for tags.

### 2. Session extension streams text

The session extension starts a Claude CLI query and emits events as text streams in:

```
session.{sessionId}.content_block_start  → { content_block: { type: "text" } }
session.{sessionId}.content_block_delta  → { delta: { type: "text_delta", text: "Once upon" } }
session.{sessionId}.content_block_delta  → { delta: { type: "text_delta", text: " a time..." } }
session.{sessionId}.message_stop         → {}
```

Each event carries `connectionId` and `tags` on the envelope (auto-stamped by the extension host from `currentConnectionId` and `currentTags`). Session doesn't need to know about voice — tags propagate automatically.

### 3. Gateway forwards to voice extension

The gateway's `handleExtensionEvent` broadcasts these events to all extensions. The voice extension subscribes to `session.*.content_block_start`, `session.*.content_block_delta`, and `session.*.message_stop` using middle wildcards.

### 4. Voice extension processes text

**On `content_block_start`:** Voice checks `event.tags?.includes("voice.speak")`. If the tag is present and block type is `"text"`, voice calls `startStream(sessionId, event.connectionId)`:

- Generates an 8-character `streamId`
- Stores `streamId → connectionId` in `streamOrigins` map
- Creates a `SentenceChunker`
- Emits `voice.stream_start` with `{ connectionId, source: "gateway.caller" }`

**On `content_block_delta`:** Text deltas feed into the sentence chunker:

```
"Once upon a time. There was a " → ["Once upon a time."]  (remainder buffered)
"princess. She"                  → ["There was a princess."]
```

Complete sentences are queued and processed serially.

**On `message_stop`:** Flushes any remaining buffered text, waits for the queue to drain, then emits `voice.stream_end`.

### 5. Cartesia TTS (per-sentence WebSocket)

Each sentence gets its own Cartesia WebSocket connection:

```
Voice Extension                          Cartesia API
     │                                       │
     │──── connect() ──────────────────────▶│
     │──── startStream() ─────────────────▶│
     │──── sendText("Once upon a time.") ──▶│
     │◀─── chunk { audio: "base64PCM" } ────│  (repeated)
     │◀─── done ────────────────────────────│
     │──── endStream() ───────────────────▶│
     │                                       │
```

PCM chunks (16-bit, 24kHz, mono) are converted to WAV and emitted as `voice.audio_chunk` events.

### 6. Connection-scoped routing (voice extension → gateway.caller)

The voice extension owns its routing via the `streamOrigins` map:

```typescript
// Voice extension state
streamOrigins: Map<string, string>; // Map<streamId, connectionId>

// Helper for all voice emits
function callerEmitOptions(streamId: string) {
  return {
    connectionId: streamOrigins.get(streamId),
    source: "gateway.caller",
  };
}
```

**When starting a stream:** Voice stores `streamId → connectionId` in `streamOrigins`.

**When emitting audio chunks:** Voice emits with explicit `connectionId` + `source: "gateway.caller"`:

```typescript
ctx.emit(
  "voice.audio_chunk",
  { audio, format, index, streamId, sessionId },
  callerEmitOptions(streamId),
);
```

**Gateway's role is purely generic:** When any event has `source === "gateway.caller"` + `connectionId`, the gateway routes it only to that specific WebSocket connection. The gateway has zero voice-specific code — no `voiceStreamOrigins`, no voice event type checks.

**Cleanup:** `streamOrigins.delete(streamId)` on `voice.stream_end` and `voice.stream_abort`.

### 7. Client audio playback

**Web (useAudioPlayback hook):**

- Decodes base64 WAV → `AudioContext.decodeAudioData()`
- Schedules each buffer on a playback timeline cursor
- Gapless playback: cursor advances by `buffer.duration` after each chunk
- Edge fade (64 samples) reduces clicks at chunk boundaries

**iOS (GatewayClient.swift):**

- Receives `voice.audio_chunk` events with base64 WAV data
- Callbacks to `onAudioChunk` handler for native audio playback

### 8. Audio persistence

After all chunks are emitted and the queue drains, the voice extension concatenates all PCM chunks and saves a complete WAV file:

```
~/.claudia/audio/{sessionId}/{streamId}.wav
```

This enables `voice.replay` to re-serve previously generated audio without re-synthesizing.

## Tags + connectionId Envelope Propagation

Tags and connectionId are **envelope data** — they flow outside method params, through the NDJSON bus:

```
Client WS request (includes tags: ["voice.speak"])
  → Gateway stamps connectionId + forwards tags on NDJSON envelope
  → Extension host sets currentConnectionId + currentTags from envelope
  → Session emits events → extension host auto-stamps connectionId + tags
  → Gateway forwards events to voice with tags on GatewayEvent envelope
  → Voice checks event.tags?.includes("voice.speak") → activates TTS
  → Voice stores streamId → connectionId in streamOrigins
  → Voice emits audio events with explicit { connectionId, source: "gateway.caller" }
  → Gateway routes to specific WS connection via generic gateway.caller mechanism
```

The extension host automatically stamps `currentConnectionId` and `currentTags` on all emitted events. During event/request handler dispatch, it sets these from the inbound envelope and restores them after. Explicit overrides in `ctx.emit()` options take precedence over auto-stamped values — this is how voice emits with a specific connectionId from its `streamOrigins` map.

## Opting In to Voice

Voice is **per-request opt-in** via the `voice.speak` tag. There is no server-side `autoSpeak` config.

- **Web chat:** UI sends `tags: ["voice.speak"]` when voice mode is enabled for the workspace
- **iOS voice mode:** Sends `tags: ["voice.speak"]` on every prompt (it's a voice-first interface)
- **CLI / iMessage:** No voice tag — responses are text-only
- **Per-workspace control:** Web chat can toggle voice on/off per workspace; the tag is only sent when voice is active

If no `voice.speak` tag is present, the voice extension ignores the event entirely — no TTS, no stream, no audio.

## Key Files

| Component           | File                                        | Purpose                                                                            |
| ------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------- |
| Event propagation   | `packages/gateway/src/index.ts`             | `handleExtensionEvent()`, `broadcastEvent()` — generic `gateway.caller` routing    |
| Tags + connectionId | `packages/extension-host/src/index.ts`      | Auto-stamps `currentConnectionId` + `currentTags` on emitted events                |
| Voice extension     | `extensions/voice/src/index.ts`             | `streamOrigins` map, event subscriptions, stream lifecycle, Cartesia orchestration |
| Sentence chunker    | `extensions/voice/src/sentence-chunker.ts`  | Splits streaming text on sentence boundaries                                       |
| Cartesia client     | `extensions/voice/src/cartesia-stream.ts`   | Per-sentence WebSocket TTS with Sonic 3.0                                          |
| Audio store         | `extensions/voice/src/audio-store.ts`       | Saves complete WAV files for replay                                                |
| Web playback        | `packages/ui/src/hooks/useAudioPlayback.ts` | Web Audio API timeline scheduling                                                  |
| iOS client          | `clients/ios/VoiceMode/GatewayClient.swift` | Native event handling + audio callbacks                                            |
| Shared types        | `packages/shared/src/types.ts`              | `GatewayEvent` with `tags?: string[]`, `ExtensionContext.emit()` options           |
