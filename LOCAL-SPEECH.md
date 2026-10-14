# Lokale deutsche Spracheingabe

Context transkribiert Mikrofon-Audio mit **whisper.cpp 1.9.2** und erkennt Sprache/Sprechpausen mit **Silero VAD 5.1.2**. Standard ist das mehrsprachige Modell **small**, fest auf Deutsch eingestellt. Optional ist **large-v3-turbo** verfügbar. Die Erkennung läuft in der Electron-Desktop-App; ein gewöhnlicher Browser besitzt diese native Anbindung nicht.

## Verwenden und Modelle laden

1. Den Context-Assistenten öffnen und einen Chat-Anbieter verbinden. Für vollständig lokale Chatverarbeitung kann auch LM Studio/Ollama gewählt werden.
2. Im Chat **Spracheingabe einstellen → Modell herunterladen** wählen. Die Oberfläche zeigt Dateigröße, Fortschritt und Integritätsprüfung. Für `small` werden zusammen mit VAD **488.487.065 Bytes** geladen, etwa **466 MiB**; für `large-v3-turbo` **1.625.440.373 Bytes**, etwa **1,51 GiB**. VAD wird zwischen beiden Modellen wiederverwendet.
3. **Spracheingabe** drücken und die Mikrofonfreigabe erteilen. Das erste Laden braucht zusätzlich Zeit; anschließend bleiben Whisper und VAD im Hilfsprozess bereit.
4. Sprechen. Vorläufiger Text wird fortlaufend ersetzt. **Stoppen** oder eine ausreichend lange Sprechpause übernimmt den endgültigen Text in das Eingabefeld. Prüfen/bearbeiten und mit dem vorhandenen Chatbutton senden.
5. **Verwerfen** bricht Aufnahme und Verarbeitung ab; der erkannte Beitrag wird nicht übernommen.

Ein Download darf maximal 60 Minuten je Datei laufen und lässt sich jederzeit anhalten. Der Download verwendet feste upstream Revisionen und Größen sowie SHA-256-Prüfsummen aus `desktop/speech-models.mjs`. Dateien werden zunächst als `.part` geschrieben und erst nach erfolgreicher Prüfung übernommen. Abgebrochene/unvollständige Downloads werden entfernt. Bei einer beschädigten Datei erscheint ein Fehler; ein neuer Download muss ausdrücklich gestartet werden. Nach einem erfolgreichen Download sind Statusprüfung, Modellladen und Transkription **offline** möglich. Ein gewählter Cloud-Chat-Anbieter braucht beim späteren Senden weiterhin Internet.

## Einstellungen

| Einstellung | Standard | Verhalten |
| --- | --- | --- |
| Whisper-Modell | `small` | Mehrsprachige Gewichte, Transkription mit Sprache `de`, keine Übersetzung. `large-v3-turbo` braucht mehr Speicher und einen separaten Download. |
| Sprechpause | 1.800 ms | Konfigurierbar von 600 bis 5.000 ms. Für Denkpausen z. B. 3.500 oder 5.000 ms wählen. |
| CPU statt Metal/GPU | Aus | macOS verwendet Metal, soweit verfügbar, mit CPU-Fallback bei Initialisierungs-/Verarbeitungsfehlern. Windows/Linux sind zunächst auf CPU vorbereitet. |
| Automatisch senden | Aus | Ein abgeschlossener Beitrag wird einmal an den bestehenden Chat-Ablauf übergeben. Bei geändertem Chat/Kurs wird er verworfen; überlange Texte werden nicht automatisch gesendet. |
| Spracheingaben speichern | Aus | Nur ausdrücklich freigegebene Spracheingaben dürfen in das lokale, verschlüsselte Chatarchiv. Audio wird auch dann nie gespeichert. |

