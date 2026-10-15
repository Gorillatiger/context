# Nutzung und Limit · 0.17.4

Im Chat und im schwebenden Assistenten steht neben dem Anbieter ein kompakter **Nutzung-und-Limit-Button**. Ein Klick öffnet die Details. Dort aktualisiert das Pfeilkreis-Symbol den Stand; Escape oder das Kreuz schließt die Ansicht. Anbieter-/Modellverbindung und ein abgeschlossener Chatauftrag aktualisieren den Stand automatisch. Ein Modellwechsel verwendet dieselben Kontodaten, statt erneut abzufragen.

## Was angezeigt werden kann

- **OpenRouter:** Restbudget des API-Schlüssels und gegebenenfalls das wirksame Organisationsbudget, dessen Zeitraum und Resetzeit. Der aktuelle Tageszähler kostenloser Modelle wird bei `:free`-Varianten direkt im Button angezeigt und ist in den Details verfügbar. Ein fehlender Schlüsseldeckel heißt „Kein Schlüssellimit“, nicht unbegrenztes Guthaben. `null`, fehlende und ungültige Zahlen ergeben keine erfundenen Restwerte. Daten kommen aus dem dokumentierten lesenden `GET /api/v1/key`.
- **KI:connect NRW:** „Limit unbekannt“. Die öffentliche API dokumentiert Chat, Responses, Embeddings und Modelle, aber keinen Abruf des verbleibenden Nutzerkontingents. API und Webnutzung zählen laut Betreiber gegen dasselbe Kontingent. Tokenzahlen einzelner Antworten ersetzen diesen Wert nicht.
- **Lokale Modelle:** „Kein Cloud-Limit“. Rechner und Modellserver können eigene technische Grenzen haben; Context behauptet keine unbegrenzte Leistung.

Der OpenRouter-Wert ist **kein Kontoguthaben**. Dessen separates `/credits` benötigt laut aktueller Dokumentation einen Management-Schlüssel. Context beschafft oder verlangt dafür keine zusätzlichen Rechte. Einzelne Modellanbieter können zusätzlich begrenzen; kostenfreie Zähler können für BYOK oder ausgenommene Konten nicht bindend sein. Anbieterwerte können verzögert sein. Der Zeitpunkt des tatsächlich abgerufenen OpenRouter-Stands wird angezeigt.

## Technik und Datenschutz

`connectors/ai-usage.mjs` übernimmt ausschließlich überprüfte Zahlen, bekannte Budgettypen und valide Zeitpunkte. Schlüssel, Labels, Hashes, Konto-/Organisations-IDs und das veraltete `rate_limit` werden nicht ausgegeben. `/key` ist auf 64 KB JSON begrenzt; Host, Pfad, keine Redirects und bestehende Zeitlimits gelten. Cache und gemeinsam laufende Abrufe sind an Schlüssel-Fingerprint und Verbindungsgeneration gebunden, bleiben im RAM und werden nach einem Chat oder Schlüsselwechsel verworfen. 30 Sekunden Cache; manuelles Aktualisieren innerhalb dieses Fensters kann denselben belegten Stand zeigen. Kein permanentes Polling.

`GET /api/ai/usage` bleibt hinter der bestehenden Loopback-Sitzung, Host-/Origin-/Cross-Site-Prüfung und `private, no-store`. Die native IPC-Aktion `usage` erhält UUID und Abbruchsignal wie Chat. Sie besitzt keinen beliebigen URL-/Body-Parameter. KI:connect und der lokale Adapter liefern ihre ehrlichen Statusangaben ohne zusätzliche Anbieter-/Modellabfrage. Ein Limitabruf verbraucht keine Modellanfrage oder das lokale Chat-Anfragelimit.

