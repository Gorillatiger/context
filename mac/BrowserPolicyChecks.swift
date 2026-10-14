import Foundation

@main struct PolicyChecks {
    static func main() {
        var checked = 0
        func check(_ result: Bool) { checked += 1; precondition(result, "Browser boundary failed") }
        check(BrowserPolicy.courseURL("https://spaces.th-koeln.de/course/") != nil)
        check(BrowserPolicy.courseURL("https://spaces.th-koeln.de/course/index.php?page_id=12") != nil)
        for value in ["http://spaces.th-koeln.de/", "https://spaces.th-koeln.de.evil.test/", "https://u:p@spaces.th-koeln.de/", "https://spaces.th-koeln.de:8443/", "https://spaces.th-koeln.de/wp-admin/", "https://spaces.th-koeln.de/?action=logout", "https://spaces.th-koeln.de/?redirect_to=https://evil.test"] { check(BrowserPolicy.courseURL(value) == nil) }
        check(BrowserPolicy.providerURL(URL(string: "https://login.th-koeln.de/nidp/")!))
        check(!BrowserPolicy.providerURL(URL(string: "https://login.th-koeln.de.evil.test/")!))
        check(BrowserPolicy.hubURL(URL(string: "http://127.0.0.1:4318/#projects")!))
        check(!BrowserPolicy.hubURL(URL(string: "http://127.0.0.1:4317/")!))
        check(!BrowserPolicy.hubURL(URL(string: "http://u:p@127.0.0.1:4318/")!))
        check(BrowserPolicy.messageOrigin("http", "127.0.0.1", 4318, mainFrame: true))
        check(!BrowserPolicy.messageOrigin("http", "127.0.0.1", 4318, mainFrame: false))
        check(!BrowserPolicy.messageOrigin("https", "spaces.th-koeln.de", 443, mainFrame: true))
        check(BrowserPolicy.outsideURL(URL(string: "https://git.coco.study/course/repo")!))
        check(BrowserPolicy.outsideURL(URL(string: "https://bookmarks.example.test/")!))
        check(!BrowserPolicy.outsideURL(URL(string: "file:///tmp/source")!))
        check(!BrowserPolicy.outsideURL(URL(string: "https://user:password@example.test/")!))
        for host in BrowserPolicy.browserHosts {
            let entry = URL(string: "https://\(host)/")!
            check(BrowserPolicy.entryURL(entry.absoluteString) == entry)
            check(BrowserPolicy.navigationURL(entry, entry: entry))
        }
        check(BrowserPolicy.entryURL("https://login.th-koeln.de/nidp/") == nil)
        check(BrowserPolicy.entryURL("https://signal.org/") == nil)
        check(BrowserPolicy.entryURL("https://web.whatsapp.com/") == nil)
        check(BrowserPolicy.outsideURL(URL(string: "https://web.whatsapp.com/")!))
        check(BrowserPolicy.entryURL("https://webmail.th-koeln.de.evil.test/") == nil)
        check(BrowserPolicy.entryURL("https://u:p@github.com/") == nil)
        check(BrowserPolicy.navigationURL(URL(string: "https://login.th-koeln.de/nidp/")!, entry: URL(string: "https://webmail.th-koeln.de/")!))
        check(!BrowserPolicy.navigationURL(URL(string: "https://login.th-koeln.de/nidp/")!, entry: URL(string: "https://github.com/")!))
        check(!BrowserPolicy.navigationURL(URL(string: "https://github.com/")!, entry: URL(string: "https://spaces.th-koeln.de/course/")!))
        check(!BrowserPolicy.navigationURL(URL(string: "https://webmail.th-koeln.de:8443/")!, entry: URL(string: "https://webmail.th-koeln.de/")!))
        check(BrowserPolicy.displayURL(URL(string: "https://login.th-koeln.de/nidp/?SAMLRequest=synthetic#secret")!) == "https://login.th-koeln.de/nidp/")
        check(BrowserPolicy.displayURL(URL(string: "http://spaces.th-koeln.de/")!) == "")
        check(BrowserPolicy.downloadURL(URL(string: "blob:http://127.0.0.1:4318/synthetic")!, entry: nil, hub: true))
        check(!BrowserPolicy.downloadURL(URL(string: "blob:https://other.example.test/synthetic")!, entry: nil, hub: true))
        check(!BrowserPolicy.downloadURL(URL(string: "data:text/plain,test")!, entry: nil, hub: true))
        check(BrowserPolicy.downloadURL(URL(string: "blob:https://th-koeln.sciebo.de/synthetic")!, entry: URL(string: "https://th-koeln.sciebo.de/")!, hub: false))
        check(!BrowserPolicy.downloadURL(URL(string: "https://other.example.test/file")!, entry: URL(string: "https://th-koeln.sciebo.de/")!, hub: false))
        check(BrowserPolicy.navigationURL(URL(string: "https://git.coco.study/oauth/authorize")!, entry: URL(string: "https://chat.coco.study/")!))
        check(BrowserPolicy.navigationURL(URL(string: "https://chat.coco.study/oauth/gitlab/complete")!, entry: URL(string: "https://git.coco.study/")!))
        check(!BrowserPolicy.navigationURL(URL(string: "https://git.coco.study.evil.test/")!, entry: URL(string: "https://chat.coco.study/")!))
        print("Native browser: \(checked) boundary checks passed")
    }
}
