# Spaces-Crawler · 0.16.7

**Projekte → Spaces indexieren** öffnet die Kursabdeckung. Alternativ das Spaces-Symbol rechts neben dem Suchfeld verwenden. Gewählten Kurs oder alle verknüpften Kurse und 20, 100 oder 300 Ansichten pro Lauf wählen. „Fortsetzen“ arbeitet die gespeicherte Warteschlange weiter ab; „Pausieren“ oder Schließen beendet den Lauf. Ein neuer Lauf beginnt erst nach deinem Klick. „Erneut prüfen“ liest die gewählten Kurse frisch ein, während ältere Texte bis zum erfolgreichen Abruf als letzter Stand verfügbar bleiben.

Die Suche zeigt weiterhin 24 Zeilen pro Seite, jetzt mit Gesamtzahl, Seite und Vor-/Zurück-Schaltflächen. Die Begrenzung betrifft die gleichzeitig dargestellten Zeilen, nicht die Zahl auffindbarer Dokumente.

## Installation und Anmeldung

Das Mac-Paket **Context-Browser-Mac-0.16.7.zip** enthält den nativen Leser. Für ein Update Entwürfe sichern und die laufende App regulär beenden. Den bisherigen dauerhaften Browserbestand behalten; in Context einmal selbst bei Spaces anmelden. Der Crawler verwendet dasselbe lokale Websiteprofil, ohne Cookies aus anderen Browsern zu kopieren. Anmeldungen und Freigaben bleiben beim Anbieter. In einer älteren Mac-App erscheint „App-Update erforderlich“; die normale Webansicht kann nur bereits gespeicherte Quellen durchsuchen.

Die neue Indexierung benötigt keinen Modellanbieter, API-Schlüssel oder neuen OAuth-Zugriff. Sie verwendet einen separaten versteckten, lesenden Browser mit derselben Anmeldung. Die sichtbaren Benutzer-Tabs werden dabei nicht navigiert. Gleichzeitige native Quellenprüfungen werden gegeneinander abgesichert. Die bestehende Node-Mail-/KI-Sitzung muss für diesen Ausbau nicht neu gestartet werden.

## Erfasster Umfang

Der Crawler beginnt ausschließlich an den aktiven, konkret verknüpften Spaces-Kursseiten. Er folgt tatsächlich angebotenen HTML-Unterseiten und Beiträgen, Seitennavigation, Home/Orga und sichtbaren verschachtelten Kursabschnitten. Globale Blog-/Datumslinks werden nur über ihre beobachtete Herkunft im Kursgraph verfolgt. Duplikate und Schleifen werden erkannt. Lange Seitentexte werden in Unicode-sicheren Fenstern eingelesen und für Suche und Quellenarchive in Textabschnitte aufgeteilt; auch deren Ende bleibt suchbar.

Miro-Anker werden als kanonische Boardlinks mit Linktitel und beobachteter Fundstelle gespeichert. Einladungsschlüssel und URL-Parameter werden entfernt. **Miro-Boards → Lokale Quellen prüfen** kann sie danach einsammeln. Das kontaktiert Miro nicht. „Link gepostet von“ und Zeitstempel erscheinen nur, soweit der Beitrag diese Angaben belegt; der tatsächliche Board-Ersteller bleibt unbekannt.

Die Texte stehen dem menschlichen Suchindex und dem Begleiter zur Verfügung. Der KI-Chat erhält sie nur im ausgewählten Kurs und bei aktivierter Wissensart **gelesene Browserquellen**. Das Crawlen selbst schickt nichts an einen KI-Anbieter. Ein späterer KI-Auftrag folgt deinen bisherigen Anbieter-/Wissensfreigaben.

## Speicher und Sicherheitsgrenzen

Bis zu 500 Ansichten pro Kurs, 2.000 insgesamt, 20 Millionen UTF-16-Textzeichen, 60.000 Zeichen pro Ansicht und acht verschachtelte Abschnitte. Pro Ansicht bis zu 500 Kurslinks, 300 Abschnittsschalter und 100 Miro-Fundstellen. Lauf-, Text-, Link- und Zugriffslücken werden angezeigt; „Lauf beendet“ behauptet keine vollständige Kenntnis aller Hochschulinhalte.

