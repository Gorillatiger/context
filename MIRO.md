# Miro-Inhalte für Suche und Assistent

Context liest Miro-Boards auf zwei Wegen und kennzeichnet jedes Ergebnis mit seinem Weg (`coverage.basis`):

| Weg | Voraussetzung | `coverage.basis` |
| --- | --- | --- |
| **Miro-API** | Eigene Nango-Verbindung mit `boards:read`, Board im verbundenen Team | `rest-api-text` |
| **Besucherzugriff** | Öffentlicher Board-Link („Jeder mit dem Link kann ansehen“), kein Miro-Konto nötig | `visitor-overview` |

Ist die API verbunden und kann sie das Board lesen, wird sie verwendet. Andernfalls (keine Verbindung, Board in einem fremden Team, fehlende Berechtigung) liest Context das Board als Besucher. Ein solcher Wechsel steht ausdrücklich in den Warnungen der Quelle. Abbrüche, Kurs- und Kontowechsel werden nie durch den Besucherweg überdeckt.

Das Board-Verzeichnis bleibt die Zuordnung zwischen Kursen und gefundenen Links. Ein gefundener Link allein gilt weiterhin nicht als gelesenes Board.

## Besucherzugriff über den öffentlichen Link

Lehrkräfte teilen Boards meist aus ihren eigenen Miro-Konten. Eine OAuth-Verbindung sieht solche Boards in der Regel nicht. Der Besucherweg braucht deshalb nur den Link:

1. **Titel und Besitz:** Nach einer Board-Suche fragt Context für höchstens 20 noch unbekannte Boards den dokumentierten oEmbed-Endpunkt von Miro ab (`https://miro.com/api/v1/oembed`). Ohne Cookies, ohne Weiterleitungen, mit Zeit- und Größenlimit. Übernommen werden nur Titel und Besitz; ein eigener Titel hat Vorrang. Nicht gefundene Boards werden höchstens wöchentlich erneut geprüft.
2. **Inhalt:** Beim Lesen einer Kursquelle öffnet die Desktop-App das Board in einem unsichtbaren, stummgeschalteten Offscreen-Fenster der Website-Sitzung. Es rendert nur in den Speicher, ist nicht fokussierbar und erscheint weder im Dock noch auf dem Bildschirm. Eine bloß verborgene Ansicht genügt nicht: Chromium zeichnet sie nicht, und Miro bleibt dann im Ladebildschirm stehen. Dort aktiviert sie Miros barrierefreie Board-Übersicht („Board-Inhalte erkunden“ / „Explore board content“). Diese Übersicht ist ein schreibgeschütztes Inhaltsverzeichnis für Screenreader.
3. **Auslesen:** Gelesen werden nur die Elemente der Übersicht (`#a11y-dom-contents`) anhand ihrer Rollen und Kennungen: Frames („Titel, Rahmen/Frame, n von m“), Auswahlgruppen und Elemente mit ihrem Text. Leere Elemente („Leer“/„Empty“), Auswahlzähler und generische Verbindungslinien werden entfernt.
4. **Ergebnis:** Jeder Frame wird eine Quelle, typischerweise eine Folie. Verschachtelte Frames nennen ihren übergeordneten Bereich; Elemente außerhalb von Frames werden nach ihrer obersten Gruppe gebündelt. Jede Quelle verweist über `moveToWidget` auf genau dieses Element im Original-Board. Das Format entspricht dem API-Weg, sodass Suche und Assistent unverändert arbeiten.

Nur Navigation innerhalb von `miro.com` ist erlaubt. Eine Anmeldeseite, eine fremde Weiterleitung oder eine Zugriffsanfrage erzeugen sichtbare Zustände: *Anmeldung nötig*, *für Besucher nicht freigegeben* oder *Board-Übersicht nicht verfügbar*. Es gibt keine Klicks auf andere Bedienelemente, keine Eingaben, keine Popups und keine Downloads.

**Effizienz:** Es wird immer nur ein Board gleichzeitig gelesen. Die Übersicht gilt als fertig, wenn zwei aufeinanderfolgende Abfragen denselben Stand liefern (höchstens 60 Sekunden). Ein Hash über die Übersicht erkennt unveränderte Boards; deren Ergebnis wird ohne erneute Verarbeitung wiederverwendet. Das Board wird dafür dennoch kurz geöffnet, weil nur so eine Änderung erkennbar ist.

### Einladungslinks (`share_link_id`)

Manche Links enthalten einen Einladungsschlüssel. Er kann für den Zugriff nötig sein und wird deshalb nicht mehr verworfen, sondern getrennt behandelt:

