# Context 0.16.3 — Chat und Integrationen

Der Hauptchat und der schwebende Assistent verwenden dieselbe kompakte Gesprächsfläche. Neu, Verlauf und Einstellungen sind über beschriftete Icons erreichbar. Modellwahl, aktive Kurs-/Quellen-/Aktionsmodi bleiben sichtbar. Wissensauswahl, Anbieter, Sprachoptionen und Verbindungsinformationen liegen im Einstellungsmenü; Backup und Import im Verlauf. Quellen und Schritte einer Antwort sind aufklappbar. Wiederholte Einleitungen und Hilfetexte auf Heute, Projekte, Notizen, Ablage und Mitteilungen sind gekürzt oder über Info-Details zugänglich.

Das Gespräch hat einen eigenen Scrollbereich. Die Eingabe bleibt unten sichtbar; passive Aktualisierungen erhalten Leseposition, offene Quelldetails, Entwurf und Markierungsrichtung. Die Hauptansicht blendet das zusätzliche schwebende Symbol aus, damit es Senden nicht verdeckt. Escape schließt zunächst das offene Chatmenü und gibt den Fokus zurück. Provider-/Wissenswechsel beginnt weiterhin einen neuen Chat, damit alte Antworten aus abgewählten Quellen nicht erneut an den Anbieter gesendet werden; der Entwurf bleibt erhalten. Mikrofon, Foto, Stoppen, lokale Aktionen, Archiv und ihre bisherigen Freigaben bleiben erhalten.

## Mitteilungen

Mattermost nutzt mit einem eingerichteten `MATTERMOST_TOKEN` ausschließlich lesende GET-Endpunkte. Bis zu fünf Teams und 20 Kanäle werden geprüft; maximal zehn ungelesene Kanäle liefern je zehn Textvorschauen. Höchstens 40 Requests, drei gleichzeitig und 20 Sekunden Gesamtbudget. Keine Direktnachrichten, Anhänge, Medien, Send- oder Lesestatusänderung. Fehler und Grenzen bleiben als Teilstand sichtbar. Ein Post-Link führt zur konkreten Nachricht; seine Kanal-URL sorgt für passende Kurszuordnung. Hinweistext bleibt im laufenden Feed im RAM und wird nicht als vollständige Offline-Chatkopie gespeichert. Ausgewählte Texte können wie bisher im Assistenten und dessen lokalem Archiv verwendet werden.

Verschwindet die ausgewählte Gruppe beim Aktualisieren, fällt der Filter sichtbar auf alle verfügbaren Gruppen zurück. Fehlende Veröffentlichungszeiten bleiben unbekannt. Zähler verwenden eine separat als „Stand“ bezeichnete Abrufzeit. Fehlende Mail-Datumsheader lassen die Nachricht nicht mehr fälschlich neu erscheinen.

Primär geprüft: [Mattermost-Kanal-API](https://raw.githubusercontent.com/mattermost/mattermost/master/api/v4/source/channels.yaml), [Post-API](https://raw.githubusercontent.com/mattermost/mattermost/master/api/v4/source/posts.yaml), [Post-Permalinks](https://docs.mattermost.com/end-user-guide/collaborate/share-links).

## Begleiter und Kalender

Gespeicherte Ablage-Links und ihre redigierten lokalen Notizen sind kursbezogen durchsuchbar. Das liest den verlinkten Inhalt nicht automatisch. Manuelles Spaces-Einlesen hält bis zu 20.000 Zeichen über vier Abschnitte bereit und prüft Kurs, URL, Titel und Offset vor der Zuordnung. Fremde oder veränderte Abschnitte werden nicht unter dem ursprünglichen Kurs gespeichert.

Der Foto-Kalenderknopf erzeugt wieder einen tatsächlichen Importauftrag. Bei ausgeschalteter direkter Übernahme bleiben Vorschläge; bei eingeschalteter Übernahme entstehen belegte lokale Termine mit ICS. Die Regeln für Fragen, Negation und uneindeutige Daten bleiben bestehen. Der Outlook-Schreibrechte-Ablauf hat seine eigene Verbindungsrevision, verhindert den vorherigen ReferenceError und ignoriert veraltete Antworten.

## Prüfung und Aktivierung

941 JavaScript- und 19 Python-Prüfungen bestanden; eine optionale echte Speech-Modellprüfung bleibt im Standardlauf übersprungen. Separate Subagenten haben Connector, Kalender, Begleiter und UI geprüft. 15 neue Chat-UI-Fälle testen tatsächliches `createKIView` mit isolierten Daten; zusammen mit Floating-/Scrollprüfungen 30 Fälle. Die echte Browserbedienung mit ausschließlich synthetischem Provider wurde bei 1440×900, 850×600 und 390×844 geprüft: ein Composer, kein horizontaler Überlauf, Eingabe im Fenster, Menü/Escape, Entwurf, langer Verlauf, erhaltene Leseposition, Kursfilter und Nachrichtenvorschau. Darkmode wurde mit bestätigtem Themezustand bedient. Bericht: `chat-ui-qa.json`, Maße: `chat-ui-geometry.json`.

Getestet wurde macOS mit Chromium im Codex-Browser. Diese Prüfung umfasst keine neue echte Mattermost-API-Verbindung, Outlook-Zustimmung, Mikrofonaufnahme oder externe Modellinferenz. Windows/Linux wurden nicht ausgeführt. Der neue Appstand ist gebaut, aber die laufende installierte App bleibt bis zum regulären Beenden 0.16.0. Offene Entwürfe und Anmeldungen zuerst abschließen. Der bestehende Mail-/KI-Server auf 4318 wird nicht automatisch beendet. Seine geladenen Connector-Module werden erst bei einem bewussten Serverneustart erneuert; RAM-Zugänge müssen danach wieder verbunden werden. Die UI benötigt ein reguläres Neuladen beziehungsweise den aktualisierten Appstart. Die Inventar-Einbettung benötigt auch die neue native App.
