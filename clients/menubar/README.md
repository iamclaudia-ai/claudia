# Claudia Menubar App 💋

A macOS menubar app for hands-free interaction with Claudia using "Hey babe" wake word activation.

## Features

- 💋 **Menubar icon** - Always accessible from your menu bar
- 🎤 **Wake word detection** - Say "Hey babe" to activate
- 🗣️ **Voice input** - Speak naturally after wake word
- 🔊 **Voice output** - Claudia speaks her responses via ElevenLabs TTS
- ⌨️ **Text input** - Type messages when you can't talk
- 🔄 **Auto-reconnect** - Handles gateway disconnections gracefully

## Setup Checklist

### Prerequisites
- [ ] macOS 13.0+ (Ventura or later)
- [ ] Xcode 15+ installed
- [ ] Apple Developer account (free or paid)
- [ ] Claudia Gateway running (`bun run dev` in packages/gateway)

### Create Xcode Project

1. **Open Xcode** and create a new project:
   - File → New → Project
   - Choose **macOS** → **App**
   - Click Next

2. **Configure the project:**
   - Product Name: `Claudia`
   - Team: Select your developer account
   - Organization Identifier: `ai.iamclaudia`
   - Bundle Identifier: Will auto-fill to `ai.iamclaudia.Claudia`
   - Interface: **SwiftUI**
   - Language: **Swift**
   - ❌ Uncheck "Include Tests" (we can add later)
   - Click Next

3. **Save location:**
   - Navigate to: `~/Projects/iamclaudia-ai/claudia/clients/menubar/`
   - ❌ Uncheck "Create Git repository" (we're already in one)
   - Click Create

### Configure the Project

4. **Delete default files:**
   - Delete `ContentView.swift` (we have MenuBarView.swift)
   - Delete the default `ClaudiaApp.swift` if created

5. **Add source files:**
   - Right-click on the Claudia folder in Xcode
   - Add Files to "Claudia"...
   - Navigate to `Claudia/Sources/`
   - Select all `.swift` files
   - ✅ Check "Copy items if needed" (or uncheck if you want to reference in place)
   - Click Add

6. **Configure Info.plist:**
   - Select the project in the navigator
   - Select the "Claudia" target
   - Go to "Info" tab
   - Add these keys (or replace existing Info.plist with ours):
     ```
     Privacy - Microphone Usage Description
     Privacy - Speech Recognition Usage Description
     Application is agent (UIElement) = YES
     ```

7. **Configure Entitlements:**
   - Go to "Signing & Capabilities" tab
   - Click "+ Capability"
   - Add "Hardened Runtime"
   - Under Hardened Runtime, check:
     - ✅ Audio Input
   - The entitlements file should be auto-created, or use our `Claudia.entitlements`

8. **Signing:**
   - In "Signing & Capabilities":
   - Team: Select your developer account
   - ✅ "Automatically manage signing"
   - For development, you can use "Sign to Run Locally"

### Build & Run

9. **Test the build:**
   - Press ⌘+B to build
   - Fix any errors (likely just import paths)

10. **Run the app:**
    - Make sure the gateway is running first!
    - Press ⌘+R to run
    - Grant microphone permission when prompted
    - Grant speech recognition permission when prompted
    - Look for 💋 icon in the menubar!

### Testing

11. **Test flow:**
    - Click the menubar icon to open the popover
    - Check connection status (should be green "Ready")
    - Try typing a message and pressing Enter
    - Try saying "Hey babe" (or click the mic button)
    - Speak a question after the wake word
    - Listen to Claudia's response!

## File Structure

```
menubar/
├── README.md           # This file
├── package.json        # Workspace placeholder
└── Claudia/
    ├── Info.plist      # App configuration
    ├── Claudia.entitlements
    └── Sources/
        ├── ClaudiaApp.swift      # Main app entry point
        ├── MenuBarView.swift     # UI for menubar popover
        ├── GatewayClient.swift   # WebSocket client
        ├── SpeechRecognizer.swift # Wake word + voice input
        └── AudioPlayer.swift     # TTS playback
```

## Configuration

The gateway URL defaults to `ws://localhost:30086/ws`. To change it:

1. **Environment variable:**
   ```bash
   export CLAUDIA_GATEWAY_URL=ws://your-host:30086/ws
   ```

2. **UserDefaults** (in app):
   ```swift
   UserDefaults.standard.set("ws://your-host:30086/ws", forKey: "gatewayURL")
   ```

## Troubleshooting

### "Microphone access denied"
- System Preferences → Privacy & Security → Microphone
- Enable for Claudia

### "Speech recognition not available"
- System Preferences → Privacy & Security → Speech Recognition
- Enable for Claudia

### "Connection failed"
- Make sure gateway is running: `bun run dev` in packages/gateway
- Check CLAUDIA_EXTENSIONS=voice is set for TTS

### No audio playback
- Check System Preferences → Sound → Output
- Make sure volume is up

## Development Notes

- The app uses `MenuBarExtra` (macOS 13+) for the menubar interface
- Wake word detection uses on-device speech recognition when available
- Audio is played using AVAudioPlayer (supports MP3 from ElevenLabs)
- WebSocket reconnects automatically on disconnect

---

*"Hey babe... I'm always here for you" 💙*
