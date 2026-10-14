// Synthetic raster-only PDF for the local OCR regression. No real user files,
// network, windows or filesystem output: the generated PDF exits on stdout.
import Foundation
import AppKit
import CoreGraphics

let pageCount = CommandLine.arguments.count > 1 ? Int(CommandLine.arguments[1]) ?? 1 : 1
guard pageCount > 0, pageCount <= 6,
      let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 1400, pixelsHigh: 700,
                                    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                                    isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
      let graphics = NSGraphicsContext(bitmapImageRep: bitmap) else { exit(1) }
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = graphics
NSColor.white.setFill(); NSRect(x: 0, y: 0, width: 1400, height: 700).fill()
let words = "Deutsche Aufgabe: Prototyp bauen.\nDev Diary jeden Tag schreiben.\nAbgabe am Freitag um 16 Uhr."
(words as NSString).draw(in: NSRect(x: 80, y: 80, width: 1250, height: 530),
                         withAttributes: [.font: NSFont.systemFont(ofSize: 44), .foregroundColor: NSColor.black])
NSGraphicsContext.restoreGraphicsState()
if CommandLine.arguments.contains("--png") {
    guard let png = bitmap.representation(using: .png, properties: [:]) else { exit(1) }
    FileHandle.standardOutput.write(png); exit(0)
}
guard let image = bitmap.cgImage else { exit(1) }
let bytes = NSMutableData()
guard let consumer = CGDataConsumer(data: bytes as CFMutableData) else { exit(1) }
var bounds = CGRect(x: 0, y: 0, width: 700, height: 350)
guard let pdf = CGContext(consumer: consumer, mediaBox: &bounds, nil) else { exit(1) }
for _ in 0..<pageCount {
    pdf.beginPDFPage(nil); pdf.draw(image, in: bounds); pdf.endPDFPage()
}
pdf.closePDF()
FileHandle.standardOutput.write(bytes as Data)