Die Einstellungen werden im lokalen Browserprofil gespeichert. Ohne Speicherfreigabe bleiben die Spracheingabe und die daraus entstehenden Antworten/Arbeitsschritte nur in RAM. Auch spätere Beiträge desselben privaten Chats werden nicht archiviert, weil sie sich auf diese Spracheingabe beziehen können. Ein nachträglicher Opt-in für eine weitere Diktierung veröffentlicht einen bereits privaten gemeinsamen Entwurf nicht. Ein neuer Chat beginnt wieder mit eigenständiger Speicherung. Die Schaltflächen zum ausdrücklichen Übernehmen einer Antwort als Notiz oder zum Ausführen von Projektaktionen bleiben bewusste Speicheraktionen.

**Lokale Erkennung und Chatverarbeitung sind getrennt:** Mikrofon-Audio verlässt den Rechner nicht. Erst beim Senden geht der erkannte Text an den gewählten Chat-Anbieter; bei einem lokalen Chatmodell bleibt auch dieser Schritt auf dem Gerät.

## Installation aus dem Quellcode

Für ein vorhandenes Desktop-Paket werden kein CMake und kein Compiler benötigt. Für einen eigenen Build im Projektverzeichnis:

```sh
npm ci
npm run build:speech
npm run desktop
```

`build:speech` braucht **Node.js ab 22**, **CMake ab 3.22**, einen **C++17-Compiler** und `tar`. Auf macOS werden Xcode Command Line Tools/Clang mit Metal-Unterstützung benötigt; auf Windows z. B. Visual Studio Build Tools mit C++ und einer passenden Developer-Shell; auf Linux z. B. GCC/Clang und die üblichen C/C++-Buildwerkzeuge. Der erste Build lädt die auf Version und SHA-256 festgelegte whisper.cpp-Quelle. Die Sprachmodelle werden dadurch noch nicht geladen. Python, PyTorch, ONNX Runtime oder ein Speech-HTTP-Server sind für die Aufnahme/Erkennung nicht erforderlich.

```sh
# Optional: Hilfsprozess ausschließlich mit CPU-Unterstützung bauen
npm run build:speech -- --cpu

# Vollständiges Desktop-Paket; baut auch den Sprachdienst
npm run build:desktop
```

`CONTEXT_CMAKE` kann den Pfad zur CMake-Datei setzen; `CONTEXT_SPEECH_BUILD_DIR` setzt den Buildcache. Ohne Override liegt der Cache in diesem Workspace unter `work/speech-build`. Der Hilfsprozess heißt `desktop/speech-helper` bzw. `desktop/speech-helper.exe`; der Packager legt ihn ausführbar außerhalb von `app.asar` ab. `desktop/speech-build.json` enthält Version, Plattform, Architektur und Helper-Prüfsumme.

### Modellablage

Die Laufzeit verwendet `app.getPath('userData')/speech/models`. Der Bootstrap legt das Profil unter `appData/dev.hazylabs.context.workspace` an:

| Betriebssystem | Standardpfad |
| --- | --- |
| macOS | `~/Library/Application Support/dev.hazylabs.context.workspace/speech/models` |
| Windows | `%APPDATA%\dev.hazylabs.context.workspace\speech\models` |
| Linux | `$XDG_CONFIG_HOME/dev.hazylabs.context.workspace/speech/models`, sonst `~/.config/dev.hazylabs.context.workspace/speech/models` |

Dateinamen sind `ggml-small.bin`, optional `ggml-large-v3-turbo.bin` und `ggml-silero-v5.1.2.bin`. Für eine offline vorbereitete Installation können diese offiziellen Dateien vor dem Start in die Ablage kopiert werden; sie müssen exakt dem Manifest entsprechen. Der Renderer darf keine beliebigen Modellpfade oder Downloadadressen angeben.

## Architektur und Grenzen

