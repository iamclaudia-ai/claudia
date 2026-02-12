import SwiftUI
import WidgetKit

/// SwiftUI view for the Voice Mode widget
///
/// Displays a purple microphone button that can appear as:
/// - accessoryCircular: Round button for lock screen
/// - accessoryRectangular: Wider button for lock screen
struct VoiceModeWidgetView: View {
    @Environment(\.widgetFamily) var family

    var body: some View {
        switch family {
        case .accessoryCircular:
            CircularWidgetView()
        case .accessoryRectangular:
            RectangularWidgetView()
        default:
            CircularWidgetView()
        }
    }
}

/// Circular widget for lock screen accessory
private struct CircularWidgetView: View {
    var body: some View {
        ZStack {
            // Purple background circle
            Circle()
                .fill(Color.purple.opacity(0.8))

            // Microphone icon
            Image(systemName: "mic.fill")
                .foregroundColor(.white)
                .font(.title2)
        }
        .widgetAccentable()
    }
}

/// Rectangular widget for lock screen accessory
private struct RectangularWidgetView: View {
    var body: some View {
        HStack(spacing: 8) {
            // Microphone icon
            Image(systemName: "mic.fill")
                .foregroundColor(.purple)
                .font(.title3)

            // Label text
            Text("Talk to Claudia")
                .foregroundColor(.primary)
                .font(.caption)
                .fontWeight(.medium)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(Color.purple.opacity(0.1))
        )
        .widgetAccentable()
    }
}

/// Preview for development
#Preview("Circular", as: .accessoryCircular) {
    VoiceModeWidget()
} timeline: {
    VoiceModeEntry()
}

#Preview("Rectangular", as: .accessoryRectangular) {
    VoiceModeWidget()
} timeline: {
    VoiceModeEntry()
}