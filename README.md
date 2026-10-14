# Context

Ein lokaler Studien-Hub für Code & Context an der TH Köln. Kurse, Aufgaben, Notizen, Quellen, Mail und Kalender stehen in einer Oberfläche bereit. Ein KI-Begleiter kann freigegebene Quellen lesen und Antworten mit Quellenlinks liefern.

**Stand: 0.17.4.** Entwicklungsprojekt, keine offizielle Anwendung der TH Köln. Integrationen benötigen eine eigene Anmeldung und gegebenenfalls eigene API-/OAuth-Konfiguration; ein Link allein ist noch kein verbundener Connector.

## Starten

Voraussetzungen: **Node.js 22+**, **npm**, für TH-Mail zusätzlich **Python 3**.

```sh
git clone https://github.com/Gorillatiger/context.git
cd context
npm ci
npm run dev
```

Die Weboberfläche öffnest du unter `http://127.0.0.1:4318`. In einem zweiten Terminal:

```sh
npm run desktop
```

Der Electron-Browser verwendet ein eigenes lokales Profil. Melde dich dort bei den Diensten an; vorhandene Cookies anderer Browser werden nicht übernommen. Ohne laufenden Server startet die Desktop-App selbst einen lokalen Server auf Port 4318. Der Webmodus bietet keine native Browser- oder Mikrofonbrücke.

Der interaktive Start mit optionalen Connector-Zugangsdaten erfolgt über `python3 start-local.py`. Eingaben gehen nur in den lokalen Prozess. Bitte keine echten Schlüssel in Dateien, Source oder GitHub hinterlegen.

## Funktionen und Grenzen

| Bereich | Umsetzung |
| --- | --- |
| Kurse und Wissen | Aufgaben, Markdown-Notizen, Dev Diaries, lokale Suche und Quellen mit Original-Link |
| Spaces | Lesender Kurs-Crawler mit Unterseiten, Fortsetzung und sichtbarer Abdeckung; die Suche bleibt auf zugängliche, freigegebene Kursquellen begrenzt |
| Miro | Board-Links mit Fundstellen und Kurszuordnung; Board-Texte benötigen die separat eingerichtete Miro/Nango-Verbindung |
| GitLab und Sciebo | Angemeldete, freigegebene Dienstquellen sowie angebotene Kursdateien; keine vollständige automatische Kopie aller privaten Dateien |
| Kommunikation | Nachrichtenübersicht, Kursfilter, TH-Mail über IMAP/SMTP, Outlook/Gmail über eine konfigurierte Nango-Verbindung |
| Kalender | Tag, Monat und Agenda, ICS-Import/Export, Anbieterabgleich mit stabilen IDs; kein allgemeiner Zweiwege-Sync sämtlicher Anbieter |
| KI | KI:connect NRW, OpenRouter und lokale OpenAI-kompatible Modelle über LM Studio/Ollama; begrenzte Werkzeuge und Quellenbelege |
| KI-Limit | OpenRouter-Schlüsselbudget und Gratiszähler; Hochschul-KI zeigt unbekannte Limits ehrlich an, lokale Modelle haben kein Cloud-Kontingent |
| Sprache | Offline-Transkription mit whisper.cpp und Silero VAD nach Modelldownload; Zwischenstand, Stoppen, Abbruch und bearbeitbarer Entwurf |
| Browser | Electron/Chromium, gemeinsame lokale Dienstsitzung, Kursansichten, Inventar und optionaler WhatsApp-CoCo-Filter |
| Darstellung | Hell-/Darkmode, responsive Oberfläche und kompakter Kontextassistent |

Die zwei vorgegebenen Kurse sind öffentliche Einstiegsbeispiele. Eigene Kurse und Konten werden in der Anwendung eingerichtet. WhatsApp-Inhalte werden nicht allgemein indexiert; Signal ist ein Einstieg in die separate Desktop-App. Der Begleiter ist eine eigene Implementierung; OpenClaw und Hermes sind nicht eingebunden.

## Lokal, aber mit bewusst gewählten Cloud-Diensten

