# Mitteilungen · 0.16.5

Mitteilungen zeigen kompakte Zeilen mit Titel, Textvorschau, Herkunft, Gruppe, Kurs und Zeitpunkt. Original öffnen und im Hub abhaken haben Icon-Aktionen mit zugänglichem Namen. Quellenstatus und manuelle Kurszuordnung öffnen erst bei Bedarf. Neu/Alle, Quelle und Gruppe lassen sich kombinieren; **Ohne Kurszuordnung** erreicht auch bei ausgewähltem Kurs die ungeordneten Hinweise aus allen Kursen. Abhaken ändert keine Lesestände beim Anbieter.

## Zuordnung

Eine manuelle Auswahl hat Vorrang, einschließlich bewusst „ohne Projekt“. Sonst werden belegte Projekt-/Kurs-IDs sowie sichere ursprüngliche URLs und Gruppen-/Kanal-URLs mit den vorhandenen Projektverbindungen abgeglichen. Mattermost-Postlinks benutzen zusätzlich ihre Kanal-URL. Pfadsegmentgrenzen, Ursprung, Query-Identität und mehrere passende Kurse werden geprüft. Auth-/Mailbox-/Weiterleitungslinks werden nicht als Kursbeleg verwendet. Widersprüchliche gleichwertige Belege bleiben unzugeordnet. Titelwörter, Personen- und Gruppennamen werden nicht als sichere Kurszuordnung geraten. Archivierte Kurse gelangen nicht zurück ins KI-Wissen. Die manuelle Auswahl gilt für den einzelnen Hinweis; daraus werden keine neuen Kontorechte abgeleitet.

## Aktualisierung

Bei sichtbarer geöffneter App werden eingerichtete Live-Connectoren 60 Sekunden nach dem letzten abgeschlossenen Abruf erneut geprüft. Ohne Live-Quelle beträgt das Intervall 120 Sekunden. Im Hintergrund pausieren automatische Abrufe. Bei Rückkehr wird ein überfälliger Stand einmal geprüft. Fehler verlängern den Abstand stufenweise auf höchstens fünf Minuten. Laufende Prüfungen werden nicht überlagert; kein Nachholen aller versäumten Intervalle.

**Aktualisieren** prüft manuell; der Server fasst gleichzeitig eintreffende Prüfungen zusammen. Normaler Cache: 60 Sekunden; manuelle Wiederholung: frühestens zehn Sekunden nach dem letzten abgeschlossenen Providerabruf. Das schützt vor Abrufstürmen. Eine erneute Prüfung zeigt ihren Zeitpunkt, auch wenn kein neuer Eintrag gefunden wurde.

Bei Abruffehlern bleiben die letzten Hinweise der betroffenen Quelle als „Letzter Stand“ sichtbar. Neue Revisionen ersetzen alte Einträge ohne doppelte Zeilen. Erfolgreich leere Quellen und getrennte Konten entfernen ihre vorherigen Live-Hinweise. TH-Kontowechsel leeren zugehörige Kopfzeilen sofort, und verspätete Antworten dürfen sie nicht zurückbringen. Quellenwechsel während eines Serverabrufs verwerfen dessen alten Kontostand und prüfen die aktuelle Konfiguration. Offene Kurs-/Quellendetails, Fokus und Leseposition bleiben bei passiven Aktualisierungen erhalten; Browser-Zurücknavigation über den Seitencache setzt die Prüfung fort.

## Grenzen

**Spaces-Browserstände sind Momentaufnahmen.** Der Timer aktualisiert eingerichtete APIs, lädt aber keinen neuen vollständigen Spaces-/WhatsApp-/Signal-Verlauf. Mattermost liest begrenzte Vorschauen ungelesener Kanäle, GitLab offene To-dos, TH-Mail ungelesene Kopfzeilen. Keine neuen OAuth-Rechte, Cookiekopien, Nachrichtenversand oder externen Schreibaktionen durch diesen Ausbau. OS-Hinweise enthalten lediglich „Es gibt neue Hinweise“ ohne Betreff/Absender.

Die Backend-Korrektur benötigt einen Prozess mit dem aktuellen `server.mjs`. Ein schon laufender externer Server wird nicht beendet, weil TH-Mail-/KI-Zugangsdaten nur in dessen RAM liegen können. Renderer und clientseitige Kontowechselgrenzen funktionieren mit dem aktualisierten Quellstand; die neue Servergeneration gilt ab einem regulären Neustart. Konten danach gegebenenfalls erneut verbinden.

Prüfungen: Scheduler mit Fake-Uhr, tatsächliche Server-/Mailclient-Rennen, aktueller App-Ablauf, Quellen-/Kursgrenzen und UI in Hell/Dunkel sowie schmalen Fenstern. Echte neue Providerzugriffe wurden im Testlauf nicht ausgeführt.

## GitLab und Mattermost in der App verbinden

Unter **Mitteilungen → Quellen & Status → GitLab bzw. Mattermost** (oder „Verbindungen einrichten“) trägst du den persönlichen Zugriffstoken ein. GitLab braucht den Zugriff `read_api`, Mattermost einen persönlichen Zugriffstoken, sofern die Plattform ihn freigibt.

- **Prüfung:** Der lokale Server liest einmal genau das, was der Connector später liest (GitLab: eigene To-dos, Mattermost: eigenes Profil). Abgelehnte oder nicht erreichbare Token werden nicht gespeichert, und die Meldung sagt warum.
- **Speicherung:** Der Token liegt verschlüsselt im macOS-Schlüsselbund (`ai-keys.enc`, wie die KI-Schlüssel) und wird beim Start wieder geladen. Ohne verfügbaren Schlüsselbund bleibt er nur bis zum Beenden im Speicher; die Oberfläche sagt das. Er erscheint nie in der Seite, ihrem Speicher, Links, Backups, Exporten oder Logs und wird nie zurückgegeben; im Feld steht nach dem Speichern nichts mehr.
- **Vorrang:** Ein in der App gespeicherter Token gilt vor `GITLAB_TOKEN`/`MATTERMOST_TOKEN` des lokalen Servers. „Token entfernen“ löscht ihn; dann gilt wieder die Umgebungsvariable, falls vorhanden.
- **Danach:** Die Mitteilungen werden sofort neu geprüft. TH-Mail wird weiter im Mailbereich eingerichtet, TH-Spaces über die Anmeldung im Context-Browser.
- **Prüfen:** `npm run test:services:electron` startet die echte Oberfläche mit simulierten Anbieterantworten (falscher Token, richtiger Token, nicht erreichbar, entfernen).

