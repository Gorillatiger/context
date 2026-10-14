# Dev Diary

In **Notizen → Dev Diary** einen vorhandenen Spaces-Kurs und die Kursphase wählen (Standard: 14 Tage). Der Editor verwaltet Tagesnotizen und eine gemeinsame Beitragsvorschau. Datumsleiste oder Datumsauswahl wechseln den Tag; nicht gespeicherte Tagesentwürfe bleiben während dieser Sitzung erhalten.

## Schreiben und diktieren

Das Mikrofon neben einer Frage diktiert direkt in dieses Feld. Alternativ **Diktieren** öffnen und das Zielfeld wählen. Die vorhandene lokale whisper.cpp-/Silero-Erkennung verarbeitet Deutsch; Modellwahl, Downloadfortschritt, Pausendauer und CPU-Fallback stehen unter den Spracheinstellungen. Ein Modell muss einmal heruntergeladen werden; danach funktioniert die Erkennung offline. Die Spracheingabe braucht die Desktop-App und eine Mikrofonberechtigung. Details zu Einrichtung und Plattformgrenzen stehen in `LOCAL-SPEECH.md`.

Diktate werden an vorhandenen Text angehängt, bleiben bearbeitbar und werden erst mit **Speichern** dauerhaft in den Diary-Daten gesichert. Es gibt keinen automatischen Versand, keinen KI-Aufruf und keinen Eintrag im Chatarchiv. Audio wird verworfen. Beim Tagwechsel, Schließen oder Wechsel zum Chatmikrofon wird die Aufnahme abgebrochen. Zu lange Diktate bleiben vollständig zum manuellen Kopieren sichtbar; das Feldlimit beträgt 4.000 Zeichen.

## Beitrag gestalten

Die ausklappbaren Einstellungen steuern:

- Titel des Beitrags
- offene Tagesabschnitte oder aufklappbare Tage
- ältester oder neuester Tag zuerst
- Vorlagenfragen oder kurze Überschriften
- leere Felder ausblenden
- Kurszeitraum im Beitrag anzeigen

Die Vorschau enthält auch ungespeicherte Entwürfe. **Speichern** übernimmt Text und Gestaltung lokal. Alte Diaries erhalten die bisherige offene Darstellung als Standard; Gestaltung wird auch im Arbeitsbereich-Backup mitgenommen.

## Spaces

**Für Spaces prüfen** speichert zuerst den lokalen Stand und bereitet eine unveränderliche Veröffentlichungsvorschau vor. Erst der anschließende Veröffentlichungsbutton schreibt. Pro Diary/Kursphase bleibt es derselbe Beitrag in der Kategorie `DevDiary`; weitere Tage aktualisieren ihn. Änderungen an Text oder Gestaltung verwerfen eine vorherige Freigabe. Externe Änderungen am Beitrag müssen weiterhin abgeglichen werden.

Markdown-Export, Vorschau und nativer Publisher verwenden dieselbe Gestaltung. Der Diary-Renderer erlaubt ausschließlich feste `details`-Tags mit einem Datum als `summary`; Inhalte bleiben HTML-escaped. Die allgemeine Markdown-Darstellung akzeptiert weiterhin kein HTML. Eine WordPress-Installation kann `details` zusätzlich filtern oder anders gestalten; die tatsächliche Darstellung auf einem produktiven Kurs-Space wurde für diese Änderung nicht durch einen Testpost überprüft.

## Prüfungen

`npm run check` prüft Datenmigration, Gestaltung, Entwurfs-/Speicherverhalten, einmalige Diktatübernahme, Kontextwechsel, Konfliktschutz und den nativen Publikationspfad mit synthetischen Antworten. Optional: `npm run test:diary:electron` für den echten Chromium-Editor mit isoliertem Profil und synthetischem Sprachtransport. Die Ausgabe behauptet keine echte Mikrofonaufnahme oder Veröffentlichung.

## Bestehender technischer Ablauf und Grenzen

Die folgenden Details gelten weiterhin. In 0.18.2 ergänzt ausschließlich die oben beschriebene feste Disclosure-Syntax den bisherigen Text-Renderer.

## Veröffentlichung und Wiederholung

