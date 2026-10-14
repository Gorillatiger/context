# Studio-Inventar in Context 0.16.2

**Studio-Inventar** in der Hauptnavigation öffnet `https://inventory.coco.study/` direkt auf dieser Seite. Ein eigener Chromium-Tab sitzt innerhalb des sichtbaren Browserrahmens. Die Navigation bleibt auf **Studio-Inventar**. Die vorhandenen Inventar-Einstiegslinks führen ebenfalls hierher.

- **Zurück / Vorwärts** bewegen sich im Verlauf dieser Inventar-Ansicht.
- **Neu laden / Laden anhalten** betreffen die Inventar-Webseite.
- **Startseite** kehrt ausdrücklich zur Inventar-Startseite zurück.
- Beim Wechsel zu einem anderen Bereich und Zurückkehren bleibt die aktuelle Geräte-Unterseite beziehungsweise Anmeldung erhalten. Ein geschlossener Tab wird neu angelegt.
- **Assistent** öffnet den Kontextchat daneben. In schmalen Fenstern übernimmt er vorübergehend die Browserfläche; Schließen stellt das Inventar wieder her.

Website-Profil, Anmeldung und Cookies werden mit dem normalen Context-Browser geteilt. Der Anbieter verwaltet Inventar und Ausleihen; Context automatisiert keine Reservierung und liest keine Inventarinhalte für die KI. Anmeldefenster behalten die vorhandene Browser-Anbindung.

Die Anbieter-Seite bleibt in einem separaten Renderer ohne Node, App-Preload oder Hub-Bridge. TLS-Prüfung, Sandbox und Netzgrenzen bleiben aktiv. Die neue native Funktion akzeptiert ausschließlich feste Inventar-Aufträge, keine freie URL oder fremde Tab-ID. Die Sichtbarkeit ist an die aktive Ansicht und deren Generation gebunden. Dialoge, Navigation und Seitenwechsel blenden die Browserfläche aus; alte Antworten dürfen sie nicht wieder darüberlegen.

Die reine Webansicht und ältere Desktop-Versionen zeigen einen ausdrücklich separaten Link, weil der echte Browserrahmen die aktualisierte Desktop-Anbindung braucht. Die App wurde für macOS / Apple Silicon gebaut; Windows und Linux wurden in dieser Änderung nicht tatsächlich getestet.

Prüfungen: `node --test tests/inventory-browser*.test.mjs`, außerdem `npm run check`. Die automatisierten Fälle prüfen Tab-Wiederverwendung, Anmeldung/Unterseiten, Abbruch, gleichzeitiges Öffnen, Fehler und erneuten Versuch, Frame-Zuordnung, Dialoge, ausstehende Antworten und HTML-Escaping. Die native UI-Prüfung verwendet ein isoliertes Testprofil; echte Ausleihen werden nicht ausgelöst.

32 gezielte Inventar-Prüfungen bestehen. Die macOS-Prüfung zeigt den echten separaten Chromium-Renderer auf der Inventar-Seite sowie die erhaltene Geräte-Seite nach einem Wechsel zu Notizen. Darkmode und die Assistenten-Spalte wurden geprüft; ein gemeinsames Vordergrund-Bild mit beiden Renderern war durch die Mac-Steuerung am Ende nicht erreichbar. Der vollständige Nachweis und diese Einschränkung stehen in `inventory-qa.json`. Die echte Inventar-Anmeldung und Ausleihen wurden nicht getestet.
