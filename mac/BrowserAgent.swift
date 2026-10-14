import Foundation

// Fixed reader and navigation controls only; no model-provided JavaScript, form entry or credential access.
enum BrowserAgent {
    static func pageURL(_ value: String) -> URL? {
        guard value.count <= 2000, BrowserPolicy.courseURL(value) != nil,
              let c = BrowserPolicy.secureComponents(value) else { return nil }
        let path = c.path.removingPercentEncoding?.lowercased() ?? c.path.lowercased()
        let blocked = ["logout", "delete", "remove", "edit", "create", "submit", "update", "auth", "login", "register", "account", "password"]
        guard !path.components(separatedBy: "/").contains(where: { part in blocked.contains(where: { part.contains($0) }) }), !["pdf", "zip", "doc", "docx", "xlsx", "png", "jpg"].contains((c.path as NSString).pathExtension.lowercased()), !value.contains(where: { $0.isWhitespace || $0.isNewline }) else { return nil }
        var safe = c; safe.fragment = nil
        return safe.url
    }
    static func controlID(_ value: String) -> Bool {
        if ["primary-swap-menu-label", "secondary-swap-menu-label"].contains(value) { return true }
        return value.range(of: "^accordion-item-[a-zA-Z0-9_-]{1,80}$", options: .regularExpression) != nil
    }
    static func validID(_ value: String) -> Bool { UUID(uuidString: value) != nil }
    static func readScript(offset: Int) -> String {
        let start = max(0, min(50000, offset))
        return """
        (() => {
          const loginRequired = location.hostname !== 'spaces.th-koeln.de' || /login|auth|password/i.test(location.pathname) || !!document.querySelector('input[type=password]');
          if (loginRequired) return {loginRequired:true,title:'Spaces-Anmeldung erforderlich',url:'https://spaces.th-koeln.de/',text:'',links:[]};
          const root = document.querySelector('#swap-container') || document.querySelector('main, [role=main], #content, .layout-content-container') || document.body;
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let node, parts=[], size=0;
          while ((node=walker.nextNode()) && size<70000) {
            const parent=node.parentElement;
            if (!parent || parent.closest('script,style,noscript,form,input,textarea,select,button,nav,header,footer,[hidden],[aria-hidden=true]')) continue;
            if (!parent.getClientRects().length) continue;
            const value=node.textContent.trim(); if(value){parts.push(value);size+=value.length+1;}
          }
          const text=parts.join('\\n');
          const links=Array.from(new Set([...root.querySelectorAll('a[href]'),...document.querySelectorAll('#defaultspace-main-menu a[href]')])).filter(a=>a.getClientRects().length&&!a.closest('form,header,footer')).map(a=>({title:(a.innerText||a.getAttribute('aria-label')||'Link').trim().slice(0,160),url:a.href})).filter(a=>{try{const u=new URL(a.url);return u.protocol==='https:'&&u.hostname==='spaces.th-koeln.de'&&!u.username&&!u.password&&a.title&&Array.from(u.searchParams.keys()).every(k=>['s','paged','page_id'].includes(k));}catch{return false;}}).slice(0,45);
          const controls=Array.from(document.querySelectorAll('#primary-swap-menu-label,#secondary-swap-menu-label,h1 button[id^=accordion-item-],h2 button[id^=accordion-item-],h3 button[id^=accordion-item-],h4 button[id^=accordion-item-]')).filter(e=>e.getClientRects().length).map(e=>({id:e.id,title:e.innerText.trim().slice(0,160)})).slice(0,30);
          return {controls,url:location.href,title:document.title.slice(0,200),text:text.slice(\(start),\(start + 5000)),offset:\(start),hasMore:text.length>\(start + 5000),links,loginRequired:false};
        })()
        """
    }
}
