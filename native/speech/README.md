# Native Sprachverarbeitung

Context verwendet **whisper.cpp 1.9.2** mit dessen Silero-VAD-Anbindung. Diese Version bietet `whisper_vad_detect_speech_no_reset`: Der LSTM-Zustand bleibt während einer Aufnahme erhalten und wird vor jeder neuen Aufnahme ausdrücklich zurückgesetzt. Das Modell und der Whisper-Kontext bleiben im Hilfsprozess geladen.

## Build

Voraussetzungen: Node 22 oder neuer, CMake 3.22 oder neuer und ein C++17-Compiler. macOS benötigt die Xcode Command Line Tools; Windows benötigt Visual Studio 2022 mit C++-Werkzeugen und CMake, Linux beispielsweise GCC/Clang, CMake und Make. Der Build lädt einmal ein festes, SHA256-geprüftes Upstream-Archiv in `work/speech-build`. Danach kann der Build mit diesem Cache offline erfolgen.

```sh
node desktop/build-speech.mjs
# Optional: reiner CPU-Build
node desktop/build-speech.mjs --cpu
node --test tests/speech-native.test.mjs
```

`CONTEXT_CMAKE` wählt eine eigene CMake-Datei, `CONTEXT_SPEECH_BUILD_DIR` ein eigenes Cache-/Buildverzeichnis. Der Build verwendet keine Shell-Interpolation. Das Ergebnis ist `desktop/speech-helper` beziehungsweise `desktop/speech-helper.exe`, mit statisch gelinktem Whisper/GGML. Metal-Shader sind auf macOS eingebettet. macOS 13.3+ wird für den Accelerate-/Metal-Build vorausgesetzt. Der CPU-Build benötigt keinen separaten OpenMP-Laufzeitinstaller. Windows/Linux sind vorbereitet; nur auf tatsächlich gebauten Systemen gilt der jeweilige Build als getestet.

## Prozessprotokoll

Der Hilfsprozess hat **keinen HTTP-Server und keine offenen Netzwerkports**. Nur der native Electron-Hauptprozess bekommt seine stdin/stdout-Pipes. Fremde Webseiten erhalten diese Pipes nicht.

Ein Eingabepaket beginnt mit einer 4-Byte-Little-Endian-Länge. Das erste Payload-Byte ist der Typ:

- Typ 1: UTF8-JSON. `load {modelPath,vadPath,gpu:'auto'|'cpu',threads}`, `start {id,pauseMs,interimMs,threshold}`, `stop {id}`, `cancel {id}`, `shutdown`.
- Typ 2: 36 ASCII-Bytes Aufnahme-UUID, danach 1–16000 Float32-Little-Endian-Samples, 16 kHz, mono. Die Aufnahmequelle re-sampelt davor im AudioWorklet. Der Hilfsprozess bündelt die Daten zu Silero-Frames von 512 Samples und ergänzt einen Rest beim manuellen Stoppen mit höchstens 31 ms Stille. Ein Paket hat höchstens 64037 Bytes.

Ausgabe ist NDJSON mit `event`: `ready`, `started`, `vad`, `interim`, `processing`, `final`, `cancelled`, `error`, optional `backend` bei CPU-Fallback. Aufnahmeereignisse tragen dieselbe `id`. `interim.text` ersetzt den gesamten aktuellen Zwischenstand. Die native Seite liefert genau ein finales oder abgebrochenes Terminalereignis je Aufnahme; Renderer und Chat prüfen die ID zusätzlich.

`vad` enthält `speaking`, `speech`, `probability`, `level` und `inputMs`. `final.metrics` enthält `loadMs`, `inferenceMs`, `endToFinalMs`, `silenceDecisionToFinalMs`, `peakRssBytes`, `backend` und `audioMs`. `endToFinalMs` wird ab dem zuletzt als Sprache erkannten Silero-Frame gemessen und enthält deshalb die konfigurierte Denkpause. `silenceDecisionToFinalMs` beginnt erst beim Übergang in die Verarbeitung. `peakRssBytes` ist der gesamte Prozess-Höchstwert einschließlich Modell; Messwerte unterscheiden sich zwischen CPU und Metal.

## Grenzen und Datenschutz

Standard: Deutsch, 1800 ms Denkpause, 1500 ms Zwischenstand, Silero-Schwelle 0,5. Pause konfigurierbar 600–5000 ms, Intervall 750–5000 ms, Schwelle 0,2–0,9. Whisper bekommt höchstens 24 Sekunden je Fenster; 600 ms Audio-Kontext überlappt. Token-Zeitstempel bestimmen die Eigentümerschaft des überlappenden Texts, damit Wiederholungen im Inhalt nicht durch unscharfen Wortvergleich gelöscht werden.

Es gibt eine harte Aufnahmegrenze von 180 Sekunden, einen 3-Sekunden-Eingangspuffer und höchstens einen ausstehenden Zwischenstand. Lange Beiträge werden im selben Vorgang verarbeitet; der finale Text wird einmal geliefert. Stille ohne Sprache endet nach 15 Sekunden mit leerem Text und ruft Whisper nicht auf. Ein Burst muss mindestens 250 ms von Silero erkannte Sprache enthalten. Ein zu langsames Gerät meldet Pufferüberlauf und bricht ab, statt unbemerkt Audio zu verlieren.

