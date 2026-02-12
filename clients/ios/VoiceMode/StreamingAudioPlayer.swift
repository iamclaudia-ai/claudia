import Foundation
import AVFoundation
import Combine

/// Queue-based streaming audio player
///
/// Receives MP3 chunks from the gateway, decodes them, and plays
/// sequentially. Each chunk is a valid MP3 segment from ElevenLabs.
class StreamingAudioPlayer: NSObject, ObservableObject, AVAudioPlayerDelegate {
    private var audioQueue: [(Data, Int)] = []  // (audioData, index)
    private var currentPlayer: AVAudioPlayer?
    @Published var isPlaying = false

    var onStreamFinished: (() -> Void)?

    /// Enqueue an audio chunk for playback
    func enqueue(audio: Data, index: Int) {
        audioQueue.append((audio, index))
        print("[Audio] Enqueued chunk #\(index) (\(audio.count) bytes), queue size: \(audioQueue.count)")

        // Start playing if not already
        if currentPlayer == nil {
            playNext()
        }
    }

    /// Stop playback and clear queue
    func stop() {
        audioQueue.removeAll()
        currentPlayer?.stop()
        currentPlayer = nil
        isPlaying = false
        print("[Audio] Stopped, queue cleared")
    }

    /// Signal that the stream is complete — when queue drains, notify
    private var streamEnded = false

    func markStreamEnd() {
        streamEnded = true
        // If queue is already empty and nothing playing, notify now
        if audioQueue.isEmpty && currentPlayer == nil {
            finishStream()
        }
    }

    func reset() {
        stop()
        streamEnded = false
    }

    // MARK: - Private

    private func playNext() {
        guard !audioQueue.isEmpty else {
            currentPlayer = nil
            isPlaying = false
            if streamEnded {
                finishStream()
            }
            return
        }

        let (data, index) = audioQueue.removeFirst()

        do {
            let player = try AVAudioPlayer(data: data)
            player.delegate = self
            player.prepareToPlay()
            player.play()
            currentPlayer = player
            isPlaying = true
            print("[Audio] Playing chunk #\(index)")
        } catch {
            print("[Audio] Failed to play chunk #\(index): \(error)")
            // Skip failed chunk and try next
            playNext()
        }
    }

    private func finishStream() {
        streamEnded = false
        isPlaying = false
        print("[Audio] Stream finished")
        onStreamFinished?()
    }

    // MARK: - AVAudioPlayerDelegate

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        DispatchQueue.main.async {
            self.playNext()
        }
    }

    nonisolated func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        print("[Audio] Decode error: \(error?.localizedDescription ?? "unknown")")
        DispatchQueue.main.async {
            self.playNext()
        }
    }
}
