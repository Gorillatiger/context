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
