import Foundation
import CoreGraphics

@main struct GeometryChecks {
    static func main() {
        var checked = 0
        func check(_ result: Bool) { checked += 1; precondition(result, "Embedded browser geometry failed") }
        let bounds = CGRect(x: 0, y: 0, width: 1200, height: 840)
        var message: [String: Any] = ["visible": true, "viewport": ["width": 1200, "height": 840], "rect": ["x": 100, "y": 250, "width": 1000, "height": 500], "clip": ["x": 60, "y": 20, "width": 1080, "height": 800]]
        let initial = BrowserGeometry.layout(message, in: bounds)!
        check(initial.full == CGRect(x: 100, y: 250, width: 1000, height: 500))
        check(initial.visible == initial.full)
        message["rect"] = ["x": 100, "y": -200, "width": 1000, "height": 500]
        let scrolled = BrowserGeometry.layout(message, in: bounds)!
        check(scrolled.visible == CGRect(x: 100, y: 20, width: 1000, height: 280))
        check(scrolled.full.height == 500) // Clipping must not reflow the provider.
        message["rect"] = ["x": 100, "y": -600, "width": 1000, "height": 500]
        check(BrowserGeometry.layout(message, in: bounds) == nil)
        message["rect"] = ["x": 100, "y": 100, "width": 500, "height": 300]
        message["viewport"] = ["width": 600, "height": 420]
        check(BrowserGeometry.layout(message, in: bounds)?.full == CGRect(x: 200, y: 200, width: 1000, height: 600))
        message["visible"] = false
        check(BrowserGeometry.layout(message, in: bounds) == nil)
        message["visible"] = true
        for bad in [Double.nan, Double.infinity, -Double.infinity, 20_001.0] {
            message["rect"] = ["x": bad, "y": 0.0, "width": 500.0, "height": 300.0]
            check(BrowserGeometry.layout(message, in: bounds) == nil)
        }
        message["rect"] = ["x": 100, "y": 100, "width": 500, "height": 300]
        for viewport in [["width": 0, "height": 420], ["width": 600, "height": -1]] {
            message["viewport"] = viewport
            check(BrowserGeometry.layout(message, in: bounds) == nil)
        }
        message["viewport"] = ["width": 1200, "height": 840]
        message["clip"] = ["x": -200, "y": -200, "width": 2000, "height": 2000]
        message["rect"] = ["x": -100, "y": -100, "width": 2000, "height": 2000]
        check(BrowserGeometry.layout(message, in: bounds)?.visible == bounds)
        message["rect"] = ["x": 100, "y": 100, "width": -500, "height": 300]
        check(BrowserGeometry.layout(message, in: bounds) == nil)
        check(BrowserGeometry.layout([:], in: bounds) == nil)
        message = ["visible": true, "viewport": ["width": 1200, "height": 840], "rect": ["x": 44, "y": 210, "width": 708, "height": 480], "clip": ["x": 21, "y": 150, "width": 1158, "height": 600]]
        let docked = BrowserGeometry.layout(message, in: bounds)!
        check(docked.visible.maxX == 752) // Assistant starts at x=770; no overlap.
        message["rect"] = ["x": 44, "y": 40, "width": 708, "height": 480]
        let headerClip = BrowserGeometry.layout(message, in: bounds)!
        check(headerClip.visible.minY == 150) // Fixed project header is protected.
        check(headerClip.full.height == 480) // Clipping does not resize provider content.
        message["rect"] = ["x": 0, "y": 0, "width": 0, "height": 0]
        check(BrowserGeometry.layout(message, in: bounds) == nil) // Compact chat hides provider.
        print("Embedded browser: \(checked) geometry checks passed")
    }
}
