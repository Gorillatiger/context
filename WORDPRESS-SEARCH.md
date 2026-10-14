# Direkte Spaces-Suche · 0.18.0

Die globale Suche öffnet standardmäßig „Direkt in Spaces“. Ein Suchbegriff geht sofort an WordPress, ohne vorherigen Kurscrawl oder lokalen Volltextindex. „Lokal“ bleibt für eigene Notizen und vorhandene Offline-Auszüge verfügbar. Der Kursfilter begrenzt die Anfrage; Treffer haben einen Original-Link und eine lesende Textvorschau. Trefferseiten ersetzen keine vollständige Netzwerkabdeckung.

## Desktop

1. Context starten und im eingebauten Browser bei TH-Spaces anmelden.
2. Einen Kurs mit seinem Spaces-Root verknüpfen, beispielsweise `https://spaces.th-koeln.de/prototyping-things-w26/`.
3. Suche öffnen, Begriff eingeben; bei Bedarf Kurs auswählen oder nächste Trefferseite öffnen.

Die vorhandene Electron-Dienstsitzung sendet ihre Cookies selbst an Spaces. Context exportiert oder kopiert sie nicht. Aus der angemeldeten Kursseite werden zwei übereinstimmende API-Root-Signale und ein REST-Nonce gelesen. Dieser bleibt kurzzeitig im nativen Arbeitsspeicher und gelangt weder ins Modell noch in UI, Source oder Suchcache. Kurs-, Auth-Cookie- und Navigationswechsel verwerfen Freigaben. Electron dokumentiert fehlerhafte `Response.url`-Metadaten; der native Adapter bindet diese ausschließlich an die bereits validierte feste GET-Anfrage.

Die erlaubte API ist ausschließlich der bestätigte Root unter `https://spaces.th-koeln.de/`. Suche: `GET wp/v2/search`, Untertypen `post,page`; Lesen: `GET wp/v2/posts/{id}` beziehungsweise `pages/{id}` mit `context=view`. Das Lesen verlangt zusätzlich `status=publish`. Keine Admin-Formulare, Editoren oder Schreib-Endpunkte werden verwendet.

## Umfang

WordPress-Core durchsucht veröffentlichte Beiträge und Seiten im jeweiligen Kursblog. Die Backend-Ansicht `wp-admin/edit.php` kann daneben Entwürfe und andere Status enthalten; deshalb wird keine vollständige Gleichheit behauptet. Kommentare, Anhänge, Bilder/OCR, benachbarte Blogs und der Inhalt verknüpfter Miro-Boards werden nicht automatisch von dieser Suche umfasst. Ein Suchwort in einem Bild wird dadurch nicht gefunden. Links aus einem tatsächlich gelesenen Beitrag können aber die bestehenden Dienstwerkzeuge erschließen.

Pro UI-Anfrage: höchstens zwölf aktive Kurse, drei parallel; weitere Kurse einzeln im Kursfilter wählen. Zwanzig Treffer pro Kurs und Seite; im Agenten fünf. `X-WP-Total` und `X-WP-TotalPages` bestimmen weitere Seiten. Der Dialog zeigt „Seite N je Kurs“, keine erfundene gemeinsame Gesamtzahl. Fehlende Anmeldung, Rechte oder API-Support erscheinen je Kurs. Die Anfrage hat 15 Sekunden Zeitlimit, vier native Jobs gleichzeitig und höchstens 1 MiB Antwort. Diese Begrenzungen sind kein Speicherbenchmark.

## Agent

Bei freigegebenem Spaces-Wissen und Browsermodus stehen `search_spaces {projectId,query,page?}` und `read_spaces_result {projectId,id,offset?,expectedRevision?}` bereit. Der Agent wählt zuerst einen verknüpften Kurs. Nur tatsächlich angebotene IDs aus diesem Auftrag dürfen gelesen werden. Ein Treffer mit Titel zählt noch nicht als Inhaltsbeleg.