- Die Kursseiten-Leser geben ihn in einem eigenen Feld an den nativen Prozess. Dieser entfernt das Feld, bevor die Seite die Oberfläche erreicht. Aus Notizen, Lesezeichen und Kurslinks reicht die Oberfläche gefundene Einladungslinks einmalig an die Desktop-App weiter.
- Die Desktop-App speichert je Board einen Schlüssel ausschließlich mit der Betriebssystem-Verschlüsselung (`miro/miro-links.enc`, höchstens 2.000 Boards). Ohne verfügbare Verschlüsselung bleibt er nur bis zum Beenden im Arbeitsspeicher.
- Angehängt wird er nur, wenn die unsichtbare Ansicht genau dieses Board öffnet.
- Fundstellen, Verzeichnis-Export, Suchindex, Quellenlinks, KI-Anfragen, oEmbed-Abfragen und Fehlermeldungen enthalten ihn nicht. Die native Schnittstelle gibt nur eine Anzahl zurück, nie den Schlüssel.

### Grenzen des Besucherwegs

- Die barrierefreie Übersicht ist **keine offizielle Miro-Schnittstelle**. Miro kann Aufbau, Kennungen oder Beschriftungen ändern; dann meldet Context „Board-Übersicht nicht verfügbar“ statt falscher Inhalte. Erkannt werden deutsche und englische Beschriftungen.
- **Bilder** werden nicht gelesen; bekannt ist nur ihr Dateiname (`[Bild: name.png]`). Folien, die nur aus Bildern bestehen, sind deshalb nur als Titel und Dateinamen enthalten und als unvollständig markiert. Eine Bilderkennung per lokaler OCR ist noch nicht eingebaut.
- Absätze innerhalb eines Elements werden getrennt, wenn Miro sie als Blöcke ausgibt; sonst können Zeilen zusammenhängen.
- Boards, die eine Anmeldung oder eine Einladung als Gast verlangen, sind nur lesbar, wenn die eingebaute Browser-Sitzung bereits Zugriff hat.
- Grenzen: 4.000 Übersichtselemente, 2.000 Zeichen je Element, 12.000 Zeichen je Bereich, 2.000 Bereiche, eine Million Zeichen je Board. Erreichte Grenzen erscheinen als unvollständiger Zugriff.

## Im Assistenten: das offene Board lesen

Ist im Context-Browser ein Miro-Board geöffnet, zeigt der Assistent oben „Miro-Board · Titel“. Fragen wie „Was steht auf diesem Board?“ oder „Fasse Folie 3 zusammen“ beantwortet er mit dem Werkzeug `read_current_board`:

1. Die Desktop-App meldet nur die normalisierte Board-Adresse und den Tab-Titel; ein Einladungsschlüssel aus der Adresse geht direkt in den verschlüsselten Speicher.
2. Ist das Board schon eine Quelle des gewählten Kurses, wird sie verwendet. Sonst ordnet Context es dem im Assistenten gewählten Kurs zu, bei nur einem Kurs diesem. Bei „Alle Projekte“ und mehreren Kursen fragt der Assistent nach dem Kurs, statt zu raten.
3. Gelesen wird wie jede Kursquelle (API oder Besucherweg), mit Kurs- und Quellenprüfung. Der Agent erhält die ersten Bereiche als Auszug und eine Gliederung aller gelesenen Bereiche; alles ist danach auch in Suche und Assistent auffindbar. Antworten verweisen auf die einzelnen Frames.
4. Erst nach erfolgreichem Lesen meldet Context „‚Boardtitel‘ ist jetzt eine Quelle im Kurs …“ (mit Rückgängig) und übernimmt den echten Titel ins Board-Verzeichnis. Kann das Board nicht gelesen werden (privat, entfernt, Anmeldung nötig), wird die neue Zuordnung zurückgenommen und der Grund genannt.

Sind im Assistenten „Browser“ oder „Plattformen“ ausgeschaltet, liest er nichts und sagt, was einzuschalten ist. Der Boardtitel ist für das Modell nur Beschriftung, keine Anweisung.

## Miro-API über Nango

In Nango muss eine Integration mit dem Anbieter **miro** und dem OAuth-Scope **boards:read** eingerichtet sein. Anschließend wird das Miro-Konto in Context verbunden. Miro kann die Zustimmung eines Team-Administrators verlangen; öffentlich sichtbare oder geteilte Board-Links bedeuten nicht automatisch, dass eine OAuth-App darauf zugreifen darf. In diesem Fall greift der Besucherweg.

