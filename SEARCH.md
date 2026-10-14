# Lokale Suche · 0.16.7

Die Lupe oder ⌘K / Strg+K öffnet einen gemeinsamen Textindex. Kurs, Inhaltsart und Dienst lassen sich kombinieren. Pfeiltasten wählen einen Treffer; Enter öffnet den konkreten Eintrag. Der separate Link öffnet die Originalquelle. Hervorgehobene Auszüge können auch aus dem Ende einer langen Quelle stammen. Umlaute, ß, Präfixe und begrenzte Tippfehlerkorrektur werden berücksichtigt. Falls nicht alle Suchwörter gefunden werden, sind Ergebnisse als ähnliche Treffer gekennzeichnet.

## Welche Inhalte enthalten sind

Projekte, Aufgaben, Notizen, gespeicherte Links, Dev Diaries, Kalendertermine, Miro-Fundstellen, eingelesene Mitteilungen und gelesene Browserquellen. Erfolgreich gespeicherte Assistenten-Nachrichten sind einschließlich Quellen und Arbeitsschritten durchsuchbar. Unfertige Chatentwürfe und Anhänge werden nicht indexiert. Mail enthält nur bereits geladene Kopfzeilen und ausdrücklich geöffnete Textkörper; die Suche holt kein Postfach nach. Abgemeldete Konten und entfernte Inhalte werden aus dem aktuellen Index entfernt. Quellen mit fehlenden Zugriffsrechten oder nur Metadaten bleiben als Teilstand erkennbar.

Die Suche liest keine unbesuchten Dateien, keine vollständigen privaten Messengerverläufe und keine unbekannten Kursseiten. Weitere Spaces-Unterseiten werden über **Projekte → Spaces indexieren** eingelesen. Der fortsetzbare Crawler folgt angebotenen Kurslinks, Home/Orga und verschachtelten Ressourcen. Einstieg auch über das Spaces-Symbol in der Suche; Details in `CRAWLER.md`. Ein Link allein indexiert die Zielseite nicht.

## KI und Datenschutz

Menschliche Suche und Agent verwenden dieselbe Suchmaschine. Der Agent erstellt seinen Index ausschließlich aus dem gewählten Kurs und den freigegebenen Wissensarten. Menschlich durchsuchbare Mail- und Chatarchive werden dadurch nicht automatisch an das Modell weitergegeben. Suche und Rangfolge funktionieren ohne KI-Anbieter und ohne Netzwerk.

Der Browser verwendet einen Worker, damit die Textsuche außerhalb des UI-Threads läuft. In Umgebungen ohne Worker gibt es einen begrenzten RAM-Fallback. Standardmäßig ist keine zusätzliche Indexdatei auf Disk aktiv. Mit **Index lokal behalten** wird ein AES-GCM-256-verschlüsselter IndexedDB-Cache freigegeben und nach Neuladen wieder verwendet. Ausschalten löscht diesen Suchcache; bestehende Workspace-/Chatarchive bleiben erhalten. Falls ein anderes Fenster die Löschung blockiert, erscheint ein Fehler und die Freigabe bleibt ausgeschaltet.

Der nicht exportierbare Schlüssel liegt im selben Browserprofil. Diese Verschlüsselung schützt nicht gegen ein kompromittiertes Betriebssystem oder Benutzerkonto. Browserprofil löschen entfernt auch Schlüssel und Archive; exportierte Workspace-/Chatbackups sind separat zu sichern.

## Grenzen und Effizienz

Maximal 20.000 Dokumente, 40 Millionen Textzeichen, 250.000 Suchwörter und geschätzte 256 MiB Indexdaten; lange Quellen werden vor der Indexierung in begrenzte Textabschnitte zerlegt. Die UI zeigt **24 Treffer pro Seite**, die Gesamtzahl und Vor-/Zurück-Schaltflächen. Alle im Index gefundenen Treffer sind durch Blättern erreichbar; Filter oder Suchbegriff setzen die Seite auf 1 zurück. Ausgelassene/gekürzte Inhalte und erreichte Suchgrenzen werden unter „Index & Datenschutz“ angezeigt. Änderungen werden als Differenz in den bestehenden Index übernommen; jeder Tastendruck baut ihn nicht neu auf.

Reproduzierbarer synthetischer Node-Benchmark auf diesem Mac (Apple Silicon; 800 Zeichen je Dokument, 40 Kurse, 70 warme Suchläufe):

| Dokumente | Erstaufbau | Suche Median / p95 | eine Änderung | zusätzlicher JS-Heap |
| --- | --- | --- | --- | --- |
| 10.000 | 287 ms | 1,7 / 7,0 ms | 9,5 ms | 71 MB |
| 20.000 | 555 ms | 2,1 / 16,0 ms | 14,5 ms | 141 MB |

Der optionale verschlüsselte Beispielcache benötigt etwa 10,6 MB bei 10.000 bzw. 21,2 MB bei 20.000 solchen Dokumenten, zuzüglich Datenbank-/Dateisystem-Overhead. Das sind Messungen der Suchmaschine bzw. des serialisierten Caches, keine Messung des gesamten Electron-Prozesses. Der Browser berücksichtigt zusätzlich 100 ms Eingabeverzögerung, Workertransport und Darstellung. PDFs, Bilder, Audio und Videos werden nicht in diesen Textindex kopiert; Originale oder Chatarchive zählen separat zum Speicherbedarf.

Details: `search-benchmark.json`, `search-cache-benchmark.json`, `search-inbox-qa.json`. Tatsächlich geprüft: macOS mit Node und Codex-In-App-Browser, synthetischen Quellen sowie einem lokalen Fake-KI-/Mailprovider. Windows/Linux und echte komplette Kontoarchive wurden für diesen Ausbau nicht getestet.

Zusatzmessung für 0.16.7: synthetischer Bestand mit 20.000 Dokumenten und 20.000 passenden Treffern. Erstaufbau 736 ms, zusätzlicher JS-Heap 72,3 MB. Warme Suche einschließlich später Seite: Median 10,8–12,0 ms, p95 12,5–17,3 ms. Eine breite Suche bewertet alle passenden Treffer für ihre Reihenfolge; es werden nur 24 Zeilen dargestellt. Gemessen wurde der Node-Index ohne UI, Worker, Electron oder Netz. Details: `search-pagination-benchmark.json`.
