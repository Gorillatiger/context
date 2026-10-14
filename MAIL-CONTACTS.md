# Empfängervorschläge · 0.17.3

In **An**, **Cc** und **Bcc** nach einem Namen oder einer bekannten Mailadresse tippen. Die Liste zeigt Name und vollständige Adresse. Ein Klick übernimmt den Kontakt. Mit Pfeil auf/ab und Enter ist die Auswahl per Tastatur möglich; Escape schließt die Liste. Enter in einem Empfängerfeld öffnet keine Versandvorschau und sendet keine Mail. Bei mehreren Treffern ist eine Auswahl erforderlich.

Es wird nur der gerade bearbeitete Empfänger zwischen Komma/Semikolon ersetzt. Andere Empfänger bleiben erhalten. Bereits eingetragene Adressen werden über alle drei Felder hinweg nicht erneut vorgeschlagen. Umlaute sowie Schreibweisen wie Müller/Mueller werden gefunden.

## Herkunft und Datenschutz

Kontakte stammen aus **bereits geladenen Mailkopfzeilen**: Absender, An, Cc und Reply-To. Zusätzlich werden An-/Cc-Adressen erst nach bestätigtem erfolgreichem Versand gelernt; abgelehnte Empfänger bleiben ausgeschlossen. Bcc, Nachrichtentexte und Anmeldedaten werden nicht als Kontaktquelle genutzt. Ein bloßer Personenname erzeugt keine erfundene Hochschuladresse.

Bis zu 500 Kontakte je aktuellem Konto, höchstens acht Vorschläge. Der Kontaktbestand bleibt ausschließlich im Arbeitsspeicher und wird bei Kontowechsel/Trennung verworfen. Getrennte TH-/Outlook-/Gmail-Ansichten verwenden getrennte Bestände. Keine Kontaktdatei, kein Browser-Speicher, kein Kontakte-API-Aufruf beim Tippen. Entwürfe behalten ihre bisherigen Schutz- und Versandregeln.

Das ist kein vollständiges TH-Adressbuch. Eine Person erscheint erst, wenn eine vollständige Adresse aus den genannten Quellen bekannt ist. Weitere Mailseiten/Ordner laden erweitert den Bestand bis zur Grenze. Ein frischer App-Start beginnt ohne gespeicherte Kontakte.

## Technik und Prüfung

`dist/mail-contacts.js` validiert, begrenzt, sucht und ersetzt Empfänger. `dist/mail-recipient-ui.js` steuert die lokale ARIA-Combobox; nur die Vorschlagsliste wird beim Tippen aktualisiert. `dist/mail.js` bindet sie an bestehende Kopfzeilen, Kontogeneration, Entwurf und Versandstatus an. `dist/mail-contacts.css` verwendet die vorhandenen Theme-Farben und den scrollbaren Mailreader.

40 neue automatische Tests für Daten, Begrenzung, Tastatur/Maus, Duplikate, Stale-Account-Ergebnisse und echte Mailview-Integration. Vollständiger Prüflauf: **1.687 JS + 19 Python bestanden**, zwei bestehende optionale/umgebungsabhängige Skips. Unabhängige Integrationsprüfung sowie echte Browserbedienung mit ausschließlich synthetischen TH-/Outlook-/Gmail-Daten, 1440 × 900 hell und 390 × 844 dunkel. Keine echte Mail gesendet. Der Fixture-Mailrunner erhielt beim Tippen/Auswählen keine weiteren Anfragen.

Das neue Mac-Bundle ist für Apple Silicon gebaut. Windows/Linux für diesen Ausbau nicht praktisch getestet. Details: [mail-contacts-qa.json](mail-contacts-qa.json). Die installierte App bleibt bis zum regulären Speichern/Beenden auf ihrem bisherigen Stand; kein erzwungenes Beenden offener Entwürfe.
