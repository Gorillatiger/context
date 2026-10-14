// Apple Vision OCR. Image bytes enter only through stdin; no filenames, network
// clients or image persistence. Bounding boxes returned with a top-left origin.
// https://developer.apple.com/documentation/vision/vnrecognizetextrequest
// https://developer.apple.com/documentation/vision/vndetectedobjectobservation/boundingbox
import Foundation
import Vision
import ImageIO
import CoreGraphics

let maxBytes = 8 * 1024 * 1024
let maxPixels = 20_000_000
let maxText = 20_000
let maxLines = 500

enum OCRFailure: Error { case invalidImage, imageLimit, noText, unavailable, recognitionFailed }
struct TextLine: Encodable {
    let text: String
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}
struct OCRValue: Encodable {
    let text: String
    let lines: [TextLine]
    let engine: String
    let warnings: [String]
}
struct Success: Encodable { let ok = true; let value: OCRValue }
struct Failure: Encodable { let ok = false; let code: String }
func emit<T: Encodable>(_ value: T) {
    if let data = try? JSONEncoder().encode(value) {
        FileHandle.standardOutput.write(data)
    }
}
func prefixUTF8(_ text: String, maximum: Int) -> String {
    var result = "", length = 0
    for character in text {
        let piece = String(character), size = piece.utf8.count
        if length + size > maximum { break }
        result.append(character); length += size
    }
    return result
}
func readImageBytes() throws -> Data {
    var data = Data()
    while let chunk = try FileHandle.standardInput.read(upToCount: 65536), !chunk.isEmpty {
        if data.count + chunk.count > maxBytes { throw OCRFailure.imageLimit }
        data.append(chunk)
    }
    if data.isEmpty { throw OCRFailure.invalidImage }
    return data
}
func recognize(_ data: Data) throws -> OCRValue {
    guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
          let type = CGImageSourceGetType(source) as String?, ["public.jpeg", "public.png"].contains(type),
          CGImageSourceGetCount(source) == 1,
          let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
          let width = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue,
          let height = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue else { throw OCRFailure.invalidImage }
    guard width > 0, height > 0, width <= 10000, height <= 10000,
          Double(width) * Double(height) <= Double(maxPixels) else { throw OCRFailure.imageLimit }
    let orientationNumber = (properties[kCGImagePropertyOrientation] as? NSNumber)?.uint32Value ?? 1
    guard let orientation = CGImagePropertyOrientation(rawValue: orientationNumber),
          let image = CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCache: false] as CFDictionary) else { throw OCRFailure.invalidImage }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false // Preserve dates/names instead of dictionary substitutions.
    request.preferBackgroundProcessing = true
    request.minimumTextHeight = 0.002
    let supported = try request.supportedRecognitionLanguages()
    let languages = ["de-DE", "en-US"].filter { supported.contains($0) }
    guard !languages.isEmpty else { throw OCRFailure.unavailable }
    request.recognitionLanguages = languages
    var warnings = ["OCR kann Zeichen und Tabellen falsch erkennen. Prüfe Datum, Uhrzeit und Beleg vor dem Übernehmen."]
    if !languages.contains("de-DE") { warnings.append("Das deutsche Sprachmodell ist auf diesem Mac nicht verfügbar; Englisch wurde verwendet.") }
    let handler = VNImageRequestHandler(cgImage: image, orientation: orientation, options: [:])
    try handler.perform([request])
    var truncated = false
    let candidates = (request.results ?? []).sorted { a, b in
        if abs(a.boundingBox.maxY - b.boundingBox.maxY) > 0.002 { return a.boundingBox.maxY > b.boundingBox.maxY }
        return a.boundingBox.minX < b.boundingBox.minX
    }
    var lines = [TextLine](), remaining = maxText - maxLines
    for observation in candidates {
        if lines.count >= maxLines || remaining <= 0 { truncated = true; break }
        guard let recognized = observation.topCandidates(1).first else { continue }
        let raw = recognized.string.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let text = prefixUTF8(raw, maximum: min(1000, remaining))
        if text.isEmpty { continue }
        if text.utf8.count < raw.utf8.count { truncated = true }
        let box = observation.boundingBox
        let x = max(0, min(1, Double(box.minX))), y = max(0, min(1, 1 - Double(box.maxY)))
        let w = max(0, min(1 - x, Double(box.width))), h = max(0, min(1 - y, Double(box.height)))
        if w <= 0 || h <= 0 { continue }
        lines.append(TextLine(text: text, x: x, y: y, width: w, height: h))
        remaining -= text.utf8.count
    }
    guard !lines.isEmpty else { throw OCRFailure.noText }
    // Join text fragments sharing a visual baseline into table rows. Positions
    // remain available so the UI can show/review the actual detected layout.
    var rows = [[TextLine]]()
    for line in lines.sorted(by: { $0.y < $1.y }) {
        let center = line.y + line.height / 2
        if let index = rows.indices.last,
           let first = rows[index].first,
           abs(center - (first.y + first.height / 2)) <= min(line.height, first.height) * 0.5 {
            rows[index].append(line)
        } else { rows.append([line]) }
    }
    let ordered = rows.map { $0.sorted { $0.x < $1.x } }
    let text = ordered.map { $0.map(\.text).joined(separator: "\t") }.joined(separator: "\n")
    if truncated { warnings.append("Sehr viel Text: Ergebnis auf 20.000 Zeichen beziehungsweise 500 Textblöcke begrenzt.") }
    return OCRValue(text: text, lines: ordered.flatMap { $0 }, engine: "Apple Vision", warnings: warnings)
}

do {
    guard CommandLine.arguments.count == 1 else { throw OCRFailure.invalidImage }
    var bytes = try readImageBytes()
    defer { bytes.resetBytes(in: 0..<bytes.count) }
    emit(Success(value: try recognize(bytes)))
} catch {
    let code: String
    switch error {
    case OCRFailure.invalidImage: code = "invalidImage"
    case OCRFailure.imageLimit: code = "imageLimit"
    case OCRFailure.noText: code = "noText"
    case OCRFailure.unavailable: code = "unavailable"
    default: code = "recognitionFailed"
    }
    emit(Failure(code: code))
    exit(1)
}
