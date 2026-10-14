import Foundation

@main struct BrowserAgentChecks {
    static func main() {
        var count = 0
        func check(_ condition: Bool, _ label: String) { count += 1; if !condition { fatalError(label) } }
        for value in ["https://spaces.th-koeln.de/", "https://spaces.th-koeln.de/prototyping-things-w26/", "https://spaces.th-koeln.de/?s=Prototyp", "https://spaces.th-koeln.de/?page_id=15", "https://spaces.th-koeln.de/course/?paged=2#comment"] { check(BrowserAgent.pageURL(value) != nil, "valid course") }
        for value in ["http://spaces.th-koeln.de/", "https://spaces.th-koeln.de.evil.test/", "https://evil.test/", "https://user:pass@spaces.th-koeln.de/", "https://spaces.th-koeln.de:443/", "https://spaces.th-koeln.de/wp-admin/", "https://spaces.th-koeln.de/wp-login.php", "https://spaces.th-koeln.de/user/auth/login", "https://spaces.th-koeln.de/logout/", "https://spaces.th-koeln.de/post/delete/", "https://spaces.th-koeln.de/post/edit/", "https://spaces.th-koeln.de/%6cogout/", "https://spaces.th-koeln.de/%256cogout/", "https://spaces.th-koeln.de/?action=delete", "https://spaces.th-koeln.de/?token=x", "https://spaces.th-koeln.de/file.pdf", "https://spaces.th-koeln.de/file.zip", "https://spaces.th-koeln.de/a b/", "https://spaces.th-koeln.de/" + String(repeating: "a", count: 2001)] { check(BrowserAgent.pageURL(value) == nil, "unsafe navigation") }
        check(BrowserAgent.validID(UUID().uuidString), "valid id")
        check(!BrowserAgent.validID("alert(1)"), "invalid id")
        for id in ["primary-swap-menu-label", "secondary-swap-menu-label", "accordion-item-1"] { check(BrowserAgent.controlID(id), "read control") }
        for id in ["settings-label", "send-mail", "delete-post", "accordion-item-\"alert(1)"] { check(!BrowserAgent.controlID(id), "write control rejected") }
        let script = BrowserAgent.readScript(offset: 100)
        check(script.contains("text.slice(100,5100)"), "bounded range")
        check(script.contains("input[type=password]"), "login page guard")
        check(!script.contains("document.cookie"), "no cookies")
        check(!script.contains("localStorage"), "no storage")
        check(!script.contains("fetch("), "no network script")
        check(!script.contains(".value"), "no field values")
        print("BrowserAgent: \(count) Prüfungen bestanden.")
    }
}
