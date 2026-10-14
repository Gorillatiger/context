# Context 0.17.2: Kursquellen, Suche und Agent

Die Hauptnavigation zeigt die täglichen Arbeitsbereiche. Zusätzliche Werkzeuge bleiben unter „Mehr“ erreichbar. Auf Heute steht eine Suche mit explizitem Übergang zum Agenten. Die globale Suche beginnt mit allen Kursen; Kurs-, Dienst- und Inhaltsfilter sind optional. Trefferseiten erhalten sämtliche gefundenen Ergebnisse; 24 ist die Seitengröße, nicht die Gesamtgrenze.

## Links auf Spaces-Unterseiten finden

**Quellen → Spaces einlesen** folgt dem vorhandenen Kurscrawler. Sichtbare Links auf Home, Orga und aufgeklappten Ressourcen werden mit dem Kurs, der tatsächlich gelesenen Fundseite, Titel, Linkposter und einem vorhandenen Veröffentlichungszeitstempel übernommen. Der Agent führt denselben Schritt beim Lesen einer Kursseite aus und kann die neue Quelle im selben Auftrag öffnen. Ohne eindeutige Kurszuordnung wird keine Zuordnung geraten. Der Linkposter ist weiterhin kein belegter Board-Ersteller.

Das Verzeichnis speichert maximal 500 Fundstellen und 100 angebotene Links pro Ansicht. Neue Verbindungen entstehen erst nach erfolgreichem lokalem Speichern; der native Leser prüft zusätzlich Dienst- und Kursgrenzen. Ein geänderter oder archivierter Kurs entzieht alte Fundstellen dem aktuellen Katalog. Ein abgebrochener oder während des Lesens veränderter Kursabschnitt erteilt keine neuen Leseaufträge. Erreichte Grenzen bleiben als Teilstand sichtbar.

Die Verweise liegen im bestehenden lokalen Workspace-Feld `platformFindings`, einschließlich privater Linkadressen. Dieser bestehende Workspace und sein JSON-Backup sind nicht separat verschlüsselt. Die tatsächlich abgerufenen Plattformtexte und gespeicherten Spaces-Ansichten liegen dagegen in ihren verschlüsselten IndexedDB-Caches. Cookies, Formularwerte und Nonces werden nicht in Fundstellen aufgenommen.

Ein Link ist noch kein gelesener Inhalt. Der Originalfundstellen-Button öffnet die zugehörige Spaces-Seite; „Lesen“ prüft die Plattformquelle separat mit deiner vorhandenen Anmeldung. Dieser Schritt verbindet keine neuen OAuth-Konten und ändert keine Freigaben.

## Lesen und Indexieren

Unter **Quellen** stehen bekannte Kurslinks und Miro-Boards sowie ausdrücklich konfigurierte GitLab-/Sciebo-/Mattermost-Einstiege. Globale Einstiege besitzen keine erfundene Kurszuordnung und gehören nicht zum Wissen eines ausgewählten Einzelkurses. „Lesen“ erfasst die Quelle; „Aktualisieren“ prüft bis acht Quellen pro Lauf. Die Kurssuche nutzt danach denselben lokalen Index wie der Agent. Tippen löst keine Cloud-Anfrage und keinen Anbieterabruf aus.

- Spaces: vorhandener Kurscrawler und lesende Browserwerkzeuge, einschließlich angebotener Kurs-Unterseiten.
- Miro: OAuth über die eigene Nango-Integration, ausschließlich `boards:read`. Metadata und Elemente werden über die REST-API gelesen. Frame-/Parenttitel, tatsächlicher Boardtitel, API-Autor und Zeitangaben werden soweit geliefert übernommen; Linkposter und tatsächlicher Ersteller bleiben getrennt. Originalbelege verlinken ein Element mit `moveToWidget`.
- GitLab, Sciebo, Mattermost: ein wiederverwendbarer, unsichtbarer, sandboxed Electron-Browser liest gerenderten Text mit der vorhandenen gemeinsamen Browsersitzung. Er folgt ausschließlich angebotenen Links im freigegebenen Repository, Ordner, Freigabelink oder Channel. Ein Suchlauf prüft höchstens drei Ansichten. Das ist kein vollständiger API-/Nachrichtenabgleich.
- GitLab-/Sciebo-Dateien: ausschließlich zuvor angebotene einzelne Textdateien (bis 2 MB) und `.pdf`, `.docx`, `.pptx`, `.xlsx` (bis 8 MiB). Unter der gelesenen Quelle öffnet **Materialien** die Dateiliste; der Pfeil liest und indexiert bis zwölf Textfenster. Das Angebot wird vor dem Abruf erneut geprüft. GET verwendet die native Sitzung, keine Weiterleitungen und geprüfte MIME-/Dateinamen; Geheimnis-, Makro- und Legacy-Dateien bleiben gesperrt. Unbelegte Sciebo-Datei-ID-Zuordnungen werden nicht geöffnet.

