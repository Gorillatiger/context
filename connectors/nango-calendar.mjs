import {createHash} from "node:crypto";
import {CalendarError} from "./calendar.mjs";
import {validateCalendarEvent} from "../dist/calendar-engine.js";

// Uses the same provider data and own-event rules as calendar.mjs. Private
// normalization helpers are kept local; the public event validator is shared.
// Nango owns OAuth, scopes and refresh: this adapter never sees credentials.
// https://nango.dev/docs/guides/auth/auth-guide
// https://nango.dev/docs/reference/backend/http-api/proxy/get
const fail = (code, message, status = 400) =>
  new CalendarError(status, code, message);
const GOOGLE = "https://www.googleapis.com";
const GRAPH = "https://graph.microsoft.com/v1.0";
// One immutable property name avoids creating unbounded Outlook named properties.
const SYNC_PROPERTY =
  "String {6a3277bd-5340-48ac-9a3b-83e3f0bf852a} Name ContextCalendarSync";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const bodyText = (value) => value.replace(/\r\n?/g, "\n").trimEnd();

function syncBatch(value) {
  object(value, ["calendarId", "namespace", "events"]);
  if (
    typeof value.namespace !== "string" ||
    !UUID.test(value.namespace) ||
    !Array.isArray(value.events) ||
    !value.events.length ||
    value.events.length > 20 ||
    Buffer.byteLength(JSON.stringify(value), "utf8") > 200000
  )
    throw fail(
      "invalid_sync",
      "Eine Synchronisierung benötigt eine Workspace-ID und 1 bis 20 Termine (höchstens 200 KB).",
    );
  const ids = new Set();
  const events = value.events.map((input) => {
    object(input, [
      "id",
      "title",
      "projectId",
      "allDay",
      "start",
      "end",
      "timeZone",
      "source",
      "readonly",
      "location",
    ]);
    if (input.source !== undefined)
      object(input.source, ["kind", "title", "url", "excerpt", "externalId"]);
    let event;
    try {
      event = validateCalendarEvent(input);
    } catch {
      throw fail(
        "invalid_sync",
        "Ein Kalendertermin ist ungültig. Es wurde noch nichts geschrieben.",
      );
    }
    if (event.readonly)
      throw fail(
        "readonly_event",
        "Importierte, schreibgeschützte Termine werden nicht veröffentlicht.",
        403,
      );
    if (ids.has(event.id))
      throw fail("invalid_sync", "Doppelte Termin-ID in der Synchronisierung.");
    ids.add(event.id);
    if (
      input.location !== undefined &&
      (typeof input.location !== "string" ||
        input.location.length > 1000 ||
        /[\u0000-\u001f\u007f]/.test(input.location))
    )
      throw fail("invalid_sync", "Ein Terminort ist ungültig.");
    const description = bodyText(
      [
        "Mit Context angelegt.",
        event.source.title,
        event.source.url,
        event.source.excerpt,
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
    const canonical = {
      subject: event.title,
      body: description,
      allDay: event.allDay,
      start: event.start,
      end: event.end,
      location: input.location?.trim() || "",
    };
    const payload = {
      subject: canonical.subject,
      body: { contentType: "text", content: canonical.body },
      isAllDay: canonical.allDay,
      start: {
        dateTime: event.allDay
          ? event.start + "T00:00:00"
          : event.start.slice(0, -1),
        timeZone: event.allDay ? "W. Europe Standard Time" : "UTC",
      },
      end: {
        dateTime: event.allDay
          ? event.end + "T00:00:00"
          : event.end.slice(0, -1),
        timeZone: event.allDay ? "W. Europe Standard Time" : "UTC",
      },
      location: { displayName: canonical.location },
    };
    const marker = sha256(
      "context-calendar-v1\0" + value.namespace.toLowerCase() + "\0" + event.id,
    );
    const fingerprint = sha256(JSON.stringify(canonical));
    return { event, payload, canonical, marker, fingerprint };
  });
  return {
    calendarId: externalID(value.calendarId),
    namespace: value.namespace.toLowerCase(),
    events,
  };
}

function remoteFingerprint(remote) {
  if (
    typeof remote.subject !== "string" ||
    remote.subject.length > 240 ||
    typeof remote.body?.content !== "string" ||
    remote.body.content.length > 12000 ||
    remote.body.contentType?.toLowerCase() !== "text" ||
    typeof remote.isAllDay !== "boolean" ||
    !Array.isArray(remote.attendees) ||
    remote.attendees.length ||
    remote.isOrganizer !== true ||
    remote.isCancelled !== false ||
    remote.isOnlineMeeting !== false ||
    remote.type !== "singleInstance" ||
    remote.recurrence != null ||
    typeof remote.location?.displayName !== "string" ||
    remote.location.displayName.length > 1000
  )
    return null;
  try {
    const utc = (v) => {
      if (v?.timeZone !== "UTC")
        throw new Error("Unsupported response timezone");
      return instant(
        /(?:Z|[+-]\d\d:\d\d)$/.test(v.dateTime || "")
          ? v.dateTime
          : v.dateTime + "Z",
      );
    };
    const midnight = (v) => {
      if (
        v?.timeZone !== "W. Europe Standard Time" ||
        !/^\d{4}-\d\d-\d\dT00:00:00(?:\.0{1,7})?$/.test(v.dateTime || "")
      )
        throw new Error("All-day event does not use Berlin midnight");
      return validDate(v.dateTime.slice(0, 10));
    };
    const start = remote.isAllDay ? midnight(remote.start) : utc(remote.start);
    const end = remote.isAllDay ? midnight(remote.end) : utc(remote.end);
    if (!start || !end || end <= start) return null;
    const canonical = {
      subject: remote.subject,
      body: bodyText(remote.body.content),
      allDay: remote.isAllDay,
      start,
      end,
      location: remote.location.displayName.trim(),
    };
    return {
      fingerprint: sha256(JSON.stringify(canonical)),
      canonical,
      start,
      end,
    };
  } catch {
    return null;
  }
}
const DRIVE_TYPES = [
  "application/vnd.google-apps.document",
  "application/vnd.google-apps.spreadsheet",
  "text/plain",
  "text/csv",
  "text/calendar",
  "application/ics",
];
const text = (value, max = 2000) =>
  typeof value === "string"
    ? value
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
        .slice(0, max)
    : "";
const line = (value, max) =>
  text(value, max)
    .replace(/[\r\n\t]/g, " ")
    .trim();
const object = (value, keys) => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !keys.includes(k))
  )
    throw fail("invalid_request", "Ungültige Kalender-Anfrage.");
  return value;
};
const providerID = (value) => {
  if (!["google", "outlook"].includes(value))
    throw fail("invalid_provider", "Unbekannter Kalender-Anbieter.");
  return value;
};
const externalID = (value) => {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    [".", ".."].includes(value) ||
    value.length > 2048 ||
    /[\u0000-\u0020\u007f]/.test(value)
  )
    throw fail("invalid_id", "Ungültige Kalender- oder Datei-ID.");
  return value;
};
const safeURL = (value) => {
  try {
    const u = new URL(value);
    return u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      !/[\u0000-\u0020\u007f]/.test(value) &&
      value.length <= 2000
      ? u.href
      : "";
  } catch {
    return "";
  }
};
const shortId = (provider, calendar, id) =>
  provider +
  "-" +
  createHash("sha256")
    .update(calendar + "\0" + id)
    .digest("hex")
    .slice(0, 32);

