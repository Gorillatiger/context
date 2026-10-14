import {calendarDayLayout,calendarDayWindow} from './calendar-day.js';
import {brandLogo,brandClass} from './brand-logos.js';
import { dateKey, notificationCourse } from "./core.js";
import { readConnectedCalendarEvents, reconcileCalendarEvents } from "./calendar-refresh.js";
import { calendarRefreshRange, createCalendarAutoRefresh } from "./calendar-auto-refresh.js";
import {
  validateCalendarEvents,
  validateCalendarEvent,
  importICS,
  exportICS,
  proposeCalendarEvents,
  taskEvents,
  berlinLocalToInstant,
} from "./calendar-engine.js";
import { agentBrowserAvailable, requestAgentBrowser } from "./agent-browser.js";
import {
  validateCalendarSync,
  createCalendarSynchronizer,
  writableOutlookCalendars,
  filterSelfSyncedEvents,
} from "./calendar-sync.js";

const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const kinds = {
  local: "Context",
  spaces: "Spaces",
  drive: "Google Drive",
  outlook: "Outlook",
  google: "Google Kalender",
  ics: "Kalenderdatei",
  photo: "Terminplan-Foto",
};
const addDay = (day, amount) =>
  new Date(Date.parse(day + "T12:00:00Z") + amount * 86400000)
    .toISOString()
    .slice(0, 10);
const boundaries = new Map();
const monthLabel = (month) =>
  new Intl.DateTimeFormat("de-DE", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(month + "-01T12:00:00Z"));
const dayLabel = (day) =>
  new Intl.DateTimeFormat("de-DE", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(day + "T12:00:00Z"));
