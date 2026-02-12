import Foundation
import Speech
import AVFoundation
import Combine

/// Continuous speech recognizer for Voice Mode
///
/// Always listening — no wake word needed. Detects silence (2s pause)
/// and auto-finalizes the transcript for sending to the gateway.
class SpeechRecognizer: ObservableObject {
    private let speechRecognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private let audioEngine = AVAudioEngine()

    private var silenceTimer: Timer?
    private var lastTranscript = ""
    @Published var isListening = false
    @Published var currentTranscript = ""

    /// Called when silence is detected and transcript is ready to send
    var onFinalTranscript: ((String) -> Void)?
    var onError: ((String) -> Void)?

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

    /// Configure audio session for simultaneous mic + speaker
    func configureAudioSession() {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playAndRecord, options: [
                .allowBluetooth,
                .allowBluetoothA2DP,
                .defaultToSpeaker,
                .mixWithOthers
            ])
            try session.setActive(true)
            print("[Speech] Audio session configured: playAndRecord + bluetooth")
        } catch {
            print("[Speech] Audio session error: \(error)")
            onError?("Audio session error: \(error.localizedDescription)")
        }
    }

    /// Start continuous listening
    func startListening() {
        guard !isListening else { return }
        guard speechRecognizer?.isAvailable == true else {
            onError?("Speech recognition not available")
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
                        self.stopListening()
                        self.onFinalTranscript?(finalText)
                    }
                }
            }

            if error != nil || result?.isFinal == true {
                // If we have text and recognition ended naturally, send it
                if let transcript = result?.bestTranscription.formattedString,
                   !transcript.isEmpty, result?.isFinal == true {
                    DispatchQueue.main.async {
                        self.silenceTimer?.invalidate()
                        self.stopListening()
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

        // Connect audio input to recognition
        let inputNode = audioEngine.inputNode
        let recordingFormat = inputNode.outputFormat(forBus: 0)

        inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat) { buffer, _ in
            self.recognitionRequest?.append(buffer)
        }

        audioEngine.prepare()
        do {
            try audioEngine.start()
            DispatchQueue.main.async {
                self.isListening = true
                self.lastTranscript = ""
                self.currentTranscript = ""
            }
            print("[Speech] Listening started")
        } catch {
            onError?("Audio engine error: \(error.localizedDescription)")
        }
    }

    /// Stop listening
    func stopListening() {
        silenceTimer?.invalidate()
        silenceTimer = nil

        audioEngine.stop()
        audioEngine.inputNode.removeTap(onBus: 0)

        recognitionRequest?.endAudio()
        recognitionRequest = nil

        recognitionTask?.cancel()
        recognitionTask = nil

        DispatchQueue.main.async {
            self.isListening = false
        }
        print("[Speech] Listening stopped")
    }
}
