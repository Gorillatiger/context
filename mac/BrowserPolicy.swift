import Foundation

enum BrowserPolicy {
    static let outsideHosts: Set<String> = ["spaces.th-koeln.de", "chat.coco.study", "git.coco.study", "th-koeln.sciebo.de", "webmail.th-koeln.de", "github.com", "obsidian.md", "web.whatsapp.com", "signal.org"]
    static let browserHosts = outsideHosts.subtracting(["obsidian.md", "signal.org", "web.whatsapp.com"])
    static let thLoginHosts: Set<String> = ["spaces.th-koeln.de", "git.coco.study", "th-koeln.sciebo.de", "webmail.th-koeln.de"]
    static func secureComponents(_ value: String) -> URLComponents? {
        guard let c = URLComponents(string: value), c.scheme == "https", c.host != nil, c.port == nil, c.user == nil, c.password == nil else { return nil }
        return c
    }
    static func courseURL(_ value: String) -> URL? {
        guard let c = secureComponents(value), c.host == "spaces.th-koeln.de", !c.path.contains("/wp-admin"), !c.path.hasSuffix("/wp-login.php"), !(c.queryItems ?? []).contains(where: { !["page_id", "paged", "s"].contains($0.name) }) else { return nil }
        return c.url
    }
    static func providerURL(_ url: URL) -> Bool {
        guard let c = secureComponents(url.absoluteString) else { return false }
        return browserHosts.contains(c.host ?? "") || c.host == "login.th-koeln.de"
    }
    static func entryURL(_ value: String) -> URL? {
        guard let c = secureComponents(value), browserHosts.contains(c.host ?? "") else { return nil }
        if c.host == "spaces.th-koeln.de" { return courseURL(value) }
        return c.url
    }
    static func navigationURL(_ url: URL, entry: URL?) -> Bool {
        guard let c = secureComponents(url.absoluteString), let host = c.host,
              let entryHost = entry?.host, browserHosts.contains(entryHost) else { return false }
        return host == entryHost || (host == "login.th-koeln.de" && thLoginHosts.contains(entryHost)) || (["chat.coco.study", "git.coco.study"].contains(entryHost) && ["chat.coco.study", "git.coco.study"].contains(host))
    }
    static func displayURL(_ url: URL?) -> String {
        guard let url = url, var c = secureComponents(url.absoluteString) else { return "" }
        c.query = nil
        c.fragment = nil
        return c.string ?? ""
    }
    static func outsideURL(_ url: URL) -> Bool {
        guard let c = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return false }
        return c.scheme == "https" && c.host != nil && c.user == nil && c.password == nil
    }
    static func downloadURL(_ url: URL, entry: URL?, hub: Bool) -> Bool {
        let source: URL
        if url.scheme == "blob" {
            guard let inner = URL(string: String(url.absoluteString.dropFirst(5))) else { return false }
            source = inner
        } else { source = url }
        return hub ? hubURL(source) : navigationURL(source, entry: entry)
    }
    static func hubURL(_ url: URL) -> Bool {
        guard let c = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return false }
        return c.scheme == "http" && c.host == "127.0.0.1" && c.port == 4318 && c.user == nil && c.password == nil
    }
    static func messageOrigin(_ scheme: String, _ host: String, _ port: Int, mainFrame: Bool) -> Bool {
        return mainFrame && scheme == "http" && host == "127.0.0.1" && port == 4318
    }
}
