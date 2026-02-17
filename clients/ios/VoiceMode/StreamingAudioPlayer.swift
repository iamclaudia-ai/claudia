import Foundation
import AVFoundation
import Combine

/// Streaming audio player for gapless Cartesia TTS chunk playback.
///
/// Uses a shared AudioSessionManager instead of owning its own AVAudioEngine.
/// Buffers are scheduled on the shared player node — engine stays running
/// across all voice states.
class StreamingAudioPlayer: NSObject, ObservableObject {

    /// Shared audio manager — injected from AppState
    private weak var audioManager: AudioSessionManager?

    private var streamEnded = false
    private var scheduledBuffers = 0

    @Published var isPlaying = false
    var onStreamFinished: (() -> Void)?

    /// Inject the shared audio session manager
    func configure(audioManager: AudioSessionManager) {
        self.audioManager = audioManager
    }

    /// Enqueue an audio chunk for playback
    func enqueue(audio: Data, index: Int) {
        DispatchQueue.main.async {
            guard let audioManager = self.audioManager else {
                print("[Audio] AudioSessionManager not configured")
                return
            }

            guard let buffer = self.wavDataToPCMBuffer(audio, format: audioManager.playerFormat) else {
                print("[Audio] Failed to parse WAV chunk #\(index)")
                return
            }

            self.scheduledBuffers += 1
            audioManager.scheduleBuffer(buffer) { [weak self] in
                DispatchQueue.main.async {
                    guard let self = self else { return }
                    self.scheduledBuffers = max(0, self.scheduledBuffers - 1)
                    if self.streamEnded && self.scheduledBuffers == 0 {
                        self.finishStream()
                    }
                }
            }

            self.isPlaying = true
            print("[Audio] Scheduled chunk #\(index) (\(audio.count) bytes), pending: \(self.scheduledBuffers)")
        }
    }

    /// Stop playback and clear pending buffers. Engine stays running.
    func stop() {
        DispatchQueue.main.async {
            self.streamEnded = false
            self.scheduledBuffers = 0
            self.audioManager?.stopPlayback()
            self.isPlaying = false
            print("[Audio] Stopped, buffers cleared")
        }
    }

    /// Signal that stream is complete — finish once scheduled buffers drain
    func markStreamEnd() {
        DispatchQueue.main.async {
            self.streamEnded = true
            if self.scheduledBuffers == 0 {
                self.finishStream()
            }
        }
    }

    func reset() {
        stop()
        DispatchQueue.main.async {
            self.streamEnded = false
        }
    }

    // MARK: - Private

    private func finishStream() {
        streamEnded = false
        self.isPlaying = false
        self.onStreamFinished?()
        print("[Audio] Stream finished")
    }

    /// Parse WAV (PCM s16le mono) into AVAudioPCMBuffer.
    private func wavDataToPCMBuffer(_ data: Data, format: AVAudioFormat) -> AVAudioPCMBuffer? {
        guard data.count > 44 else { return nil }

        let bytes = [UInt8](data)
        guard String(bytes: bytes[0...3], encoding: .ascii) == "RIFF",
              String(bytes: bytes[8...11], encoding: .ascii) == "WAVE" else {
            return nil
        }

        let channels = Int(UInt16(bytes[22]) | (UInt16(bytes[23]) << 8))
        let sampleRate = UInt32(bytes[24]) |
                         (UInt32(bytes[25]) << 8) |
                         (UInt32(bytes[26]) << 16) |
                         (UInt32(bytes[27]) << 24)
        let bitsPerSample = Int(UInt16(bytes[34]) | (UInt16(bytes[35]) << 8))
        guard channels == 1, bitsPerSample == 16, sampleRate == 24000 else { return nil }

        let dataSize = Int(UInt32(bytes[40]) |
                           (UInt32(bytes[41]) << 8) |
                           (UInt32(bytes[42]) << 16) |
                           (UInt32(bytes[43]) << 24))
        guard dataSize > 0, data.count >= 44 + dataSize else { return nil }

        let frameCount = dataSize / 2
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format,
                                            frameCapacity: AVAudioFrameCount(frameCount)) else {
            return nil
        }

        buffer.frameLength = AVAudioFrameCount(frameCount)
        guard let channelData = buffer.floatChannelData?[0] else { return nil }

        let pcm = data.subdata(in: 44..<(44 + dataSize))
        pcm.withUnsafeBytes { rawBuf in
            guard let int16Ptr = rawBuf.bindMemory(to: Int16.self).baseAddress else { return }
            for i in 0..<frameCount {
                channelData[i] = Float(int16Ptr[i]) / 32768.0
            }
        }

        return buffer
    }
}
