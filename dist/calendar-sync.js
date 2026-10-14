import {
  validateCalendarEvent,
  validateCalendarEvents,
} from "./calendar-engine.js";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const statuses = new Set([
  "created",
  "updated",
  "unchanged",
  "failed",
  "unknown",
  "cancelled",
  "conflict",
]);
const success = new Set(["created", "updated", "unchanged"]);
const object = (v, keys) =>
  v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.keys(v).every((k) => keys.includes(k));
function text(v, max = 512) {
  if (typeof v !== "string" || v.length > max || /[\x00-\x1f\x7f]/.test(v))
    throw new Error("Ungültige Outlook-Synchronisierungsdaten.");
  return v.trim();
}
function hash(v) {
  v = text(v, 64);
  if (v && !HASH.test(v)) throw new Error("Ungültiger Termin-Fingerabdruck.");
  return v;
}
function date(v) {
  v = text(v, 40);
  if (v && (!Number.isFinite(Date.parse(v)) || new Date(v).toISOString() !== v))
    throw new Error("Ungültiger Synchronisierungszeitpunkt.");
  return v;
}
function link(v) {
  v = text(v, 2048);
  if (!v) return "";
  let u;
  try {
    u = new URL(v);
  } catch {
    throw new Error("Ungültiger Outlook-Link.");
  }
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    ![
      "outlook.office.com",
      "outlook.office365.com",
      "outlook.live.com",
    ].includes(u.hostname)
  )
    throw new Error("Ungültiger Outlook-Link.");
  return u.href;
}
export function initialCalendarSync() {
  return {
    version: 1,
    namespace: crypto.randomUUID(),
    automatic: false,
    target: { calendarId: "", title: "" },
    records: [],
  };
}
export function validateCalendarSync(value) {
  if (value === undefined || value === null) return initialCalendarSync();
  if (
    !object(value, [
      "version",
      "namespace",
      "automatic",
      "target",
      "records",
    ]) ||
    value.version !== 1 ||
    typeof value.namespace !== "string" ||
    !UUID.test(value.namespace) ||
    typeof value.automatic !== "boolean" ||
    !object(value.target, ["calendarId", "title"]) ||
    !Array.isArray(value.records) ||
    value.records.length > 4000
  )
    throw new Error("Ungültige Outlook-Synchronisierungseinstellungen.");
  const target = {
    calendarId: text(value.target.calendarId),
    title: text(value.target.title, 240),
  };
  if (value.automatic && !target.calendarId)
    throw new Error(
      "Automatische Synchronisierung benötigt einen Zielkalender.",
    );
  const seen = new Set(),
    records = value.records.map((r) => {
      if (
        !object(r, [
          "calendarId",
          "id",
          "remoteId",
          "localFingerprint",
          "lastFingerprint",
          "syncedAt",
          "status",
          "error",
          "url",
          "retrySafe",
        ]) ||
        !statuses.has(r.status) ||
        typeof r.retrySafe !== "boolean"
      )
        throw new Error("Ungültiger Outlook-Abgleichseintrag.");
      const record = {
        calendarId: text(r.calendarId),
        id: text(r.id, 160),
        remoteId: text(r.remoteId),
        localFingerprint: hash(r.localFingerprint),
        lastFingerprint: hash(r.lastFingerprint),
        syncedAt: date(r.syncedAt),
        status: r.status,
        error: text(r.error, 1000),
        url: link(r.url),
        retrySafe: r.retrySafe,
      };
      const key = JSON.stringify([record.calendarId, record.id]);
      if (!record.calendarId || !record.id || seen.has(key))
        throw new Error(
          "Doppelter oder unvollständiger Outlook-Abgleichseintrag.",
        );
      seen.add(key);
      if (
        success.has(record.status) &&
        (!record.remoteId ||
          !record.localFingerprint ||
          !record.lastFingerprint ||
          !record.syncedAt)
      )
        throw new Error(
          "Ein bestätigter Outlook-Termin benötigt seine Zuordnung.",
        );
      return record;
    });
  return {
    version: 1,
    namespace: value.namespace.toLowerCase(),
    automatic: value.automatic,
    target,
    records,
  };
}
// Fingerprint only the fields written by the provider. Course labels and IDs are
// local metadata; they do not produce an unnecessary Outlook PATCH.
function calendarCanonical(input) {
  const e = validateCalendarEvent(input),
    body = [
      "Mit Context angelegt.",
      e.source.title,
      e.source.url,
      e.source.excerpt,
    ]
      .filter(Boolean)
      .join("\n\n")
      .replace(/\r\n?/g, "\n")
      .trimEnd();
  const canonical = {
    subject: e.title,
    body,
    allDay: e.allDay,
    start: e.start,
    end: e.end,
    location: input.location?.trim() || "",
  };
  return JSON.stringify(canonical);
}
export async function calendarLocalFingerprint(input) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(calendarCanonical(input)),
  );
  return [...new Uint8Array(bytes)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
export function writableOutlookCalendars(calendars) {
  return (Array.isArray(calendars) ? calendars : []).filter(
    (c) =>
      c &&
      c.writable === true &&
      c.canEdit === true &&
      typeof c.id === "string" &&
      c.id.length <= 512 &&
      typeof c.title === "string",
  );
}
export function syncEligibleEvents(workspace) {
  return validateCalendarEvents(workspace.calendarEvents || [], {
    projectIds: workspace.projects.map((p) => p.id),
  }).filter(
    (e) =>
      !e.readonly &&
      !["outlook", "google"].includes(e.source.kind) &&
      !workspace.projects.find((p) => p.id === e.projectId)?.archived,
  );
}
export async function syncCandidates(
  workspace,
  settings,
  { manual = false } = {},
) {
  const sync = validateCalendarSync(settings),
    events = syncEligibleEvents(workspace),
    out = [];
  for (const event of events) {
    const fingerprint = await calendarLocalFingerprint(event),
      previous = sync.records.find(
        (r) => r.calendarId === sync.target.calendarId && r.id === event.id,
      );
    if (
      !manual &&
      previous &&
      ((success.has(previous.status) &&
        previous.localFingerprint === fingerprint) ||
        previous.status === "conflict" ||
        (!success.has(previous.status) && !previous.retrySafe))
    )
      continue;
    out.push({ event, fingerprint });
  }
  return out;
}
export function mergeSyncResults(settings, calendarId, result, submitted) {
  const state = validateCalendarSync(settings);
  if (
    !result ||
    !Array.isArray(result.results) ||
    result.results.length > submitted.length
  )
    throw new Error("Outlook hat ein ungültiges Abgleichsergebnis geliefert.");
  const wanted = new Map(submitted.map((v) => [v.event.id, v])),
    seen = new Set(),
    entries = [];
  for (const row of result.results) {
    if (
      !row ||
      !wanted.has(row.id) ||
      seen.has(row.id) ||
      !statuses.has(row.status)
    )
      throw new Error("Outlook hat unbekannte oder doppelte Termine gemeldet.");
    seen.add(row.id);
    const old = state.records.find(
        (r) => r.calendarId === calendarId && r.id === row.id,
      ),
      ok = success.has(row.status);
    entries.push({
      calendarId,
      id: row.id,
      remoteId: row.remoteId || old?.remoteId || "",
      localFingerprint: ok
        ? wanted.get(row.id).fingerprint
        : old?.localFingerprint || "",
      lastFingerprint: row.lastFingerprint || old?.lastFingerprint || "",
      syncedAt: ok ? row.syncedAt : old?.syncedAt || "",
      status: row.status,
      error: row.error || "",
      url: row.url || old?.url || "",
      retrySafe: row.retrySafe === true,
    });
  }
  for (const [id] of wanted)
    if (!seen.has(id)) {
      const old = state.records.find(
        (r) => r.calendarId === calendarId && r.id === id,
      );
      entries.push({
        calendarId,
        id,
        remoteId: old?.remoteId || "",
        localFingerprint: old?.localFingerprint || "",
        lastFingerprint: old?.lastFingerprint || "",
        syncedAt: old?.syncedAt || "",
        status: "unknown",
        error:
          "Für diesen Termin liegt keine bestätigte Outlook-Antwort vor. Prüfe ihn mit einem manuellen Abgleich.",
        url: old?.url || "",
        retrySafe: false,
      });
    }
  return validateCalendarSync({
    ...state,
    records: [
      ...state.records.filter(
        (r) =>
          !entries.some((e) => e.calendarId === r.calendarId && e.id === r.id),
      ),
      ...entries,
    ],
  });
}
export function filterSelfSyncedEvents(incoming, settings, calendarId) {
  const s = validateCalendarSync(settings),
    ids = new Set(
      s.records
        .filter((r) => r.calendarId === calendarId && r.remoteId)
        .map((r) => r.remoteId),
    );
  return incoming.filter(
    (e) => e.source?.kind !== "outlook" || !ids.has(e.source.externalId),
  );
}

// Injected boundary keeps scheduling, cancellation and partial-result handling
// testable without an account. Writes remain in the desktop provider.
export function createCalendarSynchronizer({
  getWorkspace,
  saveSettings,
  request,
  onProgress = () => {},
}) {
  let running = false,
    controller;
  const save = (value) => {
    if (saveSettings(value) !== true)
      throw new Error(
        "Outlook wurde möglicherweise geändert, aber sein Abgleichstand konnte nicht lokal gesichert werden. Automatik ist für diese Sitzung pausiert; prüfe Outlook vor einem manuellen Abgleich.",
      );
  };
  let paused = false;
  return {
    isBusy: () => running,
    isPaused: () => paused,
    stop() {
      paused = true;
      controller?.abort();
    },
    resume() {
      paused = false;
    },
    async run({ manual = false } = {}) {
      if (running) throw new Error("Ein Outlook-Abgleich läuft bereits.");
      let settings = validateCalendarSync(getWorkspace().calendarSync);
      if (!settings.target.calendarId)
        throw new Error("Wähle zuerst deinen eigenen Outlook-Zielkalender.");
      if (!manual && (!settings.automatic || paused))
        return { skipped: true, results: [] };
      const targetId = settings.target.calendarId,
        namespace = settings.namespace;
      running = true;
      controller = new AbortController();
      const signal = controller.signal,
        results = [];
      let cancelled = false;
      try {
        const candidates = await syncCandidates(getWorkspace(), settings, {
            manual,
          }),
          queue = manual ? candidates : candidates.slice(0, 20);
        if (!manual && !queue.length) return { skipped: true, results: [] };
        const status = await request("status", { provider: "outlook", signal });
        if (!status.connected || !status.syncEnabled || status.readOnly)
          throw new Error(
            "Verbinde Outlook ausdrücklich mit Kalender-Schreibrechten.",
          );
        const listed = await request("calendars", {
          provider: "outlook",
          signal,
        });
        if (
          !writableOutlookCalendars(listed.calendars).some(
            (c) => c.id === targetId,
          )
        )
          throw new Error(
            "Der Zielkalender gehört dir nicht oder ist nicht beschreibbar. Wähle einen eigenen Outlook-Kalender.",
          );
        for (let i = 0; i < queue.length && !signal.aborted; i += 20) {
          onProgress({ completed: results.length, total: queue.length });
          const current = validateCalendarSync(getWorkspace().calendarSync);
          if (
            current.namespace !== namespace ||
            current.target.calendarId !== targetId ||
            (!manual && !current.automatic)
          )
            break;
          // Recheck the local snapshot immediately before each external batch.
          const live = new Map(
              syncEligibleEvents(getWorkspace()).map((e) => [e.id, e]),
            ),
            checked = [];
          for (const candidate of queue.slice(i, i + 20)) {
            const e = live.get(candidate.event.id);
            if (
              e &&
              (await calendarLocalFingerprint(e)) === candidate.fingerprint
            )
              checked.push(candidate);
          }
          // Hashing yields to the UI: check again synchronously afterwards so an
          // undo, local edit or scope change cannot submit a stale snapshot.
          const finalState = validateCalendarSync(getWorkspace().calendarSync);
          if (
            signal.aborted ||
            finalState.namespace !== namespace ||
            finalState.target.calendarId !== targetId ||
            (!manual && !finalState.automatic)
          )
            break;
          const finalLive = new Map(
            syncEligibleEvents(getWorkspace()).map((e) => [e.id, e]),
          );
          const batch = checked.flatMap((candidate) => {
            const e = finalLive.get(candidate.event.id);
            return e &&
              calendarCanonical(e) === calendarCanonical(candidate.event)
              ? [{ event: e, fingerprint: candidate.fingerprint }]
              : [];
          });
          if (!batch.length) continue;
          let result;
          try {
            result = await request("sync", {
              provider: "outlook",
              signal,
              body: {
                calendarId: targetId,
                namespace,
                events: batch.map((v) => v.event),
              },
            });
          } catch (error) {
            const latest = validateCalendarSync(getWorkspace().calendarSync);
            if (latest.namespace !== namespace)
              throw new Error(
                "Der Arbeitsbereich wurde während des Abgleichs gewechselt. Outlook kann bereits Termine enthalten. Prüfe den vorherigen Arbeitsbereich.",
              );
            result = {
              results: batch.map((v) => ({
                id: v.event.id,
                status: "unknown",
                error:
                  "Die Outlook-Antwort ist ausgeblieben. Ein Termin kann bereits gespeichert sein; manueller Abgleich prüft seine Zuordnung.",
                retrySafe: false,
              })),
              cancelled: signal.aborted,
            };
            settings = mergeSyncResults(latest, targetId, result, batch);
            save(settings);
            results.push(...result.results);
            paused = true;
            throw error;
          }
          // Deliberately retain successes/unknowns returned after cancellation.
          const latest = validateCalendarSync(getWorkspace().calendarSync);
          if (latest.namespace !== namespace)
            throw new Error(
              "Der Arbeitsbereich wurde während des Abgleichs gewechselt. Outlook kann bereits Termine enthalten. Prüfe den vorherigen Arbeitsbereich.",
            );
          try {
            settings = mergeSyncResults(latest, targetId, result, batch);
          } catch (error) {
            const unknown = {
              results: batch.map((v) => ({
                id: v.event.id,
                status: "unknown",
                error:
                  "Die Outlook-Antwort konnte nicht sicher ausgewertet werden. Prüfe den Termin vor einem erneuten manuellen Abgleich.",
                retrySafe: false,
              })),
            };
            settings = mergeSyncResults(latest, targetId, unknown, batch);
            save(settings);
            throw error;
          }
          save(settings);
          results.push(
            ...batch.map((v) =>
              settings.records.find(
                (r) => r.calendarId === targetId && r.id === v.event.id,
              ),
            ),
          );
          if (result.cancelled) {
            cancelled = true;
            paused = true;
            break;
          }
        }
        const stillLocal = new Set(
          syncEligibleEvents(getWorkspace()).map((e) => e.id),
        );
        return {
          results,
          cancelled: cancelled || signal.aborted,
          synced: results.filter((r) => success.has(r.status)).length,
          failed: results.filter((r) => !success.has(r.status)).length,
          pending: candidates.filter(
            (v) =>
              stillLocal.has(v.event.id) &&
              !results.some((r) => r.id === v.event.id),
          ).length,
        };
      } catch (error) {
        paused = true;
        throw error;
      } finally {
        running = false;
        controller = undefined;
      }
    },
  };
}
