// Memory-only PDF text extraction. No file paths, URLs, annotations, embedded
// attachments or actions are opened. PDFKit text and optional Vision OCR run in
// a disposable process controlled by the parent's timeout and abort signal.
import Foundation
import PDFKit
import CoreGraphics
import Vision

let maximumBytes = 8 * 1024 * 1024
let maximumText = 60000 // UTF-16 code units, matching the JavaScript contract.
let maximumPages = 20
let maximumOCRPages = 5
enum DocumentError: Error { case inputLimit, invalidPDF, lockedPDF, readFailed }
struct Metadata: Encodable {
    let format = "pdf"
    let engine: String
    let unitsRead: Int
    let unitsTotal: Int
    let ocrUnits: Int
    let truncated: Bool
}
struct DocumentValue: Encodable {
    let status: String
    let text: String
    let coverage: String
    let warnings: [String]
    let metadata: Metadata
}
struct Success: Encodable { let ok = true; let value: DocumentValue }
struct Failure: Encodable { let ok = false; let code: String }
func emit<T: Encodable>(_ value: T) {
    if let bytes = try? JSONEncoder().encode(value) { FileHandle.standardOutput.write(bytes) }
}
func cleanText(_ value: String) -> String {
    String(value.unicodeScalars.filter { scalar in
        !CharacterSet.controlCharacters.contains(scalar) || [9,10,13].contains(scalar.value)
    }).replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
}
func textPrefix(_ value: String, maximum: Int) -> String {
    var result = "", length = 0
    for scalar in value.unicodeScalars {
        let size = scalar.value > 0xffff ? 2 : 1
        if length + size > maximum { break }
        result.unicodeScalars.append(scalar); length += size
    }
    return result
}
func readBytes() throws -> Data {
    var result = Data()
    while let chunk = try FileHandle.standardInput.read(upToCount: 65536), !chunk.isEmpty {
        if result.count + chunk.count > maximumBytes { throw DocumentError.inputLimit }
        result.append(chunk)
    }
    guard result.count >= 5, result.prefix(5) == Data("%PDF-".utf8) else { throw DocumentError.invalidPDF }
    return result
}
func pageOCR(_ page: CGPDFPage) throws -> String {
    let bounds = page.getBoxRect(.mediaBox)
    guard bounds.width.isFinite, bounds.height.isFinite, bounds.width > 0, bounds.height > 0,
          bounds.width < 100000, bounds.height < 100000 else { throw DocumentError.readFailed }
    let scale = min(2.5, 1800 / max(bounds.width, bounds.height))
    let width = Int(ceil(bounds.width * scale)), height = Int(ceil(bounds.height * scale))
    guard width > 0, height > 0, width * height <= 3240000,
          let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
                                  bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { throw DocumentError.readFailed }
    context.setFillColor(CGColor(gray: 1, alpha: 1)); context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    context.concatenate(page.getDrawingTransform(.mediaBox, rect: CGRect(x: 0, y: 0, width: width, height: height), rotate: 0, preserveAspectRatio: true))
    context.drawPDFPage(page)
    guard let image = context.makeImage() else { throw DocumentError.readFailed }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false
    request.preferBackgroundProcessing = true
    request.minimumTextHeight = 0.003
    let supported = try request.supportedRecognitionLanguages()
    let languages = ["de-DE", "en-US"].filter { supported.contains($0) }
    guard !languages.isEmpty else { throw DocumentError.readFailed }
    request.recognitionLanguages = languages
    try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
    let observations = (request.results ?? []).sorted { a,b in
        if abs(a.boundingBox.maxY - b.boundingBox.maxY) > 0.003 { return a.boundingBox.maxY > b.boundingBox.maxY }
        return a.boundingBox.minX < b.boundingBox.minX
    }
    var result = ""
    for observation in observations.prefix(1500) {
        guard let candidate = observation.topCandidates(1).first else { continue }
        let text = textPrefix(cleanText(candidate.string), maximum: min(2000, maximumText - result.utf16.count))
        if !text.isEmpty { result += text + "\n" }
        if result.utf16.count >= maximumText - 1 { break }
    }
    return textPrefix(result, maximum: maximumText)
}
func readPDF(_ bytes: Data) throws -> DocumentValue {
    guard let document = PDFDocument(data: bytes) else { throw DocumentError.invalidPDF }
    guard !document.isLocked else { throw DocumentError.lockedPDF }
    let total = document.pageCount
    guard total > 0, total <= 100000 else { throw DocumentError.invalidPDF }
    var result = "", pagesRead = 0, ocrRead = 0, incomplete = total > maximumPages, skippedScans = false, ocrFailure = false
    let provider = CGDataProvider(data: bytes as CFData)
    let drawingDocument = provider.flatMap { CGPDFDocument($0) }
    for index in 0..<min(total, maximumPages) {
        if result.utf16.count >= maximumText { incomplete = true; break }
        autoreleasepool {
            guard let page = document.page(at: index) else { incomplete = true; return }
            var text = cleanText(page.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if text.filter({ !$0.isWhitespace }).count < 8 {
                if ocrRead < maximumOCRPages, let drawingPage = drawingDocument?.page(at: index + 1) {
                    ocrRead += 1
                    do { let scanned = try pageOCR(drawingPage).trimmingCharacters(in: .whitespacesAndNewlines); if !scanned.isEmpty { text = scanned } else { incomplete = true } }
                    catch { ocrFailure = true; incomplete = true }
                } else { skippedScans = true; incomplete = true }
            }
            if !text.isEmpty {
                let section = "\nSeite \(index + 1)\n" + text + "\n"
                let bounded = textPrefix(section, maximum: maximumText - result.utf16.count)
                if bounded.utf16.count < section.utf16.count { incomplete = true }
                result += bounded
            }
            pagesRead += 1
        }
    }
    result = result.trimmingCharacters(in: .whitespacesAndNewlines)
    var warnings: [String] = []
    if ocrFailure { warnings.append("Mindestens eine Seite konnte mit lokaler OCR nicht gelesen werden.") }
    if result.isEmpty { warnings.append("Kein lesbarer Text gefunden.") }
    if total > maximumPages { warnings.append("Nur die ersten 20 PDF-Seiten wurden gelesen.") }
    if skippedScans { warnings.append("Weitere gescannte oder leere Seiten wurden nach der Grenze von fünf OCR-Seiten nicht erkannt.") }
    if result.utf16.count >= maximumText { warnings.append("Das Ergebnis wurde auf 60.000 Zeichen begrenzt.") }
    if ocrRead > 0 { warnings.append("OCR kann Zeichen und Tabellen falsch erkennen. Prüfe wichtige Angaben anhand der Originalquelle.") }
    warnings.append("Nur PDF-Text und gegebenenfalls lokale OCR: Bilder, Layout und Anhänge werden nicht interpretiert.")
    return DocumentValue(status: result.isEmpty ? "empty" : "ok", text: result,
                         coverage: incomplete ? "partial" : "complete", warnings: warnings,
                         metadata: Metadata(engine: ocrRead > 0 ? "PDFKit + Apple Vision" : "PDFKit",
                                            unitsRead: pagesRead, unitsTotal: total, ocrUnits: min(ocrRead,pagesRead), truncated: incomplete))
}
do {
    guard CommandLine.arguments.count == 1 else { throw DocumentError.invalidPDF }
    var bytes = try readBytes(); defer { bytes.resetBytes(in: 0..<bytes.count) }
    emit(Success(value: try readPDF(bytes)))
} catch {
    let code: String
    switch error {
    case DocumentError.inputLimit: code = "inputLimit"
    case DocumentError.invalidPDF: code = "invalidPDF"
    case DocumentError.lockedPDF: code = "lockedPDF"
    default: code = "readFailed"
    }
    emit(Failure(code: code)); exit(1)
}