const EVENT_PAGE_LIMIT = 8, EVENT_RESULT_LIMIT = 2000;
// Compare provider-selected fields before skipping unsupported rows. An unstable
// page snapshot with one ID and contradictory times must never look consistent.
function rawEventFingerprint(provider, event) {
  const fields = provider === 'google'
    ? [event.summary, event.description, event.location, event.htmlLink, event.status,
       event.start?.date, event.start?.dateTime, event.start?.timeZone,
       event.end?.date, event.end?.dateTime, event.end?.timeZone]
    : [event.subject, event.isAllDay, event.location?.displayName, event.webLink, event.isCancelled,
       event.start?.dateTime, event.start?.timeZone, event.end?.dateTime, event.end?.timeZone,
       event.originalStartTimeZone, event.originalEndTimeZone];
  return sha256(JSON.stringify(fields));
}
// Google uses an opaque pageToken; Graph requires its complete nextLink.
// https://developers.google.com/workspace/calendar/api/v3/reference/events/list
// https://learn.microsoft.com/en-us/graph/paging
function nextEventPageURL(provider, data, initialURL, seen) {
  const value = provider === 'google' ? data.nextPageToken : data['@odata.nextLink'];
  if (value === undefined || value === '') return '';
  const invalid = () => fail('invalid_response', 'Die Kalender-Folgeseite konnte nicht sicher geprüft werden.', 502);
  if (typeof value !== 'string' || value.length > 20000 || /[\u0000-\u0020\u007f\\]/.test(value)) throw invalid();
  const initial = new URL(initialURL);
  let next, cursor;
  if (provider === 'google') {
    next = new URL(initialURL);
    next.searchParams.set('pageToken', value);
    cursor = value;
  } else {
    try { next = new URL(value); } catch { throw invalid(); }
    if (next.origin !== initial.origin || next.pathname !== initial.pathname ||
        next.protocol !== 'https:' || next.username || next.password || next.hash) throw invalid();
    const pagination = ['$skip', '$skiptoken', '$skipToken'];
    const keys = [...next.searchParams.keys()];
    if (new Set(keys).size !== keys.length ||
        keys.some(key => !initial.searchParams.has(key) && !pagination.includes(key)) ||
        [...initial.searchParams].some(([key, expected]) => next.searchParams.get(key) !== expected)) throw invalid();
    const pageKeys = pagination.filter(key => next.searchParams.has(key));
    if (pageKeys.length !== 1) throw invalid();
    const key = pageKeys[0], token = next.searchParams.get(key);
    if (!token || /[\u0000-\u0020\u007f\\]/.test(token) || (key === '$skip' && (!/^(?:0|[1-9]\d{0,15})$/.test(token) || !Number.isSafeInteger(Number(token))))) throw invalid();
    cursor = key.toLowerCase() + ':' + token;
  }
  if (seen.has(cursor)) throw invalid();
  seen.add(cursor);
  return next.href;
}
const plain = (value) =>
  text(value, 12000)
    .replace(/<[^>]{0,1000}>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
const cancelled = () => fail("cancelled", "Kalender-Anfrage abgebrochen.", 499);
const checkAbort = (signal) => {
  if (signal?.aborted) throw cancelled();
};
const instant = (value) => {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,7})?)?(?:Z|[+-]\d\d:\d\d)$/.test(
      value,
    ) ||
    !Number.isFinite(Date.parse(value))
  )
    throw fail(
      "invalid_range",
      "Bitte gültige Zeitpunkte mit Zeitzone angeben.",
    );
  return new Date(value).toISOString();
};
function range(value) {
  object(value, ["calendarId", "from", "to"]);
  const from = instant(value.from),
    to = instant(value.to),
    span = Date.parse(to) - Date.parse(from);
  if (span <= 0 || span > 180 * 86400000)
    throw fail(
      "invalid_range",
      "Der Kalenderzeitraum muss zwischen einem Moment und 180 Tagen liegen.",
    );
  return { calendarId: externalID(value.calendarId), from, to };
}
function validDate(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\d$/.test(value) ||
    !Number.isFinite(Date.parse(value + "T00:00:00Z")) ||
    new Date(value + "T00:00:00Z").toISOString().slice(0, 10) !== value
  )
    throw fail("invalid_response", "Ein Kalenderdatum ist ungültig.", 502);
  return value;
}
const WINDOWS_ZONES = {
  UTC: "UTC",
  "W. Europe Standard Time": "Europe/Berlin",
  "Romance Standard Time": "Europe/Paris",
  "Central Europe Standard Time": "Europe/Budapest",
  "Central European Standard Time": "Europe/Warsaw",
  "GMT Standard Time": "Europe/London",
  "Eastern Standard Time": "America/New_York",
  "Central Standard Time": "America/Chicago",
  "Mountain Standard Time": "America/Denver",
  "Pacific Standard Time": "America/Los_Angeles",
  "Tokyo Standard Time": "Asia/Tokyo",
  "India Standard Time": "Asia/Kolkata",
  "China Standard Time": "Asia/Shanghai",
  "AUS Eastern Standard Time": "Australia/Sydney",
};
function originalDate(value, zone) {
  if (typeof zone !== "string" || !zone || zone.length > 100) return null;
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: WINDOWS_ZONES[zone] || zone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      })
        .formatToParts(new Date(value))
        .map((p) => [p.type, p.value]),
    );
    // Graph's original*TimeZone is the creation timezone. If a later update
    // changed the all-day timezone, do not silently shift the calendar date.
    if (parts.hour !== "00" || parts.minute !== "00" || parts.second !== "00")
      return null;
    return parts.year + "-" + parts.month + "-" + parts.day;
  } catch {
    return null;
  }
}


