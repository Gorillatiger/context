# Lokaler Dokumentleser

`createDocumentReader()` verarbeitet ausschließlich bereits freigegebene Dateibytes. Er erhält keine URL, Cookies, Konten, Dateipfade oder Netzwerkfunktion. Die native Quellenanbindung prüft weiterhin Angebot, Kursbereich, aktuelle Anmeldung und Abbruch vor Abruf und Veröffentlichung. Der Dokumentleser erweitert keine Zugriffsrechte.

```js
const reader = createDocumentReader();
const result = await reader.read({
  bytes, // Buffer, Uint8Array oder ArrayBuffer; höchstens 8 MiB
  mimeType: 'application/pdf',
  fileName: 'Aufgaben.pdf', // ausschließlich ein Dateiname
  signal: abortController.signal
});
reader.dispose();
```

Das Ergebnis enthält `status` (`ok`, `empty`, `unsupported`), `text` (maximal 60.000 Zeichen), `coverage` (`complete`, `partial`, `none`), `warnings` und `metadata` mit Format, Engine, gelesenen/verfügbaren Abschnitten, OCR-Seiten und Begrenzungsstatus. Fehler werfen ein `Error` mit stabilem `code`; Abbruch wirft `AbortError`. Rohe Parserfehler, Dateiinhalte aus Diagnosen und stderr werden nicht weitergegeben.

## Formate und Grenzen

- **DOCX:** Haupttext, Absätze, Tabellen, Kopf-/Fußzeilen und Fuß-/Endnoten. Gelöschter Text und Feldinstruktionen werden ausgeschlossen.
- **PPTX:** Folientext in der tatsächlichen Präsentationsreihenfolge. Sprechernotizen, Bilder, Layout und Diagramme bleiben ungelesen.
- **XLSX:** Tabellen in Arbeitsmappenreihenfolge, gemeinsame/inline Texte und gespeicherte Werte. Formeln werden nicht ausgeführt; Zahlen und Datumscodes bleiben unformatiert.
- **PDF auf macOS:** PDFKit liest höchstens 20 Seiten. Bei fehlender Textlage versucht Apple Vision lokale OCR auf höchstens fünf Seiten; ein OCR-Ausfall bleibt als `empty` beziehungsweise `partial` mit Warnung sichtbar. Bilder, Anlagen, JavaScript und Dokumentaktionen werden nicht geöffnet.
- **PDF auf Windows/Linux:** momentan `unsupported`. Office verwendet nur Node-Standardmodule und ist für alle drei Plattformen vorbereitet.

Office-Abdeckung bleibt ausdrücklich `partial`, da vorhandener Text keine vollständige Interpretation des Dokuments ist. Alte binäre Office-Dateien (`.doc`, `.ppt`, `.xls`), Makroformate und passwortgeschützte PDFs werden nicht gelesen.

Ein einzelner Hilfsprozess läuft maximal 45 Sekunden. Start/Abbruch/Dispose sind begrenzt; ein zweiter paralleler Auftrag meldet `busy`. Node startet mit 128 MiB maximalem JavaScript-Heap und minimaler Umgebung. stdout ist auf 1 MiB, verworfene Diagnosen auf 64 KiB begrenzt. Der native PDFKit-/Vision-Prozess hat keinen garantierten RSS-Hardcap; Dateigröße, Seiten, OCR-Raster und Ausgabe sind begrenzt, und ein Abbruch beendet den Prozess.

ZIP-Dateien werden vollständig im Arbeitsspeicher gelesen und niemals entpackt oder gespeichert. Zentral-/Lokalheader, Pfade, CRC, Kompressionsmethode und Größen müssen übereinstimmen. Grenzen: 512 Einträge, 2 MiB je expandiertem Eintrag, insgesamt 32 MiB, Kompressionsverhältnis 100. ZIP64, Verschlüsselung, Makros, mehrteilige Archive und unsichere Pfade werden verweigert. XML hat Token-/Tiefe-/Attributgrenzen; DTD, eigene/externe Entitäten und fremde Hauptteil-Namespaces werden verweigert. Externe Beziehungen werden nicht geladen. Kein Netzwerk und keine Pakete werden nachgeladen.

## Build und Prüfung

