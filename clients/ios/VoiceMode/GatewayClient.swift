import Foundation

/// WebSocket client for Claudia Gateway
///
/// Connects to the gateway and handles the streaming voice protocol:
/// - Sends: { type: "req", id, method, params }
/// - Receives: { type: "res", id, ok, payload/error }
/// - Receives: { type: "event", event, payload }
class GatewayClient: NSObject, @unchecked Sendable {
    private var webSocket: URLSessionWebSocketTask?
    private var session: URLSession!
    private var isConnecting = false
    private var shouldReconnect = true

    private let gatewayURL: URL
    private var pendingRequests: [String: (Result<Any, Error>) -> Void] = [:]

    // Working directory for voice mode sessions
    private let cwd: String

    // Callbacks — set by AppState
    var onConnected: (() -> Void)?
    var onDisconnected: (() -> Void)?
    var onStreamStart: ((_ streamId: String) -> Void)?
    var onAudioChunk: ((_ audio: Data, _ index: Int, _ streamId: String) -> Void)?
    var onStreamEnd: ((_ streamId: String) -> Void)?
    var onError: ((String) -> Void)?

    init(url: String, cwd: String = "/Users/michael/claudia/chat") {
        self.gatewayURL = URL(string: url)!
        // Use server path directly (no expansion needed)
        self.cwd = cwd
        super.init()
        let config = URLSessionConfiguration.default
        self.session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }

    func connect() {
        guard webSocket == nil && !isConnecting else { return }
        isConnecting = true
        shouldReconnect = true
        print("[Gateway] Connecting to \(gatewayURL)")
        webSocket = session.webSocketTask(with: gatewayURL)
        webSocket?.resume()
    }

    func disconnect() {
        shouldReconnect = false
        webSocket?.cancel(with: .goingAway, reason: nil)
        webSocket = nil
        DispatchQueue.main.async { self.onDisconnected?() }
    }

    var isConnected: Bool {
        webSocket != nil && !isConnecting
    }

    // MARK: - Public API

