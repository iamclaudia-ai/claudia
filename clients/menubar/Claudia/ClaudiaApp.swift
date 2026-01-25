import SwiftUI
import Combine

/**
 * Claudia Menubar App
 *
 * A lightweight menubar app that provides:
 * - "Hey babe" wake word detection
 * - Voice input via speech recognition
 * - Text responses with TTS playback
 *
 * Icon: 💋 (when idle), 🎤 (when listening), 💬 (when speaking)
 */
@main
struct ClaudiaApp: App {
    @StateObject private var appState = AppState()

    var body: some Scene {
        MenuBarExtra {
            MenuBarView()
                .environmentObject(appState)
        } label: {
            Image(systemName: appState.statusIcon)
                .symbolRenderingMode(.hierarchical)
        }
        .menuBarExtraStyle(.window)
    }
}

/**
 * App-wide state management
 */
@MainActor
class AppState: ObservableObject {
    @Published var status: AppStatus = .idle
    @Published var isListening = false
    @Published var isSpeaking = false
    @Published var lastTranscript = ""
    @Published var lastResponse = ""
    @Published var isConnected = false
    @Published var error: String?

    let gateway = GatewayClient()
    let speechRecognizer = SpeechRecognizer()
    let audioPlayer = AudioPlayer()

    var statusIcon: String {
        switch status {
        case .idle: return "mouth.fill"  // 💋 vibes
        case .listening: return "mic.fill"
        case .processing: return "ellipsis.circle.fill"
        case .speaking: return "speaker.wave.2.fill"
        case .error: return "exclamationmark.triangle.fill"
        }
    }

    init() {
        setupGateway()
        setupSpeechRecognizer()
    }

    private func setupGateway() {
        gateway.onConnected = { [weak self] in
            Task { @MainActor in
                self?.isConnected = true
                self?.error = nil
            }
        }

        gateway.onDisconnected = { [weak self] in
            Task { @MainActor in
                self?.isConnected = false
            }
        }

        gateway.onResponse = { [weak self] text in
            Task { @MainActor in
                self?.lastResponse = text
            }
        }

        gateway.onAudio = { [weak self] audioData in
            Task { @MainActor in
                self?.status = .speaking
                self?.isSpeaking = true
                self?.audioPlayer.play(audioData) {
                    Task { @MainActor in
                        self?.status = .idle
                        self?.isSpeaking = false
                        // Re-enable wake word listening after speaking
                        self?.startWakeWordListening()
                    }
                }
            }
        }

        gateway.onError = { [weak self] error in
            Task { @MainActor in
                self?.error = error
                self?.status = .error
            }
        }

        // Connect to gateway
        gateway.connect()
    }

    private func setupSpeechRecognizer() {
        speechRecognizer.onWakeWord = { [weak self] in
            Task { @MainActor in
                self?.handleWakeWord()
            }
        }

        speechRecognizer.onTranscript = { [weak self] transcript, isFinal in
            Task { @MainActor in
                self?.lastTranscript = transcript
                if isFinal {
                    self?.handleFinalTranscript(transcript)
                }
            }
        }
    }

    func startWakeWordListening() {
        status = .idle
        speechRecognizer.startWakeWordDetection()
    }

    func stopListening() {
        speechRecognizer.stop()
        status = .idle
        isListening = false
    }

    private func handleWakeWord() {
        // Wake word detected! Start full speech recognition
        status = .listening
        isListening = true
        speechRecognizer.startFullRecognition()
    }

    private func handleFinalTranscript(_ transcript: String) {
        guard !transcript.isEmpty else {
            startWakeWordListening()
            return
        }

        status = .processing
        isListening = false

        // Send to gateway with voice response
        gateway.sendPrompt(transcript, withVoice: true)
    }

    func sendTextPrompt(_ text: String) {
        status = .processing
        gateway.sendPrompt(text, withVoice: true)
    }

    func interruptSpeaking() {
        audioPlayer.stop()
        status = .idle
        isSpeaking = false
    }
}

enum AppStatus {
    case idle
    case listening
    case processing
    case speaking
    case error
}
