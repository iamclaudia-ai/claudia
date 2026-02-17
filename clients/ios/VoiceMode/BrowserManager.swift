import Foundation
import WebKit
import SwiftUI
import Combine

/// Content extracted from a web page
struct PageContent {
    let title: String
    let url: URL?
    let text: String
    let headings: [String]
}

/// WKWebView wrapper for in-app browsing during voice conversations.
///
/// Capabilities:
/// - Navigate to any URL
/// - Extract page content (title, text, headings) via JS
/// - Take screenshots of the visible area
/// - Execute arbitrary JavaScript
/// - Track navigation state (loading, canGoBack/Forward, current URL)
class BrowserManager: NSObject, ObservableObject {
    @Published var currentURL: URL?
    @Published var pageTitle: String = ""
    @Published var isLoading: Bool = false
    @Published var canGoBack: Bool = false
    @Published var canGoForward: Bool = false
    @Published var estimatedProgress: Double = 0

    /// The underlying WKWebView — created lazily, accessed by BrowserView
    private(set) var webView: WKWebView!

    override init() {
        super.init()

        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []

        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.allowsBackForwardNavigationGestures = true

        // Observe KVO properties
        webView.addObserver(self, forKeyPath: "loading", options: .new, context: nil)
        webView.addObserver(self, forKeyPath: "title", options: .new, context: nil)
        webView.addObserver(self, forKeyPath: "URL", options: .new, context: nil)
        webView.addObserver(self, forKeyPath: "canGoBack", options: .new, context: nil)
        webView.addObserver(self, forKeyPath: "canGoForward", options: .new, context: nil)
        webView.addObserver(self, forKeyPath: "estimatedProgress", options: .new, context: nil)
    }

    deinit {
        webView.removeObserver(self, forKeyPath: "loading")
        webView.removeObserver(self, forKeyPath: "title")
        webView.removeObserver(self, forKeyPath: "URL")
        webView.removeObserver(self, forKeyPath: "canGoBack")
        webView.removeObserver(self, forKeyPath: "canGoForward")
        webView.removeObserver(self, forKeyPath: "estimatedProgress")
    }

    // MARK: - Navigation

    /// Navigate to a URL
    func navigate(to url: URL) {
        let request = URLRequest(url: url)
        webView.load(request)
        print("[Browser] Navigating to: \(url)")
    }

    /// Navigate to a URL string (convenience)
    func navigate(to urlString: String) {
        // If it looks like a search query (no dots, no scheme), search Google
        let trimmed = urlString.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.contains(".") && !trimmed.hasPrefix("http") {
            let query = trimmed.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? trimmed
            if let searchURL = URL(string: "https://www.google.com/search?q=\(query)") {
                navigate(to: searchURL)
            }
            return
        }

        var urlStr = trimmed
        if !urlStr.hasPrefix("http://") && !urlStr.hasPrefix("https://") {
            urlStr = "https://" + urlStr
        }

        if let url = URL(string: urlStr) {
            navigate(to: url)
        }
    }

    func goBack() {
        webView.goBack()
    }

    func goForward() {
        webView.goForward()
    }

    func reload() {
        webView.reload()
    }

    func stopLoading() {
        webView.stopLoading()
    }

    // MARK: - Content Extraction

    /// Extract page content (title, text, headings) via JavaScript
    func extractContent() async -> PageContent? {
        let js = """
        (function() {
            var headings = Array.from(document.querySelectorAll('h1, h2, h3')).map(h => h.textContent.trim());
            var text = document.body.innerText.substring(0, 5000);
            return JSON.stringify({
                title: document.title,
                url: window.location.href,
                text: text,
                headings: headings
            });
        })()
        """

        do {
            if let result = try await webView.evaluateJavaScript(js) as? String,
               let data = result.data(using: .utf8),
               let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] {
                return PageContent(
                    title: json["title"] as? String ?? "",
                    url: URL(string: json["url"] as? String ?? ""),
                    text: json["text"] as? String ?? "",
                    headings: json["headings"] as? [String] ?? []
                )
            }
        } catch {
            print("[Browser] Content extraction failed: \(error)")
        }
        return nil
    }

    /// Take a screenshot of the visible area
    func takeScreenshot() async -> UIImage? {
        let config = WKSnapshotConfiguration()
        do {
            let image = try await webView.takeSnapshot(configuration: config)
            print("[Browser] Screenshot taken: \(image.size)")
            return image
        } catch {
            print("[Browser] Screenshot failed: \(error)")
            return nil
        }
    }

    /// Execute arbitrary JavaScript and return the result
    func executeJavaScript(_ script: String) async -> Any? {
        do {
            return try await webView.evaluateJavaScript(script)
        } catch {
            print("[Browser] JS execution failed: \(error)")
            return nil
        }
    }

    // MARK: - KVO

    override func observeValue(forKeyPath keyPath: String?,
                                of object: Any?,
                                change: [NSKeyValueChangeKey: Any]?,
                                context: UnsafeMutableRawPointer?) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.isLoading = self.webView.isLoading
            self.pageTitle = self.webView.title ?? ""
            self.currentURL = self.webView.url
            self.canGoBack = self.webView.canGoBack
            self.canGoForward = self.webView.canGoForward
            self.estimatedProgress = self.webView.estimatedProgress
        }
    }
}

// MARK: - WKNavigationDelegate

extension BrowserManager: WKNavigationDelegate {
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        print("[Browser] Loading: \(webView.url?.absoluteString ?? "unknown")")
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        print("[Browser] Loaded: \(webView.title ?? "untitled") — \(webView.url?.absoluteString ?? "")")
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        print("[Browser] Navigation failed: \(error)")
    }

    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        // Allow all navigation
        decisionHandler(.allow)
    }
}
