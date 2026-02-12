import SwiftUI

struct VoiceModeView: View {
    let appState: AppState

    // Pulse animation
    @State private var pulseScale: CGFloat = 1.0
    @State private var pulseOpacity: Double = 0.6

    // Claudia's purple
    private let accentColor = Color(red: 0.533, green: 0.4, blue: 0.867)

    var body: some View {
        ZStack {
            // Background
            Color.black.ignoresSafeArea()

            VStack(spacing: 40) {
                Spacer()

                // Connection indicator
                HStack(spacing: 8) {
                    Circle()
                        .fill(appState.isConnected ? Color.green : Color.red)
                        .frame(width: 8, height: 8)
                    Text(appState.isConnected ? "Connected" : "Disconnected")
                        .font(.caption)
                        .foregroundColor(.gray)
                }

                Spacer()

                // Pulse rings (behind button)
                ZStack {
                    if appState.voiceState == .listening {
                        ForEach(0..<3, id: \.self) { i in
                            Circle()
                                .stroke(accentColor.opacity(0.3), lineWidth: 2)
                                .frame(width: 160 + CGFloat(i) * 40,
                                       height: 160 + CGFloat(i) * 40)
                                .scaleEffect(pulseScale)
                                .opacity(pulseOpacity)
                                .animation(
                                    .easeInOut(duration: 1.5)
                                    .repeatForever(autoreverses: true)
                                    .delay(Double(i) * 0.3),
                                    value: pulseScale
                                )
                        }
                    }

                    if appState.voiceState == .speaking {
                        ForEach(0..<3, id: \.self) { i in
                            Circle()
                                .stroke(accentColor.opacity(0.5), lineWidth: 3)
                                .frame(width: 160 + CGFloat(i) * 40,
                                       height: 160 + CGFloat(i) * 40)
                                .scaleEffect(1.0 + CGFloat.random(in: 0...0.1))
                                .animation(
                                    .easeInOut(duration: 0.3)
                                    .repeatForever(autoreverses: true),
                                    value: appState.audioPlayer.isPlaying
                                )
                        }
                    }

                    // Big mic button
                    Button(action: { appState.toggleListening() }) {
                        ZStack {
                            Circle()
                                .fill(buttonColor)
                                .frame(width: 140, height: 140)
                                .shadow(color: accentColor.opacity(0.5), radius: 20)

                            Image(systemName: buttonIcon)
                                .font(.system(size: 50, weight: .medium))
                                .foregroundColor(.white)
                        }
                    }
                    .buttonStyle(.plain)
                }

                // Status text
                Text(appState.statusText)
                    .font(.title2)
                    .fontWeight(.medium)
                    .foregroundColor(.white)

                if !appState.sessionDebugText.isEmpty {
                    Text(appState.sessionDebugText)
                        .font(.caption2)
                        .foregroundColor(.gray)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 24)
                        .lineLimit(2)
                }

                // Current transcript (while listening)
                if appState.voiceState == .listening && !appState.speechRecognizer.currentTranscript.isEmpty {
                    Text(appState.speechRecognizer.currentTranscript)
                        .font(.body)
                        .foregroundColor(.gray)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 40)
                        .lineLimit(3)
                }

                Spacer()
                Spacer()
            }
        }
        .onAppear {
            // Start pulse animation
            pulseScale = 1.15
            pulseOpacity = 0.2
        }
        .preferredColorScheme(.dark)
    }

    private var buttonColor: Color {
        switch appState.voiceState {
        case .idle:
            return .gray.opacity(0.5)
        case .listening:
            return accentColor
        case .processing:
            return .orange.opacity(0.7)
        case .speaking:
            return .red.opacity(0.7)
        }
    }

    private var buttonIcon: String {
        switch appState.voiceState {
        case .idle:
            return "mic.slash"
        case .listening:
            return "mic"
        case .processing:
            return "ellipsis"
        case .speaking:
            return "stop.fill"
        }
    }
}
