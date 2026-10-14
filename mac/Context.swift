import Cocoa
import WebKit

final class Canvas: NSView {
    override var isFlipped: Bool { true }
}

final class ContextApp: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
    private var window: NSWindow!
    private let canvas = Canvas()
    private var hub: WKWebView!
    private var space: WKWebView!
    private var currentEntry: URL?
    private let browserPanel = Canvas()
    private let browserClip = Canvas()
    private var embedded = false
    private var embeddedFrame: [String: Any]?
    private var pendingEmbeddedURL: URL?
    private var pendingBrowserURL: URL?
    private var escapeMonitor: Any?
    private var closeButton: NSButton!
    private var assistantButton: NSButton!
    private var floatingOpened = false
    private var lastBrowserContext = ""
    private let toolbar = NSView()
    private let address = NSTextField(string: "https://spaces.th-koeln.de/")
    private let browserStatus = NSTextField(labelWithString: "TH-Spaces")
    private var backButton: NSButton!
    private var forwardButton: NSButton!
    private var observations: [NSKeyValueObservation] = []
    private var resizeObserver: NSObjectProtocol?
    private let hubURL = URL(string: "http://127.0.0.1:4318/#today")!
    private var agentRequestID: String?
    private var agentOffset = 0
    private var agentLinks = Set<URL>()
    private var agentControls = Set<String>()
    private var ownedServer: Process?
    private var hubReconnectAttempts = 0
    private var historyEntries: [URL: URL] = [:]
    private var transfers: BrowserTransfers!

    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu()
        let appMenuItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Arbeitsbereich neu laden", action: #selector(reloadHub(_:)), keyEquivalent: "r")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "Context beenden", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appMenuItem.submenu = appMenu
        menu.addItem(appMenuItem)
        let editItem = NSMenuItem()
        let edit = NSMenu(title: "Bearbeiten")
        edit.addItem(withTitle: "Ausschneiden", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Kopieren", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Einfügen", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Alles auswählen", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        menu.addItem(editItem)
        NSApp.mainMenu = menu

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 840), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Context — Code & Context \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "")"
        window.minSize = NSSize(width: 650, height: 520)
        window.contentView = canvas
        transfers = BrowserTransfers(window: window) { [weak self] message in self?.window.subtitle = message }
        let hubConfig = WKWebViewConfiguration()
        hubConfig.websiteDataStore = .default()
        hubConfig.userContentController.add(self, name: "contextSpace")
        hubConfig.userContentController.add(self, name: "contextAgent")
        hubConfig.userContentController.add(self, name: "contextFloating")
        hub = WKWebView(frame: canvas.bounds, configuration: hubConfig)
        hub.autoresizingMask = [.width, .height]
        hub.navigationDelegate = self
        hub.uiDelegate = self
        canvas.addSubview(hub)
        let spaceConfig = WKWebViewConfiguration()
        spaceConfig.websiteDataStore = .default()
        // The provider has no bridge or cookie export. The agent only reads DOM
        // through a fixed script in an isolated content world on explicit request.
        space = WKWebView(frame: NSRect(x: 0, y: 70, width: 800, height: 500), configuration: spaceConfig)
        space.navigationDelegate = self
        space.uiDelegate = self
        space.allowsBackForwardNavigationGestures = true
        buildBrowserPanel()
        assistantButton = NSButton(title: "✳", target: self, action: #selector(toggleAssistant(_:)))
        assistantButton.isBordered = false
        assistantButton.font = .systemFont(ofSize: 31)
        assistantButton.contentTintColor = .white
        assistantButton.wantsLayer = true
        assistantButton.layer?.backgroundColor = NSColor(calibratedRed: 0.56, green: 0.24, blue: 0.36, alpha: 1).cgColor
        assistantButton.layer?.cornerRadius = 26
        assistantButton.setAccessibilityLabel("Kontextassistent öffnen")
        assistantButton.toolTip = "Frage zum aktuellen Kontext · ⌘⇧K"
        canvas.addSubview(assistantButton)
        layoutBrowser()
        escapeMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self = self, self.window.isKeyWindow else { return event }
            if event.keyCode == 40 && event.modifierFlags.contains([.command, .shift]) {
                self.toggleAssistant(nil); return nil
            }
            guard event.keyCode == 53, self.embedded || self.floatingOpened else { return event }
            self.hub.evaluateJavaScript("(() => { const search=document.querySelector('#search-modal[open]'); if(search){search.close();return;} const panel=document.querySelector('#context-agent-panel'); if(panel && !panel.hidden){window.dispatchEvent(new CustomEvent('context-agent-toggle',{detail:{open:false}}));return;} document.querySelector('#modal[open]')?.close(); })()", completionHandler: nil)
            self.window.makeFirstResponder(self.hub)
            return nil
        }
        resizeObserver = NotificationCenter.default.addObserver(forName: NSWindow.didResizeNotification, object: window, queue: .main) { [weak self] _ in self?.layoutBrowser() }
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        connectHub()
    }


    private func buildBrowserPanel() {
        browserPanel.frame = NSRect(x: 0, y: 0, width: 800, height: 570)
        browserClip.wantsLayer = true
        browserClip.layer?.masksToBounds = true
        browserPanel.wantsLayer = true
        browserPanel.appearance = NSAppearance(named: .aqua)
        browserPanel.layer?.backgroundColor = NSColor(calibratedWhite: 0.965, alpha: 1).cgColor
        toolbar.autoresizingMask = [.width]
        browserPanel.addSubview(toolbar)
        backButton = NSButton(title: "←", target: self, action: #selector(back(_:)))
        backButton.toolTip = "Zurück"
        forwardButton = NSButton(title: "→", target: self, action: #selector(forward(_:)))
        forwardButton.toolTip = "Vorwärts"
        let reload = NSButton(title: "↻", target: self, action: #selector(reload(_:)))
        reload.toolTip = "Neu laden"
        let close = NSButton(title: "×", target: self, action: #selector(closeBrowser(_:)))
        close.toolTip = "Browser schließen"
        closeButton = close
        let outside = NSButton(title: "↗", target: self, action: #selector(openOutside(_:)))
        outside.toolTip = "Dienst in deinem Browser öffnen"
        for button in [backButton!, forwardButton!, reload, outside, close] {
            button.bezelStyle = .texturedRounded
            button.widthAnchor.constraint(equalToConstant: 30).isActive = true
        }
        address.isEditable = false
        address.isSelectable = true
        address.font = .systemFont(ofSize: 11)
        address.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        address.setContentHuggingPriority(NSLayoutConstraint.Priority(1), for: .horizontal)
        let stack = NSStackView(views: [backButton, forwardButton, reload, address, outside, close])
        stack.orientation = .horizontal
        stack.distribution = .fill
        stack.alignment = .centerY
        stack.spacing = 7
        stack.translatesAutoresizingMaskIntoConstraints = false
        toolbar.addSubview(stack)
        browserStatus.font = .systemFont(ofSize: 11)
        browserStatus.textColor = .secondaryLabelColor
        browserStatus.lineBreakMode = .byTruncatingTail
        browserStatus.translatesAutoresizingMaskIntoConstraints = false
        toolbar.addSubview(browserStatus)
        space.translatesAutoresizingMaskIntoConstraints = true
        browserPanel.addSubview(space)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: toolbar.leadingAnchor, constant: 10), stack.trailingAnchor.constraint(equalTo: toolbar.trailingAnchor, constant: -10),
            stack.topAnchor.constraint(equalTo: toolbar.topAnchor, constant: 10),
            browserStatus.leadingAnchor.constraint(equalTo: stack.leadingAnchor), browserStatus.trailingAnchor.constraint(equalTo: stack.trailingAnchor),
            browserStatus.topAnchor.constraint(equalTo: stack.bottomAnchor, constant: 7)
        ])
        observations = [
            space.observe(\.url, options: [.new]) { [weak self] view, _ in self?.address.stringValue = BrowserPolicy.displayURL(view.url) },
            space.observe(\.canGoBack, options: [.initial, .new]) { [weak self] view, _ in self?.backButton.isEnabled = view.canGoBack },
            space.observe(\.canGoForward, options: [.initial, .new]) { [weak self] view, _ in self?.forwardButton.isEnabled = view.canGoForward }
        ]
    }

    private func layoutBrowser() {
        let bounds = canvas.bounds
        defer {
            if let button = assistantButton {
                button.frame = NSRect(x: max(12, bounds.width - 74), y: max(12, bounds.height - 74), width: 52, height: 52)
                canvas.addSubview(button, positioned: .above, relativeTo: nil)
            }
            publishBrowserContext()
        }
        if embedded {
            hub.frame = bounds
            guard let message = embeddedFrame, let geometry = BrowserGeometry.layout(message, in: bounds) else { browserClip.isHidden = true; return }
            browserClip.isHidden = false
            browserClip.frame = geometry.visible
            browserPanel.frame = NSRect(x: geometry.full.minX - geometry.visible.minX, y: geometry.full.minY - geometry.visible.minY, width: geometry.full.width, height: geometry.full.height)
            toolbar.frame = NSRect(x: 0, y: 0, width: geometry.full.width, height: 70)
            space.frame = NSRect(x: 0, y: 70, width: geometry.full.width, height: max(0, geometry.full.height - 70))
            browserPanel.layoutSubtreeIfNeeded()
            // Give WebKit its final, visible viewport before its first navigation.
            if let url = pendingEmbeddedURL {
                pendingEmbeddedURL = nil
                DispatchQueue.main.async { [weak self] in
                    guard let self = self, self.embedded, self.currentEntry == url else { return }
                    self.space.load(URLRequest(url: url))
                }
            }
            return
        }
        if browserPanel.superview == nil { hub.frame = bounds; return }
        let width = min(720, max(480, bounds.width * 0.52))
        hub.frame = NSRect(x: 0, y: 0, width: bounds.width - width, height: bounds.height)
        browserPanel.frame = NSRect(x: bounds.width - width, y: 0, width: width, height: bounds.height)
        toolbar.frame = NSRect(x: 0, y: 0, width: width, height: 70)
        space.frame = NSRect(x: 0, y: 70, width: width, height: max(0, bounds.height - 70))
        browserPanel.layoutSubtreeIfNeeded()

    }
    @objc private func reloadHub(_ sender: Any?) {
        if let id = agentRequestID { finishAgent(id, ["error": "Der Arbeitsbereich wird neu geladen."]) }
        closeBrowser(nil); floatingOpened = false; assistantButton.title = "✳"
        assistantButton.setAccessibilityLabel("Kontextassistent öffnen")
        lastBrowserContext = ""; hub.reload()
    }
    @objc private func back(_ sender: Any?) { space.goBack() }
    @objc private func forward(_ sender: Any?) { space.goForward() }
    @objc private func reload(_ sender: Any?) { space.reload() }
    @objc private func openOutside(_ sender: Any?) { if let url = space.url.flatMap({ BrowserPolicy.entryURL($0.absoluteString) }) ?? currentEntry { NSWorkspace.shared.open(url) } }
    @objc private func closeBrowser(_ sender: Any?) {
        if let id = agentRequestID { finishAgent(id, ["error": "Der Spaces-Browser wurde geschlossen."]) }
        embedded = false; embeddedFrame = nil; pendingEmbeddedURL = nil; pendingBrowserURL = nil
        browserPanel.removeFromSuperview(); browserClip.removeFromSuperview()
        window.minSize = NSSize(width: 650, height: 520); layoutBrowser()
        window.makeFirstResponder(hub)
    }

    private func embedBrowser(_ url: URL) {
        embedded = true; embeddedFrame = nil
        browserPanel.removeFromSuperview()
        browserClip.addSubview(browserPanel)
        browserClip.frame = .zero
        browserClip.isHidden = false
        if browserClip.superview == nil { canvas.addSubview(browserClip) }
        closeButton.isHidden = true
        window.minSize = NSSize(width: 650, height: 520)
        hub.frame = canvas.bounds
        if currentEntry != url || space.url == nil { currentEntry = url; pendingEmbeddedURL = url }
    }

    private func openBrowser(_ url: URL) {
        if embedded {
            if currentEntry != url || space.url != url { currentEntry = url; space.load(URLRequest(url: url)) }
            return
        }
        closeButton.isHidden = false
        if browserPanel.superview == nil { canvas.addSubview(browserPanel) }
        window.minSize = NSSize(width: 1000, height: 650)
        if window.frame.width < 1000 { window.setContentSize(NSSize(width: 1000, height: max(650, canvas.bounds.height))) }
        layoutBrowser()
        if currentEntry != url || space.url != url {
            currentEntry = url
            pendingBrowserURL = url
            // Attach and size WebKit before starting its first navigation.
            DispatchQueue.main.async { [weak self] in
                guard let self = self, !self.embedded, self.browserPanel.superview != nil, self.pendingBrowserURL == url else { return }
                self.pendingBrowserURL = nil
                self.space.load(URLRequest(url: url))
            }
        }
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        let origin = message.frameInfo.securityOrigin
        guard message.webView === hub, message.frameInfo.isMainFrame, BrowserPolicy.messageOrigin(origin.protocol, origin.host, origin.port, mainFrame: message.frameInfo.isMainFrame),
              let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        if message.name == "contextAgent" { handleAgent(body); return }
        if message.name == "contextFloating" {
            if type == "state", let opened = body["open"] as? Bool {
                floatingOpened = opened
                assistantButton.title = opened ? "×" : "✳"
                assistantButton.setAccessibilityLabel(opened ? "Kontextassistent schließen" : "Kontextassistent öffnen")
            }
            return
        }
        guard message.name == "contextSpace" else { return }
        switch type {
        case "embed":
            guard let value = body["url"] as? String, let url = BrowserPolicy.courseURL(value) else { return }
            embedBrowser(url)
        case "frame":
            guard embedded else { return }
            embeddedFrame = body; layoutBrowser()
        case "detach":
            if embedded { closeBrowser(nil) }
        case "open":
            guard let value = body["url"] as? String, let url = BrowserPolicy.entryURL(value) else { return }
            openBrowser(url)
        case "close": closeBrowser(nil)
        default: break
        }
    }

    private func finishAgent(_ id: String, _ value: [String: Any]) {
        guard agentRequestID == id else { return }
        agentRequestID = nil
        var payload = value; payload["id"] = id
        guard hub.url.map(BrowserPolicy.hubURL) == true,
              let data = try? JSONSerialization.data(withJSONObject: payload, options: [.fragmentsAllowed]), let json = String(data: data, encoding: .utf8) else { return }
        hub.evaluateJavaScript("window.dispatchEvent(new CustomEvent('context-agent-browser',{detail:\(json)}))", completionHandler: nil)
    }

    private func handleAgent(_ body: [String: Any]) {
        guard let id = body["id"] as? String, BrowserAgent.validID(id), let type = body["type"] as? String else { return }
        if type == "cancel" { if agentRequestID == id { agentRequestID = nil; pendingBrowserURL = nil; space.stopLoading() }; return }
        guard type == "request", agentRequestID == nil, let command = body["command"] as? String,
              Set(body.keys).isSubset(of: ["type", "id", "command", "url", "offset", "controlId", "direction"]) else { return }
        agentRequestID = id
        if command == "start" || command == "open" {
            guard let value = body["url"] as? String, let url = BrowserAgent.pageURL(value), command == "start" || agentLinks.contains(url) else { finishAgent(id, ["error": "Dieser Spaces-Link wurde noch nicht auf einer gelesenen Seite gefunden."]); return }
            if command == "start" { agentLinks = [url]; agentControls.removeAll() }
            agentOffset = 0
            openBrowser(url)
            if pendingBrowserURL == nil && space.url == url && !space.isLoading { readAgentPage(id) }
        } else if command == "read" {
            let offset = body["offset"] as? Int ?? 0
            guard offset >= 0, offset <= 50000 else { finishAgent(id, ["error": "Ungültiger Textabschnitt."]); return }
            agentOffset = offset
            if space.isLoading { return }
            readAgentPage(id)
        } else if command == "click" || command == "scroll" {
            guard space.url.flatMap({ BrowserAgent.pageURL($0.absoluteString) }) != nil else { finishAgent(id, ["error": "Öffne zuerst eine angemeldete Spaces-Seite."]); return }
            let script: String
            if command == "click" {
                guard let control = body["controlId"] as? String, BrowserAgent.controlID(control), agentControls.contains(control),
                      let data = try? JSONSerialization.data(withJSONObject: [control]), let json = String(data: data, encoding: .utf8) else { finishAgent(id, ["error": "Dieser lesende Seitenbereich wurde nicht gefunden."]); return }
                let identifier = String(json.dropFirst().dropLast())
                script = "(() => { const e=document.getElementById(\(identifier)); if(!e || !e.getClientRects().length || !e.matches('#primary-swap-menu-label,#secondary-swap-menu-label,h1 button[id^=accordion-item-],h2 button[id^=accordion-item-],h3 button[id^=accordion-item-],h4 button[id^=accordion-item-]')) return false; e.click(); return true; })()"
            } else {
                guard let direction = body["direction"] as? String, ["down", "up"].contains(direction) else { finishAgent(id, ["error": "Ungültige Scrollrichtung."]); return }
                script = "(() => { window.scrollBy(0, window.innerHeight * \(direction == "down" ? "0.85" : "-0.85")); return true; })()"
            }
            agentOffset = 0
            space.evaluateJavaScript(script, in: nil, in: .world(name: "ContextReadOnly")) { [weak self] result in
                guard let self = self, self.agentRequestID == id else { return }
                guard case .success(let value) = result, value as? Bool == true else { self.finishAgent(id, ["error": "Der lesende Browser-Schritt konnte nicht ausgeführt werden."]); return }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.75) { [weak self] in
                    guard let self = self, self.agentRequestID == id, !self.space.isLoading else { return }
                    self.readAgentPage(id)
                }
            }
        } else { finishAgent(id, ["error": "Unbekanntes Browserwerkzeug."]) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 28) { [weak self] in
            guard let self = self, self.agentRequestID == id else { return }
            self.space.stopLoading(); self.finishAgent(id, ["error": "Spaces hat zu lange gebraucht. Prüfe den eingebauten Browser."])
        }
    }

    @objc private func toggleAssistant(_ sender: Any?) {
        guard hub.url.map(BrowserPolicy.hubURL) == true else { return }
        hub.evaluateJavaScript("window.dispatchEvent(new CustomEvent('context-agent-toggle'))", completionHandler: nil)
        window.makeFirstResponder(hub)
    }

    // Share only page availability. Provider DOM is read separately on a tool request.
    private func publishBrowserContext(force: Bool = false) {
        guard hub != nil, space != nil, hub.url.map(BrowserPolicy.hubURL) == true else { return }
        let payload: [String: Bool] = ["visible": browserPanel.superview != nil, "readable": !space.isLoading && space.url.flatMap({ BrowserAgent.pageURL($0.absoluteString) }) != nil]
        guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]), let json = String(data: data, encoding: .utf8), force || json != lastBrowserContext else { return }
        lastBrowserContext = json
        hub.evaluateJavaScript("window.dispatchEvent(new CustomEvent('context-browser-page',{detail:\(json)}))", completionHandler: nil)
    }

    private func readAgentPage(_ id: String) {
        guard agentRequestID == id else { return }
        guard let currentURL = space.url, BrowserAgent.pageURL(currentURL.absoluteString) != nil else {
            finishAgent(id, ["loginRequired": true, "title": "Spaces-Anmeldung erforderlich", "text": "", "links": [], "url": "https://spaces.th-koeln.de/"]); return
        }
        space.evaluateJavaScript(BrowserAgent.readScript(offset: agentOffset), in: nil, in: .world(name: "ContextReadOnly")) { [weak self] result in
            guard let self = self, self.agentRequestID == id else { return }
            switch result {
            case .success(let raw):
                guard var page = raw as? [String: Any], let links = page["links"] as? [[String: String]] else { self.finishAgent(id, ["error": "Spaces konnte nicht gelesen werden."]); return }
                let allowed = links.compactMap { link -> [String: String]? in
                    guard let value = link["url"], let url = BrowserAgent.pageURL(value), let title = link["title"] else { return nil }
                    return ["url": url.absoluteString, "title": String(title.prefix(160))]
                }
                page["links"] = allowed
                let controls = (page["controls"] as? [[String: String]] ?? []).filter { BrowserAgent.controlID($0["id"] ?? "") }
                page["controls"] = controls
                self.agentControls = Set(controls.compactMap { $0["id"] })
                if let url = self.space.url.flatMap({ BrowserAgent.pageURL($0.absoluteString) }) { page["url"] = url.absoluteString; self.agentLinks.insert(url) }
                for link in allowed { if let url = URL(string: link["url"] ?? "") { self.agentLinks.insert(url) } }
                if self.agentLinks.count > 200 { self.agentLinks = Set(allowed.compactMap { URL(string: $0["url"] ?? "") }) }
                self.finishAgent(id, page)
            case .failure: self.finishAgent(id, ["error": "Die Spaces-Seite konnte nicht gelesen werden."])
            }
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if webView === hub { publishBrowserContext(force: true) }
        if webView === space {
            layoutBrowser()
            webView.needsLayout = true
            webView.layoutSubtreeIfNeeded()
            webView.needsDisplay = true
            address.toolTip = webView.title
            browserStatus.stringValue = webView.title ?? currentEntry?.host ?? "Browser"
            if let url = webView.url, let entry = currentEntry { historyEntries[url] = entry }
            let retained = Set(webView.backForwardList.backList.map(\.url) + webView.backForwardList.forwardList.map(\.url) + [webView.url].compactMap { $0 })
            historyEntries = historyEntries.filter { retained.contains($0.key) }
            if let id = agentRequestID { readAgentPage(id) }
        }
    }
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        if webView === space { browserStatus.stringValue = "\(currentEntry?.host ?? "Dienst") wird geladen …"; publishBrowserContext() }
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        handleFailure(webView, error: error)
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        handleFailure(webView, error: error)
    }
    private func handleFailure(_ webView: WKWebView, error: Error) {
        guard (error as NSError).code != NSURLErrorCancelled else { return }
        if webView === space { browserStatus.stringValue = "Seite konnte nicht geladen werden. Neu laden oder im Browser öffnen."; if let id = agentRequestID { finishAgent(id, ["error": "Spaces konnte nicht geladen werden."]) } }
        if webView === hub {
            if hubReconnectAttempts < 3 { hubReconnectAttempts += 1; connectHub() }
            else { showStartupHelp() }
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if webView === space, action.navigationType == .backForward, let entry = historyEntries[url] { currentEntry = entry }
        if action.shouldPerformDownload, BrowserPolicy.downloadURL(url, entry: currentEntry, hub: webView === hub) {
            decisionHandler(.download); return
        }
        if webView === hub, BrowserPolicy.hubURL(url) {
            decisionHandler(.allow); return
        }
        if webView === space, BrowserPolicy.navigationURL(url, entry: currentEntry) {
            decisionHandler(.allow); return
        }
        if action.navigationType == .linkActivated {
            if let entry = BrowserPolicy.entryURL(url.absoluteString) { openBrowser(entry) }
            else if BrowserPolicy.outsideURL(url) { NSWorkspace.shared.open(url) }
        } else if webView === space, action.targetFrame?.isMainFrame != false {
            browserStatus.stringValue = "Weiterleitung außerhalb dieses Dienstes blockiert. Nutze deinen Browser."
        }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, webView === space, BrowserPolicy.navigationURL(url, entry: currentEntry) { space.load(action.request); return nil }
        if let url = action.request.url, (webView === hub || action.navigationType == .linkActivated), let entry = BrowserPolicy.entryURL(url.absoluteString) { openBrowser(entry); return nil }
        if action.navigationType == .linkActivated, let url = action.request.url, BrowserPolicy.outsideURL(url) { NSWorkspace.shared.open(url) }
        return nil
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if !response.canShowMIMEType, response.isForMainFrame, let url = response.response.url,
           BrowserPolicy.downloadURL(url, entry: currentEntry, hub: webView === hub) { decisionHandler(.download); return }
        decisionHandler(.allow)
    }
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { transfers.register(download, entry: currentEntry, hub: webView === hub) }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { transfers.register(download, entry: currentEntry, hub: webView === hub) }
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let origin = frame.securityOrigin
        let isHub = webView === hub && BrowserPolicy.messageOrigin(origin.protocol, origin.host, origin.port, mainFrame: frame.isMainFrame)
        let isProvider = webView === space && frame.request.url.map { BrowserPolicy.navigationURL($0, entry: currentEntry) } == true
        guard isHub || isProvider else { completionHandler(nil); return }
        let panel = NSOpenPanel()
        panel.title = isHub ? "Dateien für Context auswählen" : "Dateien für \(currentEntry?.host ?? "diesen Dienst") auswählen"
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = !isHub && parameters.allowsDirectories
        panel.canChooseFiles = true
        panel.beginSheetModal(for: window) { result in completionHandler(result == .OK ? panel.urls : nil) }
    }

    private func connectHub(_ attempt: Int = 0) {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 1
        config.httpCookieStorage = nil
        let session = URLSession(configuration: config)
        var request = URLRequest(url: hubURL)
        request.httpMethod = "HEAD"
        session.dataTask(with: request) { [weak self] _, response, _ in
            session.finishTasksAndInvalidate()
            DispatchQueue.main.async {
                guard let self = self else { return }
                if (response as? HTTPURLResponse)?.statusCode == 200 { self.hub.load(URLRequest(url: self.hubURL)); return }
                if attempt == 0 { self.startOwnServer() }
                if attempt < 12 { DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { self.connectHub(attempt + 1) }; return }
                self.showStartupHelp()
            }
        }.resume()
    }

    private func showStartupHelp() {
        hub.loadHTMLString("<html lang='de'><meta charset='utf-8'><style>body{font:16px system-ui;background:#f7f8f2;color:#2a2d27;padding:48px;line-height:1.7}h1{font:38px Georgia}</style><h1>Context starten</h1><p>Der lokale Server ist noch nicht erreichbar. Starte im Ordner context-hub: <code>PORT=4318 npm run dev</code>.</p><p>Node.js ab Version 22 und der Ordner context-hub neben Context.app werden benötigt.</p></html>", baseURL: hubURL)
    }

    private func startOwnServer() {
        let folder = Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent("context-hub")
        let home = FileManager.default.homeDirectoryForCurrentUser
        let candidates = [home.appendingPathComponent(".local/bin/node").path, "/opt/homebrew/bin/node", "/usr/local/bin/node"]
        guard FileManager.default.fileExists(atPath: folder.appendingPathComponent("server.mjs").path), let executable = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else { return }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = [folder.appendingPathComponent("server.mjs").path]
        process.currentDirectoryURL = folder
        var environment = ProcessInfo.processInfo.environment
        environment["PORT"] = "4318"
        process.environment = environment
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do { try process.run(); ownedServer = process } catch {}
    }
    func applicationWillTerminate(_ notification: Notification) { if ownedServer?.isRunning == true { ownedServer?.terminate() } }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

@main struct ContextMain {
    @MainActor static func main() {
        let app = NSApplication.shared
        let delegate = ContextApp()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        withExtendedLifetime(delegate) { app.run() }
    }
}
