# Mitteilungen · 0.18.3

Context Browser synchronisiert Spaces, Mattermost und GitLab über die vorhandene Website-Sitzung. TH-Mail bleibt über den lokalen IMAP-Connector eingebunden. Ein Link allein ist keine Anmeldung. Die Webansicht kann weiterhin eingerichtete Server-Connectoren und ausdrücklich gekennzeichnete Browser-Momentaufnahmen anzeigen.

## Einheitliche Synchronisierung

`connectors/platform-feed.mjs` verwaltet Adapter mit `source`, `account()` und `read({scope, signal, previous})`. Alle Adapter liefern dieselben Eintrags- und Quellenzustände. Gleichzeitige Abrufe werden zusammengeführt, erfolgreiche Ergebnisse 60 Sekunden zwischengespeichert und Wiederholungen nach Fehlern pro Quelle auf bis zu fünf Minuten verlängert. Eine manuelle Wiederholung kann nach zehn Sekunden prüfen. Ein Fehler einer Plattform bremst die erfolgreichen Plattformen nicht aus. Auch Fehler bei Konto- oder Kursprüfung bleiben auf diese Quelle begrenzt. Kann die Identität nach einem Abruf nicht mehr bestätigt werden, werden weder neue noch frühere private Hinweise veröffentlicht.

Die Native-IPC ist ausschließlich aus dem lokalen Workspace-Hauptframe erreichbar. GET-Anfragen verwenden Electrons bestehende Provider-Sitzung. Cookies, Nonces und Tokens werden weder durch IPC zurückgegeben noch in Projektlinks oder Backups geschrieben. Es werden keine neuen Kontorechte angefordert und keine Provider-Lesestände verändert.

Kontowechsel brechen zugehörige Abrufe ab und entfernen alte Hinweise sofort. Konto und Kursauswahl bilden eine gemeinsame Generation; eine verspätete Antwort darf Daten aus einem alten Konto oder einer widerrufenen Kursauswahl nicht wiederherstellen. Der letzte Stand bleibt bei Netzwerkfehlern erhalten, aber nicht nach einem erkannten Kontowechsel oder abgelehntem Zugriff. Aufbewahrte Teilstände sind sichtbar gekennzeichnet.

Der Renderer führt native Sitzungsdaten und vorhandene Server-Connectoren zusammen. Live-Daten ersetzen alte Momentaufnahmen. Ein eingerichteter Token-Connector kann einspringen, wenn die Website-Sitzung nicht verfügbar ist. Der native Sync funktioniert auch, wenn der Mailserver vorübergehend nicht erreichbar ist. Serverantwort einschließlich JSON-Auswertung ist auf zehn Sekunden begrenzt. Umgekehrt kann eine nicht erreichbare native IPC unabhängig geprüfte Mail- und Token-Ergebnisse nicht verdrängen. Ein fehlgeschlagener oder abgelaufener Live-Zugang wird im Server nicht mehr durch eine alte Momentaufnahme als erfolgreich kaschiert.

## WordPress / Spaces

Für bis zu 20 aktive verknüpfte Kurse wird die kursbezogene REST-API geprüft. Die normale Kursseite muss API-Link und `wpApiSettings` mit demselben Kursroot deklarieren. Fehlt dort die API-Konfiguration, kann die lesende Beitragsübersicht des WordPress-Backends die kursbezogenen Einstellungen liefern. Danach müssen der API-Index GET-Routen bestätigen und `users/me` die bestehende Anmeldung bestätigen. Die WordPress-REST-Nonce bleibt im nativen Prozess.

Pro Kurs werden die zuletzt geänderten 50 veröffentlichten Beiträge und bis zu 50 Kommentare zu diesen Beiträgen gelesen. Die App liest keine Entwürfe, passwortgeschützten Beitragstexte oder fremden Kursroots. Weitere Seiten und fehlgeschlagene Kommentare werden als Teilstand ausgewiesen. Das ist eine begrenzte Aktivitätsübersicht und kein vollständiger Verlauf oder Abgleich von WordPress-Benachrichtigungs-Leseständen.

Einträge erhalten IDs aus Konto, Kurs und Provider-ID. Inhalt und Änderungsstand bestimmen die Revision. Eine Bearbeitung ersetzt die bisherige Zeile. Beiträge und Kommentare sind getrennt erkennbar und führen zum jeweiligen Original. GMT-Daten werden als UTC verarbeitet und in Berlin-Zeit angezeigt. Alte englische Zeitlabels aus Browser-Momentaufnahmen werden nicht auf neue API-Einträge übertragen.

## Andere Plattformen

Mattermost liest begrenzte Vorschauen ungelesener Teamkanäle über die vorhandene Browser-Sitzung oder einen eingerichteten Token: bis zu fünf Teams, 20 geprüfte Kanäle und zehn Kanäle mit je zehn Textvorschauen. Fehlende Texte bleiben als Zähler sichtbar. GitLab liest bis zu 50 offene To-dos, TH-Mail ungelesene Kopfzeilen. Anhänge, Medien und vollständige Chatverläufe werden darüber nicht automatisch importiert.

