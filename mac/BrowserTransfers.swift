import Cocoa
import WebKit

@MainActor final class BrowserTransfers: NSObject, WKDownloadDelegate {
    private struct Job {
        let entry: URL?
        let hub: Bool
        var destination: URL?
        var temporary: URL?
        var overwriteAllowed = false
    }
    private weak var window: NSWindow?
    private let report: (String) -> Void
    private var jobs: [ObjectIdentifier: Job] = [:]

    init(window: NSWindow, report: @escaping (String) -> Void) {
        self.window = window
        self.report = report
    }
    func register(_ download: WKDownload, entry: URL?, hub: Bool) {
        jobs[ObjectIdentifier(download)] = Job(entry: entry, hub: hub)
        download.delegate = self
    }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let key = ObjectIdentifier(download)
        guard var job = jobs[key], let url = response.url,
              BrowserPolicy.downloadURL(url, entry: job.entry, hub: job.hub), let window = window else { completionHandler(nil); return }
        let panel = NSSavePanel()
        panel.title = "Download speichern"
        panel.nameFieldStringValue = (suggestedFilename as NSString).lastPathComponent
        panel.canCreateDirectories = true
        panel.beginSheetModal(for: window) { [weak self] result in
            guard let self = self, result == .OK, let destination = panel.url else { completionHandler(nil); return }
            let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("context-download-\(UUID().uuidString)", isDirectory: true)
            do {
                try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
                job.destination = destination
                job.temporary = temporary
                job.overwriteAllowed = FileManager.default.fileExists(atPath: destination.path)
                self.jobs[key] = job
                self.report("Download wird gespeichert …")
                completionHandler(temporary.appendingPathComponent("download"))
            } catch { self.report("Der Download konnte nicht vorbereitet werden."); completionHandler(nil) }
        }
    }
    func download(_ download: WKDownload, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, decisionHandler: @escaping (WKDownload.RedirectPolicy) -> Void) {
        guard let job = jobs[ObjectIdentifier(download)], let url = request.url else { decisionHandler(.cancel); return }
        decisionHandler(BrowserPolicy.downloadURL(url, entry: job.entry, hub: job.hub) ? .allow : .cancel)
    }
    func downloadDidFinish(_ download: WKDownload) {
        guard let job = jobs.removeValue(forKey: ObjectIdentifier(download)), let destination = job.destination, let temporary = job.temporary else { return }
        let source = temporary.appendingPathComponent("download")
        do {
            if job.overwriteAllowed && FileManager.default.fileExists(atPath: destination.path) {
                _ = try FileManager.default.replaceItemAt(destination, withItemAt: source)
            } else { try FileManager.default.moveItem(at: source, to: destination) }
            try? FileManager.default.removeItem(at: temporary)
            report("Gespeichert: \(destination.lastPathComponent)")
        } catch {
            report("Speichern fehlgeschlagen. Die heruntergeladene Datei bleibt im geöffneten Ordner.")
            NSWorkspace.shared.activateFileViewerSelecting([source])
        }
    }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        if let temporary = jobs.removeValue(forKey: ObjectIdentifier(download))?.temporary { try? FileManager.default.removeItem(at: temporary) }
        if (error as NSError).code != NSURLErrorCancelled { report("Download fehlgeschlagen. Bitte erneut versuchen.") }
    }
}
