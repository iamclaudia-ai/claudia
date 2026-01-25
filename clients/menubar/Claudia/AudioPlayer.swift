import Foundation
import AVFoundation
import Combine

/**
 * Audio player for TTS playback
 *
 * Plays MP3 audio data received from ElevenLabs via the gateway.
 * Supports interruption (stop mid-speech) and completion callbacks.
 */
class AudioPlayer: NSObject, ObservableObject {
    private var audioPlayer: AVAudioPlayer?
    private var completionHandler: (() -> Void)?

    @Published var isPlaying = false
    @Published var currentTime: TimeInterval = 0
    @Published var duration: TimeInterval = 0

    override init() {
        super.init()
        // Note: macOS doesn't need AVAudioSession configuration like iOS
    }

    /**
     * Play audio data (MP3 format expected)
     */
    func play(_ data: Data, completion: (() -> Void)? = nil) {
        // Stop any current playback
        stop()

        do {
            audioPlayer = try AVAudioPlayer(data: data)
            audioPlayer?.delegate = self
            audioPlayer?.prepareToPlay()

            duration = audioPlayer?.duration ?? 0
            completionHandler = completion

            if audioPlayer?.play() == true {
                isPlaying = true
                print("[Audio] Playing \(duration)s of audio")
            } else {
                print("[Audio] Failed to start playback")
                completion?()
            }
        } catch {
            print("[Audio] Playback error: \(error)")
            completion?()
        }
    }

    /**
     * Play audio from a file URL
     */
    func play(url: URL, completion: (() -> Void)? = nil) {
        stop()

        do {
            audioPlayer = try AVAudioPlayer(contentsOf: url)
            audioPlayer?.delegate = self
            audioPlayer?.prepareToPlay()

            duration = audioPlayer?.duration ?? 0
            completionHandler = completion

            if audioPlayer?.play() == true {
                isPlaying = true
            } else {
                completion?()
            }
        } catch {
            print("[Audio] Playback error: \(error)")
            completion?()
        }
    }

    /**
     * Stop playback immediately
     */
    func stop() {
        audioPlayer?.stop()
        audioPlayer = nil
        isPlaying = false
        currentTime = 0
        duration = 0
        // Don't call completion handler when manually stopped
        completionHandler = nil
    }

    /**
     * Pause playback
     */
    func pause() {
        audioPlayer?.pause()
        isPlaying = false
    }

    /**
     * Resume playback
     */
    func resume() {
        if audioPlayer?.play() == true {
            isPlaying = true
        }
    }
}

extension AudioPlayer: AVAudioPlayerDelegate {
    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        DispatchQueue.main.async { [weak self] in
            self?.isPlaying = false
            self?.currentTime = 0
            let completion = self?.completionHandler
            self?.completionHandler = nil
            completion?()
        }
    }

    func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        print("[Audio] Decode error: \(error?.localizedDescription ?? "unknown")")
        DispatchQueue.main.async { [weak self] in
            self?.isPlaying = false
            let completion = self?.completionHandler
            self?.completionHandler = nil
            completion?()
        }
    }
}
