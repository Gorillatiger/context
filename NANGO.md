# Outlook und Google über Nango

Context 0.16.0 verbindet Outlook, Gmail, Google Kalender und Google Drive über Nango. Die Konten erscheinen unter **Verbindungen** in der Hauptnavigation und im Plugin-Bereich. Unter **Mail** kannst du zwischen TH-Mail, Outlook und Gmail wechseln. Die Kalenderansicht verwendet ein ausdrücklich verbundenes Nango-Konto; die bisherige Anmeldung mit einer eigenen OAuth-App bleibt als Alternative erhalten.

## Einrichten

1. Verwende eine Nango-Cloud-Umgebung oder deine eigene Nango-Instanz. Context betreibt oder installiert Nango nicht automatisch.
2. Richte die gewünschten Integrationen im Nango-Dashboard ein. Die Integration-ID ist dein frei gewählter Schlüssel, nicht die Microsoft-/Google-Client-ID. Die passenden Nango-Anbieter sind Outlook (`outlook`), Google Mail (`google-mail`), Google Calendar (`google-calendar`) und Google Drive (`google-drive`).
3. Erstelle einen **Environment API Key** mit `environment:integrations:list`, `environment:connections:list`, `environment:connect_sessions:write` und `environment:proxy`. Context ruft keine OAuth-Zugangstokens ab. Rechte zum Lesen von Credentials sind nicht erforderlich.
4. Öffne **Verbindungen**, wähle Cloud oder eigenen Server und gib Serveradresse, Nango-Schlüssel und Integration-IDs ein. Nango Cloud: `https://api.nango.dev`. Eigene Instanz: HTTPS; für lokale Entwicklung ist HTTP ausschließlich an einer Loopback-Adresse erlaubt. Die Adresse muss eine reine Origin ohne Zugangsdaten, Pfad, Query oder Fragment sein.
5. Speichere die Einrichtung. Wähle anschließend **Mit Microsoft/Google anmelden**. Context öffnet die Nango-Anmeldung im Systembrowser und bestätigt die Verbindung erst, wenn Nango die passende Connection mit der eigenen lokalen Nutzer- und Anmeldekennung meldet.
6. Alternativ kannst du eine bereits vorhandene Connection-ID ausdrücklich übernehmen. Context prüft Integration, Anbieter und gegebenenfalls Nutzerzuordnung; es übernimmt nicht automatisch irgendein Konto aus deiner Nango-Umgebung.

Für Cloud-Anmeldungen wird ausschließlich `https://connect.nango.dev` geöffnet. Bei einer eigenen Instanz muss der Connect-Link dieselbe Origin wie dein Nango-Server haben. Eine separate Connect-Frontend-Origin ist derzeit nicht freigegeben; dort kannst du die Verbindung im Nango-Dashboard herstellen und die Connection-ID übernehmen. Das Abbrechen beendet die lokale Wartezeit, nicht automatisch eine bereits im Browser erteilte OAuth-Freigabe.

Nango ersetzt die Einrichtung der OAuth-Apps und der Anbieterrechte nicht grundsätzlich. Je nach Nango-Umgebung gibt es Entwicklungszugänge; für eigene oder produktive Apps brauchst du die Registrierung, erlaubte Redirect-URLs und gegebenenfalls Anbieterprüfung bzw. die Zustimmung deiner Hochschule.

## Rechte

| Dienst | Voreinstellung in Context | Zusätzlich möglich |
| --- | --- | --- |
| Outlook | Nachrichten und Kalender lesen | Mail senden, gelesen/ungelesen ändern, eigene Context-Termine synchronisieren |
| Gmail | Nachrichten lesen | Mail senden, gelesen/ungelesen ändern |
| Google Kalender | Kalender lesen | Keine Schreibaktionen |
| Google Drive | Terminplan-Dateien lesen | Keine Uploads oder Änderungen |

Die Schalter in Context begrenzen lokale Aktionen. Die OAuth-Integration in Nango muss die entsprechenden Rechte ebenfalls enthalten. Für Microsoft sind typischerweise `User.Read`, `Mail.Read`, `Calendars.Read` und für die Token-Erneuerung `offline_access` nötig; optional `Mail.Send`, `Mail.ReadWrite` und `Calendars.ReadWrite`. Google verwendet je Dienst `gmail.readonly`, optional `gmail.send`/`gmail.modify`, `calendar.readonly` und eine passende Drive-Lesefreigabe. Prüfe die konkret angeforderten Scopes im Nango-Dashboard und im Anbieter-Dialog.

Eine Änderung der Nango-Einrichtung verwirft offene Mail-Lesevorgänge und Versandvorschauen. Entwürfe bleiben im Arbeitsspeicher und müssen erneut geprüft werden. Ein laufender Versand mit unklarem Ausgang bleibt gegen erneutes Absenden gesperrt. Automatischer Outlook-Abgleich wird bei Änderungen an den Verbindungen ausgeschaltet; wähle den Zielkalender erneut.

## Datenschutz und Sicherheit