`dist/ai-usage.js` hält einen separaten UI-Zustand. Anbieterwechsel, Schlüsselwechsel, mehrfaches Aktualisieren, Abbruch, A→B→A und verspätete Antworten können keine früheren Zahlen erneut anzeigen. Ein Abruffehler bleibt von Modell-/Chatfehlern getrennt. Limits werden nicht ins Chatarchiv, Notizen oder Backups aufgenommen; keine Chat-/Kursinhalte werden für diesen Abruf gesendet.

## Prüfung und Grenzen

48 neue automatische Normalizer-, Connector-, IPC-/HTTP-Handler-, UI-Race- und Chatview-Regressionen. Der vollständige Prüflauf besteht aus **1.735 JS + 19 Python erfolgreichen Tests**, 0 Fehler; die beiden bestehenden optionalen Speech-/umgebungsabhängigen Raster-OCR-Skips bleiben dokumentiert. Unabhängiger Review fand und bestätigte den korrigierten Abbruch während eines asynchronen Schlüssel-Lookups. Die Browserprüfung fand und bestätigte das sofortige Entfernen alter Budgets beim Anbieterwechsel.

Echte Browserbedienung des Produktionsrenderers und der Connector-/IPC-Funktionen mit ausschließlich synthetischen Antworten: bezahltes Budget, kostenlose Varianten, Aktualisieren, ein synthetischer Chat und anschließender Abruf, Hochschul-KI ohne Restzahlen und lokales Modell. Heller Desktop 1440 × 900 und Darkmode 390 × 844 ohne horizontalen Seitenüberlauf; Dialog hat eigenen Scroller, Escape gibt Fokus zurück. Kein echter Cloud-Modellaufruf oder neues Konto verbunden. Windows/Linux und Live-OpenRouter-Kontowerte wurden für dieses Update nicht praktisch getestet.

Installierte App weiter 0.17.0 und laufend; Update erst nach regulärem Speichern/Beenden aktivieren. Der bestehende Dienst 4318 wurde nicht neu gestartet. Keine Browser-Cookies/Profile kopiert. [Prüfbericht](ai-usage-qa.json).

