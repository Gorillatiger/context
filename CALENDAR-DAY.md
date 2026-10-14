# Kalender-Tagesansicht · 0.16.4

Im Kalender **Tag** auswählen. Die Pfeile wechseln einen Tag, **Heute** kehrt zum aktuellen Berliner Datum zurück, und das Datumsfeld öffnet einen beliebigen Tag. Ein zuvor im Monatsraster gewähltes Datum wird übernommen. Monat und Agenda bleiben verfügbar.

Ganztägige Termine und Abgabefristen stehen über dem Stundenraster. Uhrzeit-Termine zeigen ihre Dauer; überlappende Termine werden nebeneinander dargestellt. Ein Zeitblock öffnet seine Details mit Kurs, Originalquelle und bestehenden Aktionen. Auf schmalen Inhaltsflächen stehen die Details unter dem Raster. Der Stundenbereich scrollt unabhängig, bei vielen parallelen Terminen auch horizontal; die Uhrzeitbeschriftung bleibt links sichtbar. Der bestehende Kursfilter gilt für Raster und Details.

**Mehr** enthält Foto-KI, Terminplanimport, Konten und ICS-Export. Anlegen und Synchronisieren bleiben direkt erreichbar. Ein Klick auf einen Zeitblock verändert oder synchronisiert keinen Termin. Importierte Outlook-/Google-Zeitangaben bleiben beim bisherigen Ablauf zur Kurszuordnung unverändert.

Die Darstellung verwendet Europe/Berlin und echte Zeitpunkte. Tage mit Zeitumstellung umfassen entsprechend 23 oder 25 Stunden. Doppelte Herbststunden sowie über die Zeitumstellung laufende Termine unterscheiden MEZ und MESZ. Über Mitternacht laufende Termine werden an der Tagesgrenze begrenzt; Pfeile kennzeichnen ihre Fortsetzung. Das Enddatum von Ganztagsterminen bleibt exklusiv. Sehr kurze Termine bekommen eine lesbare Mindestfläche; ihre angezeigte Uhrzeit bleibt exakt.

26 neue Prüfungen testen Datum, Kursfilter, tatsächliche Kalender-Steuerelemente, Details ohne Schreibzugriff, Mitternacht, Zeitumstellung, Überlappungen und die Erhaltung des Scrollzustands. Der gesamte Standardlauf hat 976 JavaScript- und 19 Python-Prüfungen bestanden; eine optionale echte Speech-Modellprüfung wurde übersprungen.

Die echte Browserbedienung wurde mit ausschließlich synthetischen Terminen im vollständigen App-Ablauf auf macOS/Chromium bei 1440×1000, 850×600 und 390×844 geprüft: Tageswechsel mehrfach per Enter ohne Fokusverlust, Kurswechsel, kompakte Kurztitel, Nebeneinander bei Überschneidungen, Termindetails, Darkmode und horizontaler Scroll mit sichtbarer Zeitachse. Kein horizontaler Überlauf der ganzen Seite, keine Browser-Konsole-Fehler im Prüftab. Keine echten Termine oder Konten wurden geändert. Windows/Linux wurden nicht ausgeführt.

Bericht: `calendar-day-qa.json`; Maße: `calendar-day-geometry.json`; Bilder: `calendar-day-desktop-qa.png`, `calendar-day-small-qa.png` und `calendar-day-dark-mobile-qa.png`. Die neue Mac-App ist gebaut. Die laufende installierte Version 0.16.0 wurde nicht beendet oder ersetzt; der bestehende Server mit den angemeldeten Mail-/KI-Sitzungen bleibt erhalten. Zur Aktivierung offene Entwürfe speichern, Context regulär beenden und das neue App-Paket verwenden.