- OAuth-Tokens werden bei deiner **Nango-Instanz** verwaltet und erneuert. Bei Nango Cloud ist Nango ein zusätzlicher Dienst, über den Mail-, Kalender- und Drive-Anfragen laufen. Die Verarbeitung dieser Dienste ist deshalb nicht vollständig lokal.
- Der Nango-Schlüssel gelangt nur über die eingeschränkte native IPC-Schnittstelle zur Desktop-App. Er wird nach dem Absenden aus dem Eingabefeld entfernt und erscheint nicht in Workspace-Backups, Browser-Storage oder KI-Kontext.
- Die Desktop-App speichert die Einrichtung mit Electron `safeStorage`, atomaren Dateien und eingeschränkten Dateirechten. Wenn sichere Verschlüsselung nicht verfügbar ist, bleibt der Schlüssel nur für die laufende Sitzung im Speicher. Insbesondere Linux `basic_text` wird nicht als sicherer Speicher verwendet.
- Fremde Browserseiten erhalten keine Nango-Schnittstelle. Es gibt keinen generischen Proxy für den Assistenten: Nur fest definierte Mail-, Kalender- und Dateioperationen sind erreichbar. Anbieteradresse, Pfade, Header und Größen werden im nativen Prozess kontrolliert.
- Context zeigt Mail-Inhalte als Text und lädt keine externen Bilder. Mails, Anhänge und Entwürfe werden nicht automatisch als lokale Dateien archiviert und nicht automatisch an ein KI-Modell übergeben. Gewählte Kalenderimporte bleiben wie zuvor im lokalen Workspace.
- **Trennen** entfernt die lokale Kontozuordnung. **Nango-Einrichtung entfernen** löscht die lokale Einrichtung. OAuth-Freigaben und die Verbindung auf dem Nango-Server werden dabei nicht widerrufen; verwalte deren Widerruf beim Anbieter oder im Nango-Dashboard.
- Nutze für diese persönliche Desktop-App eine eigene Nango-Umgebung. Für eine gemeinsam verteilte Mehrnutzer-App gehört ein Environment-Schlüssel in einen serverseitigen Dienst mit Nutzerisolierung, nicht in ein öffentliches Frontend oder ein ausgeliefertes vorkonfiguriertes Paket.

## Mail und Kalender

Outlook und Gmail verwenden dieselbe scrollbare Mailansicht wie TH-Mail. Konten behalten getrennte Entwürfe und Scrollzustände. Lesen verändert den Gelesen-Status nicht. Versand erfolgt erst nach Empfänger- und Textvorschau. Ein Konto- und Vorschauabgleich verhindert Versand über eine inzwischen gewechselte Verbindung. Unklare Versandantworten werden nicht automatisch wiederholt.

Microsoft Graph `202 Accepted` bedeutet, dass der Anbieter den Versandauftrag angenommen hat, nicht dass die Mail bereits zugestellt wurde oder die Gesendet-Kopie schon vorliegt. Eine Gesendet-Kopie wird angefordert. Gmail bestätigt die Annahme über die zurückgegebene Nachrichtenkennung; auch das ist kein Zustellnachweis. Bei Outlook sind normale Dateianhänge unter 3 MB pro Datei und der direkte Request unter 4 MB begrenzt; größere Upload-Sessions sind derzeit nicht implementiert. Insgesamt gelten weiterhin höchstens zehn Anhänge und acht MB. Gmail-Ordner entsprechen Labels; die Trefferanzahl kann eine Schätzung sein. Die Microsoft-Suche über `$search` ist anbieterseitig auf höchstens 1.000 Ergebnisse beschränkt.

Google Kalender und Drive sind getrennte Verbindungen. Kalenderimporte werden zunächst geprüft. Der optionale Outlook-Abgleich verwendet die bestehende Context-Zuordnung mit Namespace, Transaktionskennung und ETags. Er erstellt und aktualisiert ausschließlich zugeordnete eigene Termine in einem bestätigten eigenen Kalender; er löscht keine Termine. Google-Synchronisierung mit Schreibzugriff ist nicht enthalten.

## Architektur und Prüfung

`desktop/nango.mjs` hält Einrichtung, Connect-Sessions, Kontozuordnung und den internen Proxy. `connectors/nango-mail.mjs` und `connectors/nango-calendar.mjs` übersetzen die Anbieterantworten in die vorhandenen Mail-/Kalenderverträge. `desktop/nango-mail.mjs` und `desktop/calendar-routing.mjs` verbinden sie mit den bestehenden nativen Schnittstellen. Die Rendereransicht ist `dist/nango-connections.js`.

Automatische Prüfungen: `npm run check`; fokussiert: `node --test tests/nango-*.test.mjs`. Tests verwenden künstliche Anbieterantworten, Abbruch- und Kontowechselfälle sowie einen lokalen Nango-Testserver. Sie verschicken keine echten Nachrichten und erzeugen keine echten Termine. Den tatsächlichen Prüfstand und die Mac-Paketversion findest du in `../NANGO-UPDATE.md`.

## Quellen und Lizenz

Die Context-Anbindung steht unter der MIT-Lizenz dieses Projekts. Nango wird nicht in das App-Paket eingebettet und hat eine eigene [Elastic License 2.0](https://github.com/NangoHQ/nango/blob/master/LICENSE). Der Quellcode ist verfügbar; die Lizenz enthält Einschränkungen und sollte nicht als uneingeschränkte Open-Source-Lizenz beschrieben werden.

Offizielle Grundlagen: [Nango Auth](https://nango.dev/platform/auth/), [Connect-Sessions](https://nango.dev/docs/reference/backend/http-api/connect/sessions/create), [Connections ohne Credentials](https://nango.dev/docs/reference/backend/http-api/connections/list), [Proxy](https://nango.dev/docs/reference/backend/http-api/proxy/get), [Gmail-Anbindung](https://nango.dev/blog/how-to-build-a-gmail-api-integration-with-nango-and-claude), [Microsoft sendMail](https://learn.microsoft.com/en-us/graph/api/user-sendmail), [Gmail API](https://developers.google.com/workspace/gmail/api/guides/sending).
