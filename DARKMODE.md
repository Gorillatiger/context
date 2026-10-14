# Darkmode — Context 0.14.1

Der Darkmode verwendet warme dunkle Flächen, burgunderfarbene Aktionsflächen und helle Rosétöne für Links und Überschriften. Die App behält ihre bisherigen Abstände, Größen und Browser-Clipping-Maße.

## Bedienung

- Oben in der App schaltet die Sonne-/Mond-Schaltfläche zwischen Hell und Dunkel um.
- Unter **Einstellungen → Darstellung** stehen **Hell**, **Dunkel** und **System** zur Auswahl. System folgt der Erscheinungsbildeinstellung des Betriebssystems.
- Die Auswahl wird im lokalen Renderer-Cache und in der lokalen JSON-Einstellung der Desktop-App gespeichert. Die frühe Theme-Anwendung verhindert einen hellen Zwischenzustand beim Start.
- Ein Wechsel verändert die Erscheinung, ohne die Ansicht neu aufzubauen. Offene Entwürfe bleiben erhalten.

Eingebettete Webseiten erhalten die native Erscheinungsbildpräferenz und können ihr eigenes Darkmode-Design verwenden, sofern sie diese Einstellung unterstützen. Context wendet auf Webseiten keine Farbfilter und keine CSS-Injektion an. Bildlogos behalten ihre Originalfarben auf kleinen hellen Flächen.

## Aufbau und geprüfter Stand

`dist/dark-theme.css` wird nach den vorhandenen Feature-Styles geladen. Alle tatsächlichen Style-Regeln gelten ausschließlich unter `html[data-theme="dark"]`. `--coco-white` bezeichnet auch im Darkmode eine Oberfläche. Für gefüllte Aktionen werden die getrennten Tokens `--accent-fill`, `--accent-fill-hover` und `--on-accent` verwendet; `--coco-burgundy` ist im Darkmode heller Akzenttext.

Die neuen Farben sind in OKLCH definiert. Die Light-Hues wurden für semantische und Service-Paletten beibehalten, die Helligkeitsabstufungen für dunkle Flächen und helle Texte angepasst und die Farben durch Chroma-Clamping innerhalb des sRGB-Gamuts gehalten. Der Hauptbackground entspricht weiterhin `#191417`.

Die CSS-Datei wurde mit Lightning CSS ohne Syntaxfehler oder Warnungen geprüft. Die DOM-Kontrastprüfung in 18 App-Ansichten sowie im Markdown-Dialog fand nach Korrektur eines hartcodierten Links im schwebenden Begleiter keine Textkontrastfehler und keine unerwarteten hellen Restflächen. Helle Logo-Inseln und farbige Statuspunkte sind beabsichtigt. 18 automatische Tests für native Theme-Verarbeitung und Renderer-Verhalten bestanden; auch die vollständige Projektprüfung mit 524 Checks bestand. Im Browser blieb der Inhalt von Chat- und Formularentwürfen beim Wechsel von Hell nach Dunkel erhalten.

Diese Prüfungen beziehen sich auf die untersuchten App-Ansichten und Zustände. Sie sind keine umfassende WCAG-Konformitätsbewertung und keine Aussage über die Barrierefreiheit eingebetteter Webseiten. Der Darkmode wurde mit Version 0.14.1 in der installierten Mac-App aktiviert. Version 0.14.2 ergänzt den Browserfilter und bestand mit 552 Projektprüfungen.

| Geprüfte Farbkombination | WCAG-Kontrast | APCA-Lc |
|---|---:|---:|
| Fließtext / Canvas | 15,74:1 | −96,2 |
| Sekundärtext / Raised | 8,94:1 | −68,3 |
| Caption / Selected | 7,28:1 | −63,9 |
| Akzenttext / Selected | 7,38:1 | −64,8 |
| Buttontext / Primary | ca. 6,55:1 | ca. −83 |
| Buttontext / Primary Hover | ca. 5,20:1 | ca. −77 |
| Header-Hinweise / Primary | 5,61:1 | −71,9 |

## Farbvergleich