- Mikrofon-Audio bleibt auf dem Gerät. Die Erkennung öffnet keinen HTTP-Port. Modelle werden SHA256-geprüft; Audio wird standardmäßig nicht gespeichert.
- Chats, Quellen und Arbeitsschritte werden lokal verschlüsselt gespeichert, soweit der sichere lokale Speicher verfügbar ist. Projekte, Kalender und exportierte Workspace-Backups haben einen separaten lokalen Speicher und sind nicht pauschal verschlüsselt.
- An einen Cloud-KI-Anbieter gehen die mit dem Auftrag ausgewählten Texte. Lokale Modelle benötigen einen selbst gestarteten Server auf Loopback; kein stiller Cloud-Fallback.
- TH-Mail-/KI-Zugangsdaten bleiben im Connector-RAM. Konfigurierte Nango-Verbindungen und Browser-Sitzungen verwenden den sicheren lokalen Speicher. Nango kann selbst gehostet oder als Cloud-Dienst eingerichtet werden; bei Cloud-Nango verarbeitet dieser Dienst die OAuth-Zugänge.
- Der lokale Hub prüft Host, Origin und Sitzung; fremde Webseiten erhalten keinen freien Zugriff auf native Werkzeuge oder Konto-Zugänge. Nicht als öffentlich erreichbaren Internetserver betreiben.
- Externe Schreibaktionen wie Mailversand, Kalenderabgleich oder Diary-Veröffentlichung erfolgen nur im dafür vorgesehenen Ablauf. Erinnerungen veröffentlichen keine Diaries automatisch.

## Native Builds

Für die Sprachkomponente: **CMake 3.22+ und C++17-Compiler**. macOS benötigt Xcode Command Line Tools, Windows Visual Studio mit C++-Werkzeugen, Linux GCC/Clang und CMake.

```sh
npm run build:speech
# CPU-Build:
node desktop/build-speech.mjs --cpu
# Electron-Paket einschließlich lokaler Helfer:
npm run build:desktop
```

`CONTEXT_CMAKE` und `CONTEXT_SPEECH_BUILD_DIR` können Compiler-/Cachepfade anpassen. whisper.cpp-Upstreamquellen und Sprachmodelle werden separat geladen; sie gehören nicht ins Repository. Der bestehende Desktop-Build verwendet einen Arbeitsordner außerhalb des Quellverzeichnisses und legt das signaturgeprüfte macOS-Paket unter `/private/tmp/context-browser-runtime/Context Browser.app` ab. Details: [lokale Sprache](LOCAL-SPEECH.md), [native Sprachkomponente](native/speech/README.md).

**Praktisch geprüft: macOS auf Apple Silicon.** Windows/Linux-Builds sind vorbereitet, jedoch nicht durch einen erfolgreichen End-to-End-Test verifiziert. Lokale Office-Dateien sind plattformübergreifend vorbereitet; PDFKit ist macOS-spezifisch. Raster-OCR kann auf diesem Mac wegen Apple-Vision/CoreML-Fehlern ausfallen und meldet dies sichtbar. Metal-Unterstützung wird mitgebaut; die dokumentierten Sprachbenchmarks stammen vom CPU-Fallback.

## Prüfen

```sh
npm run check
```

Das prüft JavaScript-Syntax, Funktions- und Sicherheitsregressionen sowie die Python-Mailkomponente. Tests verwenden synthetische Daten. Native Tests werden ohne gebaute Helfer beziehungsweise ohne ausdrücklich bereitgestellte Modelle übersprungen; kein Test meldet sich still bei einem echten Konto an. Tests mit realen Mikrofonen, Windows/Linux und nicht eingerichteten Cloud-Konten sind davon getrennt.

## Dokumentation

- [Suche](SEARCH.md), [Spaces-Crawler](CRAWLER.md), [Dienstquellen](PLATFORM-SEARCH.md), [Miro](MIRO.md)
- [Mail](MAIL.md), [Empfängervorschläge](MAIL-CONTACTS.md), [Mitteilungen](NOTIFICATIONS.md)
- [Kalenderabgleich](CALENDAR-SYNC.md), [Tagesansicht](CALENDAR-DAY.md), [Nango](NANGO.md)
- [Dev Diaries](DEV-DIARY.md), [KI-Nutzungslimits](AI-USAGE.md), [lokale Sprache](LOCAL-SPEECH.md)
- [Darkmode](DARKMODE.md), [Inventar](INVENTORY.md), [WhatsApp-Filter](COCO-CHAT-FILTER.md)
- [Dokumentlesen](desktop/DOCUMENT-READER.md), [Plugins](PLUGINS.md), [Dienstlogos](BRAND-ASSETS.md)

## Lizenz

Eigener Quellcode: [MIT](LICENSE). Dienstlogos und Marken gehören ihren Rechteinhabern und sind nicht unter dieser MIT-Lizenz freigegeben. Native Abhängigkeiten: [Third-party Speech](THIRD-PARTY-SPEECH.md). Nango ist eine optionale externe Integration mit eigener, eingeschränkter Elastic-Lizenz; diese Anwendung lizenziert Nango nicht neu.

Das Repository enthält Quellcode, Tests und technische Dokumentation. Lokale Profile, Konto-Zugänge, persönliche Kursinhalte, Screenshots, Modelle, Helfer-Binaries und Laufzeitdaten werden nicht hochgeladen.
