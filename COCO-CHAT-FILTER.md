# CoCo-Fokus · Context 0.16.1

Der Filter gilt ausschließlich für WhatsApp Web im eingebauten Context-Browser. Er verändert keine WhatsApp-Kontoeinstellungen oder Chatlisten auf anderen Geräten.

## Benutzen

1. WhatsApp Web im Context-Browser öffnen und anmelden.
2. Neben der Adresszeile **CoCo-Fokus** öffnen. Während der Auswahl ist die normale WhatsApp-Liste sichtbar.
3. Die gewünschten Chats/Gruppen anhaken. **CoCo markieren** schlägt ausschließlich bereits gefundene Namen mit „CoCo“ oder „Code & Context“ vor; die Auswahl bleibt bearbeitbar.
4. **Fokus aktivieren** zeigt eine lokale Liste der ausgewählten Chats über der originalen WhatsApp-Liste. Ein Klick sucht den Chat bei Bedarf in den weiteren gerenderten Ausschnitten der Liste und öffnet ihn genau einmal, wenn die Zuordnung eindeutig ist. Währenddessen erscheint **Chat wird in WhatsApp gesucht …** und die Einträge sind vorübergehend gesperrt. Es werden keine Nachrichten verschickt.
5. **Alle Chats** im Auswahlpanel deaktiviert den Filter. Die gespeicherte Auswahl bleibt erhalten. Das Schließen des Auswahlpanels verwirft unbestätigte Checkboxänderungen.

WhatsApp lädt seine Liste während des Scrollens nach. Für weitere Chats in WhatsApp scrollen oder die normale WhatsApp-Suche benutzen, anschließend **Aktualisieren** im Auswahlpanel. Die Suche im Panel durchsucht nur bereits gefundene Chatnamen. Höchstens 500 gefundene Namen bleiben vorübergehend im Arbeitsspeicher; bis zu 100 ausgewählte Chats werden übernommen.

## Grenzen und Zuordnung

Wenn die gerenderte WhatsApp-Seite eine Chat-ID bereitstellt, verwendet Context sie. Andernfalls erfolgt die ausdrücklich gekennzeichnete Zuordnung über den normalisierten sichtbaren Namen. Ein umbenannter Chat muss dann neu ausgewählt werden. Identische Namen werden zusammengefasst; eine uneindeutige Zuordnung öffnet keinen zufälligen Chat.

Ein ausgewählter Chat kann beim Öffnen außerhalb des aktuell geladenen Ausschnitts liegen. Context scrollt dafür ausschließlich die vorhandene Chatliste, liest Titelattribute und prüft den Namen beziehungsweise die veröffentlichte Chat-ID erneut unmittelbar vor dem Klick. Namensbasierte Zuordnungen werden in der verfügbaren Liste auf doppelte Namen geprüft. Der Suchlauf ist auf 80 Ausschnitte und acht Sekunden begrenzt. Kann die Liste nicht vollständig durchlaufen, der Chat nicht gefunden oder ein doppelter Name erkannt werden, öffnet Context keinen Chat und stellt die ursprüngliche Scrollposition wieder her. Ein sichtbarer Hinweis führt zur normalen WhatsApp-Suche beziehungsweise **Alle Chats**. Aktive WhatsApp-Suchfilter begrenzen die verfügbare Liste; archivierte oder noch nicht geladene Chats können fehlen. Context verwendet keine internen WhatsApp-APIs.

Tabwechsel, Navigation, Ausschalten, Auswahländerung und Beenden brechen einen laufenden Öffnungsauftrag ab. Die Abbruchmeldung wartet nicht hinter dem laufenden Auftrag. Ausstehende asynchrone Titelprüfungen dürfen nach dem Abbruch keinen verspäteten Klick auslösen. Der native DOM-Aufruf hat außerdem ein Zeitlimit von elf Sekunden.

WhatsApp kann seine Oberfläche ändern; nicht mehr erkannte Listen bleiben mit einem sichtbaren Hinweis in der normalen Ansicht nutzbar.

Der Filter gehört zum Browser, nicht zum Posteingang oder KI-Gedächtnis. Auf anderen Domains erscheint kein Filterbutton. Auf kleinen Fenstern erhält die Auswahl vorübergehend den Platz der Browserfläche; die Fokusansicht schafft bei Bedarf mehr Raum.

## Lokale Daten und Sicherheit