Der native Publisher verwendet ausschließlich die angemeldete Spaces-Sitzung des Context-Browsers. Er liest die tatsächliche Kurs-API-Konfiguration, den angemeldeten Benutzer und die im API-Index bestätigten WordPress-Beitragsfunktionen. Die Kategorie **DevDiary** muss für den gewählten Kurs eindeutig vorhanden sein. Er legt keine Kategorien an und weicht nicht still auf Townsquare aus. Vorhandene Kategorien werden im Lesemodus abgefragt; dadurch sind keine Kategorie-Verwaltungsrechte erforderlich ([WordPress-Berechtigungsprüfung](https://developer.wordpress.org/reference/classes/wp_rest_terms_controller/get_items_permissions_check/)).

Eine Vorschau bindet den genauen Inhalt für maximal zehn Minuten an eine lokale Freigabe. Doppelklicks und wiederholte Freigaben derselben Vorschau legen keinen zweiten Beitrag an. Eine dauerhafte lokale Zuordnung und ein laufzeitbezogener Marker verbinden Kurs, Autor und eigenen Post. Die Zuordnung wird vor dem Schreibauftrag gesichert. Bei Zeitüberschreitung oder unklarer Serverantwort wird nicht automatisch erneut geschrieben; ein späterer lesender Abruf kann das Ergebnis abgleichen. Bleibt es unklar, hält das Tool weitere Schreibaufträge an.

Manuelle Änderungen außerhalb von Context erzeugen einen Konflikt. Die Oberfläche zeigt den aktuellen eigenen Spaces-Text mit Original-Link; längere Texte sind als gekürzt gekennzeichnet. Relevante Änderungen müssen zunächst in die lokalen Tagesnotizen übertragen werden. Erst eine ausdrückliche Bestätigung erlaubt eine neue Vorschau gegen genau diese aktuelle Revision. Jede weitere externe Änderung vor dem Schreiben blockiert erneut. WordPress bietet hier keine bestätigte atomare Compare-and-Swap-Funktion: Eine gleichzeitige Änderung zwischen der letzten Prüfung und dem Schreiben ist weiterhin möglich.

Automatische E-Mails an Kursmitglieder werden nur abgeschaltet, wenn die tatsächliche API das entsprechende Spaces-Feld bestätigt. Andernfalls weist die Vorschau ausdrücklich darauf hin, dass die Site ihre üblichen E-Mail-Mitteilungen auslösen kann.

## Erinnerungen

Fällige Hinweise erscheinen im gemeinsamen Context-Posteingang und öffnen den betreffenden Tag. In der Mac-App läuft zusätzlich ein nativer Timer, auch bei minimiertem Fenster. Die Systemmeldung enthält nur **„Zeit für deinen Dev Diary“**, ohne Kursname oder Tagebuchtext. Ein Klick öffnet das passende Diary.

Die App muss laufen; es wird kein Betriebssystem-Hintergrunddienst installiert und kein Gerät automatisch geweckt. Beim nächsten Start wird nur eine für **heute** fällige Erinnerung nachgeholt, kein Stapel vergangener Tage. Sommerzeit, Winterzeit und wiederholte Stunden sind behandelt. Änderungen an Zeitraum, Erinnerung, Abschlussstatus und die lokale tägliche Zustellkennung verhindern doppelte Hinweise.

## Lokale Daten

Diaries liegen als `devDiaries` im vorhandenen lokalen Arbeitsbereich und sind im normalen Workspace-Backup enthalten. Dieser vorhandene Workspace-Speicher ist nicht separat verschlüsselt. Sichere das Mac-Benutzerkonto und verwende FileVault, wenn ein verschlüsseltes Gerät benötigt wird.

Die native Datei `dev-diaries/dev-diary-publisher.json` enthält mit Dateimodus 0600 nur Kurs-/Autor-/Post-Zuordnung, Hashes und ausstehende Schreibkennung, keine Inhalte, Cookies oder Nonces. Die Konfiguration des Erinnerungsdienstes und die täglichen Zustellkennungen liegen verschlüsselt in `dev-diaries/diary-reminders.enc`; sie enthalten weder Kursnamen noch Tagebuchtexte. Ohne sichere Plattformverschlüsselung bleiben Erinnerungen in der Sitzung. Windows/Linux sind vorbereitet, aber für diese Funktion nicht getestet.

API-Nonces bleiben im nativen Arbeitsspeicher, gehen nicht an den Renderer oder an KI-Anbieter und werden nicht protokolliert. Die beiden nativen Schnittstellen sind nur aus dem vertrauenswürdigen Context-Hauptframe erreichbar. Die allgemeine lesende Agenten-Browserfunktion bekommt keine Schreibberechtigung.

Ein Backup-Import setzt importierte Spaces-Statusangaben auf „unbekannt“; sie sind keine Veröffentlichungsberechtigung. Der native Publisher prüft seine eigene Zuordnung und den tatsächlichen eigenen Beitrag erneut.

## Grenzen und Prüfung

Die Oberfläche erlaubt Laufzeiten von 1 bis 90 Tagen; importierte Daten können bis zu 366 Tage umfassen. Ein Diary unterstützt insgesamt 100.000 Zeichen Tagesnotizen, höchstens 4.000 Zeichen je Feld und maximal 100 Diaries pro Arbeitsbereich. Sehr große zusammengesetzte Beiträge können zusätzlich an die Größenbegrenzung des Publishers stoßen. Dateien, Bilder und HTML werden durch diese Textvorlage nicht hochgeladen oder ausgeführt.

Automatische Prüfungen decken Kalenderzuordnung, reale Datumsgrenzen und Berlin-Zeit, lokale Speicherung und Import, Drafts, überlappende asynchrone Antworten, genau eine Veröffentlichung, Abbruch/Navigation, ursprüngliche Post-Zuordnung, API-/Origin-Grenzen, eigene Autorenschaft, verlorene Antworten, Konflikte und ausdrückliche Revision-Freigabe ab. Der Erinnerungsdienst wurde mit verschlüsselten Testdateien, Neustart, Sommer-/Winterzeit, Schreibfehlern und unterdrückten bzw. einmaligen Systemmeldungen geprüft.

Die Browser-UI wird separat mit synthetischen Tagebuchtexten und einem Fake-Connector geprüft. Solche Prüfungen sind kein echter Spaces-Schreibtest. Es werden keine Testtexte in einem realen Kurs veröffentlicht. Der tatsächlich geprüfte Mac-Stand und die endgültige Prüfanzahl stehen im begleitenden Update-Bericht.
