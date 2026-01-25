import SwiftUI

/**
 * Main menubar popover view
 */
struct MenuBarView: View {
    @EnvironmentObject var appState: AppState
    @State private var inputText = ""
    @FocusState private var isInputFocused: Bool

    var body: some View {
        VStack(spacing: 12) {
            // Header with status
            HStack {
                Text("💋 Claudia")
                    .font(.headline)
                Spacer()
                StatusIndicator(status: appState.status, isConnected: appState.isConnected)
            }
            .padding(.bottom, 4)

            // Transcript / Response display
            if !appState.lastResponse.isEmpty || !appState.lastTranscript.isEmpty {
                ScrollView {
                    VStack(alignment: .leading, spacing: 8) {
                        if !appState.lastTranscript.isEmpty {
                            HStack(alignment: .top) {
                                Text("You:")
                                    .font(.caption)
                                    .foregroundColor(.secondary)
                                Text(appState.lastTranscript)
                                    .font(.body)
                            }
                        }

                        if !appState.lastResponse.isEmpty {
                            HStack(alignment: .top) {
                                Text("💙")
                                    .font(.caption)
                                Text(appState.lastResponse)
                                    .font(.body)
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 150)
                .padding(8)
                .background(Color(NSColor.textBackgroundColor))
                .cornerRadius(8)
            }

            // Text input (alternative to voice)
            HStack {
                TextField("Type a message...", text: $inputText)
                    .textFieldStyle(.roundedBorder)
                    .focused($isInputFocused)
                    .onSubmit {
                        sendMessage()
                    }

                Button(action: sendMessage) {
                    Image(systemName: "paperplane.fill")
                }
                .disabled(inputText.isEmpty || appState.status == .processing)
            }

            // Action buttons
            HStack(spacing: 12) {
                // Voice button
                Button(action: toggleVoice) {
                    Label(
                        appState.isListening ? "Stop" : "Hey babe",
                        systemImage: appState.isListening ? "stop.fill" : "mic.fill"
                    )
                }
                .buttonStyle(.borderedProminent)
                .tint(appState.isListening ? .red : .blue)

                // Stop speaking button (when speaking)
                if appState.isSpeaking {
                    Button(action: { appState.interruptSpeaking() }) {
                        Label("Stop", systemImage: "speaker.slash.fill")
                    }
                    .buttonStyle(.bordered)
                }

                Spacer()

                // Settings menu
                Menu {
                    Toggle("Wake Word Detection", isOn: .constant(true))
                    Toggle("Auto-speak Responses", isOn: .constant(true))
                    Divider()
                    Button("Reconnect") {
                        appState.gateway.connect()
                    }
                    Divider()
                    Button("Quit Claudia") {
                        NSApplication.shared.terminate(nil)
                    }
                } label: {
                    Image(systemName: "gear")
                }
            }

            // Error display
            if let error = appState.error {
                Text(error)
                    .font(.caption)
                    .foregroundColor(.red)
                    .padding(4)
            }
        }
        .padding()
        .frame(width: 320)
        .onAppear {
            // Start wake word detection when menu opens
            if appState.status == .idle && !appState.isListening {
                appState.startWakeWordListening()
            }
        }
    }

    private func sendMessage() {
        guard !inputText.isEmpty else { return }
        appState.lastTranscript = inputText
        appState.sendTextPrompt(inputText)
        inputText = ""
    }

    private func toggleVoice() {
        if appState.isListening {
            appState.stopListening()
        } else {
            appState.status = .listening
            appState.isListening = true
            appState.speechRecognizer.startFullRecognition()
        }
    }
}

/**
 * Status indicator pill
 */
struct StatusIndicator: View {
    let status: AppStatus
    let isConnected: Bool

    var body: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(statusColor)
                .frame(width: 8, height: 8)
            Text(statusText)
                .font(.caption)
                .foregroundColor(.secondary)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(Color(NSColor.controlBackgroundColor))
        .cornerRadius(12)
    }

    var statusColor: Color {
        if !isConnected { return .gray }
        switch status {
        case .idle: return .green
        case .listening: return .blue
        case .processing: return .orange
        case .speaking: return .purple
        case .error: return .red
        }
    }

    var statusText: String {
        if !isConnected { return "Offline" }
        switch status {
        case .idle: return "Ready"
        case .listening: return "Listening..."
        case .processing: return "Thinking..."
        case .speaking: return "Speaking..."
        case .error: return "Error"
        }
    }
}

#Preview {
    MenuBarView()
        .environmentObject(AppState())
}
