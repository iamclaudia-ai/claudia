import SwiftUI
import AVFoundation

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
    var sessionDebugText = ""
    var micAvailable = true
    private var isRecoveringMic = false
    private var postSpeechRecoveryWorkItem: DispatchWorkItem?

    /// Shared audio engine — single instance for the entire app
    let audioManager = AudioSessionManager()

    let gateway: GatewayClient
    let speechRecognizer = SpeechRecognizer()
    let audioPlayer = StreamingAudioPlayer()

    /// In-app browser for viewing web pages during voice conversations
    let browser = BrowserManager()

    // Gateway URL — reverse proxy with TLS
    private static let defaultURL = "wss://claudia.kiliman.dev/ws"

    init() {
        let url = UserDefaults.standard.string(forKey: "gatewayURL") ?? Self.defaultURL
        gateway = GatewayClient(url: url)

        // Inject shared audio manager into speech + player
        speechRecognizer.configure(audioManager: audioManager)
        audioPlayer.configure(audioManager: audioManager)

        setupCallbacks()
        setupInterruptionHandling()
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

        gateway.onSessionResolved = { [weak self] message in
            print("[App] Session: \(message)")
            self?.sessionDebugText = message
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
            self.postSpeechRecoveryWorkItem?.cancel()
            self.speechRecognizer.setTranscriptionEnabled(false)
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
            self.schedulePostSpeechRecovery()
        }

        gateway.onError = { [weak self] error in
            print("[App] Error: \(error)")
            self?.statusText = "Error: \(error)"
        }

        // Audio playback finished — restart listening
        audioPlayer.onStreamFinished = { [weak self] in
            guard let self else { return }
            self.resumeListeningAfterSpeech()
        }

        // Speech recognition
        speechRecognizer.onFinalTranscript = { [weak self] transcript in
            guard let self else { return }
            self.speechRecognizer.setTranscriptionEnabled(false)
            self.voiceState = .processing
            self.statusText = "Thinking..."
            self.gateway.sendPrompt(transcript)
        }

        speechRecognizer.onError = { [weak self] error in
            print("[App] Speech error: \(error)")
            guard let self else { return }
            if error.contains("Microphone input unavailable") {
                self.micAvailable = false
                self.voiceState = .idle
                self.statusText = "Mic unavailable on current audio route"
                self.scheduleMicRecovery()
                return
            }
            // Try to restart listening after transient errors.
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                if self.isConnected && self.voiceState != .speaking {
                    self.startListening()
                }
            }
        }
    }

    private func setupInterruptionHandling() {
        // Phone calls, Siri, etc. — pause everything
        audioManager.onInterruptionBegan = { [weak self] in
            guard let self else { return }
            print("[App] Audio interruption — pausing")
            self.speechRecognizer.stopListening()
            self.audioPlayer.stop()
            self.voiceState = .idle
            self.statusText = "Interrupted"
        }

        // Interruption ended — resume if appropriate
        audioManager.onInterruptionEnded = { [weak self] shouldResume in
            guard let self else { return }
            if shouldResume && self.isConnected {
                print("[App] Resuming after interruption")
                self.startListening()
            } else {
                self.statusText = "Paused"
            }
        }

        // Route changes (headphones unplugged, etc.)
        audioManager.onRouteChange = { [weak self] reason in
            guard let self else { return }
            if reason == .oldDeviceUnavailable {
                // Headphones removed — stop speaking, keep listening
                self.audioPlayer.stop()
                if self.voiceState == .speaking {
                    self.startListening()
                }
            } else if reason == .newDeviceAvailable {
                self.micAvailable = true
                self.scheduleMicRecovery(delay: 0.2)
            }
        }
    }

    private func schedulePostSpeechRecovery() {
        postSpeechRecoveryWorkItem?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            if self.voiceState == .speaking {
                // If callbacks didn't drain in background, force transition.
                self.audioPlayer.stop()
                self.resumeListeningAfterSpeech()
            }
        }
        postSpeechRecoveryWorkItem = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0, execute: work)
    }

    private func resumeListeningAfterSpeech() {
        postSpeechRecoveryWorkItem?.cancel()
        postSpeechRecoveryWorkItem = nil
        if isConnected {
            speechRecognizer.setTranscriptionEnabled(true)
            micAvailable = true
            if !speechRecognizer.isListening {
                startListening()
            } else {
                voiceState = .listening
                statusText = "Listening..."
            }
        } else {
            voiceState = .idle
            statusText = "Disconnected"
        }
    }

    func start() {
        // Configure and start the shared audio engine
        audioManager.configureAudioSession()
        audioManager.startEngine()

        speechRecognizer.requestPermissions { [weak self] granted in
            guard granted else {
                self?.statusText = "Permissions denied"
                return
            }
            self?.gateway.connect()
        }
    }

    func startListening() {
        guard micAvailable else {
            voiceState = .idle
            statusText = "Mic unavailable on current audio route"
            scheduleMicRecovery()
            return
        }
        speechRecognizer.setTranscriptionEnabled(true)
        voiceState = .listening
        statusText = "Listening..."
        speechRecognizer.startListening()
    }

    func interrupt() {
        audioPlayer.stop()
        gateway.sendInterrupt()
        gateway.sendVoiceStop()
        resumeListeningAfterSpeech()
    }

    func toggleListening() {
        switch voiceState {
        case .speaking:
            interrupt()
        case .listening:
            speechRecognizer.stopListening()
            speechRecognizer.setTranscriptionEnabled(false)
            voiceState = .idle
            statusText = "Paused"
        default:
            micAvailable = true
            startListening()
        }
    }

    // MARK: - Scene Phase

    func handleScenePhase(_ phase: ScenePhase) {
        switch phase {
        case .active:
            audioManager.handleSceneActive()
            if isConnected && voiceState != .speaking && !speechRecognizer.isListening {
                micAvailable = true
                scheduleMicRecovery(delay: 0.2)
            }
        case .background:
            audioManager.handleSceneBackground()
        case .inactive:
            break
        @unknown default:
            break
        }
    }

    private func scheduleMicRecovery(delay: TimeInterval = 1.0) {
        guard !isRecoveringMic else { return }
        isRecoveringMic = true
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self else { return }
            self.audioManager.configureAudioSession()
            self.audioManager.startEngine()
            self.micAvailable = true
            self.isRecoveringMic = false
            if self.isConnected && self.voiceState != .speaking && !self.speechRecognizer.isListening {
                self.startListening()
            }
        }
    }
}

@main
struct VoiceModeApp: App {
    @State private var appState = AppState()
    @Environment(\.scenePhase) private var scenePhase

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
        .onChange(of: scenePhase) { _, newPhase in
            appState.handleScenePhase(newPhase)
        }
    }
}