export function createNangoCalendarProviders({nango, now = Date.now} = {}) {
  if (!nango || typeof nango.status !== "function" || typeof nango.proxy !== "function")
    throw fail("invalid_configuration", "Der Nango-Kalenderdienst ist nicht eingerichtet.");
  const states = Object.fromEntries(["google", "outlook"].map(provider => [provider, {
    config: {syncEnabled: false, driveEnabled: false}, epoch: 0,
    controllers: new Set(), syncing: null, calendars: new Map(), files: new Map(), calls: []
  }]));
  const bindings = new Map(), statusVersions = new Map();
  const serviceFor = provider => provider === "outlook" ? "outlook" : "google-calendar";
  const providerFor = service => service === "outlook" ? "outlook" : "google";
  const requiredCapability = service => service === "google-drive" ? "driveRead" : "calendarRead";
  const safeError = error => {
    if (error instanceof CalendarError) return error;
    const code = error?.code;
    if (["cancelled", "aborted"].includes(code) || error?.name === "AbortError") return cancelled();
    if (["reconnect_required", "not_connected", "not_configured"].includes(code) || error?.status === 401)
      return fail("reconnect_required", "Bitte das Nango-Kalenderkonto erneut verbinden.", 502);
    if (["permission_denied", "capability_required"].includes(code) || error?.status === 403)
      return fail("permission_denied", "Die Verbindung hat nicht die angefragten Kalenderrechte.", 403);
    if (error?.status === 412 || code === "conflict")
      return fail("conflict", "Der Outlook-Termin wurde inzwischen verändert und bleibt unverändert.", 409);
    if (error?.status === 429 || code === "provider_limit")
      return fail("provider_limit", "Der Kalender-Anbieter begrenzt die Zugriffe. Bitte später erneut versuchen.", 429);
    return fail("connection_failed", "Die Nango-Kalenderverbindung ist gerade nicht erreichbar.", 502);
  };
  function invalidateService(service) {
    const s = states[providerFor(service)];
    s.epoch++;
    for (const controller of s.controllers) controller.abort();
    if (service === "google-drive") s.files.clear();
    else s.calendars.clear();
  }
  async function refreshService(service, signal) {
    checkAbort(signal);
    const version = (statusVersions.get(service) || 0) + 1;
    statusVersions.set(service, version);
    let raw;
    try { raw = await nango.status(service); }
    catch (error) { checkAbort(signal); throw safeError(error); }
    checkAbort(signal);
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw fail("invalid_response", "Der Nango-Verbindungsstatus ist ungültig.", 502);
    const integrationId = typeof raw.integrationId === "string" ? raw.integrationId : "";
    const connectionId = typeof raw.connectionId === "string" ? raw.connectionId : "";
    const revision = raw.revision;
    if (typeof revision !== "string" || !/^(?:0|[1-9]\d{0,15}):(?:0|[1-9]\d{0,15})$/.test(revision))
      throw fail("invalid_response", "Die Nango-Verbindungsrevision ist ungültig.", 502);
    if (integrationId.length > 200 || connectionId.length > 512 || /[\u0000-\u0020\u007f]/.test(integrationId + connectionId) || raw.connected === true && (!integrationId || !connectionId))
      throw fail("invalid_response", "Die Nango-Verbindungskennung ist ungültig.", 502);
    const capabilities = Object.fromEntries(["calendarRead", "calendarWrite", "driveRead"].map(key => [key, raw.capabilities?.[key] === true]));
    const binding = {service, connected: raw.connected === true, integrationId, connectionId, revision, capabilities};
    binding.key = JSON.stringify([integrationId, connectionId, revision, binding.connected, capabilities]);
    const previous = bindings.get(service);
    if (version !== statusVersions.get(service)) {
      if (!previous || previous.key !== binding.key) throw cancelled();
      return previous;
    }
    if (previous && previous.key !== binding.key) invalidateService(service);
    bindings.set(service, Object.freeze(binding));
    if (service === "outlook") states.outlook.config.syncEnabled = binding.connected && capabilities.calendarRead && capabilities.calendarWrite;
    if (service === "google-drive") states.google.config.driveEnabled = binding.connected && capabilities.driveRead;
    return binding;
  }
  function requireAccess(binding) {
    if (!binding.connected) throw fail("reconnect_required", "Bitte das Nango-Kalenderkonto verbinden.", 409);
    if (!binding.capabilities[requiredCapability(binding.service)])
      throw fail("permission_denied", "Die Verbindung hat keine passenden Leserechte.", 403);
    return binding;
  }
  async function access(provider, signal, epoch) {
    const binding = requireAccess(await refreshService(serviceFor(provider), signal));
    if (states[provider].epoch !== epoch) throw cancelled();
    return binding;
  }
  async function statusOne(provider) {
    const binding = await refreshService(serviceFor(provider));
    const drive = provider === "google" ? await refreshService("google-drive") : null;
    return {
      configured: !!binding.integrationId, connected: binding.connected,
      connecting: false, clientId: "", storage: "nango", backend: "nango",
      readOnly: provider !== "outlook" || !states.outlook.config.syncEnabled,
      registrationRequired: !binding.integrationId,
      ...(provider === "google" ? {driveEnabled: !!drive?.connected && drive.capabilities.driveRead}
        : {tenant: "common", syncEnabled: states.outlook.config.syncEnabled, syncing: !!states.outlook.syncing})
    };
  }
  async function request(url, {binding, signal, type = "json", limit = 2000000, headers = {}, method = "GET", jsonBody} = {}) {
    checkAbort(signal);
    const parsed = new URL(url);
    const service = parsed.origin === "https://graph.microsoft.com" && parsed.pathname.startsWith("/v1.0/me/calendars") ? "outlook"
      : parsed.origin === GOOGLE && parsed.pathname.startsWith("/calendar/v3/") ? "google-calendar"
      : parsed.origin === GOOGLE && parsed.pathname.startsWith("/drive/v3/files") ? "google-drive" : "";
    if (!service || service !== binding?.service || parsed.username || parsed.password || parsed.hash || !["GET", "POST", "PATCH"].includes(method) || method !== "GET" && service !== "outlook")
      throw fail("invalid_request", "Ungültiges Kalender-Proxyziel.");
    const live = requireAccess(await refreshService(service, signal));
    if (live.key !== binding.key) throw cancelled();
    if (method !== "GET" && !live.capabilities.calendarWrite)
      throw fail("sync_not_enabled", "Kalender-Schreibrechte sind nicht ausdrücklich freigegeben.", 403);
    const activeSignal = AbortSignal.any([AbortSignal.timeout(20000), ...(signal ? [signal] : [])]);
    let response;
    try {
      response = await nango.proxy(service, {
        method, path: parsed.pathname, identity:{integrationId:binding.integrationId,connectionId:binding.connectionId,revision:binding.revision,capabilities:binding.capabilities},
        ...(parsed.search ? {params: Object.fromEntries(parsed.searchParams)} : {}),
        headers: {Accept: type === "json" ? "application/json" : "text/plain,text/csv,text/calendar", ...headers},
        ...(jsonBody ? {body: jsonBody} : {})
      }, activeSignal);
    } catch (error) { checkAbort(signal); throw safeError(error); }
    checkAbort(activeSignal);
    const after = await refreshService(service, signal);
    if (after.key !== binding.key) throw cancelled();
    if (!response || !Number.isInteger(response.status))
      throw fail("invalid_response", "Der Kalender-Proxy hat keine gültige Antwort geliefert.", 502);
    if (response.status < 200 || response.status >= 300)
      throw safeError({status: response.status});
    const contentType = Object.entries(response.headers || {}).find(([key]) => key.toLowerCase() === "content-type")?.[1]?.split(";")[0].trim().toLowerCase() || "";
    if (type === "text") {
      if (typeof response.data !== "string" || !["text/plain", "text/csv", "text/calendar", "application/octet-stream", "application/ics"].includes(contentType))
        throw fail("invalid_response", "Der Anbieter hat keinen gültigen Terminplan geliefert.", 502);
      if (Buffer.byteLength(response.data, "utf8") > limit) throw fail("response_limit", "Der Terminplan überschreitet die zulässige Größe.", 502);
      return response.data;
    }
    if (!contentType.includes("json") || !response.data || typeof response.data !== "object" || Array.isArray(response.data))
      throw fail("invalid_response", "Der Anbieter hat keine gültigen Kalenderdaten geliefert.", 502);
    if (Buffer.byteLength(JSON.stringify(response.data), "utf8") > limit)
      throw fail("response_limit", "Die Anbieterantwort ist zu groß. Grenze die Auswahl ein.", 502);
    return response.data;
  }
  async function read(provider, signal, fn, service = serviceFor(provider)) {
    const binding = requireAccess(await refreshService(service, signal));
    const s = states[provider], epoch = s.epoch, controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    s.controllers.add(controller);
    s.calls = s.calls.filter(time => now() - time < 60000);
    try {
      if (s.calls.length >= 30) throw fail("local_limit", "Höchstens 30 Kalenderzugriffe pro Minute. Bitte kurz warten.", 429);
      s.calls.push(now());
      const answer = await fn(binding, combined);
      checkAbort(combined);
      if (s.epoch !== epoch) throw cancelled();
      return answer;
    } finally { s.controllers.delete(controller); }
  }
  return {
    async status(provider) {
      return provider ? statusOne(providerID(provider))
        : Object.fromEntries(await Promise.all(["google", "outlook"].map(async provider => [provider, await statusOne(provider)])));
    },
    async calendars(provider, signal) {
      providerID(provider);
      return read(provider, signal, async (binding, activeSignal) => {
        const url =
          provider === "google"
            ? GOOGLE +
              "/calendar/v3/users/me/calendarList?maxResults=50&fields=items(id,summary,timeZone,primary),nextPageToken"
            : GRAPH +
              "/me/calendars?$top=50&$select=id,name,isDefaultCalendar,canEdit,canShare";
        const data = await request(url, { binding, signal: activeSignal }),
          items = provider === "google" ? data.items : data.value;
        if (!Array.isArray(items) || items.length > 50)
          throw fail(
            "invalid_response",
            "Die Kalenderliste ist ungültig.",
            502,
          );
        const calendars = items.map((c) => ({
          id: externalID(c.id),
          title:
            line(provider === "google" ? c.summary : c.name, 240) || "Kalender",
          timeZone:
            provider === "google"
              ? line(c.timeZone, 100) || "Europe/Berlin"
              : "Europe/Berlin",
          primary:
            provider === "google"
              ? c.primary === true
              : c.isDefaultCalendar === true,
          writable:
            provider === "outlook" && c.canEdit === true && c.canShare === true,
          canEdit: provider === "outlook" && c.canEdit === true,
        }));
        checkAbort(activeSignal);
        states[provider].calendars = new Map(calendars.map((c) => [c.id, c]));
        const truncated = !!(data.nextPageToken || data["@odata.nextLink"]);
        return {
          calendars,
          truncated,
          complete: !truncated,
          warnings: truncated
            ? ["Es werden die ersten 50 Kalender angezeigt."]
            : [],
        };
      });
    },
    async sync(provider, value, signal) {
      providerID(provider);
      if (provider === "outlook") await refreshService("outlook", signal);
      if (provider !== "outlook" || !states.outlook.config?.syncEnabled)
        throw fail(
          "sync_not_enabled",
          "Outlook-Synchronisierung muss ausdrücklich mit Kalender-Schreibrechten verbunden werden.",
          403,
        );
      const batch = syncBatch(value),
        s = states.outlook;
      if (!s.calendars.get(batch.calendarId)?.writable)
        throw fail(
          "readonly_calendar",
          "Wähle einen gelisteten eigenen, beschreibbaren Outlook-Kalender.",
          403,
        );
      if (s.syncing)
        throw fail("busy", "Eine Outlook-Synchronisierung läuft bereits.", 429);
      const epoch = s.epoch,
        controller = new AbortController();
      const activeSignal = signal
        ? AbortSignal.any([signal, controller.signal])
        : controller.signal;
      s.syncing = controller;
      s.controllers.add(controller);
      const results = [],
        base = GRAPH + "/me/calendars/" + encodeURIComponent(batch.calendarId),
        headers = {
          Prefer: 'outlook.timezone="UTC", outlook.body-content-type="text"',
        };
      let stopError;
      const assertActive = () => {
        checkAbort(activeSignal);
        if (s.epoch !== epoch) throw cancelled();
      };
      const failure = (entry, error, attempted = false) => ({
        id: entry.event.id,
        status:
          error.code === "conflict"
            ? "conflict"
            : attempted &&
                ![
                  "permission_denied",
                  "reconnect_required",
                  "provider_limit",
                ].includes(error.code)
              ? "unknown"
              : error.code === "cancelled"
                ? "cancelled"
                : "failed",
        error:
          attempted &&
          ![
            "conflict",
            "permission_denied",
            "reconnect_required",
            "provider_limit",
          ].includes(error.code)
            ? "Die Schreibantwort ist unklar. Der Termin könnte bereits angelegt oder geändert sein. Erneutes Synchronisieren mit derselben ID prüft ihn zuerst."
            : error.message,
        code: error.code,
        retrySafe: true,
      });
      try {
        s.calls = s.calls.filter((t) => now() - t < 60000);
        if (s.calls.length >= 30)
          throw fail(
            "local_limit",
            "Höchstens 30 Kalenderzugriffe pro Minute. Bitte kurz warten.",
            429,
          );
        s.calls.push(now());
        const binding = await access(provider, activeSignal, epoch);
        // Recheck ownership immediately before this batch; cached list permissions
        // alone cannot authorize writing after a calendar has been shared/moved.
        const target = await request(base + "?$select=id,canEdit,canShare", {
          binding,
          signal: activeSignal,
        });
        assertActive();
        if (
          target.id !== batch.calendarId ||
          target.canEdit !== true ||
          target.canShare !== true
        )
          throw fail(
            "readonly_calendar",
            "Dieser Outlook-Kalender ist nicht mehr als eigener, beschreibbarer Kalender bestätigt.",
            403,
          );
        for (const entry of batch.events) {
          if (stopError) {
            results.push(failure(entry, stopError));
            continue;
          }
          let attempted = false,
            remoteId,
            oldFingerprint,
            remoteCanonical,
            remoteEvent;
          try {
            assertActive();
            const prefix = "v1:" + entry.marker + ":";
            const query = new URLSearchParams({
              $top: "2",
              $filter:
                "singleValueExtendedProperties/Any(ep: ep/id eq '" +
                SYNC_PROPERTY +
                "' and startswith(ep/value,'" +
                prefix +
                "'))",
              $expand:
                "singleValueExtendedProperties($filter=id eq '" +
                SYNC_PROPERTY +
                "')",
            });
            const found = await request(base + "/events?" + query, {
              binding,
              signal: activeSignal,
              headers,
            });
            assertActive();
            if (!Array.isArray(found.value) || found.value.length > 2)
              throw fail(
                "invalid_response",
                "Die Outlook-Eigentumsprüfung hat ungültige Daten geliefert.",
                502,
              );
            if (found["@odata.nextLink"] || found.value.length > 1)
              throw fail(
                "conflict",
                "Mehrere passende Outlook-Termine gefunden. Es wird kein weiterer angelegt oder verändert.",
                409,
              );
            let remote;
            if (found.value.length) {
              remote = found.value[0];
              remoteId = externalID(remote.id);
              if (remote.isAllDay === true) {
                const dayQuery = new URLSearchParams({
                  $expand:
                    "singleValueExtendedProperties($filter=id eq '" +
                    SYNC_PROPERTY +
                    "')",
                });
                remote = await request(
                  base +
                    "/events/" +
                    encodeURIComponent(remoteId) +
                    "?" +
                    dayQuery,
                  {
                    binding,
                    signal: activeSignal,
                    headers: {
                      Prefer:
                        'outlook.timezone="W. Europe Standard Time", outlook.body-content-type="text"',
                    },
                  },
                );
                assertActive();
                if (remote.id !== remoteId)
                  throw fail(
                    "invalid_response",
                    "Outlook hat einen anderen Termin als erwartet zurückgegeben.",
                    502,
                  );
              }
              const property = Array.isArray(
                remote.singleValueExtendedProperties,
              )
                ? remote.singleValueExtendedProperties.filter(
                    (p) => p.id === SYNC_PROPERTY,
                  )
                : [];
              const matched =
                property.length === 1 &&
                typeof property[0].value === "string" &&
                property[0].value.startsWith(prefix)
                  ? property[0].value.slice(prefix.length)
                  : "";
              if (/^[a-f0-9]{64}$/.test(matched)) oldFingerprint = matched;
              const current = remoteFingerprint(remote);
              if (current) {
                remoteCanonical = current.canonical;
                remoteEvent = {
                  id: shortId(provider, batch.calendarId, remoteId),
                  title: remote.subject,
                  projectId: "",
                  allDay: remote.isAllDay,
                  start: current.start,
                  end: current.end,
                  timeZone: "Europe/Berlin",
                  readonly: true,
                  source: {
                    kind: provider,
                    title: s.calendars.get(batch.calendarId).title,
                    url:
                      safeURL(remote.webLink) ||
                      "https://outlook.office.com/calendar/",
                    excerpt: bodyText(remote.body.content).slice(0, 4000),
                    externalId: text(remoteId, 512),
                  },
                };
              }
              if (
                !oldFingerprint ||
                !current ||
                current.fingerprint !== oldFingerprint
              )
                throw fail(
                  "conflict",
                  "Dieser Outlook-Termin wurde außerhalb von Context verändert oder ist kein einfacher eigener Termin. Er bleibt unverändert.",
                  409,
                );
              if (entry.fingerprint === oldFingerprint) {
                results.push({
                  id: entry.event.id,
                  status: "unchanged",
                  remoteId,
                  url:
                    safeURL(remote.webLink) ||
                    "https://outlook.office.com/calendar/",
                  syncedAt: new Date(now()).toISOString(),
                  lastFingerprint: entry.fingerprint,
                  retrySafe: true,
                });
                continue;
              }
              if (
                typeof remote["@odata.etag"] !== "string" ||
                !/^(?:W\/)?"[^"\r\n]{1,1000}"$/.test(remote["@odata.etag"])
              )
                throw fail(
                  "conflict",
                  "Outlook liefert keinen gültigen Änderungsstand. Der Termin bleibt unverändert.",
                  409,
                );
            }
            // Preserve provider fields which did not change locally. In particular,
            // a title edit must not reset a user's location metadata or body format.
            const changes = remote ? {} : entry.payload;
            if (remote) {
              if (entry.canonical.subject !== remoteCanonical.subject)
                changes.subject = entry.payload.subject;
              if (entry.canonical.body !== remoteCanonical.body)
                changes.body = entry.payload.body;
              if (entry.canonical.allDay !== remoteCanonical.allDay)
                changes.isAllDay = entry.payload.isAllDay;
              if (
                entry.canonical.start !== remoteCanonical.start ||
                entry.canonical.allDay !== remoteCanonical.allDay
              )
                changes.start = entry.payload.start;
              if (
                entry.canonical.end !== remoteCanonical.end ||
                entry.canonical.allDay !== remoteCanonical.allDay
              )
                changes.end = entry.payload.end;
              if (entry.canonical.location !== remoteCanonical.location) {
                if (
                  (Array.isArray(remote.locations) &&
                    remote.locations.length > 1) ||
                  Object.values(remote.location.address || {}).some(Boolean) ||
                  Object.values(remote.location.coordinates || {}).some(
                    (v) => v !== null && v !== undefined,
                  )
                )
                  throw fail(
                    "conflict",
                    "Der Outlook-Ort enthält zusätzliche Nutzerdaten und bleibt unverändert.",
                    409,
                  );
                changes.location = entry.payload.location;
              }
            }
            const payload = {
              ...changes,
              singleValueExtendedProperties: [
                { id: SYNC_PROPERTY, value: prefix + entry.fingerprint },
              ],
              ...(!remote
                ? {
                    transactionId: sha256(
                      "context-transaction-v1\0" +
                        batch.namespace +
                        "\0" +
                        batch.calendarId +
                        "\0" +
                        entry.event.id,
                    ),
                    responseRequested: false,
                    allowNewTimeProposals: false,
                    isOnlineMeeting: false,
                  }
                : {}),
            };
            if (Buffer.byteLength(JSON.stringify(payload), "utf8") > 64000)
              throw fail(
                "invalid_sync",
                "Der Outlook-Termin überschreitet die zulässige Größe.",
              );
            assertActive();
            attempted = true;
            const saved = await request(
              base +
                "/events" +
                (remote ? "/" + encodeURIComponent(remoteId) : ""),
              {
                binding,
                signal: activeSignal,
                headers: {
                  ...headers,
                  ...(remote ? { "If-Match": remote["@odata.etag"] } : {}),
                },
                method: remote ? "PATCH" : "POST",
                jsonBody: payload,
              },
            );
            remoteId = externalID(saved?.id);
            if (remote && remoteId !== remote.id)
              throw fail(
                "invalid_response",
                "Outlook hat einen anderen Termin als erwartet zurückgegeben.",
                502,
              );
            assertActive();
            // Confirm both ownership metadata and normalized provider content.
            const verifyQuery = new URLSearchParams({
              $expand:
                "singleValueExtendedProperties($filter=id eq '" +
                SYNC_PROPERTY +
                "')",
            });
            const verified = await request(
              base +
                "/events/" +
                encodeURIComponent(remoteId) +
                "?" +
                verifyQuery,
              {
                binding,
                signal: activeSignal,
                headers: entry.event.allDay
                  ? {
                      Prefer:
                        'outlook.timezone="W. Europe Standard Time", outlook.body-content-type="text"',
                    }
                  : headers,
              },
            );
            assertActive();
            const normalized = remoteFingerprint(verified);
            if (
              verified.id !== remoteId ||
              !normalized ||
              normalized.fingerprint !== entry.fingerprint ||
              !Array.isArray(verified.singleValueExtendedProperties) ||
              verified.singleValueExtendedProperties.filter(
                (p) =>
                  p.id === SYNC_PROPERTY &&
                  p.value === prefix + entry.fingerprint,
              ).length !== 1
            )
              throw fail(
                "invalid_response",
                "Der veröffentlichte Outlook-Termin konnte nicht eindeutig bestätigt werden.",
                502,
              );
            results.push({
              id: entry.event.id,
              status: remote ? "updated" : "created",
              remoteId,
              url:
                safeURL(verified.webLink) ||
                "https://outlook.office.com/calendar/",
              syncedAt: new Date(now()).toISOString(),
              lastFingerprint: entry.fingerprint,
              retrySafe: true,
            });
          } catch (error) {
            const safe =
              error instanceof CalendarError
                ? error
                : fail(
                    "connection_failed",
                    "Die Outlook-Synchronisierung konnte nicht abgeschlossen werden.",
                    502,
                  );
            results.push({
              ...failure(entry, safe, attempted),
              ...(remoteId ? { remoteId } : {}),
              ...(oldFingerprint ? { lastFingerprint: oldFingerprint } : {}),
              ...(!attempted && remoteEvent && safe.code === "conflict"
                ? { remoteEvent }
                : {}),
            });
            if (activeSignal.aborted || s.epoch !== epoch)
              stopError = cancelled();
            else if (
              [
                "reconnect_required",
                "permission_denied",
                "provider_limit",
              ].includes(safe.code)
            )
              stopError = safe;
          }
        }
      } catch (error) {
        const safe =
          error instanceof CalendarError
            ? error
            : fail(
                "connection_failed",
                "Die Outlook-Synchronisierung konnte nicht begonnen werden.",
                502,
              );
        for (const entry of batch.events.slice(results.length))
          results.push(failure(entry, safe));
      } finally {
        s.controllers.delete(controller);
        if (s.syncing === controller) s.syncing = null;
      }
      const synced = results.filter((r) =>
        ["created", "updated", "unchanged"].includes(r.status),
      ).length;
      return {
        provider,
        calendarId: batch.calendarId,
        results,
        complete: synced === batch.events.length,
        cancelled: activeSignal.aborted || s.epoch !== epoch,
        synced,
        failed: results.length - synced,
      };
    },
    async events(provider, value, signal) {
      providerID(provider);
      const { calendarId, from, to } = range(value);
      await refreshService(serviceFor(provider), signal);
      if (!states[provider].calendars.has(calendarId))
        throw fail(
          "unknown_calendar",
          "Bitte zuerst einen gelisteten Kalender auswählen.",
        );
      return read(provider, signal, async (binding, activeSignal) => {
        const query =
          provider === "google"
            ? new URLSearchParams({
                timeMin: from,
                timeMax: to,
                singleEvents: "true",
                orderBy: "startTime",
                showDeleted: "false",
                maxResults: "250",
                fields:
                  "items(id,summary,description,location,htmlLink,status,start,end),nextPageToken",
              })
            : new URLSearchParams({
                startDateTime: from,
                endDateTime: to,
                $top: "250",
                $select:
                  "id,subject,start,end,isAllDay,location,webLink,isCancelled,originalStartTimeZone,originalEndTimeZone",
                $orderby: "start/dateTime",
              });
        const url =
          provider === "google"
            ? GOOGLE +
              "/calendar/v3/calendars/" +
              encodeURIComponent(calendarId) +
              "/events?" +
              query
            : GRAPH +
              "/me/calendars/" +
              encodeURIComponent(calendarId) +
              "/calendarView?" +
              query;
        const items = [], seenPages = new Set();
        let nextURL = url, pages = 0;
        while (nextURL && pages < EVENT_PAGE_LIMIT && items.length < EVENT_RESULT_LIMIT) {
          checkAbort(activeSignal);
          const data = await request(nextURL, {
            binding,
            signal: activeSignal,
            ...(provider === "outlook"
              ? { headers: { Prefer: 'outlook.timezone="UTC"' } }
              : {}),
          });
          checkAbort(activeSignal);
          const page = provider === "google" ? data?.items : data?.value;
          if (!Array.isArray(page) || page.length > 250 ||
              page.some(item => !item || typeof item !== 'object' || Array.isArray(item)) ||
              items.length + page.length > EVENT_RESULT_LIMIT)
            throw fail("invalid_response", "Die Terminliste ist ungültig.", 502);
          items.push(...page);
          pages++;
          nextURL = nextEventPageURL(provider, data, url, seenPages);
        }
        const rawById = new Map();
        for (const item of items) {
          const id = externalID(item.id), fingerprint = rawEventFingerprint(provider, item);
          const previous = rawById.get(id);
          if (previous && previous.fingerprint !== fingerprint)
            throw fail('invalid_response', 'Der Anbieter hat widersprüchliche Termine mit gleicher ID geliefert.', 502);
          if (!previous) rawById.set(id, { item, fingerprint });
        }
        const warnings = [];
        let skipped = 0, invalidPeriods = 0;
        const events = [...rawById.values()].map(entry => entry.item)
          .filter((e) => e.status !== "cancelled" && !e.isCancelled)
          .map((e) => {
            const externalId = externalID(e.id),
              allDay =
                provider === "google" ? !!e.start?.date : e.isAllDay === true;
            let start, end;
            if (provider === "google") {
              start = allDay
                ? validDate(e.start?.date)
                : instant(e.start?.dateTime);
              end = allDay ? validDate(e.end?.date) : instant(e.end?.dateTime);
            } else {
              const utc = (value) =>
                instant(
                  /(?:Z|[+-]\d\d:\d\d)$/.test(value || "")
                    ? value
                    : value + "Z",
                );
              const a = utc(e.start?.dateTime),
                b = utc(e.end?.dateTime);
              start = allDay ? originalDate(a, e.originalStartTimeZone) : a;
              end = allDay
                ? originalDate(
                    b,
                    e.originalEndTimeZone || e.originalStartTimeZone,
                  )
                : b;
              if (allDay && (!start || !end)) {
                skipped++;
                return null;
              }
            }
            if (end <= start) {
              invalidPeriods++;
              return null;
            }
            const title =
                line(provider === "google" ? e.summary : e.subject, 240) ||
                "Termin",
              location = text(
                provider === "google" ? e.location : e.location?.displayName,
                1000,
              ),
              description = provider === "google" ? plain(e.description) : "";
            const sourceURL =
              safeURL(provider === "google" ? e.htmlLink : e.webLink) ||
              (provider === "google"
                ? "https://calendar.google.com/calendar/u/0/r"
                : "https://outlook.office.com/calendar/");
            return {
              id: shortId(provider, calendarId, externalId),
              title,
              projectId: "",
              allDay,
              start,
              end,
              timeZone: "Europe/Berlin",
              location,
              source: {
                kind: provider,
                title:
                  states[provider].calendars.get(calendarId)?.title ||
                  "Kalender",
                url: sourceURL,
                excerpt: [title, start, location, description]
                  .filter(Boolean)
                  .join("\n")
                  .slice(0, 4000),
                externalId: text(externalId, 512),
              },
            };
          })
          .filter(Boolean);
        const byId = new Map();
        for (const event of events) {
          const previous = byId.get(event.id);
          if (previous && JSON.stringify(previous) !== JSON.stringify(event))
            throw fail('invalid_response', 'Der Anbieter hat widersprüchliche Termine mit gleicher ID geliefert.', 502);
          byId.set(event.id, event);
        }
        const truncated = !!nextURL;
        if (truncated)
          warnings.push(
            "Nach höchstens 8 Seiten oder 2.000 Termineinträgen wurde das Einlesen begrenzt. Der Kalender ist nicht vollständig synchronisiert. Wähle einen kleineren Zeitraum.",
          );
        if (skipped)
          warnings.push(
            skipped +
              " Outlook-Ganztagstermine wurden wegen unbekannter oder veränderter ursprünglicher Zeitzone übersprungen.",
          );
        if (invalidPeriods)
          warnings.push(
            invalidPeriods + (invalidPeriods === 1 ? " Termin ohne positive Dauer wurde" : " Termine ohne positive Dauer wurden") + " übersprungen. Es wurde keine Dauer ergänzt. Bereits gespeicherte Termine bleiben erhalten.",
          );
        return {
          events: [...byId.values()],
          from,
          to,
          truncated,
          complete: !truncated && !skipped && !invalidPeriods,
          warnings,
          pages,
        };
      });
    },
    async driveFiles(provider, signal) {
      providerID(provider);
      if (provider === "google") await refreshService("google-drive", signal);
      if (provider !== "google" || !states.google.config?.driveEnabled)
        throw fail(
          "drive_not_enabled",
          "Google Drive muss separat mit Leserechten verbunden werden.",
          403,
        );
      return read("google", signal, async (binding, activeSignal) => {
        const query = new URLSearchParams({
          pageSize: "50",
          q:
            "trashed = false and (" +
            DRIVE_TYPES.map((t) => "mimeType = '" + t + "'").join(" or ") +
            ")",
          fields: "files(id,name,mimeType,webViewLink,size),nextPageToken",
          orderBy: "modifiedTime desc",
        });
        const data = await request(GOOGLE + "/drive/v3/files?" + query, {
          binding,
          signal: activeSignal,
        });
        if (!Array.isArray(data.files) || data.files.length > 50)
          throw fail(
            "invalid_response",
            "Die Drive-Dateiliste ist ungültig.",
            502,
          );
        const files = data.files
          .filter((f) => DRIVE_TYPES.includes(f.mimeType))
          .map((f) => {
            if (typeof f.id !== "string" || !/^[-\w]{1,200}$/.test(f.id))
              throw fail(
                "invalid_response",
                "Die Drive-Datei-ID ist ungültig.",
                502,
              );
            return {
              id: f.id,
              title: line(f.name, 240) || "Terminplan",
              mimeType: f.mimeType,
              url:
                safeURL(f.webViewLink) ||
                "https://drive.google.com/file/d/" +
                  encodeURIComponent(f.id) +
                  "/view",
              ...(f.size ? { size: text(f.size, 30) } : {}),
            };
          });
        checkAbort(activeSignal);
        states.google.files = new Map(files.map((f) => [f.id, f]));
        const truncated = !!data.nextPageToken;
        return {
          files,
          truncated,
          complete: !truncated,
          warnings: truncated
            ? ["Es werden die ersten 50 passenden Drive-Dateien angezeigt."]
            : [],
        };
      }, "google-drive");
    },
    async driveText(provider, value, signal) {
      providerID(provider);
      object(value, ["fileId"]);
      if (provider === "google") await refreshService("google-drive", signal);
      if (provider !== "google" || !states.google.config?.driveEnabled)
        throw fail(
          "drive_not_enabled",
          "Google Drive ist nicht mit Leserechten verbunden.",
          403,
        );
      const id = externalID(value.fileId),
        file = states.google.files.get(id);
      if (!file)
        throw fail(
          "unknown_file",
          "Bitte eine zuvor gelistete Drive-Datei auswählen.",
        );
      if (file.size && Number(file.size) > 256000)
        throw fail(
          "file_limit",
          "Der Terminplan darf höchstens 256 KB groß sein.",
        );
      return read("google", signal, async (binding, activeSignal) => {
        const native = file.mimeType.startsWith("application/vnd.google-apps."),
          query = native
            ? "export?mimeType=" +
              encodeURIComponent(
                file.mimeType === "application/vnd.google-apps.spreadsheet"
                  ? "text/csv"
                  : "text/plain",
              )
            : "?alt=media";
        const url =
          GOOGLE +
          "/drive/v3/files/" +
          encodeURIComponent(id) +
          (native ? "/" : "") +
          query;
        const content = await request(url, {
          binding,
          signal: activeSignal,
          type: "text",
          limit: 256000,
        });
        return {
          title: file.title,
          url: file.url,
          text: content,
          mimeType: file.mimeType,
          externalId: id,
          warnings:
            file.mimeType === "application/vnd.google-apps.spreadsheet"
              ? [
                  "Der CSV-Export von Google Sheets enthält nur das erste Tabellenblatt. Weitere Blätter sind nicht eingelesen.",
                ]
              : [],
        };
      }, "google-drive");
    },
  };
}
