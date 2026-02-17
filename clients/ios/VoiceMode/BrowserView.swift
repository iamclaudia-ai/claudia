import SwiftUI
import WebKit

/// UIViewRepresentable wrapper for WKWebView
struct WebViewRepresentable: UIViewRepresentable {
    let webView: WKWebView

    func makeUIView(context: Context) -> WKWebView {
        webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {
        // No-op — BrowserManager controls the web view
    }
}

/// In-app browser for viewing web pages during voice conversations.
///
/// Presented as a sheet modal over the voice UI. Features:
/// - Address bar with URL input
/// - Back/forward/reload navigation controls
/// - Loading progress bar
/// - Full WKWebView with swipe navigation
struct BrowserView: View {
    @ObservedObject var browser: BrowserManager
    @Environment(\.dismiss) private var dismiss

    @State private var addressText: String = ""
    @FocusState private var addressFocused: Bool

    // Claudia's purple
    private let accentColor = Color(red: 0.533, green: 0.4, blue: 0.867)

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                // Address bar
                HStack(spacing: 8) {
                    // Back
                    Button(action: { browser.goBack() }) {
                        Image(systemName: "chevron.left")
                            .foregroundColor(browser.canGoBack ? accentColor : .gray)
                    }
                    .disabled(!browser.canGoBack)

                    // Forward
                    Button(action: { browser.goForward() }) {
                        Image(systemName: "chevron.right")
                            .foregroundColor(browser.canGoForward ? accentColor : .gray)
                    }
                    .disabled(!browser.canGoForward)

                    // URL field
                    HStack {
                        Image(systemName: browser.isLoading ? "arrow.clockwise" : "magnifyingglass")
                            .foregroundColor(.gray)
                            .font(.caption)

                        TextField("Search or enter URL", text: $addressText)
                            .textFieldStyle(.plain)
                            .font(.system(.body, design: .monospaced))
                            .autocapitalization(.none)
                            .disableAutocorrection(true)
                            .keyboardType(.URL)
                            .focused($addressFocused)
                            .submitLabel(.go)
                            .onSubmit {
                                browser.navigate(to: addressText)
                                addressFocused = false
                            }
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
                    .background(Color(.systemGray6))
                    .cornerRadius(10)

                    // Reload / Stop
                    Button(action: {
                        if browser.isLoading {
                            browser.stopLoading()
                        } else {
                            browser.reload()
                        }
                    }) {
                        Image(systemName: browser.isLoading ? "xmark" : "arrow.clockwise")
                            .foregroundColor(accentColor)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)

                // Progress bar
                if browser.isLoading {
                    GeometryReader { geometry in
                        Rectangle()
                            .fill(accentColor)
                            .frame(width: geometry.size.width * browser.estimatedProgress, height: 2)
                            .animation(.easeInOut(duration: 0.2), value: browser.estimatedProgress)
                    }
                    .frame(height: 2)
                } else {
                    Rectangle()
                        .fill(Color.clear)
                        .frame(height: 2)
                }

                // Web view
                WebViewRepresentable(webView: browser.webView)
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    VStack(spacing: 1) {
                        Text(browser.pageTitle.isEmpty ? "Browser" : browser.pageTitle)
                            .font(.caption)
                            .fontWeight(.semibold)
                            .lineLimit(1)
                        if let host = browser.currentURL?.host {
                            Text(host)
                                .font(.caption2)
                                .foregroundColor(.gray)
                        }
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") {
                        dismiss()
                    }
                    .foregroundColor(accentColor)
                }
            }
        }
        .onChange(of: browser.currentURL) { _, newURL in
            // Sync address bar with current URL (only when not editing)
            if !addressFocused, let url = newURL {
                addressText = url.absoluteString
            }
        }
        .onAppear {
            if let url = browser.currentURL {
                addressText = url.absoluteString
            }
        }
    }
}