PDF-Texte werden auf macOS mit PDFKit gelesen, Office-Texte in einem kurzlebigen Node-Hilfsprozess. Maximal 60.000 Zeichen, 20 PDF-Seiten und fünf OCR-Seiten. ZIP-/XML-Strukturen sind begrenzt; Makros, Formeln, externe Inhalte und PDF-Aktionen werden nicht ausgeführt. Nur Text und Erkennungshinweise gelangen in den verschlüsselten Cache, keine Rohdateien. Hinweise auf Teilabdeckung/OCR bleiben am Dokument erhalten und erreichen auch spätere Agentenfragen. Einzelheiten: [Lokaler Dokumentleser](desktop/DOCUMENT-READER.md).

Windows/Linux: Office ist vorbereitet, noch nicht praktisch geprüft; PDF ist dort ausdrücklich nicht verfügbar. Auf diesem Mac scheitert der lokale Apple-Vision-Prozess bei Raster-PDFs; er meldet leeren/partiellen Text mit Warnung. Miro-Bilder, eigenständige Spaces-Dateianhänge, Audio und weitere Binärformate sind noch nicht durch diesen Quellenleser erschlossen. Bestehende Kalender-Foto-OCR und lokale Spracheingabe bleiben separate Funktionen.

## Agentenwerkzeuge

Neben `search_knowledge`, `read_source` und Spaces-Werkzeugen stehen `list_platform_sources`, `read_platform`, `search_platform`, `open_platform` und `read_platform_file` zur Verfügung. Quellen-IDs stammen ausschließlich aus dem aktuellen Katalog oder den geprüften Plattformlinks einer gelesenen Spaces-Seite. Der Agent kann passende Kursquellen selbständig lesen und angebotene Unterseiten prüfen; er besitzt keinen allgemeinen Netzwerk-, Shell-, Passwort- oder Schreibzugriff auf diese Dienste.

Der Chat-Schalter **Boards & Kursdienste** begrenzt eingelesenes Plattformwissen. **Kursquellen selbst lesen** steuert Live-Lesezugriffe. Eine nicht zugängliche Quelle wird im selben Auftrag nicht wiederholt versucht. Der normale Browser ermöglicht die persönliche Anmeldung; neue Berechtigungen, MFA und Freigaben können nicht automatisch ersetzt werden. Miro-Codex-MCP und Contexts eigene Miro-OAuth-Verbindung sind separate Kontoverbindungen; Codex-Zugriffstokens werden nicht übernommen.

Plattformaufträge besitzen höchstens zehn Werkzeugschritte plus Abschluss. Modellkontext, Ergebnisse und gesamte Unterhaltung sind begrenzt. Nur tatsächlich übergebene Textabschnitte werden als verifizierte Belege gespeichert und angezeigt. Laufende Aufträge prüfen den aktuellen Katalog und die Kontogeneration auch vor dem Lesen bereits indexierter Texte. Ein Zugriffsentzug stoppt den Auftrag; ungelesene alte Textteile werden nicht nachgereicht. Webtexte sind unvertrauenswürdige Belege, niemals zusätzliche Werkzeugaufträge. Lokale Notizen, Aufgaben und Kalenderänderungen bleiben durch den bestehenden Ablauf geregelt.

## Lokale Speicherung und Grenzen

Der Plattformcache liegt in IndexedDB des vertrauenswürdigen Context-Profils, verschlüsselt mit AES-GCM-256 und nicht exportierbarem CryptoKey. Texte und Manifest sind verschlüsselt. Änderungen verwenden atomare Revisionen; unveränderte Quellen können ihren vorhandenen Ciphertext behalten. Abbruch, Kurswechsel, Entlinken oder Kontowechsel verhindern verspätete Veröffentlichungen. Authentifizierung wird über einen opaken nativen Sitzungsfingerprint gebunden; Cookie-Werte verlassen den nativen Prozess nicht.

