# Kalender-Sync · 0.16.9

**Sync** liest alle verbundenen Outlook- und Google-Kalender für den angezeigten Monat und übernimmt neue oder geänderte Termine direkt in den lokalen Context-Kalender. Ein unveränderter Abgleich schreibt keine Termine und keinen neuen Aktivitätseintrag. Konten, Foto-KI, Dateiimport, ICS-Export und Sync-Einstellungen stehen in jeder Ansicht unter **Mehr**. „Gmail“ bedeutet hier den Google-Kalender des Gmail-Kontos; E-Mail-Texte werden nicht in Termine umgewandelt.

## Automatische Aktualisierung

Beim Start der Desktop-App läuft ein Abgleich unabhängig davon, welche Seite geöffnet ist. Er liest den Vormonat, den aktuellen Monat und die drei folgenden Monate. Die Grenzen sind Berliner Monatsanfänge einschließlich Zeitumstellungen. Danach wird alle 15 Minuten bei sichtbarer App geprüft. Bei Hintergrundbetrieb warten fällige Prüfungen bis zur Rückkehr; Seiten-Cache, Abbruch und Beenden stoppen laufende Arbeit. Fehler werden nach 1, 2, 5 und höchstens 15 Minuten erneut geprüft. Es laufen keine überlappenden automatischen Abfragen. Ein belegter Prozess wird nach fünf Sekunden erneut versucht.

Dauerhaft eingerichtete **Nango-Verbindungen** können nach einem Prozessneustart mit Token-Erneuerung weiterarbeiten. Bei direkter OAuth-Einrichtung bleiben Tokens und Konfiguration bewusst im Arbeitsspeicher; nach dem Beenden kann eine erneute Anmeldung nötig sein. Der Sync öffnet keine Anmeldedialoge und erweitert keine Berechtigungen selbstständig. Ohne verbundenes Konto bleiben gespeicherte Termine verfügbar; **Mehr → Konten verbinden** führt zur Einrichtung. Ein Browser-Login bei Microsoft/Google ersetzt keine Kalenderfreigabe.

## Identität und Sicherheit

Ein Termin wird über Anbieter, Kalender-ID und externe Termin-ID identifiziert. Eine andere Uhrzeit oder ein anderer Titel aktualisiert denselben lokalen Eintrag; die lokale Kurszuordnung bleibt erhalten. Identische Seitenüberlappungen werden einmal übernommen. Widersprüchliche IDs, ungültige Antworten, Kontowechsel oder ein während der Abfrage ersetzter Arbeitsbereich verhindern die gesamte Übernahme. Die Speicherung erfolgt erst nach Validierung des vollständigen lokalen Ergebnisses. Fehler lassen den bisherigen Kalender unverändert. Einzelne Quelltermine mit einer Null- oder negativen Dauer werden als nicht darstellbar ausgelassen und gezählt angezeigt; gültige Termine aus dem Abruf bleiben nutzbar. Der Abruf wird dabei ausdrücklich als unvollständig markiert. Für ausgelassene Termine wird keine Dauer erfunden, und ein eventuell vorhandener lokaler Eintrag bleibt erhalten.

Unterschiedliche Termine mit ähnlichem Titel oder derselben Uhrzeit werden nicht zusammengeführt. Derselbe Termin in verschiedenen Kalendern/Anbietern kann weiterhin getrennte Quelleneinträge besitzen. Fehlende oder beim Anbieter gelöschte Termine werden nicht automatisch lokal entfernt: Teilantworten und Zeitfenster beweisen keine Löschung. Der Sync löscht auch keine Termine bei den Anbietern.

Automatische Outlook-Veröffentlichung eigener Context-Termine setzt die zuvor ausdrücklich aktivierte Automatik, einen gewählten Zielkalender und bestehende Schreibrechte voraus. Ein gespeichertes Ziel allein genügt nicht. **Sync** kann den bereits eingerichteten Zielkalender manuell abgleichen. Google bleibt lesend. Outlook-/Google-Importe werden nicht erneut als eigene Context-Termine veröffentlicht; bestätigte Outlook-Marker verhindern Doppelanlagen nach Wiederholung oder unsicheren Antworten.

## Grenzen und Plattformen

- Maximal 50 Kalender je Anbieter; unvollständige Listen werden angezeigt.
- Je Kalenderabruf höchstens acht Seiten und 2.000 Rohzeilen. Folgeseiten laufen ausschließlich über die überprüften ursprünglichen Provider-Endpunkte. Eine weitere Seite nach der Grenze wird als unvollständiger Abruf gemeldet.
- Der bestehende lokale Workspace unterstützt insgesamt 2.000 Termine. Bei Überschreitung bleibt der bisherige Stand erhalten; ein kleinerer manueller Zeitraum kann weiterhin geprüft werden. Es gibt keine automatische Bereinigung alter Termine.
- Provider-Zeitraum höchstens 180 Tage. Der manuelle Abgleich umfasst einen Monat, die Startaktualisierung fünf Monate.
- Windows/Linux sind architektonisch vorbereitet, für dieses Update aber nicht ausgeführt. macOS/Chromium wurde geprüft.

## Prüfung

Automatische Tests decken identische Wiederholung, geänderte Zeit/Titel, Kurszuordnung, widersprüchliche IDs, volle und leere Folgeseiten, 2.000er-Grenze, unsichere Folgelinks, Kontowechsel, Abbruch, BFCache, Start ohne geöffneten Kalender, Timer und die Freigabegrenze für Outlook-Schreibaktionen ab. Die echte Browserbedienung nutzt isolierte synthetische Konten: zwei Termine erscheinen beim Start auf „Heute“, eine Verschiebung aktualisiert denselben Eintrag und ein erneuter Sync meldet „Alle Termine aktuell“. Helle Desktop- und dunkle 390×844-Ansicht sowie Menü und Tagesraster geprüft. Dabei wurden keine echten Providerkonten verbunden oder verändert.

Prüfbericht: [calendar-sync-qa.json](calendar-sync-qa.json). Die aktualisierte App enthält auch die vorherige Crawler-Korrektur aus 0.16.7. Der bestehende Mail-/KI-Server auf Port 4318 wird bei der Installation nicht neu gestartet.


Die installierte Mac-App **0.16.9** wurde anschließend mit den bereits eingerichteten echten Konten geprüft: Beide Kalenderverbindungen bleiben nach dem Neustart verbunden. Der automatische Startabruf übernahm 65 neue Termine; ein Outlook-Eintrag ohne positive Dauer wurde mit sichtbarer Warnung ausgelassen. Ein anschließender manueller Oktober-Sync meldete „Alle Termine aktuell“ ohne weitere Anlagen oder Änderungen. Private Kalendertitel, IDs, Beschreibungen und Browserprofile wurden nicht in Prüfberichte oder Releasearchive übernommen. Für neue direkte OAuth-Anmeldungen oder unverbundene Konten ersetzt dieser Test keine eigene Freigabe.
