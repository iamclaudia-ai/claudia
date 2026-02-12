import WidgetKit
import SwiftUI

/// Entry point for the Voice Mode lock screen widget
@main
struct VoiceModeWidget: Widget {
    let kind: String = "VoiceModeWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: VoiceModeProvider()) { entry in
            VoiceModeWidgetView()
                .widgetURL(URL(string: "voicemode://launch"))
        }
        .configurationDisplayName("Voice Mode")
        .description("Tap to start talking to Claudia")
        .supportedFamilies([.accessoryCircular, .accessoryRectangular])
    }
}

/// Simple provider for the widget - no dynamic content needed
struct VoiceModeProvider: TimelineProvider {
    func placeholder(in context: Context) -> VoiceModeEntry {
        VoiceModeEntry()
    }

    func getSnapshot(in context: Context, completion: @escaping (VoiceModeEntry) -> ()) {
        let entry = VoiceModeEntry()
        completion(entry)
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<Entry>) -> ()) {
        // Static widget - no need to refresh
        let entry = VoiceModeEntry()
        let timeline = Timeline(entries: [entry], policy: .never)
        completion(timeline)
    }
}

/// Entry data for the widget (empty since it's static)
struct VoiceModeEntry: TimelineEntry {
    let date: Date = Date()
}