Die Tabellen erfassen die geänderten Farbrollen. Wiederholte Regeln und Aliase sind zusammengefasst. `--surface`, `--ink`, `--muted`, `--line`, `--accent`, `--sage` und `--pink` verweisen auf die entsprechenden semantischen Tokens.

| Token / Rolle | Light vorher | Dark nachher |
|---|---|---|
| `--bg` / Canvas | `#fff7f8` | `oklch(0.199 0.010 341.331)` |
| `--coco-white` / Surface | `#fffdfd` | `oklch(0.232 0.006 17.194)` |
| `--coco-paper` / Raised | `#fff7f8` | `oklch(0.261 0.014 8.543)` |
| `--coco-rose` / Wash | `#fbe8ea` | `oklch(0.285 0.022 10.224)` |
| `--coco-rose-deep` / Selected | `#f4d9de` | `oklch(0.315 0.032 5.066)` |
| `--coco-ink` / Text | `#292025` | `oklch(0.952 0.012 343.842)` |
| `--coco-muted` | `#73515a` | `oklch(0.825 0.035 1.633)` |
| `--coco-caption` | `#7a535d` | `oklch(0.815 0.035 2.456)` |
| `--coco-burgundy` / Akzenttext | `#511428` | `oklch(0.825 0.080 4.609)` |
| `--coco-burgundy-hover` / heller Akzent | `#701f38` | `oklch(0.906 0.051 4.609)` |
| `--accent-fill` / gefüllte Akzentflächen | `#511428` | `oklch(0.475 0.110 4.609)` |
| `--accent-fill-hover` | `#701f38` | `oklch(0.530 0.118 5.884)` |
| `--on-accent` | `#fffdfd` | `oklch(0.974 0.013 4.609)` |
| `--on-accent-muted` | `#f7dbe2` | `oklch(0.925 0.038 4.609)` |
| `--coco-coral` | `#d7373e` | `oklch(0.780 0.100 23.627)` |
| `--coco-coral-soft` | `#eda7ac` | `oklch(0.380 0.060 14.390)` |
| `--coco-outline` | `#b1818b` | `oklch(0.535 0.040 5.091)` |
| `--coco-control-outline` | `#9c6d78` | `oklch(0.620 0.042 3.752)` |
| `--coco-divider` | `#e2c4ca` | `oklch(0.355 0.027 4.282)` |
| `--coco-success` | `#386047` | `oklch(0.820 0.045 155.593)` |
| `--coco-success-bg` | `#edf3ea` | `oklch(0.300 0.026 134.898)` |
| `--coco-warning` | `#854923` | `oklch(0.845 0.080 50.686)` |
| `--coco-warning-bg` | `#fff1df` | `oklch(0.325 0.035 74.314)` |
| Fehlertext, Overdue, Danger | `#a02438`, `#8d2c2d`, `#8b1929`, `#81213a` | `oklch(0.850 0.082 14.161)` |
| Fehlerfläche | `#fff0ec`, `#fff0f3` | `oklch(0.310 0.040 14.161)` |
| Fehlerrahmen | `#d3a19c`, `#bd3555` | `oklch(0.590 0.075 14.161)` |
| Erfolgsrahmen | `#acbea5` | `oklch(0.535 0.035 155.593)` |
| Warnungsrahmen | `#c7a477` | `oklch(0.590 0.063 50.686)` |
| Dialog-/Navigationsbackdrop | `#51142840` | `oklch(0.144 0.013 346.720 / 0.761)` |

