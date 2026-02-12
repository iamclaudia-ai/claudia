import SwiftUI

enum VoiceState {
    case idle
    case listening
    case processing
    case speaking
}

@Observable
class AppState {
    var voiceState: VoiceState = .idle
    var isConnected = false
    var statusText = "Connecting..."

    let gateway: GatewayClient
    let speechRecognizer = SpeechRecognizer()
    let audioPlayer = StreamingAudioPlayer()

    // Gateway URL — reverse proxy with TLS
    private static let defaultURL = "wss://claudia.kiliman.dev/ws"

    init() {
        let url = UserDefaults.standard.string(forKey: "gatewayURL") ?? Self.defaultURL
        gateway = GatewayClient(url: url)
        setupCallbacks()
    }

    private func setupCallbacks() {
        // Gateway connection
        gateway.onConnected = { [weak self] in
            guard let self else { return }
            self.isConnected = true
            self.statusText = "Connected"
            // Auto-start listening when connected
            self.startListening()
        }

        gateway.onDisconnected = { [weak self] in
            guard let self else { return }
            self.isConnected = false
            self.voiceState = .idle
            self.statusText = "Reconnecting..."
            self.speechRecognizer.stopListening()
        }

        // Streaming audio
        gateway.onStreamStart = { [weak self] streamId in
            guard let self else { return }
            self.voiceState = .speaking
            self.statusText = "Speaking..."
            self.audioPlayer.reset()
        }

        gateway.onAudioChunk = { [weak self] audio, index, streamId in
            guard let self else { return }
            self.audioPlayer.enqueue(audio: audio, index: index)
        }

        gateway.onStreamEnd = { [weak self] streamId in
            guard let self else { return }
            self.audioPlayer.markStreamEnd()
        }

        gateway.onError = { [weak self] error in
            print("[App] Error: \(error)")
            self?.statusText = "Error: \(error)"
        }

        // Audio playback finished — restart listening
        audioPlayer.onStreamFinished = { [weak self] in
            guard let self else { return }
            self.startListening()
        }

        // Speech recognition
        speechRecognizer.onFinalTranscript = { [weak self] transcript in
            guard let self else { return }
            self.voiceState = .processing
            self.statusText = "Thinking..."
            self.gateway.sendPrompt(transcript)
        }

        speechRecognizer.onError = { [weak self] error in
            print("[App] Speech error: \(error)")
            // Try to restart listening after error
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                self?.startListening()
            }
        }
    }

    func start() {
        speechRecognizer.configureAudioSession()
        speechRecognizer.requestPermissions { [weak self] granted in
            guard granted else {
                self?.statusText = "Permissions denied"
                return
            }
            self?.gateway.connect()
        }
    }

    func startListening() {
        voiceState = .listening
        statusText = "Listening..."
        speechRecognizer.startListening()
    }

    func interrupt() {
        audioPlayer.stop()
        gateway.sendInterrupt()
        gateway.sendVoiceStop()
        startListening()
    }

    func toggleListening() {
        switch voiceState {
        case .speaking:
            interrupt()
        case .listening:
            speechRecognizer.stopListening()
            voiceState = .idle
            statusText = "Paused"
        default:
            startListening()
        }
    }
}

@main
struct VoiceModeApp: App {
    @State private var appState = AppState()

    var body: some Scene {
        WindowGroup {
            VoiceModeView(appState: appState)
                .onAppear {
                    appState.start()
                }
                .onOpenURL { url in
                    if url.scheme == "voicemode" && url.host == "launch" {
                        print("[App] Widget launch detected - ensuring voice mode starts")
                        appState.start()
                    }
                }
        }
    }
}