const localInput = (instant) => {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instant));
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
};
export function monthCells(month) {
  if (
    !/^\d{4}-\d{2}$/.test(month) ||
    Number(month.slice(5)) < 1 ||
    Number(month.slice(5)) > 12
  )
    throw new Error("Ungültiger Kalendermonat.");
  const first = month + "-01",
    weekday = (new Date(first + "T12:00:00Z").getUTCDay() + 6) % 7;
  return Array.from({ length: 42 }, (_, i) => addDay(first, i - weekday));
}
export function eventOnDay(event, day) {
  if (event.allDay) return event.start <= day && event.end > day;
  // Compare actual instants with Berlin day boundaries, including midnight endings and DST.
  if (!boundaries.has(day)) {
    if (boundaries.size > 400) boundaries.clear();
    boundaries.set(day, [
      berlinLocalToInstant(day, "00:00"),
      berlinLocalToInstant(addDay(day, 1), "00:00"),
    ]);
  }
  const [start, end] = boundaries.get(day);
  return event.start < end && event.end > start;
}
export function mergeCalendarEvents(previous, incoming, options = {}) {
  const next = validateCalendarEvents(previous, options);
  for (const event of validateCalendarEvents(incoming, options)) {
    const index = next.findIndex((e) => e.id === event.id);
    if (index >= 0)
      next[index] = {
        ...event,
        projectId: event.projectId || next[index].projectId,
      };
    else next.push(event);
  }
  return validateCalendarEvents(next, options);
}
export function calendarEventFromForm(draft, fields, workspace) {
  if (!draft) throw new Error("Öffne den Termin erneut.");
  const options = { projectIds: workspace.projects.map((p) => p.id) };
  if (["google", "outlook"].includes(draft.source?.kind)) {
    const original = (workspace.calendarEvents || []).find(
      (e) => e.id === draft.id,
    );
    if (!original) throw new Error("Dieser Termin ist nicht mehr gespeichert.");
    // Changing a course must retain the provider's exact instant, including DST offsets and fractions.
    return validateCalendarEvent(
      { ...original, projectId: fields.projectId },
      options,
    );
  }
  const allDay = draft.allDay,
    toInstant = (value) =>
      berlinLocalToInstant(String(value).slice(0, 10), String(value).slice(11));
  return validateCalendarEvent(
    {
      ...draft,
      id: draft.id || crypto.randomUUID(),
      title: fields.title,
      projectId: fields.projectId,
      allDay,
      start: allDay ? fields.start : toInstant(fields.start),
      end: allDay ? addDay(fields.end, 1) : toInstant(fields.end),
      timeZone: "Europe/Berlin",
      source: draft.source || {
        kind: "local",
        title: "Eigener Termin",
        url: "",
        excerpt: "",
        externalId: "",
      },
    },
    options,
  );
}
function eventWhen(event) {
  if (event.allDay)
    return event.end === addDay(event.start, 1)
      ? dayLabel(event.start) + " · Ganztägig"
      : dayLabel(event.start) +
          " – " +
          dayLabel(addDay(event.end, -1)) +
          " · Ganztägig";
  const format = new Intl.DateTimeFormat("de-DE", {
    timeZone: "Europe/Berlin",
    dateStyle: "short",
    timeStyle: "short",
  });
  return (
    format.format(new Date(event.start)) +
    " – " +
    format.format(new Date(event.end)) +
    " · Berlin"
  );
}
function download(text, name) {
  const url = URL.createObjectURL(
    new Blob([text], { type: "text/calendar;charset=utf-8" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function calendarRequest(action, { provider, body, signal } = {}) {
  if (typeof window.contextDesktop?.calendar !== "function")
    throw new Error(
      "Die Kontenanbindung benötigt die Context-Desktop-App. Lokaler Kalender und Dateiimport funktionieren auch hier.",
    );
  if (signal?.aborted) throw new DOMException("Abgebrochen", "AbortError");
  const id = crypto.randomUUID(),
    cancel = () => {
      void Promise.resolve(window.contextDesktop.calendar({ action: "cancel", id })).catch(() => {});
    };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    const result = await window.contextDesktop.calendar({
      action,
      ...(provider ? { provider } : {}),
      ...(body ? { body } : {}),
      ...([
        "connect",
        "calendars",
        "events",
        "driveFiles",
        "driveText",
        "sync",
      ].includes(action)
        ? { id }
        : {}),
    });
    if (signal?.aborted && action !== "sync")
      throw new DOMException("Abgebrochen", "AbortError");
    if (!result?.ok)
      throw new Error(
        result?.error || "Die Kalenderverbindung ist nicht erreichbar.",
      );
    return result.value;
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

export function createCalendarView({
  getContext,
  onChange,
  onSave,
  onShow,
  onTask,
  onNotice = () => {},
  onSyncSave = () => false,
  onAsk = () => {},
}) {
  let month = dateKey().slice(0, 7),
    selected = dateKey(),
    mode = "month",
    focusedEvent = "",
    error = "",
    notice = "",
    busy = "",
    loaded = false,
    connections = {},
    calendars = { google: [], outlook: [] },
    choices = { google: "", outlook: "" },
    files = [],
    proposals = [],
    warnings = [],
    checked = new Set(),
    panel = "",
    draft = null;
  let importDraft = {
      text: "",
      url: "",
      title: "Terminplan",
      kind: "spaces",
      projectId: "",
    },
    configs = {
      google: { clientId: "", clientSecret: "", driveEnabled: true },
      outlook: { clientId: "", tenant: "common", syncEnabled: false },
    };
  let abort;
  const editedConfigs = new Set();
  function applyConnections(next) {
    connections = next;
    for (const provider of ["outlook", "google"]) {
      if (!next[provider]?.configured || editedConfigs.has(provider)) continue;
      configs[provider].clientId = next[provider].clientId || "";
      if (provider === "outlook") {
        configs.outlook.tenant = next.outlook.tenant || "common";
        configs.outlook.syncEnabled = next.outlook.syncEnabled === true;
      }
    }
  }
  const api = (action, options = {}) =>
    calendarRequest(action, { ...options, signal: options.signal ?? abort?.signal });
  const context = () => getContext();
  const syncSettings = () =>
    validateCalendarSync(context().workspace.calendarSync);
  const synchronizer = createCalendarSynchronizer({
    getWorkspace: () => context().workspace,
    saveSettings: onSyncSave,
    request: calendarRequest,
    onProgress: ({ completed, total }) => {
      notice = `Outlook wird abgeglichen: ${completed} von ${total} Terminen geprüft.`;
      change();
    },
  });
  let lastRefresh = "", refreshWarnings = [], disposed = false, refreshAbort, loadAbort, workspaceEpoch = 0;
  const autoRefresh = createCalendarAutoRefresh({
    refresh: () => synchronizeNow({ automatic: true }),
    isVisible: () => document.visibilityState === "visible",
  });
  let syncTimer;
  function queueAutomatic(delay = 1000) {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      if (
        document.visibilityState === "visible" &&
        !busy &&
        syncSettings().automatic &&
        !synchronizer.isPaused()
      )
        void runSync(false);
    }, delay);
  }
  const automaticClock = setInterval(() => queueAutomatic(1), 120000);
  const visibilityHandler = () => {
    if (document.visibilityState === "visible") { queueAutomatic(); void autoRefresh.resume(); }
  };
  document.addEventListener("visibilitychange", visibilityHandler);
  async function runSync(manual = true) {
    if (disposed || busy || synchronizer.isBusy()) return;
    busy = "sync";
    error = "";
    notice = "";
    if (manual) synchronizer.resume();
    change();
    try {
      const result = await synchronizer.run({ manual });
      if (!result.skipped)
        notice = `${result.cancelled ? "Abgleich angehalten. " : ""}${result.synced} Termine in Outlook bestätigt; ${result.failed} benötigen Prüfung.${result.pending ? ` ${result.pending} weitere Termine bleiben offen.` : ""} Bereits bestätigte Änderungen bleiben erhalten.`;
    } catch (e) {
      error =
        e.name === "AbortError"
          ? "Abgleich angehalten. Outlook kann bereits Termine enthalten. Prüfe das Protokoll und starte einen manuellen Abgleich."
          : e.message;
    } finally {
      busy = "";
      change();
    }
  }
  async function synchronizeNow({ automatic = false } = {}) {
    if (disposed || !window.contextDesktop?.calendar) return {};
    if (busy || synchronizer.isBusy()) return { skipped: true };
    const controller = new AbortController(), version = ++connectionLoadVersion,
      epoch = workspaceEpoch, namespace = syncSettings().namespace;
    loadAbort?.abort(); refreshAbort = controller; abort = controller; loaded = true;
    busy = "refresh"; error = ""; notice = ""; refreshWarnings = [];
    const assertCurrent = () => {
      if (disposed || controller.signal.aborted || version !== connectionLoadVersion ||
          epoch !== workspaceEpoch || namespace !== syncSettings().namespace)
        throw new DOMException("Verbindung oder Arbeitsbereich geändert", "AbortError");
    };
    change();
    let outcome = {}, refreshed = false;
    try {
      const before = await api("status", { signal: controller.signal });
      assertCurrent(); applyConnections(before);
      const linked = ["outlook", "google"].filter(provider => before[provider]?.connected);
      if (!linked.length) {
        if (!automatic) { panel = "connections"; notice = "Verbinde zuerst einen Kalender."; }
        return {};
      }
      const range = calendarRefreshRange(month, { automatic });
      const result = await readConnectedCalendarEvents({
        request: api, connections: before, signal: controller.signal, ...range,
        filterEvents: (events, provider, calendarId) => provider === "outlook"
          ? filterSelfSyncedEvents(events, syncSettings(), calendarId) : events,
      });
      assertCurrent();
      // A batch may span several requests. Verify the same authorized accounts
      // still own the results before applying any of them to local state.
      const after = await api("status", { signal: controller.signal });
      assertCurrent();
      for (const provider of linked) {
        const a = before[provider], b = after[provider];
        if (!b?.connected || a.backend !== b.backend ||
            (a.generation !== undefined && a.generation !== b.generation))
          throw new DOMException("Kalenderkonto wurde während des Abgleichs geändert", "AbortError");
      }
      const incoming = result.events.map(event => ({ ...event, projectId: "" }));
      const merged = reconcileCalendarEvents(context().workspace.calendarEvents || [], incoming,
        { projectIds: context().workspace.projects.map(project => project.id) });
      assertCurrent();
      if (merged.changed) write(merged.events, `Kalender: ${merged.added} neu, ${merged.updated} aktualisiert`);
      applyConnections(after);
      for (const provider of result.providers) {
        calendars[provider] = result.calendars[provider];
        if (!calendars[provider].some(calendar => calendar.id === choices[provider]))
          choices[provider] = calendars[provider].find(calendar => calendar.primary)?.id || calendars[provider][0]?.id || "";
      }
      lastRefresh = new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit" }).format(new Date());
      notice = merged.changed ? `${merged.added} neu · ${merged.updated} aktualisiert · ${merged.unchanged} unverändert`
        : "Alle Termine aktuell.";
      refreshWarnings = result.warnings;
      if (refreshWarnings.length) notice = `${merged.added} neu · ${merged.updated} aktualisiert · Abgleich unvollständig`;
      refreshed = true;
    } catch (e) {
      outcome = { failed: e.name !== "AbortError" };
      if (!disposed && version === connectionLoadVersion && epoch === workspaceEpoch)
        error = e.name === "AbortError" ? "Sync angehalten. Vorhandene Termine bleiben erhalten." : e.message;
    } finally {
      if (abort === controller) abort = undefined;
      if (refreshAbort === controller) { refreshAbort = undefined; busy = ""; }
      if (!disposed) change();
    }
    if (!refreshed || disposed || controller.signal.aborted) return outcome;
    const outlook = connections.outlook || {}, settings = syncSettings();
    if ((!automatic || settings.automatic) && settings.target.calendarId &&
        outlook.connected && outlook.syncEnabled && !outlook.readOnly) {
      const readNotice = notice;
      await runSync(!automatic);
      if (!disposed) { notice = readNotice + " " + notice; change(); }
    }
    return outcome;
  }
  function syncOverview() {
    const linked = ["outlook", "google"].filter(provider => connections[provider]?.connected);
    return `<div class="calendar-sync-overview" aria-label="Kalenderstatus"><div><span class="calendar-sync-indicator${linked.length ? " connected" : ""}" aria-hidden="true"></span><strong>${linked.length ? linked.map(provider => provider === "outlook" ? "Outlook" : "Google Kalender").join(" · ") : "Kein Kalender verbunden"}</strong><span>${lastRefresh ? "Zuletzt aktualisiert um " + lastRefresh : linked.length ? "Automatisch beim Start und alle 15 Minuten" : "Konten über Mehr verbinden"}</span></div></div>`;
  }
  function invalidateRefresh() {
    ++workspaceEpoch; ++connectionLoadVersion; refreshAbort?.abort(); loadAbort?.abort();
    if (!disposed) void autoRefresh.refreshSoon();
  }
  const projectName = (id) =>
    context().workspace.projects.find((p) => p.id === id)?.name || "Persönlich";
  const projectOptions = (value) =>
    `<option value="">Persönlich / ohne Kurs</option>${context()
      .workspace.projects.filter((p) => !p.archived || p.id === value)
      .map(
        (p) =>
          `<option value="${esc(p.id)}" ${p.id === value ? "selected" : ""}>${esc(p.name)}</option>`,
      )
      .join("")}`;
  const events = () =>
    [
      ...(context().workspace.calendarEvents || []),
      ...taskEvents(context().workspace),
    ]
      .filter(
        (e) =>
          (!context().workspace.activeCourse ||
            e.projectId === context().workspace.activeCourse) &&
          !context().workspace.projects.find((p) => p.id === e.projectId)
            ?.archived,
      )
      .sort((a, b) => a.start.localeCompare(b.start));
  const change = (focus) => {
    if (disposed) return;
    onChange();
    if (focus) document.getElementById(focus)?.focus({ preventScroll: true });
  };
  function write(next, label) {
    const validated = validateCalendarEvents(next, {
      projectIds: context().workspace.projects.map((p) => p.id),
    });
    if (!onSave(validated, label))
      throw new Error(
        "Die Termine konnten nicht lokal gespeichert werden. Dein vorheriger Kalender bleibt erhalten.",
      );
    queueAutomatic();
  }
  async function perform(label, fn) {
    if (disposed || busy) return;
    busy = label;
    error = "";
    notice = "";
    abort = new AbortController();
    change();
    try {
      await fn();
    } catch (e) {
      error =
        e.name === "AbortError"
          ? "Einlesen abgebrochen. Es wurde nichts übernommen."
          : e.message;
    } finally {
      busy = "";
      abort = undefined;
      change();
    }
  }
  let connectionLoadVersion=0;
  async function load(force=false) {
    if (disposed || (loaded && !force)) return;
    if (force) invalidateRefresh();
    if(force){editedConfigs.clear();calendars.google=[];calendars.outlook=[];choices.google="";choices.outlook="";}
    loaded = true;
    const version=++connectionLoadVersion;
    if (!window.contextDesktop?.calendar) return;
    const controller = new AbortController(); loadAbort = controller;
    try {
      const next=await api("status", {signal:controller.signal});if(version!==connectionLoadVersion)return;applyConnections(next);
      if (connections.outlook?.connected)
        {const next=await api("calendars", { provider: "outlook", signal:controller.signal });if(version!==connectionLoadVersion)return;calendars.outlook=next.calendars;}
    } catch (e) {
      if(version!==connectionLoadVersion || disposed)return;error = e.message;
    } finally { if (loadAbort === controller) loadAbort = undefined; }
    if(version===connectionLoadVersion)change();
  }
  async function showDriveFiles(){
    return perform("drive",async()=>{const result=await api("driveFiles",{provider:"google"});files=result.files;panel="import";notice=(files.length?"Wähle eine Terminplan-Datei.":"Keine unterstützten Dateien gefunden.")+" "+(result.warnings||[]).join(" ");});
  }
  function proposalKey(e) {
    return e.id;
  }
  function review(result) {
    if (abort?.signal.aborted)
      throw new DOMException("Abgebrochen", "AbortError");
    proposals = validateCalendarEvents(result.events, {
      projectIds: context().workspace.projects.map((p) => p.id),
    });
    warnings = result.warnings || [];
    checked = new Set(proposals.map(proposalKey));
    panel = "import";
    notice = `${proposals.length} Termine zur Prüfung. Es wurde noch nichts übernommen.`;
    onShow();
    change("calendar-review-title");
  }
  function saveProposal() {
    const incoming = proposals.filter((e) => checked.has(proposalKey(e))),
      next = mergeCalendarEvents(
        context().workspace.calendarEvents || [],
        incoming,
        { projectIds: context().workspace.projects.map((p) => p.id) },
      );
    write(next, "Kalender: " + incoming.length + " Termine übernommen");
    proposals = [];
    checked.clear();
    notice = `${incoming.length} Termine lokal übernommen.${syncSettings().automatic ? " Der Outlook-Abgleich ist für den gewählten Zielkalender aktiv." : " In Outlook und Google wurde nichts geändert."}`;
    change();
  }
  function edit(id = "") {
    const e = (context().workspace.calendarEvents || []).find(
      (e) => e.id === id,
    );
    draft = e
      ? {
          ...e,
          start: e.allDay ? e.start : localInput(e.start),
          end: e.allDay ? addDay(e.end, -1) : localInput(e.end),
        }
      : {
          id: "",
          title: "",
          projectId: context().workspace.activeCourse || "",
          allDay: false,
          start: selected + "T09:00",
          end: selected + "T10:00",
        };
    panel = "form";
    error = "";
    change("calendar-title");
  }
  function eventCard(e) {
    const task = e.id.startsWith("task-") && e.readonly,
      remote = e.source.kind === "google" || e.source.kind === "outlook";
    const record = syncSettings().records.find(
      (r) => r.calendarId === syncSettings().target.calendarId && r.id === e.id,
    );
    const syncLine = record
      ? `<p class="calendar-sync-event ${["conflict", "unknown", "failed"].includes(record.status) ? "error" : ""}">Outlook: ${esc(syncStatusLabel(record.status))}${record.error ? ` · ${esc(record.error)}` : ""}${record.url ? ` <a href="${esc(record.url)}" target="_blank" rel="noopener noreferrer" data-open="Outlook-Termin">In Outlook ansehen ↗</a>` : ""}</p>`
      : "";
    return `<article id="calendar-event-${esc(e.id)}" tabindex="-1" class="calendar-event-card ${task ? "deadline" : ""}"><div class="calendar-event-meta"><span class="tag">${task ? "Abgabefrist" : esc(kinds[e.source.kind] || "Termin")}</span><span>${esc(projectName(e.projectId))}</span></div><h3>${esc(e.title)}</h3><p><time>${esc(eventWhen(e))}</time></p>${syncLine}${e.source.excerpt ? `<details><summary>Quellenbeleg</summary><p>${esc(e.source.excerpt)}</p></details>` : ""}<div class="calendar-event-actions">${e.source.url ? `<a class="calendar-source-link" href="${esc(e.source.url)}" target="_blank" rel="noopener noreferrer" data-open="Terminquelle">${esc(e.source.title || "Originalquelle")} ↗</a>` : ""}${task ? `<button class="text-link" data-calendar="task" data-id="${esc(e.source.externalId)}">Aufgabe öffnen →</button>` : `<button class="text-link" data-calendar="edit" data-id="${esc(e.id)}">${remote ? "Kurs zuordnen" : "Bearbeiten"}</button><button class="text-link danger" data-calendar="delete" data-id="${esc(e.id)}">Lokal entfernen</button>`}</div></article>`;
  }
  function syncStatusLabel(status) {
    return (
      {
        created: "angelegt",
        updated: "aktualisiert",
        unchanged: "bestätigt",
        failed: "fehlgeschlagen",
        unknown: "Speicherstand unklar",
        cancelled: "nicht ausgeführt",
        conflict: "Konflikt · Outlook wurde verändert",
      }[status] || status
    );
  }
  function syncPanel() {
    const s = syncSettings(),
      c = connections.outlook || {},
      own = writableOutlookCalendars(calendars.outlook),
      ready = c.connected && c.syncEnabled && !c.readOnly;
    const records = s.records.filter(
        (r) => r.calendarId === s.target.calendarId,
      ),
      issues = records.filter((r) =>
        ["failed", "unknown", "conflict", "cancelled"].includes(r.status),
      );
    const logRecords = [
      ...issues.slice().reverse(),
      ...records
        .filter((r) => !issues.includes(r))
        .slice(-30)
        .reverse(),
    ];
    return `<section class="calendar-sync-panel" aria-label="Outlook-Synchronisierung"><div class="section-title"><div><p class="small-label">DEIN KALENDER IN OUTLOOK</p><h2>Lokal planen. In Outlook wiederfinden.</h2></div><button class="text-link" data-calendar="connections">Verbindung einrichten ↗</button></div><p>Eigene lokale Termine aus Context, Spaces, Terminplan-Fotos und Dateien können in deinen Outlook-Kalender übertragen werden. Das gilt für alle aktiven Kurse. Übernommene Google-/Outlook-Termine und Aufgabenfristen werden nicht erneut veröffentlicht.</p><label>Zielkalender · nur deine eigenen Kalender<select id="calendar-sync-target" ${busy || !ready ? "disabled" : ""}><option value="">${ready ? "Eigenen Kalender wählen" : "Zuerst Outlook mit Schreibrechten verbinden"}</option>${own.map((cal) => `<option value="${esc(cal.id)}" ${s.target.calendarId === cal.id ? "selected" : ""}>${esc(cal.title)}</option>`).join("")}</select></label>${s.target.calendarId ? `<p class="subtle-note">Gespeichertes Ziel: ${esc(s.target.title || "Outlook-Kalender")}${!own.some((cal) => cal.id === s.target.calendarId) ? " · Kalenderliste erneut laden." : ""}</p>` : ""}<div class="calendar-event-actions"><button class="button secondary" data-calendar="list-calendars" data-provider="outlook" ${busy || !c.connected ? "disabled" : ""}>Eigene Kalender laden</button><button class="button primary" data-calendar="sync" ${busy || !ready || !s.target.calendarId ? "disabled" : ""}>Jetzt mit Outlook abgleichen</button></div><label class="checkbox-label calendar-sync-setting"><input id="calendar-sync-auto" type="checkbox" ${s.automatic ? "checked" : ""} ${busy || !ready || !s.target.calendarId ? "disabled" : ""}><span><strong>Automatisch nach Outlook übertragen</strong><small>Nach lokalen Änderungen und alle 2 Minuten bei geöffneter, sichtbarer App. Pro automatischem Durchlauf höchstens 20 geänderte Termine. ${synchronizer.isPaused() ? "Die Automatik ist für diese Sitzung pausiert. Ein manueller Abgleich prüft den Stand." : ""}</small></span></label><p class="subtle-note">Die Automatik ist anfangs aus. Aktivieren erlaubt das externe Anlegen und Aktualisieren deiner lokalen Termine. Änderungen in Outlook erzeugen einen sichtbaren Konflikt; sie werden nicht überschrieben. Lokales Entfernen und Rückgängig löschen keine Outlook-Termine.</p>${records.length ? `<details class="calendar-sync-log" ${issues.length ? "open" : ""}><summary>Abgleichprotokoll · ${records.length} Termine${issues.length ? ` · ${issues.length} zu prüfen` : ""}</summary><p class="subtle-note">Alle Hinweise und die letzten 30 bestätigten Termine.</p><ol>${logRecords.map((r) => `<li><strong>${esc(context().workspace.calendarEvents.find((e) => e.id === r.id)?.title || "Lokal entfernter Termin")}</strong><span>${esc(syncStatusLabel(r.status))}${r.syncedAt ? " · " + esc(new Intl.DateTimeFormat("de-DE", { dateStyle: "short", timeStyle: "short" }).format(new Date(r.syncedAt))) : ""}</span>${r.error ? `<p>${esc(r.error)}</p>` : ""}${r.url ? `<a class="calendar-source-link" href="${esc(r.url)}" target="_blank" rel="noopener noreferrer" data-open="Outlook-Termin">In Outlook ansehen ↗</a>` : ""}</li>`).join("")}</ol></details>` : ""}</section>`;
  }
  function form() {
    if (!draft) return "";
    const remote = ["google", "outlook"].includes(draft.source?.kind);
    return `<section class="calendar-form"><h2>${draft.id ? (remote ? "Kurs zuordnen" : "Termin bearbeiten") : "Neuer Termin"}</h2><form id="calendar-event-form"><label>Titel<input id="calendar-title" name="title" maxlength="200" required value="${esc(draft.title)}" ${remote ? "readonly" : ""}></label><label>Kurs<select name="projectId">${projectOptions(draft.projectId)}</select></label><label class="checkbox-label"><input name="allDay" type="checkbox" ${draft.allDay ? "checked" : ""} ${remote ? "disabled" : ""}> Ganztägig</label><div class="form-columns"><label>Beginn<input name="start" required type="${draft.allDay ? "date" : "datetime-local"}" value="${esc(draft.start)}" ${remote ? "readonly" : ""}></label><label>${draft.allDay ? "Letzter Tag (einschließlich)" : "Ende"}<input name="end" required type="${draft.allDay ? "date" : "datetime-local"}" value="${esc(draft.end)}" ${remote ? "readonly" : ""}></label></div><p class="subtle-note">Uhrzeiten werden in Europe/Berlin gespeichert. ${remote ? "Änderungen an Titel und Zeit erfolgen beim Anbieter." : "Einträge bleiben in deinem lokalen Context-Kalender."}</p><div class="form-footer"><button class="button secondary" type="button" data-calendar="close-panel">Abbrechen</button><button class="button primary" type="submit">Lokal speichern</button></div></form></section>`;
  }
  function providerCard(id) {
    const c = connections[id] || {},
      outlook = id === "outlook",
      name = outlook ? "Outlook" : "Google Kalender & Drive",
      write = outlook && c.syncEnabled && !c.readOnly;
    const driveOnly = !outlook && !c.connected && c.driveEnabled;
    const stateLabel = driveOnly ? "Drive verbunden · nur lesen" : c.connected
      ? write
        ? "Verbunden · Lesen & Synchronisieren"
        : "Verbunden · nur lesen"
      : c.configured
        ? "Bereit zur Anmeldung"
        : "Einrichtung offen";
    const readControls = `<label>Kalender zum Einlesen<select data-calendar-provider-choice="${id}"><option value="">Kalender auswählen</option>${(calendars[id] || []).map((cal) => `<option value="${esc(cal.id)}" ${choices[id] === cal.id ? "selected" : ""}>${esc(cal.title)}</option>`).join("")}</select></label><div class="calendar-event-actions"><button class="button secondary" data-calendar="list-calendars" data-provider="${id}" ${busy ? "disabled" : ""}>Kalender laden</button><button class="button primary" data-calendar="pull" data-provider="${id}" ${busy || !choices[id] ? "disabled" : ""}>Angezeigten Monat einlesen</button>${!outlook && c.driveEnabled ? `<button class="button secondary" data-calendar="drive-files" ${busy ? "disabled" : ""}>Drive-Terminplan wählen</button>` : ""}${outlook && !write && c.backend !== "nango" ? `<button class="button secondary" data-calendar="enable-sync" ${busy ? "disabled" : ""}>Outlook-Schreibrechte verbinden</button>` : ""}<button class="text-link" data-calendar="disconnect" data-provider="${id}" ${busy ? "disabled" : ""}>Trennen</button></div>`;
    const config = `<form class="calendar-provider-form" data-provider="${id}"><label>OAuth-App-ID / Client-ID<input name="clientId" required maxlength="300" value="${esc(configs[id].clientId)}" autocomplete="off"></label>${outlook ? `<label>Microsoft-Mandant<input name="tenant" maxlength="100" value="${esc(configs.outlook.tenant)}" placeholder="common oder Mandanten-ID"></label><label class="checkbox-label"><input type="checkbox" name="syncEnabled" ${configs.outlook.syncEnabled ? "checked" : ""}><span>Outlook-Synchronisierung erlauben</span></label><p class="subtle-note">Fordert Kalender-Schreibrechte an, damit Context eigene Termine anlegen und aktualisieren kann. Die automatische Übertragung aktivierst du danach separat für deinen Zielkalender.</p>` : `<label>Desktop-Client-Secret <span class="optional">falls von Google vergeben</span><input name="clientSecret" type="password" autocomplete="off" maxlength="500"></label><label class="checkbox-label"><input type="checkbox" name="driveEnabled" ${configs.google.driveEnabled ? "checked" : ""}> Google Drive zusätzlich verbinden</label>`}<button class="button primary" type="submit" ${busy || !window.contextDesktop?.calendar ? "disabled" : ""}>${busy === "connect-" + id ? "Anmeldung läuft …" : "Konto verbinden"}</button></form>`;
    return `<article class="calendar-provider-card ${brandClass(id)}"><div class="section-title"><div class="provider-brand-heading">${brandLogo(id)}<h3>${name}</h3></div><span class="tag">${stateLabel}</span></div><p>${outlook ? "Lies Termine aus Microsoft 365 oder Outlook ein. Mit ausdrücklich verbundenen Schreibrechten kannst du eigene Context-Termine gezielt nach Outlook übertragen." : "Kalendertermine abrufen und ausgewählte Terminplan-Dateien lesen. Google bleibt lesend angebunden."}</p>${c.connected ? readControls : driveOnly ? `<div class="calendar-nango-entry"><p>Drive ist verbunden. Du kannst Terminplan-Dateien einlesen, ohne Google Kalender anzumelden.</p><button class="button primary" data-calendar="drive-files" ${busy ? "disabled" : ""}>Drive-Terminplan wählen</button><button class="text-link" data-view="connections">Drive-Verbindung verwalten ↗</button></div>` : c.backend === "nango" ? `<div class="calendar-nango-entry"><p>Die Nango-Verbindung benötigt eine Anmeldung oder passende Kalenderrechte.</p><button class="button primary" data-view="connections">Nango-Verbindung verwalten ↗</button></div>` : `<div class="calendar-nango-entry"><p>Einfacher verbinden: Anmeldung und Token-Erneuerung über Nango.</p><button class="button primary" data-view="connections">Mit Nango verbinden ↗</button></div><details><summary>Eigene OAuth-App verwenden</summary>${config}</details>`}${c.backend === "nango" ? `<div class="calendar-nango-entry"><p>OAuth und Token-Erneuerung laufen über deine Nango-Instanz. Schreibrechte werden unter Verbindungen freigegeben.</p><button class="button secondary" data-view="connections">Nango-Konto und Rechte ↗</button></div>` : ""}<details><summary>Einrichtung der direkten OAuth-Verbindung</summary><p>Context benötigt eine eigene registrierte OAuth-App. Trage deren Client-ID hier ein. Die Anmeldung öffnet den Systembrowser. ${outlook ? "Für die Synchronisierung benötigt Outlook Calendars.ReadWrite; ohne deine Auswahl wird nur lesend verbunden." : "Google-Kalender und optional Drive-Dateien werden nur gelesen."} Zugangstokens bleiben im Arbeitsspeicher und werden beim Beenden gelöscht.</p><p>${outlook ? "Microsoft: öffentliche/native App registrieren, Redirect URI http://localhost/oauth/callback für Mobil-/Desktopanwendungen aktivieren; Konto- und Mandantentyp müssen zu deinem Outlook-Konto passen." : "Google: OAuth-Clienttyp „Desktop-App“, Calendar API und bei Bedarf Drive API aktivieren. Bei einer App im Testmodus dein Konto als Testnutzer hinzufügen."}</p><a href="${outlook ? "https://learn.microsoft.com/en-us/entra/identity-platform/scenario-desktop-app-registration" : "https://developers.google.com/identity/protocols/oauth2/native-app"}" target="_blank" rel="noopener noreferrer" data-open="Kalender-Einrichtung">Offizielle Einrichtung ↗</a></details></article>`;
  }
  function importer() {
    return `<section class="calendar-import"><div class="section-title"><h2>Terminpläne übernehmen</h2><button class="text-link" data-calendar="close-panel">Schließen</button></div><p>Explizite Daten mit Jahreszahl werden lokal erkannt. Unklare Termine und Serien benötigen eine Prüfung. Quellen gehen für diesen Import an keine KI.</p><div class="calendar-event-actions"><button class="button secondary" data-calendar="cached-spaces" ${busy ? "disabled" : ""}>Gespeicherten Spaces-Stand prüfen</button><button class="button secondary" data-calendar="live-spaces" ${busy || !agentBrowserAvailable() ? "disabled" : ""}>Aktuelle Spaces-Seite lesen</button><label class="button secondary">ICS / Text / CSV wählen<input id="calendar-file" type="file" accept=".ics,.csv,.txt,.md" class="sr-only"></label></div><form id="calendar-import-form"><div class="form-columns"><label>Quelle<select name="kind">${["spaces", "drive", "ics", "local"].map((k) => `<option value="${k}" ${importDraft.kind === k ? "selected" : ""}>${kinds[k]}</option>`).join("")}</select></label><label>Kurs<select name="projectId">${projectOptions(importDraft.projectId)}</select></label></div><label>Titel des Terminplans<input name="title" maxlength="200" required value="${esc(importDraft.title)}"></label><label>Quellenlink <span class="optional">optional · HTTPS</span><input name="url" type="url" value="${esc(importDraft.url)}" placeholder="https://spaces.th-koeln.de/…"></label><label>Terminplan als Text<textarea name="text" rows="5" maxlength="1000000" placeholder="16.10.2026 10:00–12:00 · Prototyping im Labor">${esc(importDraft.text)}</textarea></label><button class="button primary" type="submit" ${busy ? "disabled" : ""}>Vorschläge prüfen</button></form>${files.length ? `<h3>Google-Drive-Dateien</h3><p>Nur die gewählte Datei wird gelesen. Native Docs, das erste Sheets-Tabellenblatt und Text-/CSV-/ICS-Dateien werden unterstützt.</p><div class="calendar-proposals">${files.map((f) => `<button class="button secondary" data-calendar="drive-text" data-id="${esc(f.id)}" ${busy ? "disabled" : ""}>${esc(f.title)} ↗</button>`).join("")}</div>` : ""}${
      warnings.length
        ? `<div class="calendar-warning" role="status"><strong>Bitte prüfen</strong><ul>${warnings
            .slice(0, 30)
            .map((w) => `<li>${esc(w)}</li>`)
            .join(
              "",
            )}</ul>${warnings.length > 30 ? `<p>${warnings.length - 30} weitere Warnungen.</p>` : ""}</div>`
        : ""
    }${proposals.length ? `<h3 id="calendar-review-title" tabindex="-1">${proposals.length} Importvorschläge</h3><p>Bereits vorhandene Quelltermine mit gleicher ID werden aktualisiert. Wähle nur Termine aus, die in deinen Kalender gehören.</p><div class="calendar-proposals">${proposals.map((e) => `<article class="calendar-event-card"><label class="checkbox-label"><input data-calendar-check="${esc(e.id)}" type="checkbox" ${checked.has(e.id) ? "checked" : ""}> <strong>${esc(e.title)}</strong></label><p>${esc(eventWhen(e))}</p><small>${esc(projectName(e.projectId))}</small>${e.source.excerpt ? `<blockquote>${esc(e.source.excerpt)}</blockquote>` : ""}${e.source.url ? `<a class="calendar-source-link" href="${esc(e.source.url)}" target="_blank" rel="noopener noreferrer" data-open="Terminquelle">${esc(e.source.title || "Quelle")} ↗</a>` : ""}</article>`).join("")}</div><div class="form-footer"><button class="button secondary" data-calendar="discard">Vorschläge verwerfen</button><button class="button primary" data-calendar="accept" ${!checked.size ? "disabled" : ""}>${checked.size} Termine übernehmen</button></div>` : ""}</section>`;
  }
  function dayView(onSelected) {
    const layout = calendarDayLayout(onSelected, selected);
    const focused = onSelected.find(e => e.id === focusedEvent) || onSelected[0];
    const block = (e, extra = "") => `<button type="button" id="calendar-time-event-${esc(e.id)}" class="calendar-time-event ${e.id === focused?.id ? "is-active" : ""} ${e.readonly && e.id.startsWith("task-") ? "deadline" : ""}" data-calendar="focus-event" data-id="${esc(e.id)}" ${extra} aria-pressed="${e.id === focused?.id}" aria-label="${esc(e.title + ', ' + eventWhen(e))}" title="${esc(e.title + ' · ' + eventWhen(e))}">`;
    return `<section class="calendar-daily" aria-label="Tagesansicht ${esc(dayLabel(selected))}"><div class="calendar-daily-meta"><span>Europe/Berlin</span><span>${onSelected.length} Termine</span></div>${layout.allDay.length ? `<div class="calendar-all-day"><span class="calendar-all-day-label">Ganztägig</span><div>${layout.allDay.map(e=>block(e)+`<strong>${esc(e.title)}</strong><span>${esc(projectName(e.projectId))}</span></button>`).join("")}</div></div>` : ""}<div class="calendar-daily-layout"><div class="calendar-timeline-scroll" tabindex="0" role="region" aria-label="Stundenraster ${esc(dayLabel(selected))}" data-day-key="${esc(selected + '/' + (context().workspace.activeCourse || 'all'))}" data-initial-minute="${layout.initialMinute}"><div class="calendar-timeline-canvas" data-minutes="${layout.minutes}" data-lanes="${layout.maxLanes}">${layout.hours.map(hour=>`<div class="calendar-hour ${hour.minute===layout.minutes ? "is-end" : ""}" data-calendar-minute="${hour.minute}"><time>${esc(hour.label)}</time><span></span></div>`).join("")}<div class="calendar-time-blocks">${layout.timed.map(item=>block(item.event,`data-calendar-block data-compact="${item.heightMinutes < 60}" data-top="${item.topMinute}" data-duration="${item.heightMinutes}" data-lane="${item.lane}" data-lanes="${item.lanes}"`)+`<span class="calendar-time-label">${item.continuesBefore ? '← ' : ''}${esc(item.timeLabel)}${item.continuesAfter ? ' →' : ''}</span><strong>${esc(item.event.title)}</strong><span class="calendar-time-course">${esc(projectName(item.event.projectId))}</span></button>`).join("")}</div>${layout.nowMinute!==null ? `<div class="calendar-now-line" data-calendar-minute="${layout.nowMinute}" aria-label="Aktuelle Uhrzeit"><span></span></div>` : ""}</div></div><aside class="calendar-day-details" aria-label="Termindetails">${focused ? eventCard(focused) : `<div class="calendar-empty"><h3>Keine Termine</h3><button class="button secondary" data-calendar="new">Termin anlegen</button></div>`}</aside></div></section>`;
  }
  function render() {
    const all = events(),
      cells = monthCells(month),
      onSelected = all.filter((e) => eventOnDay(e, selected)),
      monthEvents = all.filter((e) =>
        cells.some((day) => day.startsWith(month) && eventOnDay(e, day)),
      );
    return `<div class="calendar-view"><div class="page-heading"><div><p class="eyebrow">DEINE ZEIT</p><h1>Kalender</h1></div><div class="calendar-heading-actions"><button class="button secondary calendar-add" data-calendar="new" aria-label="Termin anlegen" title="Termin anlegen">+</button><button class="button primary calendar-sync-now" data-calendar="sync-now" aria-label="Kalender synchronisieren" aria-busy="${busy === "refresh" || busy === "sync"}" ${busy || !window.contextDesktop?.calendar ? "disabled" : ""}><svg class="calendar-sync-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M20 7a9 9 0 0 0-15-2L2 8m0-6v6h6M4 17a9 9 0 0 0 15 2l3-3m0 6v-6h-6"/></svg><span>Sync</span></button></div></div>${syncOverview()}<div class="calendar-toolbar"><div class="calendar-event-actions"><button class="icon-button" id="calendar-previous" data-calendar="previous" aria-label="${mode === "day" ? "Vorheriger Tag" : "Vorheriger Monat"}">←</button><h2>${esc(mode === "day" ? dayLabel(selected) : monthLabel(month))}</h2><button class="icon-button" id="calendar-next" data-calendar="next" aria-label="${mode === "day" ? "Nächster Tag" : "Nächster Monat"}">→</button><button class="button secondary" id="calendar-today" data-calendar="today">Heute</button></div><div class="calendar-event-actions"><div class="calendar-view-switch" role="group" aria-label="Kalenderansicht"><button type="button" id="calendar-view-day" data-calendar="mode" data-value="day" aria-pressed="${mode === "day"}">Tag</button><button class="filter ${mode === "month" ? "selected" : ""}" id="calendar-view-month" data-calendar="mode" data-value="month" aria-pressed="${mode === "month"}">Monat</button><button class="filter ${mode === "agenda" ? "selected" : ""}" id="calendar-view-agenda" data-calendar="mode" data-value="agenda" aria-pressed="${mode === "agenda"}">Agenda</button></div>${mode === "day" ? `<input id="calendar-date" type="date" aria-label="Datum auswählen" value="${selected}">` : ""}<details class="calendar-more-actions"><summary aria-label="Weitere Kalenderaktionen">Mehr</summary><div><button class="button secondary" data-calendar="photo">Terminplan-Foto mit KI ↗</button><button class="button secondary" data-calendar="import">Terminplan importieren</button><button class="button secondary" data-calendar="connections">Konten verbinden</button><button class="text-link" data-calendar="export">ICS exportieren ↓</button><button class="text-link" data-calendar="sync-panel">Sync-Einstellungen</button></div></details></div></div>${busy ? `<p role="status" class="calendar-warning">${busy.startsWith("connect-") ? "Melde dich im geöffneten Systembrowser an." : busy === "sync" ? "Outlook wird abgeglichen. Bestätigte Teiländerungen bleiben erhalten." : "Wird eingelesen …"} <button class="text-link" data-calendar="cancel">Abbrechen</button></p>` : ""}${error ? `<p role="alert" class="calendar-warning">${esc(error)}</p>` : ""}${notice ? `<p role="status" class="calendar-notice">${esc(notice)}</p>` : ""}${refreshWarnings.length ? `<details class="calendar-refresh-warnings"><summary>Abgleich mit Einschränkungen (${refreshWarnings.length})</summary><ul>${refreshWarnings.map(w => `<li>${esc(w)}</li>`).join("")}</ul></details>` : ""}${panel === "form" ? form() : panel === "import" ? importer() : panel === "connections" ? `<section class="calendar-connections"><div class="section-title"><h2>Deine Kalenderkonten</h2><button class="text-link" data-calendar="close-panel">Schließen</button></div><p>Google ist lesend angebunden. Outlook kann mit deiner ausdrücklichen Auswahl zusätzlich eigene Context-Termine synchronisieren. Sync übernimmt neue und geänderte Termine automatisch in deinen lokalen Kalender. ${!window.contextDesktop?.calendar ? "Öffne die Desktop-App für die Kontenanmeldung." : ""}</p>${providerCard("outlook")}${providerCard("google")}</section>` : ""}${panel === "sync" ? syncPanel() : ""}<div class="calendar-layout ${mode === "day" ? "is-day-view" : ""}">${
      mode === "month"
        ? `<section class="calendar-month" aria-label="${esc(monthLabel(month))}"><div class="calendar-grid">${["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"].map((d) => `<div class="calendar-weekday">${d}</div>`).join("")}${cells
            .map((day) => {
              const dayEvents = all.filter((e) => eventOnDay(e, day));
              return `<button class="calendar-day ${day === dateKey() ? "is-today" : ""} ${day === selected ? "is-selected" : ""} ${!day.startsWith(month) ? "outside" : ""}" data-calendar="day" data-value="${day}" aria-pressed="${day === selected}" aria-label="${esc(dayLabel(day))}, ${dayEvents.length} Termine"><span class="calendar-day-number">${Number(day.slice(-2))}</span>${dayEvents
                .slice(0, 2)
                .map(
                  (e) =>
                    `<span class="calendar-event-chip ${e.readonly && e.id.startsWith("task-") ? "deadline" : ""}" title="${esc(e.title)}">${esc(e.title)}</span>`,
                )
                .join(
                  "",
                )}${dayEvents.length > 2 ? `<span class="calendar-day-count">+ ${dayEvents.length - 2}</span>` : ""}</button>`;
            })
            .join(
              "",
            )}</div><p class="subtle-note">Zeitzone Europe/Berlin · Abgabefristen kommen aus deinen offenen Aufgaben.</p></section>`
        : ""
    }${mode === "day" ? dayView(onSelected) : `<section class="calendar-agenda" aria-label="Terminliste"><div class="section-title"><h2>${mode === "month" ? esc(dayLabel(selected)) : esc(monthLabel(month))}</h2><span class="tag">${(mode === "month" ? onSelected : monthEvents).length} Termine</span></div>${(mode === "month" ? onSelected : monthEvents).map(eventCard).join("") || `<div class="calendar-empty"><span aria-hidden="true">✳</span><h3>Platz für deinen nächsten Termin.</h3><p>${mode === "month" ? "An diesem Tag sind keine Termine gespeichert." : "In diesem Monat sind keine Termine gespeichert."}</p><button class="button secondary" data-calendar="new">Termin anlegen</button></div>`}</section>`}</div></div>`;
  }
  function teaser() {
    const upcoming = events()
      .filter((e) =>
        e.allDay ? e.end > dateKey() : e.end > new Date().toISOString(),
      )
      .slice(0, 3);
    return `<section class="calendar-teaser focus-panel"><div class="section-title"><h2>Deine nächsten Termine</h2><button data-view="calendar">Kalender →</button></div>${upcoming.length ? upcoming.map((e) => `<p><strong>${esc(e.title)}</strong><br><small>${esc(eventWhen(e))} · ${esc(projectName(e.projectId))}</small></p>`).join("") : "<p>Verbinde deinen Kalender oder übernimm einen Spaces-Terminplan.</p>"}</section>`;
  }
  async function click(b) {
    const { calendar: action, id, provider, value } = b.dataset;
    if (action === "cancel") {
      if (busy === "sync") {
        synchronizer.stop();
        try {
          const s = syncSettings();
          if (s.automatic && onSyncSave({ ...s, automatic: false }) !== true)
            throw new Error(
              "Die laufende Übertragung wurde angehalten, aber die Automatik konnte nicht dauerhaft ausgeschaltet werden.",
            );
        } catch (e) {
          error = e.message;
          change();
        }
      } else abort?.abort();
    } else if (action === "sync-now") {
      void synchronizeNow();
    } else if (action === "sync") {
      void runSync(true);
    } else if (action === "sync-panel") {
      panel = "sync";
      change();
      void load();
    } else if (action === "photo") {
      onAsk(
        "Erstelle aus einem Terminplan-Foto belegte Kalendertermine für den gewählten Kurs. Ich lade gleich das Bild hoch. Verwende eindeutig belegte Daten mit Jahr, Beginn, Ende und Europe/Berlin als Zeitzone. Benenne fehlende oder unlesbare Angaben. Zeige die Termine mit dem Foto als Quelle und übernimm sie entsprechend dem gewählten Aktionsmodus in meinen Context-Kalender. Stelle die übernommenen Termine als ICS bereit.",
      );
    } else if (action === "enable-sync") {
      void perform("connect-outlook", async () => {
        if (!configs.outlook.clientId)
          throw new Error(
            "Trage zuerst die Client-ID deiner registrierten Microsoft-OAuth-App ein.",
          );
        const version = ++connectionLoadVersion;
        try {
          configs.outlook.syncEnabled = true;
          await api("configure", {
            provider: "outlook",
            body: {
              clientId: configs.outlook.clientId,
              tenant: configs.outlook.tenant,
              syncEnabled: true,
            },
          });
          if (version !== connectionLoadVersion) return;
          await api("connect", { provider: "outlook" });
          if (version !== connectionLoadVersion) return;
          const nextConnections = await api("status");
          if (version !== connectionLoadVersion) return;
          connections = nextConnections;
          const nextCalendars = await api("calendars", { provider: "outlook" });
          if (version !== connectionLoadVersion) return;
          calendars.outlook = nextCalendars.calendars;
          panel = "sync";
          notice =
            "Outlook ist mit Schreibrechten verbunden. Wähle deinen eigenen Zielkalender; die Automatik bleibt bis zu deiner Auswahl aus.";
        } catch (e) {
          if (version !== connectionLoadVersion) return;
          throw e;
        }
      });
    } else if (action === "new") edit();
    else if (action === "edit") edit(id);
    else if (action === "task") onTask(id);
    else if (action === "delete") {
      try {
        const previous = context().workspace.calendarEvents || [],
          item = previous.find((e) => e.id === id);
        write(
          previous.filter((e) => e.id !== id),
          "Kalendertermin lokal entfernt",
        );
        notice = "Termin lokal entfernt. Beim Anbieter bleibt er bestehen.";
        onNotice("Termin entfernt.", () => {
          try {
            write(
              [...(context().workspace.calendarEvents || []), item],
              "Kalendertermin wiederhergestellt",
            );
          } catch (e) {
            error = e.message;
            change();
          }
        });
        change();
      } catch (e) {
        error = e.message;
        change();
      }
    } else if (action === "focus-event") {
      if (!events().some(e=>e.id===id && eventOnDay(e,selected))) return;
      focusedEvent = id;
      change("calendar-event-" + id);
      document.getElementById("calendar-event-" + id)?.scrollIntoView?.({block:"nearest"});
    } else if (action === "day") {
      try { calendarDayWindow(value); } catch { return; }
      selected = value;
      focusedEvent = "";
      change();
    } else if (action === "mode") {
      if (!["day", "month", "agenda"].includes(value)) return;
      mode = value;
      month = selected.slice(0,7);
      change();
    } else if (["previous", "next", "today"].includes(action)) {
      if (action === "today") {
        month = dateKey().slice(0, 7);
        selected = dateKey();
      } else if (mode === "day") {
        selected = addDay(selected, action === "next" ? 1 : -1);
        month = selected.slice(0,7);
      } else {
        const d = new Date(month + "-01T12:00:00Z");
        d.setUTCMonth(d.getUTCMonth() + (action === "next" ? 1 : -1));
        month = d.toISOString().slice(0, 7);
        selected = month + "-01";
      }
      focusedEvent = "";
      change();
    } else if (action === "import") {
      panel = "import";
      importDraft.projectId = context().workspace.activeCourse || "";
      change();
    } else if (action === "connections") {
      panel = "connections";
      change();
      void load();
    } else if (action === "close-panel") {
      panel = "";
      draft = null;
      change();
    } else if (action === "export") {
      try {
        download(exportICS(events()), "context-kalender-" + dateKey() + ".ics");
        notice =
          "ICS-Datei exportiert. Sie kann in Outlook oder Google Kalender importiert werden.";
        change();
      } catch (e) {
        error = e.message;
        change();
      }
    } else if (action === "discard") {
      proposals = [];
      checked.clear();
      warnings = [];
      change();
    } else if (action === "accept") {
      try {
        saveProposal();
      } catch (e) {
        error = e.message;
        change();
      }
    } else if (action === "cached-spaces") {
      void perform("spaces", async () => {
        const results = { events: [], warnings: [] };
        for (const u of context().updates.filter(
          (u) => u.source === "spaces",
        )) {
          const projectId = notificationCourse(u, context().workspace);
          if (
            context().workspace.activeCourse &&
            projectId !== context().workspace.activeCourse
          )
            continue;
          if (
            !u.content ||
            context().workspace.projects.find((p) => p.id === projectId)
              ?.archived
          )
            continue;
          const r = proposeCalendarEvents(u.content, {
            kind: "spaces",
            projectId,
            title: u.title,
            url: u.url || "",
          });
          results.events.push(...r.events);
          results.warnings.push(
            ...r.warnings.map((warning) => `${u.title}: ${warning}`),
          );
        }
        results.events = [
          ...new Map(results.events.map((e) => [e.id, e])).values(),
        ];
        results.warnings.unshift(
          "Gespeicherte Spaces-Auszüge sind kein vollständiger Terminplan. Prüfe das Original.",
        );
        review(results);
      });
    } else if (action === "live-spaces") {
      void perform("spaces", async () => {
        let page = await requestAgentBrowser(
          { command: "read" },
          { signal: abort?.signal },
        );
        const originalURL = page.url,
          originalTitle = page.title,
          course = notificationCourse({ url: page.url }, context().workspace);
        if (
          context().workspace.activeCourse &&
          course !== context().workspace.activeCourse
        )
          throw new Error(
            "Die geöffnete Spaces-Seite gehört nicht zum gewählten Kurs. Öffne zuerst dessen Terminplan oder wähle Alle Kurse.",
          );
        if (page.loginRequired)
          throw new Error(
            "Melde dich zuerst im eingebauten Spaces-Browser an.",
          );
        let text = page.text;
        for (let i = 1; page.hasMore && i < 4; i++) {
          page = await requestAgentBrowser(
            { command: "read", offset: i * 5000 },
            { signal: abort?.signal },
          );
          if (page.loginRequired)
            throw new Error("Die Spaces-Anmeldung ist nicht mehr aktiv.");
          if (page.url !== originalURL)
            throw new Error(
              "Die Spaces-Seite hat sich während des Lesens geändert. Bitte erneut einlesen.",
            );
          text += "\n" + page.text;
        }
        const r = proposeCalendarEvents(text, {
          kind: "spaces",
          projectId: course,
          title: originalTitle,
          url: originalURL,
        });
        review({
          ...r,
          warnings: [
            ...r.warnings,
            "Nur der lesbare Text der geöffneten Spaces-Seite wurde geprüft. Verlinkte Dateien und andere Kursseiten sind nicht enthalten.",
          ],
        });
      });
    } else if (action === "list-calendars") {
      void perform("calendars", async () => {
        const r = await api("calendars", { provider });
        calendars[provider] = r.calendars;
        notice = (r.warnings || []).join(" ");
      });
    } else if (action === "pull") {
      void perform("events", async () => {
        const first = month + "-01",
          d = new Date(first + "T12:00:00Z");
        d.setUTCMonth(d.getUTCMonth() + 1);
        const last = d.toISOString().slice(0, 10),
          course = context().workspace.activeCourse || "";
        const r = await api("events", {
          provider,
          body: {
            calendarId: choices[provider],
            from: berlinLocalToInstant(first, "00:00"),
            to: berlinLocalToInstant(last, "00:00"),
          },
        });
        review({
          ...r,
          events: (provider === "outlook"
            ? filterSelfSyncedEvents(
                r.events,
                syncSettings(),
                choices[provider],
              )
            : r.events
          ).map((e) => ({ ...e, projectId: course })),
          warnings: [
            ...(r.warnings || []),
            `Abruf für ${monthLabel(month)}. Weitere Monate werden separat eingelesen. Keine automatische Löschung älterer lokaler Termine.`,
          ],
        });
      });
    } else if (action === "disconnect") {
      void perform("disconnect", async () => {
        if (provider === "outlook") {
          const s = syncSettings();
          if (onSyncSave({ ...s, automatic: false }) !== true)
            throw new Error(
              "Die Outlook-Automatik konnte nicht lokal pausiert werden.",
            );
        }
        await api("disconnect", { provider });
        applyConnections(await api("status"));
        calendars[provider] = [];
        choices[provider] = "";
        files = [];
        notice =
          "Konto getrennt. Bereits importierte Termine bleiben lokal verfügbar.";
      });
    } else if (action === "drive-files") {
      void showDriveFiles();
    } else if (action === "drive-text") {
      void perform("drive", async () => {
        const course = context().workspace.activeCourse || "";
        const r = await api("driveText", {
          provider: "google",
          body: { fileId: id },
        });
        const options = { projectId: course, title: r.title, url: r.url };
        const plan = r.text.includes("BEGIN:VCALENDAR")
          ? importICS(r.text, {
              projectId: options.projectId,
              sourceTitle: r.title,
              sourceURL: r.url,
            })
          : proposeCalendarEvents(r.text, { ...options, kind: "drive" });
        review({
          ...plan,
          warnings: [...(plan.warnings || []), ...(r.warnings || [])],
        });
      });
    }
  }
  const clickHandler = (e) => {
    const b = e.target.closest("[data-calendar]");
    if (!b) return;
    e.preventDefault();
    if (
      busy &&
      !["cancel", "day", "mode", "close-panel"].includes(b.dataset.calendar)
    )
      return;
    void click(b);
  };
  document.addEventListener("click", clickHandler);
  const inputHandler = (e) => {
    const f = e.target.closest(
      "#calendar-event-form,#calendar-import-form,.calendar-provider-form",
    );
    if (!f) return;
    const name = e.target.name;
    if (f.id === "calendar-event-form" && draft)
      draft[name] =
        e.target.type === "checkbox" ? e.target.checked : e.target.value;
    else if (f.id === "calendar-import-form")
      importDraft[name] = e.target.value;
    else if (f.classList.contains("calendar-provider-form")) {
      editedConfigs.add(f.dataset.provider);
      configs[f.dataset.provider][name] =
        e.target.type === "checkbox" ? e.target.checked : e.target.value;
    }
  };
  document.addEventListener("input", inputHandler);
  const changeHandler = async (e) => {
    if (e.target.id === "calendar-date") {
      try { calendarDayWindow(e.target.value); } catch { e.target.value=selected; return; }
      selected=e.target.value;month=selected.slice(0,7);focusedEvent="";change("calendar-date");
      return;
    }
    if (e.target.id === "calendar-sync-target" && !busy) {
      try {
        const selected = writableOutlookCalendars(calendars.outlook).find(
          (c) => c.id === e.target.value,
        );
        if (e.target.value && !selected)
          throw new Error(
            "Wähle einen eigenen beschreibbaren Outlook-Kalender.",
          );
        const s = syncSettings();
        if (
          onSyncSave({
            ...s,
            automatic: false,
            target: {
              calendarId: selected?.id || "",
              title: selected?.title || "",
            },
          }) !== true
        )
          throw new Error(
            "Der Zielkalender konnte nicht lokal gespeichert werden.",
          );
        notice =
          "Zielkalender gespeichert. Die automatische Übertragung ist ausgeschaltet.";
        change();
      } catch (err) {
        error = err.message;
        change();
      }
    }
    if (e.target.id === "calendar-sync-auto" && !busy) {
      try {
        const s = syncSettings(),
          c = connections.outlook || {};
        if (
          e.target.checked &&
          (!s.target.calendarId || !c.connected || !c.syncEnabled || c.readOnly)
        )
          throw new Error(
            "Verbinde zuerst Outlook mit Schreibrechten und wähle deinen eigenen Zielkalender.",
          );
        if (onSyncSave({ ...s, automatic: e.target.checked }) !== true)
          throw new Error(
            "Die Automatik konnte nicht lokal gespeichert werden.",
          );
        synchronizer.resume();
        notice = e.target.checked
          ? "Automatische Outlook-Übertragung aktiviert. Geänderte lokale Termine werden bei sichtbarer App abgeglichen."
          : "Automatische Outlook-Übertragung ausgeschaltet.";
        queueAutomatic();
        change();
      } catch (err) {
        error = err.message;
        change();
      }
    }
    if (e.target.matches("[data-calendar-check]")) {
      e.target.checked
        ? checked.add(e.target.dataset.calendarCheck)
        : checked.delete(e.target.dataset.calendarCheck);
      change();
    }
    if (e.target.matches("[data-calendar-provider-choice]")) {
      choices[e.target.dataset.calendarProviderChoice] = e.target.value;
      change();
    }
    if (
      e.target.name === "allDay" &&
      e.target.closest("#calendar-event-form") &&
      draft
    ) {
      draft.allDay = e.target.checked;
      draft.start = draft.allDay
        ? draft.start.slice(0, 10)
        : draft.start.slice(0, 10) + "T09:00";
      draft.end = draft.allDay
        ? draft.end.slice(0, 10)
        : draft.end.slice(0, 10) + "T10:00";
      change();
    }
    if (e.target.id === "calendar-file") {
      const file = e.target.files[0],
        course = context().workspace.activeCourse || "";
      e.target.value = "";
      if (!file) return;
      void perform("file", async () => {
        if (file.size > 1000000)
          throw new Error("Terminpläne dürfen höchstens 1 MB groß sein.");
        const text = await file.text();
        importDraft = { ...importDraft, text, title: file.name, kind: "ics" };
        review(
          /\.ics$/i.test(file.name)
            ? importICS(text, { projectId: course, sourceTitle: file.name })
            : proposeCalendarEvents(text, {
                kind: "ics",
                projectId: course,
                title: file.name,
              }),
        );
      });
    }
  };
  document.addEventListener("change", changeHandler);
  const submitHandler = (e) => {
    const f = e.target;
    if (f.id === "calendar-event-form") {
      e.preventDefault();
      try {
        const next = calendarEventFromForm(
          draft,
          Object.fromEntries(new FormData(f)),
          context().workspace,
        );
        const list = context().workspace.calendarEvents || [];
        write(
          [...list.filter((e) => e.id !== next.id), next],
          "Kalendertermin gespeichert",
        );
        panel = "";
        draft = null;
        notice = "Termin lokal gespeichert.";
        change();
      } catch (err) {
        error = err.message;
        change();
      }
    } else if (f.id === "calendar-import-form") {
      e.preventDefault();
      try {
        const data = new FormData(f);
        importDraft = Object.fromEntries(data);
        review(
          importDraft.text.includes("BEGIN:VCALENDAR")
            ? importICS(importDraft.text, {
                projectId: importDraft.projectId,
                sourceTitle: importDraft.title,
                sourceURL: importDraft.url,
              })
            : proposeCalendarEvents(importDraft.text, {
                kind: importDraft.kind,
                projectId: importDraft.projectId,
                title: importDraft.title,
                url: importDraft.url,
              }),
        );
      } catch (err) {
        error = err.message;
        change();
      }
    } else if (f.classList.contains("calendar-provider-form")) {
      e.preventDefault();
      const provider = f.dataset.provider,
        data = new FormData(f),
        body =
          provider === "google"
            ? {
                clientId: data.get("clientId"),
                ...(data.get("clientSecret")
                  ? { clientSecret: data.get("clientSecret") }
                  : {}),
                driveEnabled: data.get("driveEnabled") === "on",
              }
            : {
                clientId: data.get("clientId"),
                tenant: data.get("tenant") || "common",
                syncEnabled: data.get("syncEnabled") === "on",
              };
      if (provider === "google") {
        f.elements.clientSecret.value = "";
        configs.google.clientSecret = "";
      }
      void perform("connect-" + provider, async () => {
        await api("configure", { provider, body });
        await api("connect", { provider });
        editedConfigs.delete(provider);
        applyConnections(await api("status"));
        calendars[provider] = (await api("calendars", { provider })).calendars;
        notice = "Konto verbunden. Wähle einen Kalender zum Einlesen.";
        if (provider === "outlook" && body.syncEnabled) {
          panel = "sync";
          notice =
            "Outlook mit Schreibrechten verbunden. Wähle deinen eigenen Zielkalender; die Automatik aktivierst du separat.";
        }
      });
    }
  };
  document.addEventListener("submit", submitHandler);
  return {
    render,
    openEvent: id => {
      const event=events().find(e=>e.id===id);if(!event)return false;
      selected=event.allDay?event.start:localInput(event.start).slice(0,10);
      month=selected.slice(0,7);mode="day";focusedEvent=id;panel="";onShow();change("calendar-event-"+id);
      document.getElementById("calendar-event-"+id)?.scrollIntoView?.({block:"nearest"});return true;
    },
    load,
    start: () => autoRefresh.start(),
    pause: () => { autoRefresh.pause(); refreshAbort?.abort(); synchronizer.stop(); },
    resume: () => { if (!disposed) { synchronizer.resume(); return autoRefresh.resume(); } },
    invalidateRefresh,
    teaser,
    notifyLocalChange: () => queueAutomatic(),
    dispose: () => {
      disposed = true; invalidateRefresh(); autoRefresh.dispose(); abort?.abort();
      for (const [name, handler] of [["click", clickHandler], ["input", inputHandler], ["change", changeHandler], ["submit", submitHandler]]) document.removeEventListener(name, handler);
      clearTimeout(syncTimer);
      clearInterval(automaticClock);
      document.removeEventListener("visibilitychange", visibilityHandler);
      synchronizer.stop();
    },
    open: (destination="") => {
      panel = destination==="drive"?"import":"";
      onShow();
      change();
      if(destination==="drive")void showDriveFiles();
    },
  };
}