| Weitere lokale Flächen / Details | Light vorher | Dark nachher |
|---|---|---|
| Body-Gradient Mitte | `--coco-paper` | `oklch(0.228 0.012 8.543)` |
| Body-Gradient Ende | `--coco-rose-deep` | `oklch(0.270 0.020 5.066)` |
| Sidebar-Gradient Ende | `--coco-rose` | `oklch(0.281 0.022 5.066)` |
| Textauswahl | Systemfarbe | `oklch(0.445 0.070 4.609)` |
| Aktiver Navigation-Zähler | `--coco-white` | `oklch(0.330 0.055 4.609)` |
| Logo-Insel | `#fff` | `oklch(0.996 0.001 17.194)` |
| Logo-Rahmen | `#ead7dc` | `oklch(0.630 0.054 354.396)` |
| Quick-Tool-/Plugin-Gradient | `--coco-white` → `#fff9fa` / `#fff8fa` | Raised → Surface |
| Quick-Tool-Rahmen | `#ead7dc` | `--coco-divider` |
| Kartenrahmen | `#caa4ae` | `--coco-outline` |
| Quick-Tool-/Plugin-Beschreibung | `#694750`, `#77515d` | `--theme-muted` |
| Sidebar-Link Hover | `#fff4f6` | `--theme-selected` |
| Markdown-Code Fläche | `--coco-rose` | `oklch(0.313 0.028 5.066)` |
| Markdown-Code Text | `--coco-burgundy` | `oklch(0.875 0.055 4.609)` |
| API-Dokumentationslink im schwebenden Begleiter | `#874060` | `--theme-accent` / `oklch(0.825 0.080 4.609)` |
| Agentheader-Kontrollrahmen | `#b88797` | `oklch(0.750 0.070 356.400)` |
| Browser-Assistent aktiv Hover | `--coco-rose-deep` | `oklch(0.350 0.034 5.066)` |
| Boards-Zusammenfassung | `#fffaf0` | `--coco-warning-bg` |
| Speech-Zwischentextfläche | `#f8ebef` | `--theme-wash` |
| Speech-Zwischentext | `#391321` | `--theme-text` |
| Speech-Einstellungsrahmen | `#edced8` | `--coco-divider` |
| Speech-Select | `#fff` | `--theme-surface` |
| Browser-/Native-Slot-Leerfläche | `white` | `--theme-surface` |

Service-Farben betreffen ausschließlich Context-eigene Hoverflächen und Pfeile; Logo-Dateien bleiben unverändert.

| Dienst | Wash vorher → nachher | Akzent vorher → nachher |
|---|---|---|
| Spaces | `#fff5ed` → `oklch(0.287 0.025 61.349)` | `#e65c00` → `oklch(0.825 0.105 43.760)` |
| Mattermost | `#f0f4fc` → `oklch(0.287 0.025 264.511)` | `#1c58d9` → `oklch(0.825 0.086 262.687)` |
| Signal/Outlook/Google Calendar/Zoom | `#f0f4fc` → `oklch(0.287 0.025 264.511)` | `#2454aa` → `oklch(0.825 0.086 262.687)` |
| GitLab | `#fff3ef` → `oklch(0.290 0.028 39.420)` | `#d74921` → `oklch(0.827 0.099 35.766)` |
| Sciebo/WhatsApp | `#eff7f0` → `oklch(0.304 0.026 149.250)` | `#087c31` → `oklch(0.833 0.068 148.064)` |
| Miro | `#fff9e5` → `oklch(0.309 0.024 93.097)` | `#745800` → `oklch(0.852 0.091 87.073)` |
| Obsidian | `#f5effc` → `oklch(0.285 0.035 306.665)` | `#6c36b3` → `oklch(0.826 0.090 298.721)` |
| OpenRouter/GitHub | `#f4f0f2` → `oklch(0.315 0.025 345.281)` | `#43383e` → `oklch(0.852 0.033 344.072)` |
| Webmail/KI:connect | `--coco-paper` → Selected | `--coco-burgundy` → Akzenttext |

| Modul-Iconpalette | Fläche vorher → nachher | Text vorher → nachher |
|---|---|---|
| Violet | `#efdeed` → `oklch(0.302 0.035 329.506)` | `#682963` → `oklch(0.834 0.076 330.725)` |
| Peach | `#f8e0d9` → `oklch(0.301 0.028 36.865)` | `#853c25` → `oklch(0.837 0.072 38.008)` |
| Blue | `#e3edf4` → `oklch(0.308 0.026 238.014)` | `#335971` → `oklch(0.846 0.051 237.772)` |
| Green | `#e6eedf` → `oklch(0.320 0.027 130.017)` | `#476136` → `oklch(0.845 0.066 133.924)` |
| Yellow | `#f5e9cd` → `oklch(0.324 0.028 87.565)` | `#745018` → `oklch(0.856 0.079 74.064)` |