Quellen, geprüft am 14.10.2026: [OpenRouter-Limits](https://openrouter.ai/docs/api/reference/limits), [aktueller Schlüssel](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key), [Kontoguthaben und Management-Key](https://openrouter.ai/docs/api/api-reference/credits/get-remaining-credits), [KI:connect-API](https://chat.kiconnect.nrw/app/api-docs/), [KI:connect-Nutzungsregeln des Betreibers](https://help.itc.rwth-aachen.de/en/service/1808737e10424937b76e564ed15d8028/article/4f07ebbbc8c4477a8db9baa441494941/).

## Hochschul-KI: Minutenlimit und Verzögerung · 0.18.1

Die vom Nutzer genannte Grenze von 10 Nachrichten/Minute wird konservativ als 10 KI-Anfragen in einem rollenden 60-Sekunden-Fenster behandelt. Ein Agentenauftrag benötigt häufig mehrere Modellaufrufe; nicht jeder Arbeitsschritt ist ein Modellaufruf. Der gemeinsame Renderer-Gate erfasst Chat, Board-Suche und Begleiter-Aufrufe im selben Fenster, RAM-only, maximal vier wartende Aufrufe. Die lokale Connectoranzeige zählt ebenfalls nur ihren eigenen Prozess; andere Browser, Geräte und Hochschul-Webnutzung sind nicht enthalten. Verbleibende Tages-/Tokenbudgets werden nicht erfunden. Der bestehende lokale Connector begrenzt zusätzlich die Anfragerate; auch OpenRouter kann eigene und lokale Limits haben.

Die elfte hier beobachtete Anfrage wartet bis zum frei werdenden Platz, mit sekündlicher Countdownanzeige und sofortigem Abbruch. Die UI wartet vor dem Versand. Bei einer echten Provider-429-Antwort werden sichere Retry-After-Sekunden oder HTTP-Datumswerte berücksichtigt und auf 1–60 Sekunden begrenzt. Fehlt ein brauchbarer Wert, gelten lokal 60 Sekunden Wartezeit. Eine bereits abgesendete Anfrage wird nicht automatisch wiederholt. `busy` bei parallelen Anfragen ist kein Nachweis des Minutenlimits.

Nach 15 Sekunden einer tatsächlich abgesendeten, noch laufenden Hochschul-KI-Anfrage erscheint ein eigener Hinweis auf die Verzögerung. Die UI behauptet keine bekannte Ursache und keine garantierte schnellere Alternative. Der Button „Zu OpenRouter wechseln“ benötigt einen Nutzerklick: laufenden Auftrag abbrechen, Frage als Entwurf in neuen Anbieterchat übernehmen, Modellverbindung laden. Keine automatische Wiederholung oder Übertragung des bisherigen Chats, keine stillen Cloud-Fallbacks. Freigegebenen Kontext sendet erst der nächste ausdrückliche Senden-Klick an OpenRouter; Kosten und Modellanbieter gelten dann wie dokumentiert. Bereits ausgeführte lokale Aktionen und das bisherige Chatprotokoll bleiben im alten Verlauf.

Prüfungen verwenden künstliche Uhr und Timer: rollendes Fenster, parallele Reservierungen, Abbruch und verspätete Antwort, Timerfreigabe, 429 ohne Wiederholung, busy ohne Wartezeit, OpenRouter-/Local-Pfade, tatsächlicheChat-UI mit explizitemSwitch/Entwurf/keinSend. Kein echter Cloudlasttest mit elf Anfragen ausgeführt.

## Wechsel-Hinweis bei Hochschul-KI

Scheitert eine Anfrage bei KI:connect NRW, weil sie zu groß ist, zu lange dauert oder ein Limit greift (Chat zu lang, Anfrage oder Antwort zu groß, Zeitüberschreitung, erreichtes Limit), zeigt die Fehlermeldung zwei Buttons: **Zu OpenRouter wechseln** und **Zu Lokales Modell wechseln**. Der Wechsel geschieht nie automatisch, weil Kursinhalte sonst an einen anderen Anbieter gingen. Dein Text steht nach dem Wechsel als Entwurf bereit; es startet ein neuer Chat, der bisherige bleibt im Verlauf. Bei OpenRouter und lokalen Modellen, bei anderen Fehlern (z. B. „Modell nicht verfügbar“) und beim eigenen Stoppen erscheint der Kasten nie. Beim Zehn-pro-Minute-Limit zeigt der Wartehinweis mit Countdown bereits den Wechsel zu OpenRouter; dann gibt es keinen zweiten Kasten. Die Entscheidung liegt in `dist/provider-hint.js`, die Buttons in `dist/ki.js`; die Fehlercodes reicht `dist/ai-client.js` durch. Noch nicht gebaut: ein Hinweis vor dem Senden, wenn eine Aufgabe sehr groß aussieht.

## Abwägen vor großen Aufgaben (Hochschul-KI)

Bevor eine große Aufgabe an KI:connect NRW geht, schätzt Context den Aufwand lokal ein, ohne eine Modellanfrage zu verbrauchen. Anzeichen sind „alle/gesamte“, Zusammenfassen, Vergleichen oder Durchsuchen über mehrere Kurse ohne gewählten Kurs, Suche über Spaces und Plattformen, sehr lange Aufträge, viele Fragen auf einmal und lange Chats. Bei großer Aufgabe erscheint über dem Eingabefeld eine Auswahl mit Empfehlung:

- **Zu OpenRouter wechseln:** Context wechselt und schickt dieselbe Frage dort ab. Ist OpenRouter noch nicht verbunden, steht die Frage nach dem Verbinden als Entwurf bereit.
- **Eingegrenzt mit Hochschul-KI:** Gewählter Kurs, neueste Quellen, wenige Schritte, kurze Antwort; das Modell fragt nach, wenn mehr nötig ist.
- **Trotzdem vollständig versuchen** oder **Auftrag noch ändern** (der Text bleibt stehen).

Fragen zur offenen Seite („dieses Board“, „hier“) und kleine Fragen werden nie unterbrochen, OpenRouter und lokale Modelle auch nicht. Während der Arbeit weiß das Modell, dass es auf Hochschul-KI knapp ist: Wird die Aufgabe größer als gedacht, fragt es mit Auswahl nach (z. B. „Auf Kurs X eingrenzen“, „Zu OpenRouter wechseln“). Wählst du „Zu OpenRouter wechseln“, wechselt Context tatsächlich und stellt die ursprüngliche Frage dort. Erreicht ein Lauf die Schrittgrenze oder das Kontextbudget, erscheint der Wechsel-Kasten. Geprüft mit `npm run test:ki:effort` (echte Oberfläche, Modelle gescriptet).

## Anmeldung für Kursquellen (GitLab, Sciebo, Mattermost)

Braucht eine Kursquelle deine Anmeldung, schreibt der Assistent keine Anleitung. Unter der Antwort erscheint stattdessen eine Karte mit **Anmelden ↗** (öffnet die Quelle im Context-Browser) und **Angemeldet – Frage erneut stellen** (stellt dieselbe Frage noch einmal). Die übrigen Quellen liest er in derselben Antwort weiter.

## GitLab im Assistenten (eigenes Konto)

Ist GitLab unter Mitteilungen → Quellen & Status verbunden (Token oder Browser-Anmeldung), arbeitet der Assistent mit deinem eigenen GitLab wie mit einem Plugin, auch ohne Kurs-Verknüpfung: `gitlab_me` (wer du bist), `gitlab_tasks` (dir zugewiesene offene Issues und Merge Requests mit Fristen, dazu deine To-dos), `gitlab_search` (global in Projekten, Issues, Merge Requests, Meilensteinen; im Projekt auch in Dateien, Commits und Wiki), `gitlab_projects` (deine Projekte, auch Forks), `gitlab_tree` (Ordner), `gitlab_file` (Textdatei, z. B. `README.md`, bis 12.000 Zeichen) und `gitlab_commits` (letzte zehn). Er soll den Kursauftrag aus Spaces oder Board mit Fork, README, Commits und Issues verbinden. Typisch: „Wie weit ist meine Abgabe?“ → Fork finden, README und Commits lesen, Stand und Offenes belegen. Ausschließlich lesend, feste Adresse git.coco.study, nur eigene Projekte (Mitgliedschaft). Der Token bleibt im lokalen Server und kommt nie zum Modell oder in die Seite; gelesene Dateien sind Quellen mit Belegkarte „GitLab · eigenes Konto“. Ohne Verbindung gibt es die Werkzeuge nicht; der Assistent sagt dann, dass GitLab zu verbinden ist.

## Mattermost im Assistenten (eigenes Konto)

Ist Mattermost unter Mitteilungen → Quellen & Status verbunden (Token oder Browser-Anmeldung), kann der Assistent: `mattermost_search` (Nachrichten aller deiner Teams durchsuchen, z. B. Ankündigungen zu Abgaben; Mattermost-Suchsyntax wie `in:kanal`, `from:name`, `after:2026-10-01`), `mattermost_teams` (deine Teams und Kanäle, ohne Direktnachrichten) und `mattermost_channel` (letzte 25 Nachrichten eines Kanals). Treffer sind Quellen mit Datum, Semester und Alter, Kanal, Autor und Permalink; der Assistent soll sie mit Spaces, Board und GitLab abgleichen. Nur lesend: die Suche ist technisch ein POST, schreibt aber nichts und ändert keine Lesestände. Bei Browser-Anmeldung braucht Mattermost dafür sein CSRF-Token, das die Desktop-App aus ihrer eigenen Sitzung ergänzt; es verlässt den Prozess nicht. Mit allen Werkzeugen gleichzeitig passen Aufträge bis etwa 3.300 Zeichen; längere bitte kürzen.

## WhatsApp im Assistenten (nur CoCo-Fokus)

Mit dem Schalter „KI-Assistent darf diese Chats lesen“ im CoCo-Fokus (standardmäßig aus) kann der Assistent die dort ausgewählten Chats auf Anfrage lesen (`whatsapp_chats`, `whatsapp_read`): Er öffnet den Chat im offenen WhatsApp-Web-Tab und liest die letzten sichtbaren Nachrichten mit Datum. Antworten dazu tragen Quelle „WhatsApp · lokal gelesen“ mit Alter. Details und Grenzen in `COCO-CHAT-FILTER.md`; der Nachrichtentext geht an das gewählte Modell.

## Rückfragen und Aktualität (Assistent)

- **Antworten mit Auswahl:** Endet eine Antwort mit einer Frage (welches Repo, welcher Kurs, Link?), liefert das Modell 2–6 Antwortvorschläge mit (`options`); sie erscheinen als Auswahl unter der Antwort. Die Regel ist jetzt „lieber einmal gezielt fragen als falsch raten“, ausdrücklich auch bei unklarem Projekt, Fork, Person oder Abgabe.

- **Rückfragen:** Das Werkzeug `ask_user` zeigt 2 bis 6 Auswahlfelder (Checkboxen bei Mehrfachauswahl, sonst Auswahlknöpfe) plus ein Feld „Anderes“; die erste Option ist die Empfehlung des Assistenten. Gefragt wird nur, wenn die Antwort das Ergebnis wesentlich ändert und sich nicht durch Lesen klären lässt, höchstens einmal je Auftrag und nie direkt nach einer Antwort (`allowAsk`). Die Auswahl geht als normale Nachricht „Meine Auswahl zu deiner Rückfrage: …“ weiter; der Entwurf im Eingabefeld bleibt erhalten. Beantwortete und unbeantwortete Rückfragen bleiben im Chatarchiv.
- **Aktualität:** Jede Quelle trägt `date`, `sem` (Semester) und `age` (aktuell, älter, veraltet, unbekannt) relativ zum laufenden Semester (`scope.semester`). Das Datum stammt aus Metadaten (Veröffentlichung vor Änderung), aus einer datierten URL oder, mit `dateBasis: text`, aus Daten und Semesterangaben im Text. Abrufzeitpunkte zählen nie als Inhaltsdatum. Direkte Spaces-Treffer liefern ihre Veröffentlichungs- und Änderungszeit mit. Die Quellenkarten zeigen dasselbe („SS 2020 · veraltet“, „Datum unbekannt“).
- **Verhalten:** Der Assistent soll bei zeitabhängigen Aussagen Semester oder Datum nennen, Veraltetes kennzeichnen, bei nur älteren Treffern erst breiter suchen und die neueste Quelle bevorzugen. Ob ein Modell dem folgt, hängt vom Modell ab; die Einordnung selbst wird lokal berechnet.
- **Prüfen:** `npm run test:ki:clarify` startet die echte Oberfläche in Electron mit festen Modellantworten (Rückfrage → Auswahl → Antwort) und prüft Bedienung und Layout.
- **Screenshots (Miro):** Zu Aufgaben, Abgaben und Fristen aus einem Miro-Board hängt der Assistent ein Bild des gelesenen Bereichs an die Antwort (`show_board_area`, höchstens 3; bei Aufgabenantworten holt Context bis zu zwei zitierte Bereiche nach). So lässt sich jede Aussage mit einem Blick prüfen. Das Bild geht nie an das Sprachmodell und wird nur im verschlüsselten lokalen Chatarchiv gehalten; Details und Grenzen stehen in `MIRO.md`.
