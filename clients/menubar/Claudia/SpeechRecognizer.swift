import Foundation
import Speech
import AVFoundation
import Combine

/**
 * Speech recognition manager
 *
 * Handles two modes:
 * 1. Wake word detection - listens for "Hey babe" (or variations)
 * 2. Full recognition - captures complete utterance for sending to Claudia
 */
class SpeechRecognizer: NSObject, ObservableObject {
    private let speechRecognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private let audioEngine = AVAudioEngine()

    private var mode: RecognitionMode = .idle
    private var silenceTimer: Timer?
    private var lastTranscript = ""

    // Wake word patterns (case insensitive)
    private let wakeWordPatterns = [
        "hey babe",
        "hey bae",
        "hey baby",  // Common misrecognition
        "a babe",    // Sometimes "hey" gets cut off
        "hey claudia",
        "claudia"
    ]

    // Callbacks
    var onWakeWord: (() -> Void)?
    var onTranscript: ((String, Bool) -> Void)?  // (transcript, isFinal)
    var onError: ((String) -> Void)?

    override init() {
        super.init()
        requestPermissions()
    }

    private func requestPermissions() {
        SFSpeechRecognizer.requestAuthorization { [weak self] status in
            switch status {
            case .authorized:
                print("[Speech] Authorized")
            case .denied, .restricted, .notDetermined:
                self?.onError?("Speech recognition not authorized")
            @unknown default:
                break
            }
        }
        // Note: On macOS, microphone permission is requested automatically
        // when accessing the audio input node
    }

    /**
     * Start listening for wake word only
     */
    func startWakeWordDetection() {
        guard mode == .idle else { return }
        mode = .wakeWord
        startRecognition()
    }

    /**
     * Start full speech recognition (after wake word detected)
     */
    func startFullRecognition() {
        // If already in wake word mode, upgrade to full mode
        if mode == .wakeWord {
            mode = .fullRecognition
            lastTranscript = ""
            // Recognition is already running, just change how we process results
            return
        }

        guard mode == .idle else { return }
        mode = .fullRecognition
        lastTranscript = ""
        startRecognition()
    }

    /**
     * Stop all recognition
     */
    func stop() {
        stopRecognition()
        mode = .idle
    }

    private func startRecognition() {
        // Cancel any existing task
        recognitionTask?.cancel()
        recognitionTask = nil

        // Note: macOS doesn't need AVAudioSession configuration like iOS
        // The audio engine handles input directly

        // Create recognition request
        recognitionRequest = SFSpeechAudioBufferRecognitionRequest()
        guard let recognitionRequest = recognitionRequest else {
            onError?("Unable to create recognition request")
            return
        }

        recognitionRequest.shouldReportPartialResults = true

        // Use on-device recognition if available (faster, more private)
        if #available(macOS 13, *) {
            recognitionRequest.requiresOnDeviceRecognition = speechRecognizer?.supportsOnDeviceRecognition ?? false
        }

        // Start recognition task
        recognitionTask = speechRecognizer?.recognitionTask(with: recognitionRequest) { [weak self] result, error in
            guard let self = self else { return }

            if let result = result {
                let transcript = result.bestTranscription.formattedString
                self.handleTranscript(transcript, isFinal: result.isFinal)
            }

            if error != nil || result?.isFinal == true {
                // Recognition ended
                if self.mode == .fullRecognition && !self.lastTranscript.isEmpty {
                    // Send final transcript
                    self.onTranscript?(self.lastTranscript, true)
                }
                self.stopRecognition()

                // If we were in wake word mode, restart it
                if self.mode == .wakeWord {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                        self.startRecognition()
                    }
                } else {
                    self.mode = .idle
                }
            }
        }

        // Connect audio input
        let inputNode = audioEngine.inputNode
        let recordingFormat = inputNode.outputFormat(forBus: 0)

        inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat) { buffer, _ in
            self.recognitionRequest?.append(buffer)
        }

        audioEngine.prepare()
        do {
            try audioEngine.start()
            print("[Speech] Started recognition in \(mode) mode")
        } catch {
            onError?("Audio engine error: \(error.localizedDescription)")
        }
    }

    private func stopRecognition() {
        silenceTimer?.invalidate()
        silenceTimer = nil

        audioEngine.stop()
        audioEngine.inputNode.removeTap(onBus: 0)

        recognitionRequest?.endAudio()
        recognitionRequest = nil

        recognitionTask?.cancel()
        recognitionTask = nil

        print("[Speech] Stopped recognition")
    }

    private func handleTranscript(_ transcript: String, isFinal: Bool) {
        let lowercased = transcript.lowercased()

        switch mode {
        case .wakeWord:
            // Check for wake word
            for pattern in wakeWordPatterns {
                if lowercased.contains(pattern) {
                    print("[Speech] Wake word detected: \(pattern)")
                    // Stop current recognition and trigger wake word callback
                    stopRecognition()
                    onWakeWord?()
                    return
                }
            }

        case .fullRecognition:
            // Strip wake word from beginning if present
            var cleanTranscript = transcript
            for pattern in wakeWordPatterns {
                if lowercased.hasPrefix(pattern) {
                    let startIndex = cleanTranscript.index(cleanTranscript.startIndex, offsetBy: pattern.count)
                    cleanTranscript = String(cleanTranscript[startIndex...]).trimmingCharacters(in: .whitespaces)
                    break
                }
            }

            lastTranscript = cleanTranscript
            onTranscript?(cleanTranscript, false)

            // Reset silence timer
            silenceTimer?.invalidate()
            silenceTimer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: false) { [weak self] _ in
                // User stopped talking - finalize
                guard let self = self, !self.lastTranscript.isEmpty else { return }
                self.stopRecognition()
                self.onTranscript?(self.lastTranscript, true)
                self.mode = .idle
            }

        case .idle:
            break
        }
    }
}

enum RecognitionMode {
    case idle
    case wakeWord
    case fullRecognition
}
