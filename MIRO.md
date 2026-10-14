# Miro-Inhalte für Suche und Assistent

Die Miro-Anbindung liest echte Board-Inhalte über die offizielle REST-API. Das bisherige Board-Verzeichnis bleibt die Zuordnung zwischen Kursen und gefundenen Links. Ein gefundener Link allein gilt weiterhin nicht als gelesenes Board.

## Verbinden

In Nango muss eine Integration mit dem Anbieter **miro** und dem OAuth-Scope **boards:read** eingerichtet sein. Anschließend wird das Miro-Konto in Context verbunden. Miro kann die Zustimmung eines Team-Administrators verlangen; öffentlich sichtbare oder geteilte Board-Links bedeuten nicht automatisch, dass eine OAuth-App darauf zugreifen darf. Eine fehlende Berechtigung wird angezeigt und nicht umgangen.

Die Anbindung verwendet die vorhandene Nango-Installation des Projekts. OAuth und Token-Erneuerung übernimmt Nango. Ein Nango-Zugriffsschlüssel bleibt im nativen Prozess beziehungsweise dessen vorhandenem verschlüsselten Einstellungsbestand. Er wird weder an den Chatbot noch an eingebettete Webseiten weitergegeben. Die Integration benötigt keinen separat konfigurierten MCP-Server. Ein Miro-Connector in Codex und die Context-App besitzen getrennte Verbindungen.

## Was gelesen wird

- Board-Titel, Beschreibung, vom Anbieter gelieferte Ersteller und Zeitstempel.
- Texte von Stickies, Textfeldern, Formen, Karten und Frames.
- Strukturierte Textblöcke von Miro-Dokumenten, sofern sie tatsächlich in der API-Antwort enthalten sind.
- Der Titel eines übergeordneten Frames, um Aufgaben räumlich einzuordnen.

Jede Quelle verweist auf das Original-Board beziehungsweise das konkrete Element (`moveToWidget`). Ersteller werden aus Miro-Metadaten übernommen und nicht aus dem Namen der Person abgeleitet, die den Link auf Spaces veröffentlicht hat. Fehlende Namen und Zeitstempel bleiben leer.

Bilder, hochgeladene PDFs, eingebettete Seiten und nicht unterstützte Elementtypen werden nicht heruntergeladen oder als gelesener Text ausgegeben. Ihre vorhandenen Titel sind nur Metadaten. Die Oberfläche erhält ausdrücklich eine unvollständige Abdeckung mit Warnungen. Eine vollständige API-Textabdeckung bedeutet keine vollständige Erkennung aller visuellen Informationen eines Boards.

## Grenzen und Sicherheit

Die native Schnittstelle erlaubt ausschließlich lesende GET-Aufrufe für ein bekanntes Board und dessen Elemente. Sie bietet keinen allgemeinen Miro-Proxy, keine Suche im gesamten Miro-Konto und keine Schreibaktionen. Vor und nach jedem Board-Abruf werden die aktuelle Kurszuordnung und die Kontorevision geprüft. Archivierte beziehungsweise entfernte Zuordnungen und zwischenzeitlich gewechselte Verbindungen verwerfen den Abruf.

Pagination ist auf 50 Elemente je Anfrage, 40 Seiten beziehungsweise 2.000 Elemente begrenzt. Elementtexte belegen zusammen höchstens eine Million Zeichen. Ein einzelnes Element enthält höchstens 12.000 Textzeichen; für Suche und Chat werden Quellen anschließend ohne Überlappung in Stücke mit maximal 12.000 Zeichen geteilt. Grenzen, übersprungene Inhalte und Fehler erscheinen ausdrücklich als unvollständiger Zugriff.

Miro-Texte sind untrusted Quellenmaterial. HTML wird in inerten Text umgewandelt; Skripte, eingebettete Seiten und SVG-Inhalte werden nicht ausgeführt. Links in Anbieterantworten werden nicht automatisch geöffnet oder als Pagination-Ziel verwendet. Die Miro-API wird über Nango erreicht; dies ist eine Cloud-Anbindung und keine ausschließlich lokale Übertragung.

Die Einrichtung und Datenabfrage wurden mit synthetischen Anbieterantworten geprüft. Ein reales Konto benötigt seine eigene gültige Freigabe. Die Tests zeigen keine erfolgreichen Zugriffe auf ein sonst gesperrtes Nutzer-Board an.

## Referenzen

[Miro: Board lesen](https://developers.miro.com/reference/get-specific-board-1), [Miro: Elemente und Cursor-Pagination](https://developers.miro.com/reference/get-items-1), [Nango: Miro-Autorisierung und Proxy](https://nango.dev/docs/integrations/all/miro).