Der lang laufende Controller in `dist/speech.js` kapselt Start, Stop, Abbruch, Zwischenstand, endgültigen Text und Fehler. Ein AudioWorklet mittelt/resampelt das Mikrofonsignal auf 16 kHz Mono; die Web-Audio-Ausgabe bleibt stumm. Audio geht über ausschließlich für das vertrauenswürdige Hauptfenster freigegebenes Electron-IPC an `desktop/speech.mjs` und über längenbegrenzte Binärpakete an den nativen Hilfsprozess. **Es gibt keinen neuen Speech-Port oder HTTP-Endpunkt.** Eingebettete Anbieterwebseiten erhalten weder Speech-IPC noch Mikrofon-/Kameraberechtigungen.

VAD läuft mit 512 Samples pro Frame, Whisper auf einem getrennten Inferenzthread. Zwischenstände werden ungefähr alle zwei Sekunden angefragt und bei langsamer Verarbeitung zusammengefasst. Audiofenster sind maximal 24 Sekunden lang, mit 600 ms Überlappung und Wort-/Zeitgrenzen für bereits übernommene Teile. Die Renderer-Warteschlange ist auf zwei Sekunden PCM begrenzt, die native Warteschlange auf drei Sekunden. Ein Beitrag endet spätestens nach drei Minuten; bei 15 Sekunden ohne erkannte Sprache entsteht kein Chatbeitrag. Größere oder langsame Modellverarbeitung kann die Zwischenstände verzögern.

Das Mikrofon stoppt bei Abbruch, Geräteverlust, Chat-/Kurswechsel, finaler Verarbeitung und tatsächlichem Verlassen des Fensters. Abgelehnte Berechtigung, fehlendes Mikrofon, beschädigtes Modell und Helper-Ausfall werden als Fehler angezeigt. Ein erneuter Start wartet auf abgeschlossene Abbruchfreigabe. Für spätere Chat-Sprachausgabe können `setPlaybackActive(true)` oder das Ereignis `context-speech-playback` mit `{ active: true }` die Aufnahme vorher ausschalten; vorhandene Browser-Sprachausgabe wird zusätzlich beobachtet. Lautsprecher-Echo aus fremden Apps kann nicht zuverlässig als Chatbot-Audio identifiziert werden.

## Prüfungen und Messung

```sh
npm run test:speech
npm run check
```

Die Speech-Suite prüft u. a. Zwischenstände, einmalige Übergabe, Datenschutz, Pauseneinstellungen, wiederholtes Starten/Stoppen, verzögerten Abbruch, Gerät-/Berechtigungsfehler, CPU-Auswahl, Puffersperren, Download-/Hashfehler und das native Binärprotokoll. Native Tests laufen nur, wenn ein Helper für das tatsächlich verwendete Betriebssystem vorhanden ist; fehlende Binaries werden ausdrücklich als übersprungen gemeldet.

Der opt-in Benchmark `tests/speech-benchmark.mjs` verwendet die mitgelieferten **synthetischen** WAV-Dateien `short.wav`, `long.wav`, `pause-one.wav`, `pause-two.wav` in `tests/fixtures/speech`: 16 kHz, Mono, PCM16. Alternativ kann `--fixtures` eigene passende Testdateien auswählen. Die Referenztexte stehen im Skript. Er ergänzt Stille/Rauschen/Denkpause und prüft Wiederholung, Abbruch sowie explizite CPU-Verarbeitung. Nur für diese Testfixtures werden Text und Messwerte als Bericht gespeichert.

```sh
npm run bench:speech -- --models ../../work/speech-models --pace 1 --output ../../work/qa/speech-benchmark.json
```

`--pace 1` füttert PCM ungefähr in Echtzeit; `--pace 0` ist ein Durchsatztest und darf nicht als Live-Latenz dargestellt werden. Gemessen werden Modellladezeit (`loadMs`, zusätzlich Lade-Wanduhrzeit), aufsummierte Inferenzzeit inklusive Zwischenständen (`inferenceMs`), letzte erkannte Sprachaktivität bis endgültiger Text (`endToFinalMs`, einschließlich Pausenentscheidung), Pausenentscheidung bis Text (`silenceDecisionToFinalMs`) und Spitzen-RSS des Helpers (`peakRssBytes`). Spitzen-RSS ist weder der gesamte Electron-Speicher noch eine vollständige GPU-Speichermessung. Die VAD-Zeit ist eine Schätzung des Sprechendes, keine Messung mit einem echten Mikrofon.