    /// Initialize workspace, session, and subscriptions — called after WebSocket connects
    func initializeSession() {
        print("[Gateway] Initializing voice mode session (cwd: \(cwd))")

        // 1. Get or create workspace for voice mode cwd
        sendRequest(method: "workspace.getOrCreate", params: ["cwd": cwd, "name": "Voice Mode"]) { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .success(let payload):
                if let dict = payload as? [String: Any],
                   let workspace = dict["workspace"] as? [String: Any],
                   let workspaceId = workspace["id"] as? String {
                    print("[Gateway] Workspace ready: \(workspaceId)")
                    // 2. Create a session in this workspace
                    self.sendRequest(method: "session.create", params: ["workspaceId": workspaceId]) { [weak self] result in
                        guard let self = self else { return }
                        switch result {
                        case .success:
                            print("[Gateway] Session created")
                            // 3. Subscribe to events
                            self.sendRequest(method: "subscribe", params: ["events": ["session.*", "voice.*"]]) { _ in
                                print("[Gateway] Subscribed to events")
                                DispatchQueue.main.async { self.onConnected?() }
                            }
                        case .failure(let error):
                            print("[Gateway] Session create failed: \(error)")
                            DispatchQueue.main.async { self.onError?("Session create failed: \(error.localizedDescription)") }
                        }
                    }
                } else {
                    print("[Gateway] Unexpected workspace response")
                    DispatchQueue.main.async { self.onError?("Invalid workspace response") }
                }
            case .failure(let error):
                print("[Gateway] Workspace create failed: \(error)")
                DispatchQueue.main.async { self.onError?("Workspace failed: \(error.localizedDescription)") }
            }
        }
    }

    func sendPrompt(_ content: String) {
        let params: [String: Any] = [
            "content": content,
            "speakResponse": true
        ]
        sendRequest(method: "session.prompt", params: params) { [weak self] result in
            if case .failure(let error) = result {
                self?.onError?(error.localizedDescription)
            }
        }
    }

    func sendInterrupt() {
        sendRequest(method: "session.interrupt", params: [:]) { _ in }
    }

    func sendVoiceStop() {
        sendRequest(method: "voice.stop", params: [:]) { _ in }
    }

    // MARK: - Private

    private func sendRequest(method: String, params: [String: Any], completion: @escaping (Result<Any, Error>) -> Void) {
        let id = UUID().uuidString
        let message: [String: Any] = [
            "type": "req",
            "id": id,
            "method": method,
            "params": params
        ]

        guard let data = try? JSONSerialization.data(withJSONObject: message),
              let jsonString = String(data: data, encoding: .utf8) else {
            completion(.failure(GatewayError.serializationFailed))
            return
        }

        pendingRequests[id] = completion

        webSocket?.send(.string(jsonString)) { [weak self] error in
            if let error = error {
                self?.pendingRequests.removeValue(forKey: id)
                completion(.failure(error))
            }
        }
    }

    private func receiveMessage() {
        webSocket?.receive { [weak self] result in
            switch result {
            case .success(let message):
                switch message {
                case .string(let text):
                    self?.handleMessage(text)
                case .data(let data):
                    if let text = String(data: data, encoding: .utf8) {
                        self?.handleMessage(text)
                    }
                @unknown default:
                    break
                }
                self?.receiveMessage()

            case .failure(let error):
                print("[Gateway] Receive error: \(error)")
                self?.handleDisconnect()
            }
        }
    }

    private func handleMessage(_ text: String) {
        guard let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String else {
            return
        }

        switch type {
        case "res":
            handleResponse(json)
        case "event":
            handleEvent(json)
        default:
            break
        }
    }

    private func handleResponse(_ json: [String: Any]) {
        guard let id = json["id"] as? String,
              let completion = pendingRequests.removeValue(forKey: id) else {
            return
        }

        if json["ok"] as? Bool == true {
            completion(.success(json["payload"] ?? [:]))
        } else {
            let error = json["error"] as? String ?? "Unknown error"
            completion(.failure(GatewayError.serverError(error)))
        }
    }

    private func handleEvent(_ json: [String: Any]) {
        guard let event = json["event"] as? String,
              let payload = json["payload"] as? [String: Any] else {
            return
        }

        switch event {
        case "voice.stream_start":
            let streamId = payload["streamId"] as? String ?? ""
            print("[Gateway] voice.stream_start: \(streamId)")
            DispatchQueue.main.async { self.onStreamStart?(streamId) }

        case "voice.audio_chunk":
            if let audioBase64 = payload["audio"] as? String,
               let audioData = Data(base64Encoded: audioBase64) {
                let index = payload["index"] as? Int ?? 0
                let streamId = payload["streamId"] as? String ?? ""
                print("[Gateway] voice.audio_chunk #\(index) (\(audioData.count) bytes)")
                DispatchQueue.main.async { self.onAudioChunk?(audioData, index, streamId) }
            }

        case "voice.stream_end":
            let streamId = payload["streamId"] as? String ?? ""
            print("[Gateway] voice.stream_end: \(streamId)")
            DispatchQueue.main.async { self.onStreamEnd?(streamId) }

        case "voice.error":
            if let error = payload["error"] as? String {
                DispatchQueue.main.async { self.onError?("Voice error: \(error)") }
            }

        default:
            break
        }
    }

    private func handleDisconnect() {
        webSocket = nil
        isConnecting = false
        DispatchQueue.main.async { self.onDisconnected?() }

        guard shouldReconnect else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
            self?.connect()
        }
    }
}

extension GatewayClient: URLSessionWebSocketDelegate {
    nonisolated func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        print("[Gateway] WebSocket connected — initializing session...")
        isConnecting = false
        receiveMessage()
        // Set up workspace + session + subscriptions, then signal onConnected
        initializeSession()
    }

    nonisolated func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        print("[Gateway] Disconnected: \(closeCode)")
        handleDisconnect()
    }
}

enum GatewayError: LocalizedError {
    case serializationFailed
    case serverError(String)

    var errorDescription: String? {
        switch self {
        case .serializationFailed:
            return "Failed to serialize request"
        case .serverError(let message):
            return message
        }
    }
}