Der macOS-Build kompiliert `document-helper.swift` lokal mit `xcrun swiftc`, PDFKit, Vision und CoreGraphics, analog zum OCR-Helfer. Ziel ist macOS 13 oder neuer. `document-helper` und `document-worker.mjs` müssen im Electron-Archiv ausgepackt liegen (`app.asar.unpacked/desktop/`). Der Worker benötigt keine npm-Pakete. Auf Windows/Linux wird der Worker durch den gebündelten Electron-Prozess mit `ELECTRON_RUN_AS_NODE=1` gestartet; für PDF fehlt noch ein lokaler Parser.

Standardprüfungen:

```sh
node --test tests/document-reader.test.mjs tests/document-security.test.mjs
```

Native PDF-Regressionsprüfungen nehmen ausschließlich synthetische Dokumente über stdin. Nach Kompilierung der beiden Swift-Dateien kann man zusätzlich `CONTEXT_TEST_DOCUMENT_HELPER` auf den Testhelfer und `CONTEXT_TEST_DOCUMENT_PDF_FIXTURE` auf die kompilierte `tests/document-pdf-fixture.swift` setzen. Es werden keine Nutzerdateien gelesen und keine Testdokumente auf Disk geschrieben.

Tatsächlich geprüft wurde **macOS auf Apple Silicon**: reale Node-Hilfsprozesse für DOCX/PPTX/XLSX, deutsche PDF-Textlage, 20-Seitengrenze, leere Seiten, manipulierte Archive/XML, Timeout, Abbruch, Dispose, begrenzte Ausgaben und unveränderte Aufruferbytes. Windows/Linux sind durch Vertragsprüfungen vorbereitet, aber nicht auf echten Rechnern getestet. Der echte Raster-OCR-Erfolg war auf diesem Host nicht überprüfbar: Apple Vision/CoreML schlägt auch mit dem bestehenden Foto-OCR-Helfer im separaten Testprozess fehl. Die ehrliche leere/partielle Rückgabe und Grenze von fünf OCR-Versuchen wurden geprüft; der Raster-Erfolgstest meldet diesen Umgebungsfall als übersprungen.

## Verwendung in Context 0.17.2

Quellen → Quelle lesen → Materialien → Dateipfeil. Dieser Schritt erneuert die beobachtete Dateiliste und liest höchstens zwölf Fenster mit je 5.000 Zeichen. Dateitexte, Kurs, Original-URL und Erkennungshinweise werden nach erfolgreichem, gegen Anmeldung/Kurs/Abbruch abgesichertem Speichern lokal indexiert. Der Agent verwendet denselben Leser über `read_platform_file`; Folgefenster benötigen `nextOffset` und die aktuelle Dateirevision. Gespeicherte Erkennungshinweise bleiben auch nach einem späteren HTML-Seitenrefresh erhalten.

Der native GET bindet sich an Electrons bestehende Anbietersitzung, ohne Cookie-Werte auszugeben. Er akzeptiert keine Redirects und prüft Dateinamen, MIME, deklarierte und tatsächliche Größe. Es gibt keinen neuen Server oder allgemeinen Dateipfadzugriff. Die 45-Sekunden-Parserfrist liegt innerhalb einer 60-Sekunden-Dateiauftragsfrist; Abbruch beendet den jeweiligen Hilfsprozess. Dies ist Prozessisolation mit begrenztem Parser, keine zusätzliche Betriebssystem-Sandbox für den Helfer.

### Gemessene gebündelte Helfer

Apple Silicon/macOS, drei synthetische deutsche Textdokumente je Format, einschließlich tatsächlichem Electron-Node-Worker:

| Format | Median Helferzeit | Max. Helfer-RSS |
| --- | ---: | ---: |
| DOCX | 61,49 ms | 70,53 MiB |
| PPTX | 51,70 ms | 62,53 MiB |
| XLSX | 59,05 ms | 72,83 MiB |
| PDF-Textlage | 21,30 ms | 21,97 MiB |

RSS stammt aus POSIX `wait4`; es betrifft nur den einzelnen Helfer. Messwrapper-Start und vollständige Zeiten sind separat in `document-benchmark.json` beschrieben. Kein OCR-/Worst-Case-/Gesamt-App-Benchmark und keine garantierte RSS-Obergrenze. `node tests/bench-documents.mjs [pdf-helper] [metrics-output] [node-or-electron-executable] [worker-path]` reproduziert den synthetischen macOS-Benchmark; Python-Standardbibliothek genügt.
