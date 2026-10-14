# Dev Diary

In **Notizen → Dev Diary** einen vorhandenen Spaces-Kurs und die Kursphase wählen (Standard: 14 Tage). Der Editor zeigt eine große Tagesnotiz; Pfeile und Datumsauswahl wechseln den Tag. Änderungen werden nach kurzer Schreibpause lokal gespeichert. Beitragsvorschau und zusätzliche Reflexionsfragen bleiben optional.

## Schreiben und diktieren

Das Mikrofon neben einer Frage diktiert direkt in dieses Feld. Nach dem Öffnen der Spracheingabe lässt sich bei Bedarf das Zielfeld wechseln. Die vorhandene lokale whisper.cpp-/Silero-Erkennung verarbeitet Deutsch; Modellwahl, Downloadfortschritt, Pausendauer und CPU-Fallback stehen unter den Spracheinstellungen. Ein Modell muss einmal heruntergeladen werden; danach funktioniert die Erkennung offline. Die Spracheingabe braucht die Desktop-App und eine Mikrofonberechtigung. Details zu Einrichtung und Plattformgrenzen stehen in `LOCAL-SPEECH.md`.

Diktate werden an vorhandenen Text angehängt, bleiben bearbeitbar und werden nach dem Sprechende lokal in den Diary-Daten gesichert. Es gibt keinen automatischen Versand, keinen KI-Aufruf und keinen Eintrag im Chatarchiv. Audio wird verworfen. Beim Tagwechsel, Schließen oder Wechsel zum Chatmikrofon wird die Aufnahme abgebrochen. Zu lange Diktate bleiben vollständig zum manuellen Kopieren sichtbar; das Feldlimit beträgt 4.000 Zeichen.

## Beitrag gestalten

Die ausklappbaren Einstellungen steuern:

- Titel des Beitrags
- offene Tagesabschnitte oder aufklappbare Tage
- ältester oder neuester Tag zuerst
- Vorlagenfragen oder kurze Überschriften
- leere Felder ausblenden
- Kurszeitraum im Beitrag anzeigen

Die Vorschau enthält auch ungespeicherte Entwürfe. Text und Gestaltung werden automatisch lokal gesichert. Alte Diaries erhalten die bisherige offene Darstellung als Standard; Gestaltung wird auch im Arbeitsbereich-Backup mitgenommen.

## Spaces

**Auf Spaces speichern** führt lokale Sicherung, Vorprüfung und Veröffentlichung in einem einzigen Auftrag aus. Beim ersten Beitrag heißt der Button **Auf Spaces veröffentlichen**. Eine zusätzliche Freigabeseite gibt es im normalen Ablauf nicht. Pro Diary/Kursphase bleibt es derselbe Beitrag in der Kategorie `DevDiary`; weitere Tage aktualisieren ihn. Änderungen an Text oder Gestaltung verwerfen eine vorherige Freigabe. Externe Änderungen am Beitrag müssen weiterhin abgeglichen werden.

Markdown-Export, Vorschau und nativer Publisher verwenden dieselbe Gestaltung. Der Diary-Renderer erlaubt ausschließlich feste `details`-Tags mit einem Datum als `summary`; Inhalte bleiben HTML-escaped. Die allgemeine Markdown-Darstellung akzeptiert weiterhin kein HTML. Eine WordPress-Installation kann `details` zusätzlich filtern oder anders gestalten; die tatsächliche Darstellung auf einem produktiven Kurs-Space wurde für diese Änderung nicht durch einen Testpost überprüft.

## Prüfungen

`npm run check` prüft Datenmigration, Gestaltung, Entwurfs-/Speicherverhalten, einmalige Diktatübernahme, Kontextwechsel, Konfliktschutz und den nativen Publikationspfad mit synthetischen Antworten. Optional: `npm run test:diary:electron` für den echten Chromium-Editor mit isoliertem Profil und synthetischem Sprachtransport. Die Ausgabe behauptet keine echte Mikrofonaufnahme oder Veröffentlichung.

## Bestehender technischer Ablauf und Grenzen

Die folgenden Details gelten weiterhin. Seit 0.18.5 werden Vorprüfung und Freigabe innerhalb des einzelnen ausdrücklichen Speicherauftrags ausgeführt. Konflikte stoppen den Auftrag weiterhin. Bilder werden ausschließlich über die zusätzliche enge Medien-Schnittstelle zugelassen.

## Veröffentlichung und Wiederholung

