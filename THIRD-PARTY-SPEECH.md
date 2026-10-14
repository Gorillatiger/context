# Drittkomponenten der lokalen Spracheingabe

Die Context-Anbindung ist eigener MIT-Quellcode. Sie nutzt folgende externe Komponenten; deren Urheberhinweise und Lizenzen gelten zusätzlich. Modelle werden separat heruntergeladen und gehören nicht zum Source-ZIP oder zum Desktop-Paket.

| Komponente | Festgelegter Stand | Herkunft und Lizenz |
| --- | --- | --- |
| whisper.cpp einschließlich ggml | `v1.9.2` | [Offizielle Quelle](https://github.com/ggml-org/whisper.cpp/tree/v1.9.2), [MIT-Lizenz](https://github.com/ggml-org/whisper.cpp/blob/v1.9.2/LICENSE). Statisch im Helper, auf macOS einschließlich Metal-Backend. |
| Whisper-Modellgewichte | Mehrsprachiges `small` / `large-v3-turbo`, ggml-Konvertierung | [Konvertierte Modelle und MIT-Angabe](https://huggingface.co/ggerganov/whisper.cpp). OpenAI stellt [Whisper-Code und Modellgewichte unter MIT](https://github.com/openai/whisper#license), [Original-Lizenz](https://github.com/openai/whisper/blob/main/LICENSE). |
| Silero VAD | `v5.1.2`, ggml-Konvertierung | [Silero-Quelle](https://github.com/snakers4/silero-vad/tree/v5.1.2), [MIT-Lizenz](https://github.com/snakers4/silero-vad/blob/v5.1.2/LICENSE). Das [offizielle ggml-Modellrepository](https://huggingface.co/ggml-org/whisper-vad) kennzeichnet die Konvertierung ebenfalls als MIT. |
| JSON for Modern C++ | `3.11.2` aus dem whisper.cpp-Quellarchiv | [Verwendeter Header](https://github.com/ggml-org/whisper.cpp/blob/v1.9.2/examples/json.hpp), [MIT-Lizenz](https://github.com/nlohmann/json/blob/v3.11.2/LICENSE.MIT). Für das interne JSON-Steuerprotokoll. |

Das verifizierte whisper.cpp-Quellarchiv stammt von `https://codeload.github.com/ggml-org/whisper.cpp/tar.gz/refs/tags/v1.9.2`. Erwartetes SHA-256: `a6abd064fcca8b85e794d205abf328c522e9451db43a3eadc178b883b7d0e9cd`. Der Build bricht bei Abweichung ab. Der Quellcache enthält die upstream Lizenz und unveränderten Urheberhinweise. Der Context-Helper ist eine eigene Anwendung dieser Bibliothek; es wurde kein upstream Sprach-Server übernommen.

## Exakte Modelldateien

`desktop/speech-models.mjs` ist das verbindliche Manifest. Die App nimmt nur diese Modell-IDs an und prüft Größe und SHA-256 vor der Verwendung.

| Datei | Repository / feste Revision | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| `ggml-small.bin` | `ggerganov/whisper.cpp` / `5359861c739e955e79d9a303bcbc70fb988958b1` | 487601967 | `1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b` |
| `ggml-large-v3-turbo.bin` | `ggerganov/whisper.cpp` / `98aa99a0a9db05ae2342309f5096248665f7cba3` | 1624555275 | `1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69` |
| `ggml-silero-v5.1.2.bin` | `ggml-org/whisper-vad` / `e5614ed76a5dd4b03fad5068c89efcd2617a9d1e` | 885098 | `29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf` |

Die Dateien stammen von festen `huggingface.co/<repository>/resolve/<revision>/<filename>`-Adressen. Der Downloadmanager erlaubt ausschließlich HTTPS-Weiterleitungen zu Hugging-Face-/HF-CDN-Domains. Hugging Face ist dabei Downloadanbieter; Audio und Transkripte werden nicht dorthin gesendet.

## MIT-Urheberhinweise

Für die oben genannten MIT-Komponenten gelten die jeweiligen upstream Hinweise. Die folgenden Hinweise werden mit der Context-Distribution erhalten:

```text
whisper.cpp / ggml:
Copyright (c) 2023-2026 The ggml authors

Whisper code and model weights:
Copyright (c) 2022 OpenAI

Silero VAD:
Copyright (c) 2020-present Silero Team

JSON for Modern C++:
Copyright (c) 2013-2022 Niels Lohmann
Included MIT header portions:
Copyright (c) 2016-2021 Evan Nemerson
Copyright (c) 2008-2009 Björn Hoehrmann
Copyright (c) 2009 Florian Loitsch
```

Der folgende MIT-Lizenztext gilt jeweils zusammen mit dem entsprechenden Urheberhinweis:

```text
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Der nlohmann-Header enthält außerdem einen gekennzeichneten C++11-Kompatibilitätsabschnitt aus [Abseil](https://github.com/abseil/abseil-cpp/blob/10cb35e459f5ecca5b2ff107635da0bfa41011b4/absl/utility/utility.h), `Copyright 2017 The Abseil Authors`, unter [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0). Dieser Abschnitt ist im festgelegten C++17-Build nicht aktiv. Bei Weitergabe des vollständigen upstream Headers bleiben sein Herkunftshinweis und die zugehörigen Lizenzinformationen erhalten.

Synthetische Benchmarkstimmen sind reine Entwicklungsfixtures und werden nicht mit dem Produkt verteilt. Ihre jeweiligen Modelllizenzen sind bei Weitergabe gesondert zu beachten. Electron/Chromium und die übrigen bereits vorhandenen Projektkomponenten behalten ihre eigenen Lizenzhinweise.

## Synthetische Prüfaufnahmen

`tests/fixtures/speech` enthält selbst formulierte deutsche Testtexte und daraus erzeugte WAV-Dateien, keine Mikrofonaufnahmen oder Nutzerdaten. Sie wurden außerhalb der Runtime mit Piper 1.4.2 und der Stimme `de_DE-thorsten-medium` erzeugt und mit Apples `afconvert` auf 16 kHz Mono PCM16 umgerechnet. Piper und ONNX Runtime werden nicht mitgeliefert und sind für das Abspielen der Prüfdateien nicht erforderlich. Herkunft und Referenztexte stehen in `fixture-metadata.json`. Die [Modellkarte](https://huggingface.co/rhasspy/piper-voices/blob/main/de/de_DE/thorsten/medium/MODEL_CARD) nennt den [Thorsten-Voice-Datensatz](https://github.com/thorstenMueller/Thorsten-Voice) mit CC0-Lizenz.