Nur Text und begrenzte Metadaten werden gespeichert; keine Bilder, Videos, HTML-Dateien, Formulare, Cookies oder Passwörter. Quelle und Warteschlange liegen AES-GCM-256-verschlüsselt in IndexedDB (`context-spaces-crawl`). Ein nicht exportierbarer Schlüssel liegt im selben App-Browserprofil. Bekannte Zugangsdatenmuster werden bestmöglich entfernt. Verschlüsselung ersetzt keine Sicherheit des Betriebssystems/Benutzerkontos; Profilverlust bedeutet Datenverlust. Der Crawler-Cache ist derzeit nicht im Workspace-JSON-Export enthalten.

Jede neu gelesene Quelle wird einzeln verschlüsselt geschrieben. Es wird nicht bei jeder Seite der gesamte Textbestand erneut gespeichert. Die Warteschlange wird nach bestätigten Ansichten gesichert. Atomare Speicherung mit Revisionsprüfung schützt vor konkurrierenden Hubfenstern; bei Konflikt den Arbeitsbereich neu laden. Die Metadaten sind auf 12 MB verschlüsselte Nutzlast begrenzt. Quellen werden erst nach erfolgreichem Speichern für die Suche freigegeben. Entfernte, archivierte oder neu verknüpfte Kurse liefern keine alten Texte in den aktiven Index.

20 Millionen Zeichen sind ein Textbudget, keine garantierte Gesamt-Dateigröße oder RAM-Grenze: UTF-8, verschlüsselte Metadaten, Datenbank-Overhead und abgeleiteter Suchindex zählen zusätzlich. Der vorhandene Suchindex hat eigene Grenzen von 20.000 Dokumenten, 40 Millionen Zeichen und geschätzten 256 MiB Indexdaten. Siehe `SEARCH.md` für Messungen und Begrenzungen.

## Grenzen und Prüfung

Anhänge/PDFs, Fotos, Audio, Mitgliederverzeichnisse, nicht angebotene oder dauerhaft verborgene Inhalte und fremde Domains werden nicht automatisch eingelesen. Der Crawler ist ein lokaler Textbestand, kein Hintergrund-Vollsync. Bei HTTP-401/403 oder erkennbarer Loginseite wird pausiert; eine Anbieter-Sperrseite mit HTTP-200 lässt sich nicht zuverlässig von gewöhnlichem Inhalt unterscheiden. Änderungen während des Lesens werden über URL, Epoch und Inhaltsrevision geprüft; unbestätigte Fortsetzungen gelangen nicht in den Index. Die örtliche Zuordnung beruht auf dem verlinkten Kurs, nicht auf einem geratenen Themenklassifikator.

Automatische Prüfungen decken tiefe Ressourcen, mehr als drei Unterseiten, lange deutsche Texte, Seitennavigation, Neuaufbau, Abbruch, konkurrierende Leser, Speicherfehler/-grenzen und Quellenfreigaben ab. Browserprüfungen verwenden getrennte synthetische Kurse und keine privaten Kontoinhalte. macOS wurde geprüft; Windows/Linux und ein vollständiger Lauf durch sämtliche echten Spaces-Kurse sind nicht bestätigt. Genauere aktuelle Ergebnisse in `VALIDIERUNG.md` und `crawler-qa.json`.

Die erste Kursansicht wird nach dem Laden kurz auf Stabilität geprüft. Valide relative Zeitlabels werden anhand ihrer Original-Zeitstempel als ISO-Zeit dargestellt, damit „vor 1 Minute“ → „vor 2 Minuten“ keinen falschen Inhaltswechsel auslöst. Echte Text-, Link-, URL- und Epoch-Änderungen bleiben abgesichert. Die Stabilitätsprüfung dauert üblicherweise 350 ms, höchstens etwa 1,4 s zusätzlich pro erster Ansicht.
