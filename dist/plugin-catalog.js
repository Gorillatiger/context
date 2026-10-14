// This is a catalog of shipped code, not a loader for third-party scripts.
// Credentials and raw service responses are deliberately absent from this API.
import {brandLogo,brandClass} from './brand-logos.js';
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const freeze = (value) => {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const view = (id, calendar = "") => ({
  type: "view",
  id,
  ...(calendar ? { calendar } : {}),
});
const importer = (id) => ({ type: "import", id });
const connection = (id) => ({ type: "connection", id });
const website = (url, label) => ({ type: "website", url, label });

export const PLUGIN_GROUPS = freeze([
  {
    id: "daily",
    title: "Kurse und Kommunikation",
    description:
      "Deine Dienste öffnen und ihren tatsächlichen Zugriff einrichten.",
  },
  {
    id: "planning",
    title: "Assistent und Kalender",
    description:
      "Mit deinen Quellen arbeiten und Termine nachvollziehbar übernehmen.",
  },
  {
    id: "files",
    title: "Dateien, Notizen und Abgaben",
    description: "Offene Formate mitnehmen und lokal weiterarbeiten.",
  },
]);

export const PLUGIN_CATALOG = freeze([
  {id:'miro',name:'Miro-Boards',short:'MI',color:'yellow',group:'daily',version:'1.0.0',license:'MIT',mode:'local',description:'Boardlinks in Kursunterseiten finden, mit optionaler KI-Suche priorisieren und Kursen zuordnen.',permissions:['Lokale Kursquellen auf direkte Miro-Boardlinks prüfen.','Spaces-Kursseiten beim Start einer Suche lesend durchgehen.','Optional: Suchauftrag und beobachtete Kurs-/Abschnittstitel an das gewählte Modell senden.'],flow:'Normale Suche verarbeitet Link-Metadaten lokal. Die optionale KI-Suche überträgt nur Suchauftrag und Kurs-/Abschnittstitel an den gewählten Anbieter oder das lokale Modell; keine Beitragstexte. Ein Board öffnet erst auf Klick bei Miro.',storage:'Fundstellen, Linktitel, Postautor und belegte Zeitangaben im lokalen Workspace und seinem Backup. KI-Suchprotokoll separat im verschlüsselten Assistenten-Archiv.',setup:'Kurs-Spaces verknüpfen, bei Spaces anmelden und im Board-Verzeichnis die Suche starten.',limitation:'Linktext ist kein verifizierter Boardtitel. Der Postautor ist kein Nachweis des Board-Erstellers. Dateien und nicht verfügbare Inhalte können fehlen. Live-Suche benötigt Context Browser 0.13.0.',action:view('boards'),actionLabel:'Boards finden',secondary:website('https://miro.com/app/dashboard/','Miro öffnen')},
  {id:'inventory',name:'Studio-Inventar',short:'IN',color:'blue',group:'daily',version:'1.0.0',license:'MIT',mode:'website',description:'Geräte und Materialien im Studio Code ausleihen. Direkt über die Hauptnavigation erreichbar.',permissions:['Inventar-Website im Browser öffnen.'],flow:'Ausleihe und Anmeldung erfolgen direkt bei inventory.coco.study.',storage:'Der Einstieg ist lokal gespeichert; die Website nutzt das gemeinsame Browserprofil.',setup:'Inventar öffnen und beim Anbieter anmelden.',limitation:'Keine automatische Inventar-Abfrage oder Buchung durch Context.',action:view('inventory'),actionLabel:'Zum Studio-Inventar'},

  {
    id: "spaces",
    name: "TH-Spaces",
    short: "SP",
    color: "violet",
    group: "daily",
    version: "1.0.0",
    license: "MIT",
    mode: "browser",
    source: "spaces",
    description:
      "Kurs-Spaces im eigenen Browser öffnen. Der Assistent kann sichtbare Kursseiten lesen und erlaubten Spaces-Links folgen.",
    permissions: [
      "Lesender Zugriff auf sichtbaren Spaces-Text bei einem Agentenauftrag.",
      "Gespeicherte Kurslinks und vorhandene lokale Mitteilungen.",
    ],
    flow: "Website-Inhalte kommen von TH-Spaces. Ausgewählte gelesene Textauszüge gehen bei einer KI-Frage an deinen KI-Anbieter.",
    storage:
      "Kurslinks und ausgewählte Chatquellen bleiben lokal. Die Mac-App nutzt ein gemeinsames Website-Profil; unterstützte Sitzungscookies werden verschlüsselt gesichert.",
    setup:
      "In Context Browser bei TH-Spaces anmelden und den Kurs-Space mit einem Projekt verbinden.",
    limitation:
      "Kein vollständiger Hintergrundimport aller Spaces-Inhalte. Ein Browser-Stand kann unvollständig oder älter sein.",
    action: view("projects"),
    actionLabel: "Kurs-Space verbinden",
    secondary: website("https://spaces.th-koeln.de/", "Spaces öffnen"),
  },
  {
    id: "mattermost",
    name: "Mattermost",
    short: "MM",
    color: "blue",
    group: "daily",
    version: "1.0.0",
    license: "MIT",
    mode: "connector",
    source: "mattermost",
    description:
      "Channels im Browser nutzen und ungelesene Hinweise über den lokalen lesenden Connector sammeln.",
    permissions: [
      "Lesender API-Zugriff auf erlaubte Kurskanäle, ungelesene Zähler und begrenzte Nachrichtentexte.",
      "Keine Nachrichten senden oder beim Anbieter als gelesen markieren.",
    ],
    flow: "Der lokale Connector ruft Mattermost mit deinem eigenen Zugang ab. Ausgewählte Mitteilungsauszüge können zum KI-Anbieter gehen.",
    storage:
      "Einrichtungszugänge bleiben in der laufenden lokalen Sitzung. Übernommene Hinweise und ihre Kurszuordnung bleiben lokal.",
    setup:
      "Einrichtung öffnen und einen autorisierten Mattermost-Zugang hinterlegen; für die Website separat in Context Browser anmelden.",
    limitation:
      "Ein Website-Login bestätigt keinen API-Zugang. Begrenzter Teilstand: bis zu 20 Kanäle prüfen, bis zu 10 davon mit je 10 Textvorschauen. Keine Direktnachrichten, Anhänge, Medien oder vollständige Offline-Chatkopie.",
    action: connection("mattermost"),
    actionLabel: "Connector einrichten",
    secondary: website("https://chat.coco.study/", "Mattermost öffnen"),
  },
  {
    id: "gitlab",
    name: "GitLab",
    short: "GL",
    color: "peach",
    group: "daily",
    version: "1.0.0",
    license: "MIT",
    mode: "connector",
    source: "gitlab",
    description:
      "Repositories im Browser öffnen und offene GitLab-To-dos im gemeinsamen Posteingang sehen.",
    permissions: [
      "Lesender API-Zugriff mit einem eigenen Token mit read_api.",
      "Keine Commits, Issue-Änderungen oder Uploads durch diesen Connector.",
    ],
    flow: "Der lokale Connector liest deine offenen To-dos von GitLab. Ausgewählte Hinweise können als KI-Wissen dienen.",
    storage:
      "Token bleibt in der laufenden lokalen Sitzung; übernommene Hinweise und Projektlinks bleiben lokal.",
    setup:
      "GitLab-Connector einrichten. Für Browser-Anmeldungen ein eigenes Login in Context Browser verwenden.",
    limitation:
      "Der Connector ist vorbereitet; ein Browser-Login allein aktiviert ihn nicht. Er importiert keine kompletten Repositories.",
    action: connection("gitlab"),
    actionLabel: "Connector einrichten",
    secondary: website("https://git.coco.study/", "GitLab öffnen"),
  },
  {
    id: "mail",
    name: "TH-Mail",
    short: "EM",
    color: "peach",
    group: "daily",
    version: "1.0.0",
    license: "MIT",
    mode: "mail",
    source: "webmail",
    description:
      "Ein eigener Posteingang direkt am TH-Mailserver: lesen, suchen, antworten, Anhänge öffnen und senden.",
    permissions: [
      "Postfach und Anhänge über IMAP lesen; Lesen öffnet Nachrichten ohne Änderung des Lesestatus.",
      "Expliziter Versand über SMTP und explizite Änderung des Lesestatus.",
    ],
    flow: "Der lokale Server spricht verschlüsselt mit den TH-Mailservern. Mailtexte werden nicht automatisch an die KI weitergegeben.",
    storage:
      "Passwort bleibt im lokalen Server-Arbeitsspeicher. Mailansicht und Entwürfe bleiben in der laufenden Sitzung; keine vollständige Offline-Mailkopie.",
    setup:
      "TH-Mail öffnen, campusID, TH-Mailadresse und Passwort ausschließlich dort eingeben.",
    limitation:
      "Nach einem Server-Neustart erneut verbinden. Das bestehende Webmail-Cookie ersetzt die IMAP-/SMTP-Anmeldung nicht.",
    action: view("mail"),
    actionLabel: "TH-Mail öffnen",
  },
  {
    id: "sciebo",
    name: "Sciebo",
    short: "SC",
    color: "green",
    group: "daily",
    version: "1.0.0",
    license: "MIT",
    mode: "website",
    description:
      "Den TH-Dateispeicher im gemeinsamen Browserprofil öffnen und Ordnerlinks einem Projekt zuordnen.",
    permissions: [
      "Regulärer Website-Zugriff mit deiner Sciebo-Anmeldung.",
      "Kein automatischer Dateiabruf oder Upload durch ein Sciebo-API-Plugin.",
    ],
    flow: "Die Website verbindet sich direkt mit Sciebo und erhält ihre regulären Sitzungsdaten.",
    storage:
      "Projektlinks lokal; Website-Speicher im gemeinsamen Context-Browserprofil. Unterstützte Sitzungscookies werden verschlüsselt gesichert.",
    setup:
      "Sciebo in Context Browser öffnen und dort anmelden. Bei Bedarf den Ordnerlink im Projekt ergänzen.",
    limitation:
      "Browser-Einstieg vorhanden; automatischer Datei-Sync und eine Sciebo-API-Anbindung sind noch offen.",
    action: website("https://th-koeln.sciebo.de/", "Sciebo öffnen"),
    actionLabel: "Sciebo öffnen",
    secondary: view("projects"),
    secondaryLabel: "Ordnerlink zuordnen",
  },
  {
    id: "kiconnect",
    name: "KI:connect NRW",
    short: "KI",
    color: "violet",
    group: "planning",
    version: "1.0.0",
    license: "MIT",
    mode: "ai",
    description:
      "Der Context-Assistent nutzt die Hochschul-KI mit Kurswissen, Quellen und sichtbaren Arbeitsschritten.",
    permissions: [
      "Dein Auftrag, ausgewählte Wissensauszüge und begrenzter Gesprächskontext werden an KI:connect gesendet.",
      "Lokale Notiz-, Aufgaben- und Kalenderaktionen nach den im Assistenten gewählten Einstellungen.",
    ],
    flow: "Der lokale Adapter sendet nur ausgewählte Texte an chat.kiconnect.nrw. Browser-Cookies werden nicht an die KI übertragen.",
    storage:
      "API-Schlüssel nur im Arbeitsspeicher. Assistenten-Chats mit Quellen und Schritten lokal verschlüsselt; lesbarer Backup-Export auf Wunsch.",
    setup:
      "Assistent öffnen, Anbieter KI:connect NRW wählen und eigenen API-Schlüssel verbinden; danach ein Modell auswählen.",
    limitation:
      "Eine Antwort hängt vom Anbieter und ausgewählten Quellen ab. Der Assistent kennt keine ungeöffneten oder nicht importierten Inhalte automatisch.",
    action: view("ai"),
    actionLabel: "KI:connect einrichten",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    short: "OR",
    color: "blue",
    group: "planning",
    version: "1.0.0",
    license: "MIT",
    mode: "ai",
    description:
      "Den gleichen Assistenten und Begleiter mit einem eigenen OpenRouter-Schlüssel und wählbarem Textmodell verwenden.",
    permissions: [
      "Ausgewählte Texte gehen an OpenRouter und den ausgewählten Modellanbieter.",
      "Lokale Aktionen und Browser-Lesen folgen denselben Assistenten-Einstellungen.",
    ],
    flow: "Context fordert Anbieter ohne Datensammlung und mit Zero Data Retention an. Fehlt ein passender Endpunkt, erscheint ein Fehler.",
    storage:
      "API-Schlüssel nur im Arbeitsspeicher; Chatverlauf, Quellen und Schritte lokal verschlüsselt. Die Anfragen selbst werden extern verarbeitet.",
    setup:
      "Assistent öffnen, im Anbieterfeld OpenRouter wählen, eigenen API-Schlüssel verbinden und Textmodell auswählen.",
    limitation:
      "Eigener Schlüssel und gegebenenfalls Guthaben erforderlich. Ein ChatGPT-Abonnement oder eine dortige Plugin-Verbindung wird nicht übernommen.",
    action: view("ai"),
    actionLabel: "OpenRouter einrichten",
  },
  {
    id: "outlook",
    name: "Outlook Kalender",
    short: "OL",
    color: "blue",
    group: "planning",
    version: "1.1.0",
    license: "MIT",
    mode: "calendar",
    provider: "outlook",
    native: "calendar",
    description:
      "Outlook-Termine einlesen und eigene Context-Termine mit einem ausdrücklich ausgewählten Outlook-Kalender abgleichen.",
    permissions: [
      "Calendars.ReadBasic zum Einlesen freigegebener Kalender.",
      "Bei ausdrücklich aktivierter Synchronisierung: Calendars.ReadWrite für eigene Context-Termine im ausgewählten eigenen Kalender.",
    ],
    flow: "Anmeldung im Systembrowser mit Microsoft OAuth; anschließend spricht die Mac-App direkt mit Microsoft Graph.",
    storage:
      "OAuth-Zugriffstoken nur im Arbeitsspeicher. Termine und Zuordnungen des Abgleichs lokal; kein Token in Workspace- oder Chatbackups.",
    setup:
      "Kalenderkonten öffnen. Eine registrierte eigene OAuth-App-ID eintragen, Microsoft-Anmeldung abschließen und den Zielkalender ausdrücklich wählen.",
    limitation:
      "Die OAuth-App-Registrierung ist weiterhin erforderlich. Kein vorausregistrierter ChatGPT-Connector. Fremde Änderungen werden als Konflikt gezeigt, nicht still überschrieben; keine Remote-Löschung.",
    action: view("calendar", "connections"),
    actionLabel: "Outlook verbinden",
  },
  {
    id: "google",
    name: "Google Kalender & Drive",
    short: "GO",
    color: "green",
    group: "planning",
    version: "1.0.0",
    license: "MIT",
    mode: "calendar",
    provider: "google",
    native: "calendar",
    description:
      "Freigegebene Kalender lesend einlesen und ausgewählte Terminplan-Dateien aus Google Drive übernehmen.",
    permissions: [
      "Lesender Google-Kalenderzugriff.",
      "Optional lesender Google-Drive-Zugriff; Inhalt nur für die von dir ausgewählte unterstützte Datei abrufen.",
    ],
    flow: "Google OAuth im Systembrowser; Abruf direkt von Google durch die Mac-App. Der Terminplan-Import selbst läuft lokal.",
    storage:
      "OAuth-Zugriffstoken nur im Arbeitsspeicher. Bestätigte Importtermine und Quellen lokal im Workspace.",
    setup:
      "Kalenderkonten öffnen, eigene registrierte Desktop-OAuth-App verbinden und optional Drive freigeben.",
    limitation:
      "Eigene OAuth-App-ID und gegebenenfalls Desktop-Client-Secret erforderlich. Google ist derzeit lesend angebunden; keine automatische Schreibsynchronisierung.",
    action: view("calendar", "connections"),
    actionLabel: "Google verbinden",
  },
  {
    id: "calendar-import",
    name: "Terminplan-Import",
    short: "IC",
    color: "peach",
    group: "planning",
    version: "1.0.0",
    license: "MIT",
    mode: "local",
    description:
      "ICS, CSV, Text oder einen vorhandenen Spaces-Stand prüfen und ausgewählte Termine in Context übernehmen.",
    permissions: [
      "Nur die von dir ausgewählte Datei beziehungsweise gespeicherte oder explizit gelesene Spaces-Quelle lesen.",
      "Erst nach Importprüfung lokal speichern; ICS-Dateien lokal exportieren.",
    ],
    flow: "Die Parser arbeiten lokal. Der Dateimport sendet keine Dateien an eine KI oder einen Kalenderanbieter.",
    storage:
      "Übernommene Termine mit ihrer Quelle im lokalen Workspace und dessen Backup.",
    setup:
      "Importer öffnen, Datei oder Text wählen, Kurs zuordnen und die erkannten Termine prüfen.",
    limitation:
      "Unklare Datumsangaben und Serien brauchen eine Prüfung. Ein ICS-Export allein hält spätere Änderungen nicht mit Outlook synchron.",
    action: view("calendar", "import"),
    actionLabel: "Terminplan importieren",
  },
  {
    id: "calendar-photo",
    name: "Terminplan-Foto mit KI",
    short: "FT",
    color: "violet",
    group: "planning",
    version: "1.0.0",
    license: "MIT",
    mode: "photo",
    native: "ocr",
    description:
      "Ein Terminplan-Foto lokal auf dem Mac lesen und den Assistenten daraus belegte Termine und eine ICS-Datei erstellen lassen.",
    permissions: [
      "Nur das von dir gewählte PNG-/JPEG-Foto im Arbeitsspeicher lesen.",
      "Erkannten Text mit deinem Auftrag an den gewählten KI-Anbieter senden; Termine gemäß Assistenten-Einstellung lokal übernehmen.",
    ],
    flow: "Apple Vision erkennt den Text auf dem Mac. Das Foto wird nicht hochgeladen; der überprüfbare OCR-Text wird als Quelle verwendet.",
    storage:
      "Das Bild wird nicht archiviert. Erkannten Text und Arbeitsschritte speichert das lokale verschlüsselte Chatarchiv.",
    setup:
      "Assistent im gewünschten Kurs öffnen, Terminplan-Foto anhängen, erkannten Text prüfen und den Auftrag absenden.",
    limitation:
      "Erfordert die aktuelle Context-Mac-App und eine eingerichtete KI. Fehlende Jahreszahlen oder unlesbare Zeiten dürfen nicht geraten werden.",
    action: view("ai"),
    actionLabel: "Foto im Assistenten öffnen",
  },
  {
    id: "obsidian",
    name: "Obsidian & Markdown",
    short: "MD",
    color: "violet",
    group: "files",
    version: "1.0.1",
    license: "MIT",
    mode: "local",
    importer: "obsidian",
    description:
      "Einzelne oder mehrere Markdown-Dateien als Notizen mit einfachen Wiki-Links importieren und wieder exportieren.",
    permissions: [
      "Nur von dir ausgewählte .md-, .markdown- oder .txt-Dateien lesen.",
      "Nach geprüfter Vorschau lokale Notizen anlegen.",
    ],
    flow: "Dateiimport und Markdown-Vorschau laufen lokal, ohne Dateiupload. Wenn du Notizen als KI-Wissen auswählst, können Textauszüge an den KI-Anbieter gehen.",
    storage:
      "Notiztexte und Dateinamen als Titel im lokalen Workspace. Originaldateien im Vault werden nicht geändert.",
    setup:
      "Markdown-Dateien auswählen, Vorschau prüfen und Notizen importieren.",
    limitation:
      "Dateiimport statt Obsidian-Vault-Sync. Keine Bilder, Anhänge, Dataview oder fremden Obsidian-Plugins.",
    action: importer("obsidian"),
    actionLabel: "Markdown importieren",
    secondary: view("notes"),
    secondaryLabel: "Notizen öffnen",
  },
  {
    id: "github-submissions",
    name: "GitHub-Abgaben",
    short: "GH",
    color: "peach",
    group: "files",
    version: "1.0.0",
    license: "MIT",
    mode: "local",
    description:
      "Dateien und Dokumentation zu einem lokalen Abgabe-ZIP mit Prüfsummen bündeln und dein Repository öffnen.",
    permissions: [
      "Von dir ausgewählte Abgabedateien lesen und ein lokales ZIP erstellen.",
      "Repository-Link öffnen; kein automatischer Upload oder Commit.",
    ],
    flow: "Das Paket wird vollständig lokal erzeugt. Erst dein separater Upload auf GitHub überträgt die Dateien.",
    storage:
      "ZIP an deinem gewählten Downloadort. Abgabedateien werden nicht als vollständige Kopie im Workspace gespeichert.",
    setup:
      "Abgabebereich öffnen, Dateien und Dokumentation wählen, Paket erstellen und im Repository hochladen.",
    limitation:
      "Die GitHub-API zum direkten Hochladen ist noch nicht eingerichtet. Die Dateiprüfung erkennt nur bestimmte Zugangsdatenmuster.",
    action: view("submissions"),
    actionLabel: "Abgabe vorbereiten",
  },
  {
    id: "bookmarks",
    name: "Browser-Lesezeichen",
    short: "BM",
    color: "green",
    group: "files",
    version: "1.0.0",
    license: "MIT",
    mode: "local",
    importer: "bookmarks",
    description:
      "Lesezeichen aus einem HTML-Export von Safari, Chrome, Brave oder Firefox im Hub sammeln.",
    permissions: [
      "Nur die gewählte HTML-Exportdatei lesen.",
      "Geprüfte HTTPS-Links lokal speichern; eingebetteten HTML-Code nicht ausführen.",
    ],
    flow: "HTML wird lokal als Daten geparst. Das Importieren öffnet die gespeicherten Websites nicht.",
    storage: "Titel und HTTPS-Adressen im lokalen Workspace und dessen Backup.",
    setup:
      "Lesezeichen im Browser als HTML exportieren und die Datei hier importieren.",
    limitation: "Kein laufender Abgleich mit dem ursprünglichen Browserprofil.",
    action: importer("bookmarks"),
    actionLabel: "Lesezeichen importieren",
  },
  {
    id: "projects",
    name: "GitHub-/GitLab-Projektliste",
    short: "RE",
    color: "peach",
    group: "files",
    version: "1.0.0",
    license: "MIT",
    mode: "local",
    importer: "projects",
    description:
      "Eine exportierte JSON-Projektliste aus der GitHub- oder GitLab-API als verknüpfte Projektkontexte übernehmen.",
    permissions: [
      "Nur die gewählte JSON-Datei lesen.",
      "Nach Vorschau lokale Projekte und Repository-Links anlegen.",
    ],
    flow: "Der JSON-Import läuft lokal; er ruft die API nicht selbst ab und benötigt keinen Repository-Token.",
    storage:
      "Projektname, Beschreibung und Repository-Link im lokalen Workspace.",
    setup:
      "Projektliste als JSON wählen, Vorschau prüfen und den Import bestätigen.",
    limitation:
      "Repository-Metadaten statt Code-Clone, Issue-Sync oder GitHub-/GitLab-Kontoanmeldung.",
    action: importer("projects"),
    actionLabel: "Projektliste importieren",
  },
  {
    id: "context",
    name: "Context-Backup",
    short: "CX",
    color: "blue",
    group: "files",
    version: "1.0.0",
    license: "MIT",
    mode: "local",
    importer: "context",
    description:
      "Ein vorhandenes Workspace-Backup prüfen und Projekte, Aufgaben, Termine, Notizen und Links übernehmen.",
    permissions: [
      "Nur die gewählte JSON-Backup-Datei lesen.",
      "Nach geprüfter Vorschau den lokalen Workspace durch dessen Daten ersetzen.",
    ],
    flow: "Import und Prüfung erfolgen lokal. Dieser Workspace-Import verbindet keine externen Konten.",
    storage:
      "Übernommene Inhalte im aktuellen Browserprofil. Assistenten-Chats haben einen separaten Backup-Ablauf im Assistenten.",
    setup:
      "Backup wählen, Vorschau prüfen und bei Bedarf vorher den aktuellen Workspace exportieren.",
    limitation:
      "Enthält keine Passwörter, Browser-Cookies oder OAuth-Tokens. Automatischer Outlook-Abgleich wird beim Backup-Import ausgeschaltet.",
    action: importer("context"),
    actionLabel: "Workspace importieren",
  },
]);

const available = (native, feature) =>
  native?.[feature] === true || typeof native?.[feature] === "function";
const status = (code, label, detail) => ({ code, label, detail });

function connectionStatus(plugin, context) {
  const account =
    context.accountStates?.[plugin.id] ||
    (plugin.mode === "calendar"
      ? context.accountStates?.calendar?.[plugin.provider]
      : null);
  if (plugin.native && !available(context.native, plugin.native))
    return status(
      "desktop",
      "Mac-App erforderlich",
      "Die Funktion ist im aktuellen Context Browser verfügbar; eine normale Webansicht kann diesen nativen Zugriff nicht übernehmen.",
    );
  if (plugin.mode === "local")
    return status(
      "ready",
      "Direkt verfügbar",
      "Die lokale Funktion ist enthalten. Ein Klick öffnet ihren vorhandenen Ablauf; externe Konten werden dadurch nicht verbunden.",
    );
  if (plugin.mode === "photo")
    return status(
      "ready",
      "Lokale Texterkennung bereit",
      "Fotoauswahl im Assistenten; die KI-Verbindung wird dort separat geprüft.",
    );
  if (plugin.mode === "website")
    return status(
      "browser",
      available(context.native, "browser")
        ? "Im Context Browser verfügbar"
        : "Website-Einstieg verfügbar",
      "Der Anmeldestatus wird beim Anbieter geprüft. Ein gespeicherter Link ist kein Nachweis einer Anmeldung.",
    );
  if (plugin.mode === "calendar") {
    if (account?.connected === true)
      return status(
        "connected",
        plugin.provider === "outlook" && account.syncEnabled === true
          ? "Verbunden · Abgleich freigegeben"
          : "Verbunden · nur lesen",
        plugin.provider === "outlook" && account.syncEnabled === true
          ? "Ein Zielkalender und automatischer Abgleich werden im Kalender gesondert ausgewählt."
          : "Freigegebene Termine können zunächst geprüft und lokal importiert werden.",
      );
    if (account?.configured === true)
      return status(
        "setup",
        "Anmeldung ausstehend",
        "Eine App-Konfiguration ist vorhanden; ein erfolgreicher OAuth-Abschluss wurde noch nicht bestätigt.",
      );
    return status(
      "setup",
      "OAuth-Einrichtung erforderlich",
      "Eigene registrierte OAuth-App und Zustimmung des Kontoinhabers erforderlich. Der Katalog meldet keine Verbindung ohne bestätigten Anbieterstatus.",
    );
  }
  if (plugin.mode === "ai") {
    if (account?.configured === true)
      return status(
        "connected",
        "API-Verbindung eingerichtet",
        "Das Modell und die aktuelle Erreichbarkeit werden beim Öffnen des Assistenten geprüft.",
      );
    return status(
      "check",
      "Status im Assistenten prüfen",
      "Anbieter und Modell auswählen; der API-Zugang wird dort geprüft. Der Katalog erhält keine Schlüssel oder Chattexte.",
    );
  }
  if (plugin.mode === "mail" && account?.configured === true)
    return status(
      "connected",
      "Mailkonto verbunden",
      "Die konkrete Erreichbarkeit des Mailservers und Versandbereitschaft zeigt der Posteingang.",
    );
  const source = Array.isArray(context.sourceStates)
    ? context.sourceStates.find((s) => s?.source === plugin.source)
    : null;
  if (plugin.mode === "mail")
    return source?.status === "connected"
      ? status(
          "connected",
          "Mailzugang verbunden",
          "Die aktuelle Postfach- und SMTP-Verbindung zeigt der TH-Mailbereich.",
        )
      : status(
          "check",
          "Status im Postfach prüfen",
          "TH-Mail öffnen und den direkten Mailserver-Zugang prüfen oder einrichten.",
        );
  if (source?.status === "connected")
    return status(
      "connected",
      "Connector verbunden · nur lesen",
      "Dieser Status bestätigt den lesenden Connector, nicht automatisch die Website-Anmeldung.",
    );
  if (source?.status === "snapshot")
    return status(
      "snapshot",
      "Gespeicherter Browser-Stand",
      "Lokale Auszüge vorhanden. Es wurde kein laufender API-Abgleich bestätigt.",
    );
  if (source?.status === "login_required")
    return status(
      "setup",
      "Erneut anmelden",
      "Der vorhandene Zugriff muss beim Dienst erneuert werden.",
    );
  if (source?.status === "error")
    return status(
      "error",
      "Abruf fehlgeschlagen",
      "Die Einrichtung öffnen und den Fehler dort prüfen. Rohfehler oder Zugangsdaten werden im Katalog nicht angezeigt.",
    );
  if (plugin.mode === "browser")
    return status(
      "browser",
      available(context.native, "agent")
        ? "Browser-Werkzeuge verfügbar"
        : "Kurslinks verfügbar",
      "Spaces-Login beim Öffnen prüfen. Gespeicherte Kurslinks allein bestätigen keinen Zugriff auf Kursinhalte.",
    );
  return status(
    "setup",
    "Zugang einrichten",
    "Der lokale Connector ist enthalten; ein erfolgreicher Kontoabruf wurde noch nicht bestätigt.",
  );
}

export function pluginsForContext(context = {}) {
  return PLUGIN_CATALOG.map((plugin) => ({
    ...plugin,
    status: connectionStatus(plugin, context),
  }));
}

function renderAction(action, label, primary = false, pluginName = "") {
  const cls = primary ? "button secondary" : "text-link";
  const attrs = `class="${cls}" aria-label="${esc(label)}${pluginName ? " · " + esc(pluginName) : ""}"`;
  if (action.type === "website")
    return `<a ${attrs} href="${esc(action.url)}" target="_blank" rel="noopener noreferrer" data-open="${esc(action.label)}">${esc(label)} ↗</a>`;
  if (action.type === "view")
    return `<button type="button" ${attrs} data-view="${esc(action.id)}"${action.calendar ? ` data-calendar="${esc(action.calendar)}"` : ""}>${esc(label)} ↗</button>`;
  return `<button type="button" ${attrs} data-action="${action.type === "import" ? "start-import" : "connection-help"}" data-id="${esc(action.id)}">${esc(label)} ↗</button>`;
}

function card(plugin) {
  const id = "plugin-" + plugin.id;
  return `<article class="plugin-card ${brandClass(plugin.id)}" aria-labelledby="${id}"><div class="tool-card-top">${brandLogo(plugin.id,{color:plugin.color,fallback:plugin.short})}<span class="tag">Enthalten · ${plugin.version}</span></div><span class="small-label">${esc(plugin.status.label)}</span><h2 id="${id}">${esc(plugin.name)}</h2><p>${esc(plugin.description)}</p><p class="subtle-note">${esc(plugin.status.detail)}</p><details><summary>Zugriff, Datenschutz und Einrichtung</summary><dl><dt><strong>Erlaubter Zugriff</strong></dt><dd><ul>${plugin.permissions.map((p) => `<li>${esc(p)}</li>`).join("")}</ul></dd><dt><strong>Datenfluss</strong></dt><dd>${esc(plugin.flow)}</dd><dt><strong>Lokal gespeichert</strong></dt><dd>${esc(plugin.storage)}</dd><dt><strong>Einrichten</strong></dt><dd>${esc(plugin.setup)}</dd><dt><strong>Aktueller Umfang</strong></dt><dd>${esc(plugin.limitation)}</dd><dt><strong>Lizenz des Context-Moduls</strong></dt><dd>${plugin.license} · Die verbundenen Dienste haben ihre eigenen Bedingungen.</dd></dl></details><div class="plugin-card-footer">${plugin.secondary ? renderAction(plugin.secondary, plugin.secondaryLabel || plugin.secondary.label, false, plugin.name) : `<span>Lokales Context-Modul · ${plugin.license}</span>`}${renderAction(plugin.action, plugin.actionLabel, true, plugin.name)}</div></article>`;
}

export function renderPluginCatalog(context = {}) {
  const plugins = pluginsForContext(context),
    workspace = context.workspace || {};
  const current = Array.isArray(workspace.projects)
    ? workspace.projects.find(
        (p) => p?.id === workspace.activeCourse && !p.archived,
      )
    : null;
  const scope = current
    ? `Aktueller Kurs: ${String(current.name || "Kurs").slice(0, 200)}. Im Assistenten und Importer kannst du prüfen, welchem Kurs Inhalte zugeordnet werden.`
    : "Alle Kurse. Wähle bei Importen und im Assistenten den passenden Kurs; Konto-Verbindungen gelten für deinen Arbeitsbereich.";
  return `<div class="page-heading"><div><p class="eyebrow">FERTIGE HELFER FÜR DEINEN KONTEXT</p><h1>Deine Plugin-Bibliothek.</h1><p class="page-description">Öffne einen enthaltenen Ablauf und verbinde bei Bedarf dein eigenes Konto.</p></div></div><section class="marketplace-hero" aria-label="Enthaltene Plugins"><div><span class="small-label">OFFENE GRUNDLAGE · MIT</span><h2>Ein Einstieg. Klarer Zugriff.</h2><p>${plugins.length} lokale Module für Kurse, Assistent, Kalender, Import und Abgaben. Konto-Anmeldungen und Datenfreigaben werden im jeweiligen Dienst geprüft.</p><p class="subtle-note">${esc(scope)}</p></div><span class="marketplace-number">${String(plugins.length).padStart(2, "0")}<small>enthaltene Module</small></span></section><div class="local-import-note"><span aria-hidden="true">↗</span><div><strong>Ein Klick öffnet die Einrichtung.</strong><p>Für Dateiimporte brauchst du kein zusätzliches Konto. Outlook und Google benötigen weiterhin eine registrierte OAuth-App. Vorhandene ChatGPT-Verbindungen werden nicht mit übernommen. Ein Status wird erst nach einer bestätigten Verbindung als verbunden angezeigt.</p></div></div>${PLUGIN_GROUPS.map(
    (group) =>
      `<section class="section-space" aria-labelledby="plugins-${group.id}"><div class="section-title"><div><h2 id="plugins-${group.id}">${group.title}</h2><p class="subtle-note">${group.description}</p></div></div><div class="plugins-grid">${plugins
        .filter((p) => p.group === group.id)
        .map(card)
        .join("")}</div></section>`,
  ).join(
    "",
  )}<p class="subtle-note section-space">Dieser Katalog lädt ausschließlich mitgelieferte Context-Funktionen. Es gibt noch keinen öffentlichen Marketplace für fremden Plugin-Code. Klicks führen zu vorhandenen Abläufen; sie installieren keine Scripts und erteilen keinen zusätzlichen Kontozugriff.</p><input id="plugin-files" type="file" multiple hidden>`;
}
