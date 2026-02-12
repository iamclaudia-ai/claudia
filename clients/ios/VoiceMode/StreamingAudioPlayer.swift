import Foundation
import AVFoundation
import Combine

/// Streaming audio player backed by AVAudioEngine for gapless chunk playback.
///
/// Each incoming chunk is a small WAV payload. We parse it to PCM and schedule
/// buffers on AVAudioPlayerNode so playback remains continuous.
class StreamingAudioPlayer: NSObject, ObservableObject {
    private let engine = AVAudioEngine()
    private let playerNode = AVAudioPlayerNode()
    private let playerFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32,
                                             sampleRate: 24000,
                                             channels: 1,
                                             interleaved: false)!

    private var streamEnded = false
    private var scheduledBuffers = 0

    @Published var isPlaying = false
    var onStreamFinished: (() -> Void)?

    override init() {
        super.init()
        setupEngine()
    }

    /// Enqueue an audio chunk for playback
    func enqueue(audio: Data, index: Int) {
        DispatchQueue.main.async {
            guard let buffer = self.wavDataToPCMBuffer(audio) else {
                print("[Audio] Failed to parse WAV chunk #\(index)")
                return
            }

            self.ensureEngineRunning()
            self.scheduledBuffers += 1
            self.playerNode.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
                DispatchQueue.main.async {
                    guard let self = self else { return }
                    self.scheduledBuffers = max(0, self.scheduledBuffers - 1)
                    if self.streamEnded && self.scheduledBuffers == 0 {
                        self.finishStream()
                    }
                }
            }

            if !self.playerNode.isPlaying {
                self.playerNode.play()
            }

            self.isPlaying = true
            print("[Audio] Scheduled chunk #\(index) (\(audio.count) bytes), pending: \(self.scheduledBuffers)")
        }
    }

    /// Stop playback and clear pending buffers
    func stop() {
        DispatchQueue.main.async {
            self.streamEnded = false
            self.scheduledBuffers = 0
            self.playerNode.stop()
            self.playerNode.reset()
            if self.engine.isRunning {
                self.engine.stop()
            }
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

    private func setupEngine() {
        engine.attach(playerNode)
        engine.connect(playerNode, to: engine.mainMixerNode, format: playerFormat)
    }

    private func ensureEngineRunning() {
        if engine.isRunning {
            return
        }

        do {
            try engine.start()
        } catch {
            print("[Audio] Engine start failed: \(error)")
        }
    }

    private func finishStream() {
        streamEnded = false
        self.isPlaying = false
        self.onStreamFinished?()
        print("[Audio] Stream finished")
    }

    /// Parse WAV (PCM s16le mono) into AVAudioPCMBuffer.
    private func wavDataToPCMBuffer(_ data: Data) -> AVAudioPCMBuffer? {
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
        guard let buffer = AVAudioPCMBuffer(pcmFormat: playerFormat,
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