- Für die Funktion werden ausschließlich Chat-Titelattribute und gegebenenfalls Chat-IDs gelesen. Keine Nachrichtentexte, Bilder, Kontaktbilder, Zugangsdaten oder WhatsApp-internen Datenbanken.
- Nur die ausdrücklich gespeicherte Auswahl liegt in `whatsapp-focus.enc` im lokalen App-Profil, verschlüsselt über Electron/macOS beziehungsweise die verfügbare sichere Plattformverschlüsselung. Die temporär gefundenen übrigen Namen werden nicht dauerhaft gespeichert.
- Wenn sichere Verschlüsselung nicht verfügbar ist oder Speichern fehlschlägt, bleibt die Auswahl nur in der Sitzung; die Oberfläche zeigt den Hinweis. Es gibt keinen Klartext-Fallback. Die derzeitige Linux-Vorbereitung verwendet diesen Sitzungsmodus.
- Die Auswahl wird nicht in Workspace-Backups, Assistenten-Chats oder KI-Kontext übernommen. Es erfolgen keine Netzwerkanfragen für den Filter.
- Die native Schnittstelle ist ausschließlich aus dem vertrauenswürdigen Context-Hauptframe erreichbar. Ausführung nur im aktiven Browser auf `https://web.whatsapp.com`; Navigation und Identität werden erneut geprüft.
- Die Fokusliste läuft in einer getrennten JavaScript-Welt. Ihre lokalen Styles haben ausdrücklich Vorrang vor WhatsApps CSS-Reset, gelten ausschließlich für das eigene Overlay und werden beim Ausschalten, Auswählen, Navigieren oder Beenden entfernt. Die ursprünglichen WhatsApp-Zeilen und ihre Virtualisierung bleiben unverändert; es werden keine Chatzeilen mit `display:none` oder geänderter Höhe ausgeblendet.

## Prüfung

Native und Rendererprüfungen decken Titel-Erkennung ohne Nachrichtentextzugriff, sichere IDs/Namenszuordnung, virtuelle Zeilen, doppelte Namen, Auswahl/Abbruch, Origin- und Hauptframegrenzen, Verschlüsselung, Speicherfehler, Navigation und Cleanup ab. Fünf zusätzliche Regressionstests prüfen den Abbruch während ausstehender Titelprüfungen, den Tabwechsel und das erneute Öffnen nach einem Abbruch. Der Quit-Drain wartet auf bereits angenommene Schreibaufträge; nach dem Beenden werden neue Aufträge abgelehnt.

Ein separater Electron-Test verwendet die produktive Runtime und CSS mit einem strengen CSP, einem WhatsApp-ähnlichen CSS-Reset und 100 virtuellen Chatzeilen. Der ursprüngliche Code scheiterte an Darstellung, Öffnen einer weiter unten liegenden Zeile und doppelten Namen in unterschiedlichen Ausschnitten. Die Korrektur besteht diese Fälle. Auf macOS mit Electron 44.7.0 / Chromium 152.0.7977.130 öffnete die Suche Zeile 65 in etwa einer Sekunde; das ist eine Messung an der synthetischen Liste, kein Leistungsversprechen für das echte Konto. Originalgeometrie und Cleanup werden ebenfalls geprüft. Ergebnisdatei: `coco-filter-qa.json`. Je sieben Electron-Fälle bestehen in Hell und Dunkel, einschließlich Abbruch, fehlendem Ziel und null zusätzlichen Netzwerkzugriffen. Die schmale dunkle Prüfung verwendet ein 620 × 560 Pixel großes Testfenster. Ein nativer Klick auf **Prototyping Things** in der hellen Testansicht öffnete den richtigen Ausschnitt. Die Gesamtprüfung besteht mit 837 Tests; ein bereits vorhandener optionaler echter Sprachmodelltest bleibt übersprungen.

Eine Prüfung mit dem aktuellen echten WhatsApp Web wird getrennt ausgewiesen; synthetische Tests bestätigen keine dauerhaft stabilen WhatsApp-Selektoren. Nach jedem WhatsApp-Update kann eine Anpassung nötig werden.


Die Regressionen lassen sich aus dem Source-Paket nach `npm ci` wiederholen:

```sh
npm run test:chat-filter
npm run test:chat-filter:electron
```

Der zweite Befehl startet einen eigenen Electron-Testprozess mit frischem temporärem Profil und lokal abgefangener HTTPS-Testseite. Er greift nicht auf das echte WhatsApp-Konto zu und beendet sich nach der Prüfung. In einer Sandbox kann macOS die direkte GUI-Registrierung des Terminalprozesses verweigern; diese Sitzung verwendete deshalb eine separate lokale Test-App, die über die Mac-Oberfläche gestartet wurde. Windows und Linux wurden nicht tatsächlich getestet.