OAuth und Token-Erneuerung übernimmt Nango. Ein Nango-Zugriffsschlüssel bleibt im nativen Prozess beziehungsweise dessen vorhandenem verschlüsselten Einstellungsbestand. Er wird weder an den Chatbot noch an eingebettete Webseiten weitergegeben. Die Integration benötigt keinen separat konfigurierten MCP-Server.

Gelesen werden Board-Titel, Beschreibung, Ersteller und Zeitstempel; Texte von Stickies, Textfeldern, Formen, Karten und Frames; strukturierte Textblöcke von Miro-Dokumenten, sofern sie in der API-Antwort enthalten sind; der Titel eines übergeordneten Frames. Bilder, hochgeladene PDFs, eingebettete Seiten und nicht unterstützte Elementtypen werden nicht heruntergeladen. Pagination ist auf 50 Elemente je Anfrage, 40 Seiten beziehungsweise 2.000 Elemente begrenzt.

## Sicherheit und Datenschutz

- Miro-Texte sind untrusted Quellenmaterial. Sie werden als inerter Text behandelt; Markup, Steuer- und Richtungszeichen werden nicht ausgeführt beziehungsweise entfernt. Text in einem Element kann keine Frames, Bereiche oder Links erzeugen.
- Die native Schnittstelle liest nur Boards, die einem aktuell freigegebenen Kurs zugeordnet sind. Vor und nach jedem Lesen werden Kurszuordnung und Quellenstand geprüft; ein Wechsel verwirft das Ergebnis.
- Besucher-Ergebnisse sind an den Besuchermodus gebunden, API-Ergebnisse an die Nango-Verbindung. Entfällt ein Modus, verschwinden dessen Quellen aus Suche und Assistent.
- Beide Wege sind Cloud-Zugriffe: Miro sieht, dass das Board aufgerufen wird (beim Besucherweg wie bei einem normalen Seitenbesuch). Die API wird über Nango erreicht.

## Live-Prüfung in Electron

Zwei optionale Prüfungen laufen in echtem Electron mit temporärem Profil gegen öffentliche Boards (Netzwerkzugriff, kein Konto):

- `npm run test:miro:electron` – Besucher-Reader mit der Produktions-Ansichtsfabrik; zusätzlich `--expect-denied <url>` für ein Board, das abgewiesen werden muss.
- `npm run test:miro:assistant [board-url]` – gesamte Kette Browser-Tab → `read_current_board` → Kurszuordnung → SourceHub → native Plattform → Besucher-Reader → Antwort mit Frame-Links, inklusive Abweisung eines privaten Boards. Nur das Sprachmodell ist dabei durch feste Antworten ersetzt.

## Manuell prüfen (Desktop-App)

Automatische Tests verwenden synthetische Daten. Mit echten Boards gilt erst etwas als geprüft, wenn es so nachvollzogen wurde:

1. `npm run desktop` starten; in **Verbindungen** muss Miro *nicht* verbunden sein.
2. Einen Kurs öffnen und unter dessen Links ein öffentliches Board eintragen, z. B. `https://miro.com/app/board/o9J_kuapqg4=/`.
3. **Boards → Lokale Quellen prüfen**: Die Karte zeigt nach kurzer Zeit den Miro-Titel und „Board-Besitz laut Miro“.
4. **Quellen → Deine Quellen → Lesen** beim Board: Nach etwa 10 bis 30 Sekunden erscheinen die Bereiche. In den Warnungen steht „Besucherzugriff, keine offizielle Schnittstelle“.
5. Alternativ das Board im Context-Browser öffnen, den Assistenten öffnen (⌘⇧K) und fragen: „Was steht auf diesem Board?“ – der Arbeitsschritt heißt „Offenes Miro-Board lesen“. Oder im Assistenten nach einem Folientitel fragen (für das Beispiel „Agenda“ oder „Leadership Styles“). Der Quellenlink muss das Board an genau diesem Frame öffnen.
6. Gegenprobe: ein privates Board → Meldung *für Besucher nicht freigegeben* oder *Anmeldung nötig*, keine Inhalte.
7. Optional einen Link mit `?share_link_id=…` in eine Notiz legen, erneut suchen und prüfen, dass der Schlüssel weder in der Board-Karte noch im Verzeichnis-Export auftaucht.

## Referenzen

[Miro: oEmbed](https://developers.miro.com/docs/oembed-live-embed), [Miro: Barrierefreie Board-Übersicht](https://help.miro.com/hc/en-us/articles/4403828752274), [Miro: Board lesen](https://developers.miro.com/reference/get-specific-board-1), [Miro: Elemente und Cursor-Pagination](https://developers.miro.com/reference/get-items-1), [Nango: Miro-Autorisierung und Proxy](https://nango.dev/docs/integrations/all/miro).