Grenzen: 100 Quellen, 5.000 Textdokumente, zusammen 5 Mio. Textzeichen, 20.000 Zeichen je Dokument und 24 MB verschlüsselte Row. Miro selbst liest höchstens 2.000 Elemente/40 Seiten, maximal 1 Mio. Elementtextzeichen. Ein Grenzfehler übernimmt keinen halben Cache. Die frühere vollständige Quelle bleibt erhalten, sofern ihre Kurs- und Kontozuordnung weiterhin gültig ist. Texte können unter Quellen → Zugriff & Speicherung lokal entfernt und erneut gelesen werden. Quelle und Schlüssel liegen im selben Profil; dies ersetzt keine Absicherung des angemeldeten Betriebssystemkontos.

Bei einer synthetischen lokalen Prüfung mit 5.000 kurzen Dokumenten dauerte Indexaufbau plus Quellenprüfung für einen Antwortturn 142,4 ms. Es entstanden vier Kontosnapshots, zusätzlich etwa 13,1 MiB JS-Heap und 26,9 MiB RSS. Dies misst weder Anbieter-/Netzwerk-/Modellzeit noch den gesamten Electron-Speicherbedarf; Werte hängen von Textgröße und Gerät ab.

Im separaten Dateibenchmark mit synthetischen deutschen Unterlagen benötigten die gebündelten Helfer im Median 21–62 ms und maximal etwa 22–73 MiB Spitzen-RSS je Helfer. Der Messwrapper-Start ist darin nicht enthalten; vollständige Messzeiten stehen separat in [document-benchmark.json](document-benchmark.json). Kein Gesamt-App-, OCR- oder Worst-Case-Benchmark und keine garantierte native Speicherobergrenze. Die Rohdatei wird nicht als Offline-Kopie gespeichert.

## Prüfung und aktuelle Live-Grenzen

Funktionen/Daten: Kurs- und globale Scopes, mehrseitige Suche, Miro-Elemente, Textdateifenster, einmalige Archivübergabe, Auszüge, CAS, parallele Speicherung und maximale Boardgröße wurden mit synthetischen Daten geprüft.

Sicherheitsgrenzen: angebotene Links, fremde Ordner/Repos/Boards, Geheimnisdateien, Redirects, Login-/403-Seiten, geänderte Registrierung/Konten, Abbruch, manipulierte Cachewerte und Prompt-Injection-Grenzen wurden unabhängig geprüft.

Browser: Heute, Quellen, persistierter GitLab-Texttreffer mit Original-Link, optionales Filtermenü und Home-Suchübergabe wurden in Hell/Dunkel sowie 1440×900 und 390×844 geprüft. Screenshots enthalten synthetische Daten.

Der vorhandene Codex-Miro-Zugang wurde tatsächlich geprüft; ein bekanntes Kursboard antwortete mit fehlender Berechtigung (403). Das beweist keinen Livezugriff der App. Die eigene Miro-Nango-Integration muss eingerichtet und mit einem für das Board berechtigten Konto freigegeben sein. Erfolg wird erst nach bestätigtem Abruf angezeigt. Windows/Linux-Build und reale LLM-Läufe über alle neuen Plattformwerkzeuge sind noch nicht geprüft. `platform-qa.json` und `VALIDIERUNG.md` enthalten den aktuellen Prüfstand.

## Dev-Diary-Upload

Der eigene Publisher bleibt vom allgemeinen Agentenleser getrennt. `dist/dev-diaries.js` sammelt lokale Tagesnotizen; `desktop/dev-diary.mjs` führt `get → prepare → publish` aus. Er prüft die kursgebundene WordPress-REST-API, den im nativen Prozess gehaltenen CSRF-Nonce, `/wp/v2/users/me`, Schreibrechte und die Kategorie `DevDiary`. Erstveröffentlichung: `POST /wp/v2/posts`; weitere Tage: `POST /wp/v2/posts/{ID}` mit dem gesamten aktuellen HTML. Kurs+Autor+Diary-Laufzeit, Marker, Slug und ein dauerhaftes lokales Journal verhindern Wiederholungsbeiträge nach unklaren Antworten. Externe Änderungen werden vor dem POST geprüft; dies ist ein Vorabvergleich, kein atomarer serverseitiger CAS. Der Reminder veröffentlicht nicht automatisch. Ein Live-Upload in einem konkreten Kurs muss separat bestätigt werden.
