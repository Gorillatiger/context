import Foundation
import CoreGraphics

struct BrowserGeometry {
    let full: CGRect
    let visible: CGRect

    static func layout(_ message: [String: Any], in bounds: CGRect) -> BrowserGeometry? {
        guard message["visible"] as? Bool == true,
              let viewport = message["viewport"] as? [String: Any],
              let width = number(viewport["width"]), width > 0,
              let height = number(viewport["height"]), height > 0,
              let rect = rectangle(message["rect"]), rect.width >= 280, rect.height >= 100,
              let clip = rectangle(message["clip"]), bounds.width > 0, bounds.height > 0 else { return nil }
        let sx = bounds.width / width, sy = bounds.height / height
        func scaled(_ r: CGRect) -> CGRect { CGRect(x: r.minX * sx, y: r.minY * sy, width: r.width * sx, height: r.height * sy) }
        let full = scaled(rect)
        let visible = full.intersection(scaled(clip)).intersection(bounds)
        guard !visible.isNull, visible.width > 0, visible.height > 0 else { return nil }
        return BrowserGeometry(full: full, visible: visible)
    }

    private static func number(_ value: Any?) -> CGFloat? {
        guard let value = value as? NSNumber else { return nil }
        let number = value.doubleValue
        return number.isFinite && abs(number) <= 20_000 ? CGFloat(number) : nil
    }
    private static func rectangle(_ value: Any?) -> CGRect? {
        guard let data = value as? [String: Any], let x = number(data["x"]), let y = number(data["y"]),
              let width = number(data["width"]), let height = number(data["height"]), width >= 0, height >= 0 else { return nil }
        return CGRect(x: x, y: y, width: width, height: height)
    }
}