Roh-Audio, Zwischenstände und finale Texte werden vom Hilfsprozess ausschließlich im RAM gehalten. Audiospeicher wird nach Abbruch/finalem Ergebnis überschrieben und freigegeben; Whisper-/VAD-Modelle bleiben für die nächste Eingabe bereit. Betriebssystem-Swap, Crash-Dumps und die Speicherverwaltung des Betriebssystems können vom Hilfsprozess nicht vollständig kontrolliert werden. Es werden keine Audio-/Transkriptdateien und keine Inhaltslogs erzeugt. Persistenz im Chat ist eine eigene, ausdrücklich aktivierbare UI-Einstellung.

Abbruch setzt sofort eine atomare Sperre; Whisper prüft sie über seinen Abort-Callback. Bereits unterwegs befindliche Ereignisse werden anhand der Aufnahme-ID verworfen. Ein Hardware-/Treiberabbruch des gesamten Hilfsprozesses muss vom Electron-Host behandelt werden. Normale GPU-Lade- oder Inferenzfehler werden mit CPU erneut versucht. Eine versehentlich vom Mikrofon hörbare andere Person lässt sich ohne Sprecheridentifikation nicht zuverlässig ausschließen.

Vor dem Metal-Modellstart wird geprüft, ob der Prozess tatsächlich ein nutzbares Metal-Gerät und Gerätespeicher erhält. Ein eingeschränkter oder bildschirmloser Prozess kann den Metal-Backend-Eintrag sehen, obwohl das Gerät unzugänglich ist; in diesem Fall startet der Dienst direkt auf der CPU. `ready.backend` und `ready.fallback` zeigen die tatsächliche Entscheidung. `CONTEXT_SPEECH_DIAGNOSTICS=1` aktiviert ausschließlich für lokale Fehlersuche Upstream-Diagnosen auf stderr. Standardmäßig sind sie ausgeschaltet; das produktive Electron-Modul verwirft stderr. Diese Diagnoseoption ist nicht für Inhaltsaufzeichnungen gedacht.

## Tatsächlich geprüfte native Verarbeitung

Am 13.10.2026 auf macOS, Apple M4 Pro, 24 GiB RAM mit dem mehrsprachigen `small`-Modell: zehn Szenarien mit synthetischer deutscher Piper-Sprache, in Echtzeit mit 16 kHz eingespielt. Kurze Beiträge, Wiederholung, ein etwa 34 Sekunden langer Beitrag, 1,2 Sekunden Denkpause, Hintergrundrauschen, reine Stille, reines Rauschen, Abbruch, Neustart und expliziter CPU-Betrieb bestanden. Jeder abgeschlossene Beitrag lieferte genau ein finales Ereignis; Abbruch lieferte keines. Stille/Rauschen führten zu leerem Text ohne Whisper-Inferenz.

Die Shell-Testumgebung erlaubte keinen nutzbaren Metal-Gerätespeicher. Deshalb gelten diese Werte ausdrücklich für den geprüften **CPU-Fallback**, trotz mitgebauter Metal-Unterstützung:

| Messgröße | Ergebnis |
| --- | --- |
| Native Modellladezeit einschließlich Silero | 147–156 ms mit warmem Dateicache |
| Ende des zuletzt erkannten Sprachframes bis Text | 2,40–2,65 s einschließlich 1,8 s Pause |
| Verarbeitung nach Pausenentscheidung | 0,55–0,80 s |
| Maximales Prozess-RSS | 722 MB dezimal, ca. 689 MiB |
| Wortfehler kurze Beiträge | 0 % |
| Wortfehler langer Beitrag | 4,5 % |
| Wortfehler Denkpause / Sprache mit Rauschen | 6,7 % / 8,3 % |

Die Messung trennt native Modellladezeit, laufende Inferenz und Pause. Die Wortfehlerquote ignoriert Großschreibung und Satzzeichen. Synthetische Sprache ersetzt keine Messung mit verschiedenen echten Sprecher*innen, Raumakustik und Mikrofonen. Windows/Linux, `large-v3-turbo` und Metal-Beschleunigung werden erst nach einem entsprechenden Test als geprüft beschrieben.

Zusätzlich prüfen die nativen Protokolltests fehlerhafte Pakete und Source-SHA256. Der optionale Modelltest verwendet echte Offline-Modelle und synthetische WAVs für beliebige PCM-Paketenden, mehrfaches Stoppen, Abbruch während anstehender Verarbeitung und wiederholten Neustart mit demselben geladenen Modell:

```sh
CONTEXT_SPEECH_TEST_MODELS=../../work/speech-models node --test tests/speech-native*.test.mjs
```

`CONTEXT_SPEECH_TEST_FIXTURES` kann ein eigenes Verzeichnis mit der deutschen 16-kHz-Mono-PCM-Fixture `short.wav` angeben. Ohne ausdrückliches Modellverzeichnis wird dieser zusätzliche Modelltest übersprungen; er lädt keine Dateien aus dem Netz.

Upstream-Quellen: [whisper.cpp 1.9.2](https://github.com/ggml-org/whisper.cpp/tree/v1.9.2), [Silero VAD](https://github.com/snakers4/silero-vad). Das Whisper-Archiv enthält außerdem nlohmann/json 3.11.2 unter MIT. Siehe `THIRD_PARTY_LICENSES.txt`.
