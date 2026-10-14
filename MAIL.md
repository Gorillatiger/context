# Mail · Bedienung

**Neu in 0.17.3:** lokale Empfängervorschläge in An/Cc/Bcc aus bekannten Mailadressen, per Maus oder Tastatur. [Herkunft, Bedienung und Grenzen](MAIL-CONTACTS.md).

Die folgenden Abschnitte beschreiben die Mail-Grundfunktionen seit 0.15.2.

## Lesen und Navigieren

Ordner, Nachrichtenliste und Nachrichtenansicht haben eigene begrenzte Scrollbereiche. Der Mailbereich nutzt die verfügbare Fensterhöhe. Liste und Nachricht lassen sich auch mit Tab und Bild-ab/Bild-auf bedienen. Seitenwechsel für je 40 Nachrichten bleiben unter der Liste erreichbar. In kleinen Fenstern öffnet eine Nachricht die Detailansicht; **Zur Liste** kehrt zur vorherigen Listenposition zurück.

Beim Laden eines Anhangs, beim Aktualisieren desselben Postfachs und bei normalen Statusänderungen bleiben die Scrollpositionen erhalten. Ein neuer Ordner, eine neue Suchseite oder eine andere Nachricht beginnt mit ihrer eigenen Ansicht. Die Ordnerleiste kann bei schmalen Fenstern horizontal gescrollt werden.

Mailtexte werden als Text gezeigt. Bei HTML-Mails werden sichere Textabschnitte und HTTPS-Linkziele übernommen, keine externen Bilder oder Scripts geladen. Gemischte MIME-Nachrichten behalten ihre unterschiedlichen lesbaren Abschnitte. Doppelte Klartext-/HTML-Darstellungen derselben Nachricht werden nicht zweimal angehängt; ein leerer Klartextteil verdrängt den HTML-Text nicht mehr.

Das Öffnen verwendet IMAP `BODY.PEEK[]` und ändert den Lesestatus nicht automatisch. **Als gelesen/ungelesen markieren** ist eine eigene Aktion. Ein erfolgreich vorbereiteter Anhang erhält einen sichtbaren **Datei speichern**-Link.

## Schreiben und Versand

**Nachricht schreiben** öffnet bzw. setzt deinen lokalen Entwurf fort. **Entwurf schließen und behalten** erhält auch nur teilweise ausgefüllte An-/Cc-/Bcc-/Betreff-Felder. Eine Antwort auf eine andere Nachricht überschreibt diesen Entwurf nicht. Entwürfe bleiben nur in diesem Tab bis zum Neuladen; sichere den Text vor einem App-Neustart.

Während Anhänge eingelesen werden, ist die Versandprüfung gesperrt. Mehrere Dateiauswahlen werden auch beim Abschluss gemeinsam gegen die Grenzen geprüft: zehn Dateien, insgesamt acht MB. Die Versandvorschau ist eine unveränderliche Kopie der geprüften Empfänger, Texte und Anhänge. **Jetzt senden** ist die separate abschließende Aktion; Enter im Nachrichtentext sendet nichts.

Bei teilweiser SMTP-Annahme bleibt ein Entwurf für abgelehnte Empfänger erhalten, mit Text und Anhängen sowie den ursprünglichen An-/Cc-/Bcc-Rollen. Prüfe diese Rollen vor einem weiteren Versand. Bei unklarem Transportstatus wird kein erneuter Versand automatisch versucht; auch Zurückgehen und erneutes Prüfen umgehen diese Sperre nicht. Erst der ausdrückliche Start eines neuen Entwurfs nach Prüfung beim Empfänger oder in Webmail ist ein neuer Auftrag.

## Fehler und Wiederherstellung

Ein fehlgeschlagener Ordnerabruf zeigt **Nachrichten konnten nicht geladen werden → Erneut laden**, statt ein leeres Postfach zu behaupten. Verspätete Ergebnisse eines vorherigen Ordners, einer Nachricht, eines Downloads oder einer getrennten Verbindung dürfen die aktuelle Ansicht nicht überschreiben.

Eine zurückgewiesene IMAP-Anmeldung wird als Anmeldefehler behandelt. Eine abgelaufene lokale Browser-Sitzung ist getrennt davon: Sichere offene Entwürfe und lade den Arbeitsbereich neu. Die lokale API benutzt weiterhin HttpOnly/SameSite-Cookies, exakte Origin-Prüfung und zusätzliche Anfrageheader. Neu gestartete lokale Dienste verwenden Cookie-Namen und Session-Tokens pro Dienst/Port, damit mehrere App-Versionen bzw. Testserver einander nicht abmelden. Feed-Caches sind ebenfalls pro Handler getrennt.

Die Port-/Cookie-Korrektur wird für einen bereits laufenden alten Hub-Dienst erst beim nächsten regulären Neustart dieses Dienstes aktiv. Das Mailkonto muss danach erneut verbunden werden, weil seine Zugangsdaten absichtlich nur im Dienst-Arbeitsspeicher liegen. Der bestehende angemeldete Dienst auf Port 4318 wurde für dieses Update nicht beendet. Die Oberfläche und der Python-Mailadapter können aus dem aktualisierten Quellstand nach dem Neuladen genutzt werden; die neue Desktop-App enthält den korrigierten Dienst für zukünftige Starts.

## Prüfung und Grenzen

Die Tests decken Scroll-/Fokuserhalt, lokale Sitzungen, verspätete Antworten, Entwurfsschutz, parallele Anhänge, Teilzustellung, Wiederholungssperren, MIME-Inhalte, TLS und API-Grenzen ab. GUI-Prüfungen nutzten 82 synthetische Nachrichten, eine lange Mail mit Anhang und einen längeren Entwurf. Die echte TH-Verbindung wurde lesend mit 40 Kopfzeilen und einer vollständigen Nachricht geprüft; es wurden keine echten Mails verschickt, keine echten Anhänge heruntergeladen und keine Lesestatus-Aktionen ausgeführt.

Getestet wurde macOS auf Apple Silicon. Die Scroll-/Renderer-Korrekturen sind Webcode, die native App und die echte TH-Verbindung wurden unter Windows/Linux für dieses Update nicht getestet. Der jeweilige geprüfte Paket-/Installationsstand steht im Update-Bericht.