### Tatsächlich geprüfte Plattformen und Leistung

Stand dieser Dokumentation: **macOS auf Apple Silicon** wurde für Build, native Protokolltests und Controller-/Modelltests verwendet. Windows und Linux besitzen vorbereitete Build-, Prozess- und Pfadbehandlung, wurden jedoch **nicht physisch getestet**. macOS-Buildziel ist **13.3 oder neuer**. `large-v3-turbo` ist integriert, seine Erkennungsleistung und sein Speicherbedarf wurden bisher nicht gemessen. Ein Test mit echten deutschen Mikrofonaufnahmen, verschiedenen Geräten, Dialekten und realem Hintergrundlärm steht noch aus.

Gemessen am 13.10.2026 auf **Apple M4 Pro, 24 GiB RAM, macOS 26.6.2**, `small`, Deutsch, vier CPU-Threads, Echtzeit-Zuführung. Das Dateisystem war bereits warm; dies ist keine Kaltstartmessung nach einem Neustart. Der eingeschränkte Terminalprozess hatte keinen nutzbaren Metal-Zugriff, daher wurde der automatische CPU-Fallback tatsächlich ausgeführt.

| Messung | Ergebnis |
| --- | --- |
| Whisper + VAD laden | 147 ms automatisch/CPU-Fallback; 156 ms explizit CPU |
| Laden einschließlich Dateiprüfung/Prozessstart | 370 bzw. 429 ms |
| Letzte erkannte Sprache → fertiger Text | 2,40–2,65 s einschließlich 1,8 s Sprechpause |
| Pausenentscheidung → fertiger Text | 0,55–0,80 s |
| Spitzen-RSS des Sprachhelpers | bis 722,4 MB / 689 MiB |
| Kurze Eingabe, Wiederholung, Neustart, CPU | 0 % Wortfehlerrate in diesen Fixtures |
| 34 s lange Eingabe | 4,5 % Wortfehlerrate; elf Zwischenstände, ein Finalereignis |
| Denkpause von 1,2 s | ein Beitrag; 6,7 % Wortfehlerrate |
| Sprache mit künstlichem Rauschen | 8,3 % Wortfehlerrate |
| Stille, reines künstliches Rauschen | kein Text, keine Whisper-Inferenz |
| Abbruch | kein Finaltext; anschließender Neustart erfolgreich |
| Einzelwort / absichtliche Wiederholungen | „Ja.“ und alle drei „Bitte“ korrekt erhalten |

Verwendet wurden eigene, synthetisch mit Piper 1.4.2/Thorsten erzeugte deutsche Texte. Diese Prozentwerte sind keine allgemeine Genauigkeitsgarantie für Stimmen, Dialekte oder Räume. Der Testgenerator liegt außerhalb der Runtime; Piper/ONNX Runtime werden nicht mitgeliefert. Bericht: [speech-benchmark-cpu.json](speech-benchmark-cpu.json).

**Offene Live-Prüfung:** Der Mac war bei der abschließenden UI-Prüfung gesperrt. Ein getrenntes, signiertes GUI-Testpaket für Metal ist vorbereitet; beschleunigte Metal-Inferenz und ein echtes Mikrofon sind deshalb noch nicht als getestet markiert. Die lokale CPU-Erkennung wurde tatsächlich gemessen.

Die synthetischen Tests ersetzen keine Aufnahmeprüfung unter Alltagsbedingungen. Modell-/Silero-/Helper-Lizenzen und feste Downloadrevisionen stehen in [THIRD-PARTY-SPEECH.md](THIRD-PARTY-SPEECH.md).
