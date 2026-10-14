# Dev Diaries · seit Context 0.15.1

## Einstieg und Ablauf

Im Bereich **Notizen** steht **Dev Diary starten** direkt über dem Notizbuch. Auch der normale Markdown-Notizdialog hat die Schaltfläche **Dev Diary mit Vorlage**. Vorhandene Notizentwürfe bleiben im Arbeitsspeicher erhalten.

1. Einen vorhandenen Kurs mit einem echten Spaces-Projektlink auswählen. Fehlt er, unter **Projekte → Verbindungen** einen Kurs-Space hinzufügen.
2. Beginn und Dauer festlegen: Standard **14 Kalendertage**. Eindeutig zugeordnete lokale Kalendertermine liefern einen separaten Vorschlag, der ausdrücklich übernommen oder geändert werden kann. Eine laufende Phase kann aus einem kürzlich vergangenen und einem folgenden Kurstermin innerhalb dieses Zeitraums vorgeschlagen werden. Es gibt keine automatische Laufzeitfestlegung und keine KI-Übermittlung des Kalenders.
3. Auf Wunsch die Spaces-Verbindung bereits vor dem Anlegen lesend prüfen. Es wird kein Beitrag angelegt.
4. Die tägliche Erinnerung einstellen: Standard **18:00 Uhr, Europe/Berlin**, einschließlich Wochenende; optional nur Montag bis Freitag. Dev Diary lokal anlegen.
5. Für jeden Tag **gemacht, gelernt, Probleme und nächster Schritt** notieren. Ein abgeschlossenes Tagesdatum unterdrückt dessen Erinnerung. Tageswechsel und Schließen erhalten ungesicherte Entwürfe in dieser App-Sitzung. **Tagesnotizen speichern** übernimmt alle offenen Tagesentwürfe dieses Diaries dauerhaft in den lokalen Arbeitsbereich.
6. **Für Spaces prüfen** speichert zunächst die Entwürfe, prüft Anmeldung/Kurs/Kategorie und zeigt den vollständigen Beitrag. Erst **Diesen Beitrag veröffentlichen** überträgt ihn. Anschließend heißt die Aktion **Aktualisierung prüfen** und aktualisiert denselben eigenen Beitrag.

Für denselben Kurs und exakt denselben Zeitraum verhindert die Oberfläche ein zweites Diary. Mehrere unterschiedliche Kursphasen haben getrennte Diaries. Pro Diary-Laufzeit bleibt es ein Spaces-Beitrag. Der Markdown-Export enthält auch noch ungesicherte Tagesentwürfe, ohne sie zu veröffentlichen.

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