Der native Publisher verwendet ausschließlich die angemeldete Spaces-Sitzung des Context-Browsers. Er liest die tatsächliche Kurs-API-Konfiguration, den angemeldeten Benutzer und die im API-Index bestätigten WordPress-Beitragsfunktionen. Die Kategorie **DevDiary** muss für den gewählten Kurs eindeutig vorhanden sein. Er legt keine Kategorien an und weicht nicht still auf Townsquare aus. Vorhandene Kategorien werden im Lesemodus abgefragt; dadurch sind keine Kategorie-Verwaltungsrechte erforderlich ([WordPress-Berechtigungsprüfung](https://developer.wordpress.org/reference/classes/wp_rest_terms_controller/get_items_permissions_check/)).

Intern bindet eine Vorprüfung den genauen Inhalt für maximal zehn Minuten an eine lokale Freigabe; der direkte Speicherauftrag löst sie sofort ein. Doppelklicks und wiederholte Freigaben derselben Vorschau legen keinen zweiten Beitrag an. Eine dauerhafte lokale Zuordnung und ein laufzeitbezogener Marker verbinden Kurs, Autor und eigenen Post. Die Zuordnung wird vor dem Schreibauftrag gesichert. Bei Zeitüberschreitung oder unklarer Serverantwort wird nicht automatisch erneut geschrieben; ein späterer lesender Abruf kann das Ergebnis abgleichen. Bleibt es unklar, hält das Tool weitere Schreibaufträge an.

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

Die Oberfläche erlaubt Laufzeiten von 1 bis 90 Tagen; importierte Daten können bis zu 366 Tage umfassen. Ein Diary unterstützt insgesamt 100.000 Zeichen Tagesnotizen, höchstens 4.000 Zeichen je Feld und maximal 100 Diaries pro Arbeitsbereich. Sehr große zusammengesetzte Beiträge können zusätzlich an die Größenbegrenzung des Publishers stoßen. Freies HTML und fremde Bild-URLs werden nicht ausgeführt; ausgewählte Fotos und GIFs laufen über den unten beschriebenen Medienpfad.

Automatische Prüfungen decken Kalenderzuordnung, reale Datumsgrenzen und Berlin-Zeit, lokale Speicherung und Import, Drafts, überlappende asynchrone Antworten, genau eine Veröffentlichung, Abbruch/Navigation, ursprüngliche Post-Zuordnung, API-/Origin-Grenzen, eigene Autorenschaft, verlorene Antworten, Konflikte und ausdrückliche Revision-Freigabe ab. Der Erinnerungsdienst wurde mit verschlüsselten Testdateien, Neustart, Sommer-/Winterzeit, Schreibfehlern und unterdrückten bzw. einmaligen Systemmeldungen geprüft.

Die Browser-UI wird separat mit synthetischen Tagebuchtexten und einem Fake-Connector geprüft. Solche Prüfungen sind kein echter Spaces-Schreibtest. Es werden keine Testtexte in einem realen Kurs veröffentlicht. Der tatsächlich geprüfte Mac-Stand und die endgültige Prüfanzahl stehen im begleitenden Update-Bericht.

## Vereinfachter Ablauf ab 0.18.5

Im täglichen Editor steht eine große Tagesnotiz im Vordergrund. Reflexionsfragen, Gestaltung und Erinnerung bleiben optional eingeklappt; die vollständige Beitragsvorschau kann separat geöffnet werden. Änderungen werden nach kurzer Schreibpause lokal gesichert. Fehler beim lokalen Speichern bleiben sichtbar, der Entwurf wird behalten.

**Auf Spaces speichern** (beim ersten Mal **Auf Spaces veröffentlichen**) sichert den lokalen Stand und führt Vorprüfung und Veröffentlichung in einem Auftrag aus. Es ist keine separate Speicher-, Prüf- und Freigabefolge nötig. Der native Publisher behält die Zuordnung zum bestehenden eigenen Beitrag und prüft dessen Revision unmittelbar vor dem Schreiben. Eine bestätigte Veröffentlichung schließt den beschriebenen Tag für die tägliche Erinnerung ab. Nur bei tatsächlich externen Änderungen ist weiterhin ein ausdrücklicher Abgleich nötig. Unklare Schreibantworten werden nicht ungeprüft wiederholt.

### Fotos und GIFs

**Foto / GIF** fügt eigene Dateien zum ausgewählten Tag hinzu. Unterstützt sind JPG, PNG, WebP und GIF mit maximal 8 MiB und 40 Megapixeln je Datei, acht Bilder je Tag und 40 je Diary. Dateisignatur und Abmessungen werden geprüft; SVG/HTML und fremde Bild-URLs werden nicht als Bilder ausgeführt. GIF-Dateien werden ohne Umwandlung hochgeladen. Bildunterschriften sind optional; Entfernen entfernt die Einbindung aus dem Tag, löscht aber keine möglicherweise anderweitig verwendete Datei aus der Spaces-Mediathek.

Die Auswahl speichert die Originaldatei zunächst ausschließlich auf diesem Gerät. Der private lokale Medienspeicher ist auf 100 MiB begrenzt, Dateien und Index haben Dateimodus 0600. Die Binärdateien liegen getrennt vom Workspace-JSON; ein gewöhnlicher JSON-Backup- oder Markdown-Export enthält diese Originaldateien nicht. Nach einem Gerätewechsel müssen lokale Originale deshalb erneut ausgewählt werden. Originaldateien können Metadaten wie EXIF enthalten. Bereits auf Spaces hochgeladene Dateien bleiben dort gemäß den Zugriffsregeln der Mediathek; Medien-URLs können anders geschützt sein als der Kursbeitrag selbst.

Erst der ausdrückliche Spaces-Speicherbutton überträgt die Bilder über die vom konkreten Kurs bestätigte [WordPress-Medien-API](https://developer.wordpress.org/rest-api/reference/media/). Dafür benötigt das bereits angemeldete Konto `upload_files`; Context fordert keine neuen Rechte an und weicht nicht auf einen fremden Upload-Dienst aus. Ein nach Kurs, Autor und Inhalt gebundener Upload-Schlüssel und ein vor dem Upload gesicherter Status verhindern blinde Wiederholungen. Verlorene Antworten werden lesend anhand der eindeutigen eigenen Medienkennung abgeglichen. Kann ein Upload nicht eindeutig bestätigt werden, wird angehalten. Teilweise hochgeladene Medien können bei einem danach fehlgeschlagenen Beitrag bereits in der Mediathek liegen.

Lokale Bildvorschauen verwenden ausschließlich lokale Blob-URLs. Die Hauptfenster-Policy erlaubt dafür `blob:` in `img-src`, auch wenn noch ein älterer separat gestarteter Hub dieselbe lokale Seite ausliefert. Drittanbieter-Seiten, Skript-, Frame- und Netzwerkgrenzen bleiben dabei unverändert.
