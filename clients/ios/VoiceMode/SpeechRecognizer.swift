import Foundation
import Speech
import AVFoundation
import Combine

/// Continuous speech recognizer for Voice Mode
///
/// Always listening — no wake word needed. Detects silence (2s pause)
/// and auto-finalizes the transcript for sending to the gateway.
///
/// Uses a shared AudioSessionManager instead of owning its own AVAudioEngine.
/// The mic input tap is installed/removed without stopping the engine.
class SpeechRecognizer: ObservableObject {
    private let speechRecognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private let fallbackAudioEngine = AVAudioEngine()
    private var usingFallbackEngine = false

    /// Shared audio manager — injected from AppState
    private weak var audioManager: AudioSessionManager?

    private var silenceTimer: Timer?
    private var lastTranscript = ""
    private var transcriptionEnabled = true
    @Published var isListening = false
    @Published var currentTranscript = ""

    /// Called when silence is detected and transcript is ready to send
    var onFinalTranscript: ((String) -> Void)?
    var onError: ((String) -> Void)?

    /// Inject the shared audio session manager
    func configure(audioManager: AudioSessionManager) {
        self.audioManager = audioManager
    }

    /// Keep audio capture alive but gate whether recognition results are acted on.
    func setTranscriptionEnabled(_ enabled: Bool) {
        transcriptionEnabled = enabled
        if enabled {
            lastTranscript = ""
            DispatchQueue.main.async {
                self.currentTranscript = ""
            }
        }
    }

    /// Request permissions on first launch
    func requestPermissions(completion: @escaping (Bool) -> Void) {
        var micGranted = false
        var speechGranted = false
        let group = DispatchGroup()

        group.enter()
        AVAudioApplication.requestRecordPermission { granted in
            micGranted = granted
            group.leave()
        }

        group.enter()
        SFSpeechRecognizer.requestAuthorization { status in
            speechGranted = (status == .authorized)
            group.leave()
        }

        group.notify(queue: .main) {
            completion(micGranted && speechGranted)
        }
    }

    /// Start continuous listening using the shared audio engine
    func startListening() {
        guard !isListening else { return }
        guard speechRecognizer?.isAvailable == true else {
            onError?("Speech recognition not available")
            return
        }
        guard let audioManager = audioManager else {
            onError?("AudioSessionManager not configured")
            return
        }

        // Cancel any existing task
        recognitionTask?.cancel()
        recognitionTask = nil

        // Create recognition request
        recognitionRequest = SFSpeechAudioBufferRecognitionRequest()
        guard let recognitionRequest = recognitionRequest else {
            onError?("Unable to create recognition request")
            return
        }

        recognitionRequest.shouldReportPartialResults = true
        if speechRecognizer?.supportsOnDeviceRecognition == true {
            recognitionRequest.requiresOnDeviceRecognition = true
        }

        // Start recognition task
        recognitionTask = speechRecognizer?.recognitionTask(with: recognitionRequest) { [weak self] result, error in
            guard let self = self else { return }

            if let result = result {
                guard self.transcriptionEnabled else { return }
                let transcript = result.bestTranscription.formattedString
                DispatchQueue.main.async {
                    self.lastTranscript = transcript
                    self.currentTranscript = transcript
                }

                // Reset silence timer on each partial result
                DispatchQueue.main.async {
                    self.silenceTimer?.invalidate()
                    self.silenceTimer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: false) { [weak self] _ in
                        guard let self = self, !self.lastTranscript.isEmpty else { return }
                        let finalText = self.lastTranscript
                        print("[Speech] Silence detected — sending: \"\(finalText)\"")
                        self.lastTranscript = ""
                        self.currentTranscript = ""
                        self.onFinalTranscript?(finalText)
                    }
                }
            }

            if error != nil || result?.isFinal == true {
                if let transcript = result?.bestTranscription.formattedString,
                   !transcript.isEmpty, result?.isFinal == true, self.transcriptionEnabled {
                    DispatchQueue.main.async {
                        self.silenceTimer?.invalidate()
                        self.lastTranscript = ""
                        self.currentTranscript = ""
                        self.onFinalTranscript?(transcript)
                    }
                } else if error != nil {
                    print("[Speech] Recognition error: \(error!)")
                    DispatchQueue.main.async {
                        self.stopListening()
                    }
                }
            }
        }

        // Install mic tap on the shared engine (engine stays running)
        let micEnabled = audioManager.enableMicInput { [weak self] buffer, _ in
            self?.recognitionRequest?.append(buffer)
        }
        if !micEnabled {
            print("[Speech] Shared mic input unavailable; trying fallback engine")
            guard startFallbackInputTap() else {
                recognitionTask?.cancel()
                recognitionTask = nil
                self.recognitionRequest = nil
                onError?("Microphone input unavailable on current audio route")
                return
            }
            usingFallbackEngine = true
        }
        if micEnabled {
            usingFallbackEngine = false
        }

        DispatchQueue.main.async {
            self.isListening = true
            self.lastTranscript = ""
            self.currentTranscript = ""
        }
        print("[Speech] Listening started (shared engine)")
    }

    /// Stop listening — removes mic tap but engine stays running
    func stopListening() {
        silenceTimer?.invalidate()
        silenceTimer = nil

        if usingFallbackEngine {
            fallbackAudioEngine.stop()
            fallbackAudioEngine.inputNode.removeTap(onBus: 0)
            usingFallbackEngine = false
        } else {
            // Remove mic tap (engine keeps running)
            audioManager?.disableMicInput()
        }

        recognitionRequest?.endAudio()
        recognitionRequest = nil

        recognitionTask?.cancel()
        recognitionTask = nil

        DispatchQueue.main.async {
            self.isListening = false
        }
        print("[Speech] Listening stopped")
    }

    private func startFallbackInputTap() -> Bool {
        let inputNode = fallbackAudioEngine.inputNode
        let recordingFormat = inputNode.outputFormat(forBus: 0)
        print("[Speech] Fallback input format: \(recordingFormat.sampleRate)Hz/\(recordingFormat.channelCount)ch")
        guard recordingFormat.channelCount > 0, recordingFormat.sampleRate > 0 else {
            return false
        }
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat) { [weak self] buffer, _ in
            self?.recognitionRequest?.append(buffer)
        }
        fallbackAudioEngine.prepare()
        do {
            try fallbackAudioEngine.start()
            print("[Speech] Fallback input engine started")
            return true
        } catch {
            print("[Speech] Fallback engine error: \(error)")
            inputNode.removeTap(onBus: 0)
            return false
        }
    }
}