Gelesene Texte kommen in Abschnitten von höchstens 4.000 Zeichen; bei `hasMore` dienen `nextOffset` und die SHA256-Revision zum Weiterlesen. Die Extraktion begrenzt den gesamten Beitrag auf 64.000 Zeichen. Nur übergebene Abschnitte werden als Quellen zitiert. Kursarchivierung, Relink, Abbruch und Widerruf stoppen spätere Übergaben. Seiteninhalte gelten als Daten und erteilen keine Werkzeugrechte.

Beobachtete Miro-/Sciebo-/GitLab-/Mattermost-Anker werden URL-normalisiert, dem aktuellen Kurs und ursprünglichen Beitrag zugeordnet und im vorhandenen lokalen Linkverzeichnis registriert. Das ist eine begrenzte Liste von Fundstellen, kein Volltextindex. „Gepostet von“ ist nicht automatisch der Board-Ersteller. Der Agent bekommt aktuelle Katalog-IDs, keine frei erfundenen URLs. Ein Boardinhalt wird erst nach separatem autorisiertem Dienstabruf als Beleg verwendbar. Fehlende Anmeldung oder Miro-Freigabe bleibt eine sichtbare Lücke. An den gewählten Cloud-KI-Anbieter gehen erst bei einem Nutzerauftrag freigegebene Textauszüge; die Such-UI ruft kein KI-Modell auf.

## Web-App vorbereiten

Der browserunabhängige Kern `connectors/spaces-search.mjs` akzeptiert ein vertrauenswürdiges `fetchImpl` und optional `authContext({courseURL,signal})`. Der Desktop-Adapter verwendet `Session.fetch`. Der Renderer nutzt dieselbe Search/Read-Schnittstelle über IPC oder einen Backend-Aufruf.

`server.mjs` bietet geschützte `/api/spaces/search`, `/api/spaces/read` und `/api/spaces/status` mit einer explizit injizierten Service-Instanz. Standardmäßig fehlt diese Verbindung; der reine Webmodus meldet das ehrlich. Eine fremde Browser-Sitzung wird nicht still übernommen. Der lokale Server bleibt ausschließlich Loopback, mit Host-/Origin-/Sitzungsprüfung, JSON-/Marker- und Größenlimits und `no-store`.

Für eine öffentlich gehostete Mehrbenutzer-App fehlt noch eine eigene autorisierte WordPress-Anbindung pro Nutzer, samt serverseitiger Sitzungsisolation. Cookies von TH-Spaces lassen sich nicht aus einer anderen Web-App lesen. Ein Backend muss einen von der Hochschule erlaubten Auth-Weg verwenden; kein generisches Weiterreichen beliebiger Cookies oder URLs. Die bestehende Loopback-Anwendung ist kein fertiger öffentlicher Internetserver. Dafür wurden hier keine neuen Kontorechte eingerichtet.

## Validierung

Automatisiert: Protokoll, Pagination, Kursgrenzen, Nonce-Redaktion, URL/Redirect/MIME-/Antwortgrößengrenzen, eingeloggte/native Transportbesonderheiten, Logout/Kurswechsel, publish→draft/private, Abbruch, Revisionen, fehlende Ergebnisse, Quellenbelege und Spaces→Miro-Kette mit synthetischen Daten. UI: echte Browserbedienung mit synthetischen Kursen, mehrere Trefferseiten, Fehlerabdeckung, Darkmode und Escape/Fokusrückgabe.

Live-Nachweise und Testzählung stehen im lokalen Arbeitsstand; keine echten Kursinhalte, Profile, Nonces oder Zugangsdaten sind Testfixtures oder Teil des GitHub-Repositories. macOS/Apple Silicon ist die tatsächlich eingesetzte native Plattform; Windows/Linux wurden für diese Integration nicht live getestet.

Primärquellen: [WordPress Search](https://developer.wordpress.org/rest-api/reference/search-results/), [Cookie-Authentifizierung](https://developer.wordpress.org/rest-api/using-the-rest-api/authentication/), [Core Search-Scope](https://developer.wordpress.org/reference/classes/wp_rest_post_search_handler/search_items/), [Pagination](https://developer.wordpress.org/rest-api/using-the-rest-api/pagination/), [Electron Session.fetch](https://www.electronjs.org/docs/latest/api/session#sesfetchinput-init).