Sciebo prüft die ownCloud-OCS-Capabilities und liest bis zu 50 aktuelle Benachrichtigungen über den dokumentierten Notifications-Endpunkt. Die bestehende Browser-Sitzung bleibt maßgeblich. Fehlt die Notifications-App oder deren Listenfunktion, wird das ausdrücklich angezeigt. OCS-Anmeldefehler in einer HTTP-200-Antwort werden ebenfalls erkannt. Benachrichtigungsaktionen werden nicht ausgeführt.

Miro liest mit einer bereits eingerichteten Nango-Verbindung nur die Metadaten aktuell verknüpfter Kursboards: Titel, Beschreibung und Änderungszeit. Es gibt keine behauptete Kommentar- oder Mention-Synchronisierung. Ohne API-Verbindung können bereits erfolgreich eingelesene Besucherübersichten als Momentaufnahme erscheinen. Frühere private API-Daten werden nach einem Zugriffsverlust nicht als Besucherstand wiederverwendet. Fehlgeschlagene einzelne Boards behalten ihren alten Stand nur bei Netzwerkfehlern; abgelehnter Zugriff entfernt ihre Daten.

WhatsApp liest ausschließlich bereits gerenderte ungelesene Vorschauen der im CoCo-Filter ausdrücklich ausgewählten Gruppen. Dafür muss ein vorhandener WhatsApp-Tab seinen eigenen Kontobezeichner nachweisen. Dieser wird im isolierten Browser-Kontext gehasht; Telefonnummern und Chat-IDs werden nicht durch die Mitteilungs-IPC gegeben. Die sichtbare Chatliste wird an dieses Konto gebunden, damit ein Kontowechsel keine alte Liste einem neuen Konto zuordnet. Mehrdeutige Gruppennamen werden nicht geraten. Nicht sichtbare ausgewählte Gruppen bleiben als älterer Teilstand erkennbar; sichtbar gelesene Gruppen werden entfernt. Es werden keine Chats geöffnet, keine Nachrichtenhistorien geladen und keine Anbieter-Lesestände geändert. Der Status bleibt „Browser-Stand“, da dies keine offizielle persönliche Nachrichten-API ist.

Signal zeigt „Externe App“ mit einer ausdrücklich noch nicht verbundenen Mitteilungsschnittstelle. Es werden keine angeblich synchronisierten leeren Ergebnisse erzeugt.

Alle Quellen teilen den gleichen Fehler- und Kontowechselvertrag. Insgesamt werden höchstens 2.200 Hinweise verarbeitet; kleinere Quellen erhalten einen eigenen Anteil, damit viele Spaces-Beiträge sie nicht verdrängen. Ausgelassene Hinweise werden pro Quelle ausgewiesen.

## Bedienung und Zuordnung

Neu/Alle, Quelle und Gruppe lassen sich kombinieren. Der Neu-Zähler berücksichtigt die gewählte Quelle und Gruppe. „Alle abhaken“ betrifft den aktuellen Filter, wirkt nur im Hub und lässt sich über die Rückgängig-Aktion zurücknehmen. Der Quellenbereich zeigt letzte Prüfung, Teilstände und Warnungen pro Plattform. Passive Aktualisierungen erhalten Fokus, offene Details und Leseposition.

Manuelle Kurszuordnung hat Vorrang. Sonst gelten belegte Kurs-/Projekt-IDs und sichere Original- oder Kanal-URLs. Titelwörter und Gruppennamen werden nicht als Kursbeleg geraten. Unklare oder widersprüchliche Zuordnungen bleiben offen. Archivierte Kurse gelangen nicht zurück ins KI-Wissen.

## Aktivierung und Prüfung

Die native Sitzungssynchronisierung benötigt Context Browser 0.18.3 mit dem neuen Preload und IPC-Handler. Ein bereits laufender externer Server wird nicht beendet: Mail- und KI-Zugangsdaten können ausschließlich in dessen RAM liegen. Für die nativen Provider-APIs ist kein Neustart dieses Servers notwendig; die aktualisierte Renderer-Datei muss vom Server bereitgestellt werden.

Automatisierte Prüfungen decken authentifizierte GET-Routen mit synthetischen Providerdaten, Posts/Kommentare, Revisionen, Teilfehler, Kursgrenzen, parallele Requests, Kontowechsel, abgebrochene und verspätete Antworten, bestehende IPC-Startabläufe sowie den tatsächlichen Inbox-Renderer ab. Diese Tests ersetzen keine Live-Verifikation mit dem jeweiligen Anbieter.

Referenzen: [WordPress-Authentifizierung](https://developer.wordpress.org/rest-api/using-the-rest-api/authentication/), [Beiträge](https://developer.wordpress.org/rest-api/reference/posts/), [Kommentare](https://developer.wordpress.org/rest-api/reference/comments/), [GitLab-Sitzungs-Cookies](https://docs.gitlab.com/api/rest/authentication/), [ownCloud Notifications](https://doc.owncloud.com/server/10.16/developer_manual/core/apis/ocs-notification-endpoint-v1.html), [OCS Capabilities](https://doc.owncloud.com/server/11.0/developer_manual/core/apis/ocs-capabilities.html), [Miro Board-Metadaten](https://developers.miro.com/reference/get-board).
