import { createServer } from "node:http";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { validateCalendarEvent } from "../dist/calendar-engine.js";

// Native public-client OAuth only. Credentials and refresh tokens never leave RAM.
// Reference: developers.google.com/identity/protocols/oauth2/native-app and
// learn.microsoft.com/entra/identity-platform/v2-oauth2-auth-code-flow.
export class CalendarError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
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
const CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events.readonly",
];
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
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

export function validateOAuthCallback(url, { state, redirectURI }) {
  const expected = new URL(redirectURI),
    actual = new URL(url, redirectURI);
  if (
    actual.origin !== expected.origin ||
    actual.pathname !== expected.pathname ||
    actual.searchParams.getAll("state").length !== 1
  )
    throw fail(
      "invalid_oauth_state",
      "Diese Anmeldung gehört nicht zur geöffneten Kalender-Verbindung.",
    );
  const supplied = actual.searchParams.get("state") || "",
    a = Buffer.from(supplied),
    b = Buffer.from(state);
  if (a.length !== b.length || !timingSafeEqual(a, b))
    throw fail(
      "invalid_oauth_state",
      "Diese Anmeldung gehört nicht zur geöffneten Kalender-Verbindung.",
    );
  if (actual.searchParams.has("error"))
    throw fail(
      "oauth_denied",
      "Die Anmeldung wurde abgelehnt. Prüfe die App-Registrierung und die angefragten Kalenderrechte.",
      403,
    );
  const code = actual.searchParams.get("code");
  if (
    actual.searchParams.getAll("code").length !== 1 ||
    typeof code !== "string" ||
    !code ||
    code.length > 8192 ||
    /[\u0000-\u0020\u007f]/.test(code)
  )
    throw fail(
      "invalid_oauth_code",
      "Die Anmeldung enthält keinen gültigen Code.",
    );
  return code;
}

export async function createOAuthCallback({
  provider,
  state,
  signal,
  timeoutMs = 300000,
}) {
  providerID(provider);
  checkAbort(signal);
  let resolveResult,
    rejectResult,
    redirectURI,
    settled = false,
    timer;
  const result = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  // Avoid a transient unhandled rejection if opening the browser fails first.
  result.catch(() => {});
  const server = createServer((req, res) => {
    const headers = {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
    };
    if (
      !redirectURI ||
      req.method !== "GET" ||
      req.headers.host !== new URL(redirectURI).host ||
      !["127.0.0.1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress)
    ) {
      res.writeHead(403, headers);
      return res.end("Ungültige Anmeldung.");
    }
    try {
      const code = validateOAuthCallback(req.url, { state, redirectURI });
      res.writeHead(200, headers);
      res.end(
        '<!doctype html><html lang="de"><meta charset="utf-8"><title>Context Kalender</title><h1>Anmeldung empfangen</h1><p>Du kannst dieses Fenster schließen und zu Context zurückkehren. Context prüft jetzt die Verbindung.</p></html>',
      );
      finish(null, code);
    } catch (error) {
      res.writeHead(error.code === "oauth_denied" ? 403 : 400, headers);
      res.end(
        "Die Anmeldung konnte nicht bestätigt werden. Kehre zu Context zurück.",
      );
      if (error.code === "oauth_denied") finish(error);
    }
  });
  server.maxConnections = 8;
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 1000;
  const close = () => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    server.close();
    server.closeIdleConnections?.();
  };
  function finish(error, code) {
    if (settled) return;
    settled = true;
    close();
    if (error) rejectResult(error);
    else resolveResult(code);
  }
  const onAbort = () => finish(cancelled());
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
  } catch {
    close();
    throw fail(
      "callback_unavailable",
      "Der lokale Anmeldeempfang konnte nicht gestartet werden.",
      503,
    );
  }
  redirectURI =
    "http://" +
    (provider === "outlook" ? "localhost" : "127.0.0.1") +
    ":" +
    server.address().port +
    "/oauth/callback";
  timer = setTimeout(
    () =>
      finish(
        fail(
          "oauth_timeout",
          "Die Anmeldung ist abgelaufen. Bitte erneut verbinden.",
          408,
        ),
      ),
    Math.min(300000, Math.max(1000, timeoutMs)),
  );
  timer.unref?.();
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  return { redirectURI, result, close: () => finish(cancelled()) };
}

async function responseBytes(response, limit) {
  const reader = response.body?.getReader();
  if (!reader)
    throw fail(
      "invalid_response",
      "Der Anbieter hat keine Antwort geliefert.",
      502,
    );
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit)
        throw fail(
          "response_limit",
          "Die Anbieterantwort ist zu groß. Grenze die Auswahl ein.",
          502,
        );
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
}

export function createCalendarProviders({
  fetcher = fetch,
  openExternal,
  now = Date.now,
  callbackFactory = createOAuthCallback,
} = {}) {
  const states = Object.fromEntries(
    ["google", "outlook"].map((id) => [
      id,
      {
        config: null,
        tokens: null,
        epoch: 0,
        connecting: null,
        controllers: new Set(),
        refreshing: null,
        syncing: null,
        calendars: new Map(),
        files: new Map(),
        calls: [],
      },
    ]),
  );
  const scopes = (provider, config) =>
    provider === "google"
      ? [...CALENDAR_SCOPES, ...(config.driveEnabled ? [DRIVE_SCOPE] : [])]
      : [
          "offline_access",
          "https://graph.microsoft.com/Calendars." +
            (config.syncEnabled ? "ReadWrite" : "ReadBasic"),
        ];
  const tokenURL = (provider, config) =>
    provider === "google"
      ? "https://oauth2.googleapis.com/token"
      : "https://login.microsoftonline.com/" +
        config.tenant +
        "/oauth2/v2.0/token";
  const authURL = (provider, config) =>
    provider === "google"
      ? "https://accounts.google.com/o/oauth2/v2/auth"
      : "https://login.microsoftonline.com/" +
        config.tenant +
        "/oauth2/v2.0/authorize";
  const statusOne = (provider) => {
    const s = states[provider];
    return {
      configured: !!s.config,
      connected: !!s.tokens,
      connecting: !!s.connecting,
      clientId: s.config?.clientId || "",
      ...(provider === "google"
        ? { driveEnabled: !!s.config?.driveEnabled }
        : {
            tenant: s.config?.tenant || "common",
            syncEnabled: !!s.config?.syncEnabled,
            syncing: !!s.syncing,
          }),
      storage: "session",
      readOnly: provider !== "outlook" || !s.config?.syncEnabled,
      ...(s.tokens
        ? { expiresAt: new Date(s.tokens.expiresAt).toISOString() }
        : {}),
      registrationRequired: !s.config,
    };
  };
  function clear(provider) {
    const s = states[provider];
    s.epoch++;
    s.connecting?.abort();
    s.connecting = null;
    for (const c of s.controllers) c.abort();
    s.tokens = null;
    s.refreshing = null;
    s.calendars.clear();
    s.files.clear();
  }
  async function request(
    url,
    {
      token,
      form,
      signal,
      type = "json",
      limit = 2000000,
      headers = {},
      method,
      jsonBody,
    } = {},
  ) {
    checkAbort(signal);
    try {
      const response = await fetcher(url, {
        method: method || (form ? "POST" : "GET"),
        headers: {
          Accept:
            type === "json"
              ? "application/json"
              : "text/plain,text/csv,text/calendar",
          ...(token ? { Authorization: "Bearer " + token } : {}),
          ...(form
            ? { "Content-Type": "application/x-www-form-urlencoded" }
            : {}),
          ...(jsonBody ? { "Content-Type": "application/json" } : {}),
          ...headers,
        },
        ...(form ? { body: form.toString() } : {}),
        ...(jsonBody ? { body: JSON.stringify(jsonBody) } : {}),
        redirect: "error",
        signal: AbortSignal.any([
          AbortSignal.timeout(20000),
          ...(signal ? [signal] : []),
        ]),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw fail(
          response.status === 401
            ? "reconnect_required"
            : response.status === 403
              ? "permission_denied"
              : response.status === 412
                ? "conflict"
                : response.status === 429
                  ? "provider_limit"
                  : "provider_error",
          response.status === 401
            ? "Bitte das Kalenderkonto erneut verbinden."
            : response.status === 403
              ? "Der Anbieter verweigert die angefragten Kalenderrechte. Prüfe die App-Registrierung und die Zustimmung."
              : response.status === 412
                ? "Der Outlook-Termin wurde inzwischen verändert und bleibt unverändert."
                : response.status === 429
                  ? "Der Kalender-Anbieter begrenzt die Zugriffe. Bitte später erneut versuchen."
                  : "Die Kalender-Verbindung konnte die Anfrage nicht beantworten.",
          response.status === 429 ? 429 : response.status === 412 ? 409 : 502,
        );
      }
      const contentType =
        response.headers
          .get("content-type")
          ?.split(";")[0]
          .trim()
          .toLowerCase() || "";
      if (
        (type === "json" && !contentType.includes("json")) ||
        (type === "text" &&
          ![
            "text/plain",
            "text/csv",
            "text/calendar",
            "application/octet-stream",
            "application/ics",
          ].includes(contentType))
      )
        throw fail(
          "invalid_response",
          "Der Anbieter hat keine gültigen Kalenderdaten geliefert.",
          502,
        );
      const bytes = await responseBytes(response, limit);
      return type === "json"
        ? JSON.parse(bytes.toString("utf8"))
        : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      if (error instanceof CalendarError) throw error;
      if (signal?.aborted) throw cancelled();
      throw fail(
        error?.name === "TimeoutError" ? "timeout" : "connection_failed",
        error?.name === "TimeoutError"
          ? "Der Kalender-Anbieter hat zu lange gebraucht."
          : "Der Kalender-Anbieter ist gerade nicht erreichbar.",
        502,
      );
    }
  }
  function acceptTokens(provider, data, config, previous) {
    if (
      !data ||
      typeof data.access_token !== "string" ||
      !data.access_token ||
      data.access_token.length > 16384 ||
      /[\u0000-\u0020\u007f]/.test(data.access_token) ||
      !Number.isFinite(data.expires_in) ||
      data.expires_in <= 0 ||
      data.expires_in > 86400 ||
      (data.token_type !== undefined &&
        (typeof data.token_type !== "string" ||
          data.token_type.toLowerCase() !== "bearer"))
    )
      throw fail(
        "invalid_token_response",
        "Die Anmeldung hat keine gültige Sitzung geliefert.",
        502,
      );
    const granted =
      typeof data.scope === "string"
        ? data.scope.split(/\s+/)
        : previous?.scopes;
    if (
      granted &&
      scopes(provider, config)
        .filter((s) => s !== "offline_access")
        .some(
          (required) =>
            !granted.includes(required) &&
            !granted.includes(
              required.replace("https://graph.microsoft.com/", ""),
            ),
        )
    )
      throw fail(
        "permission_denied",
        "Die angefragten Kalenderrechte wurden nicht vollständig bestätigt.",
        403,
      );
    const refresh =
      typeof data.refresh_token === "string"
        ? data.refresh_token
        : previous?.refreshToken;
    if (
      refresh &&
      (refresh.length > 16384 || /[\u0000-\u0020\u007f]/.test(refresh))
    )
      throw fail(
        "invalid_token_response",
        "Die Anmeldung hat keine gültige Sitzung geliefert.",
        502,
      );
    return {
      accessToken: data.access_token,
      refreshToken: refresh || "",
      expiresAt: now() + data.expires_in * 1000,
      scopes: granted,
    };
  }
  async function access(provider, signal, epoch) {
    const s = states[provider];
    checkAbort(signal);
    if (!s.tokens)
      throw fail(
        "not_connected",
        "Verbinde zuerst dein eigenes Kalenderkonto.",
        503,
      );
    if (s.tokens.expiresAt > now() + 30000) return s.tokens.accessToken;
    if (!s.tokens.refreshToken) {
      s.tokens = null;
      throw fail(
        "reconnect_required",
        "Die Sitzung ist abgelaufen. Bitte erneut verbinden.",
        401,
      );
    }
    if (!s.refreshing) {
      const old = s.tokens,
        config = s.config;
      const form = new URLSearchParams({
        grant_type: "refresh_token",
        client_id: config.clientId,
        refresh_token: old.refreshToken,
        ...(config.clientSecret ? { client_secret: config.clientSecret } : {}),
      });
      s.refreshing = request(tokenURL(provider, config), { form, signal })
        .then((data) => {
          if (s.epoch !== epoch) throw cancelled();
          s.tokens = acceptTokens(provider, data, config, old);
          return s.tokens.accessToken;
        })
        .catch((error) => {
          if (s.epoch === epoch) s.tokens = null;
          throw error;
        })
        .finally(() => {
          if (s.epoch === epoch) s.refreshing = null;
        });
    }
    const token = await s.refreshing;
    checkAbort(signal);
    if (s.epoch !== epoch) throw cancelled();
    return token;
  }
  async function read(provider, signal, fn) {
    const s = states[provider],
      epoch = s.epoch;
    const controller = new AbortController(),
      combined = signal
        ? AbortSignal.any([signal, controller.signal])
        : controller.signal;
    s.controllers.add(controller);
    s.calls = s.calls.filter((t) => now() - t < 60000);
    if (s.calls.length >= 30) {
      s.controllers.delete(controller);
      throw fail(
        "local_limit",
        "Höchstens 30 Kalenderzugriffe pro Minute. Bitte kurz warten.",
        429,
      );
    }
    s.calls.push(now());
    try {
      const token = await access(provider, combined, epoch);
      const answer = await fn(token, combined);
      checkAbort(combined);
      if (s.epoch !== epoch) throw cancelled();
      return answer;
    } catch (error) {
      if (error.code === "reconnect_required" && s.epoch === epoch)
        s.tokens = null;
      throw error;
    } finally {
      s.controllers.delete(controller);
    }
  }
  return {
    status(provider) {
      return provider
        ? statusOne(providerID(provider))
        : Object.fromEntries(
            ["google", "outlook"].map((p) => [p, statusOne(p)]),
          );
    },
    configure(provider, value) {
      providerID(provider);
      object(
        value,
        provider === "google"
          ? ["clientId", "driveEnabled", "clientSecret"]
          : ["clientId", "tenant", "syncEnabled"],
      );
      const valid =
        provider === "google"
          ? typeof value.clientId === "string" &&
            /^[A-Za-z0-9_-]{6,200}\.apps\.googleusercontent\.com$/.test(
              value.clientId,
            )
          : typeof value.clientId === "string" &&
            /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
              value.clientId,
            );
      if (!valid)
        throw fail(
          "invalid_client",
          "Bitte die Client-ID deiner eigenen Desktop-App-Registrierung eingeben.",
        );
      if (
        (provider === "google" &&
          value.driveEnabled !== undefined &&
          typeof value.driveEnabled !== "boolean") ||
        (provider === "outlook" &&
          value.syncEnabled !== undefined &&
          typeof value.syncEnabled !== "boolean") ||
        (value.clientSecret !== undefined &&
          (typeof value.clientSecret !== "string" ||
            !value.clientSecret ||
            value.clientSecret.length > 4096 ||
            /[\u0000-\u0020\u007f]/.test(value.clientSecret)))
      )
        throw fail("invalid_client", "Ungültige Desktop-App-Konfiguration.");
      const tenant = value.tenant || "common";
      if (
        provider === "outlook" &&
        !["common", "organizations", "consumers"].includes(tenant) &&
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
          tenant,
        )
      )
        throw fail(
          "invalid_tenant",
          "Bitte common, organizations, consumers oder eine Tenant-ID verwenden.",
        );
      clear(provider);
      states[provider].config = {
        clientId: value.clientId,
        ...(provider === "google"
          ? {
              driveEnabled: value.driveEnabled === true,
              ...(value.clientSecret
                ? { clientSecret: value.clientSecret }
                : {}),
            }
          : { tenant, syncEnabled: value.syncEnabled === true }),
      };
      return statusOne(provider);
    },
    async connect(provider, signal) {
      providerID(provider);
      const s = states[provider];
      if (!s.config)
        throw fail(
          "registration_required",
          "Für diese Verbindung fehlt deine eigene OAuth-Desktop-App-Client-ID.",
          503,
        );
      if (typeof openExternal !== "function")
        throw fail(
          "native_required",
          "Die sichere Konto-Anmeldung ist in der Context-Mac-App verfügbar.",
          503,
        );
      if (s.connecting)
        throw fail("busy", "Eine Konto-Anmeldung läuft bereits.", 429);
      clear(provider);
      const epoch = s.epoch,
        config = s.config,
        controller = new AbortController();
      s.connecting = controller;
      const combined = signal
        ? AbortSignal.any([signal, controller.signal])
        : controller.signal;
      let callback;
      try {
        const state = randomBytes(32).toString("base64url"),
          verifier = randomBytes(48).toString("base64url"),
          challenge = createHash("sha256").update(verifier).digest("base64url");
        callback = await callbackFactory({ provider, state, signal: combined });
        checkAbort(combined);
        const url = new URL(authURL(provider, config));
        for (const [key, value] of Object.entries({
          client_id: config.clientId,
          redirect_uri: callback.redirectURI,
          response_type: "code",
          scope: scopes(provider, config).join(" "),
          state,
          code_challenge: challenge,
          code_challenge_method: "S256",
          ...(provider === "google"
            ? { access_type: "offline", prompt: "consent" }
            : { response_mode: "query" }),
        }))
          url.searchParams.set(key, value);
        await openExternal(url.href);
        const code = await callback.result;
        checkAbort(combined);
        const form = new URLSearchParams({
          grant_type: "authorization_code",
          client_id: config.clientId,
          redirect_uri: callback.redirectURI,
          code,
          code_verifier: verifier,
          ...(config.clientSecret
            ? { client_secret: config.clientSecret }
            : {}),
        });
        const data = await request(tokenURL(provider, config), {
          form,
          signal: combined,
        });
        if (s.epoch !== epoch) throw cancelled();
        s.tokens = acceptTokens(provider, data, config);
        return statusOne(provider);
      } catch (error) {
        if (error instanceof CalendarError) throw error;
        if (combined.aborted) throw cancelled();
        throw fail(
          "oauth_failed",
          "Die Konto-Anmeldung konnte nicht abgeschlossen werden. Prüfe deine Desktop-App-Registrierung und versuche es erneut.",
          502,
        );
      } finally {
        callback?.close();
        if (s.epoch === epoch) s.connecting = null;
      }
    },
    disconnect(provider) {
      providerID(provider);
      clear(provider);
      return statusOne(provider);
    },
    async calendars(provider, signal) {
      providerID(provider);
      return read(provider, signal, async (token, activeSignal) => {
        const url =
          provider === "google"
            ? GOOGLE +
              "/calendar/v3/users/me/calendarList?maxResults=50&fields=items(id,summary,timeZone,primary),nextPageToken"
            : GRAPH +
              "/me/calendars?$top=50&$select=id,name,isDefaultCalendar,canEdit,canShare";
        const data = await request(url, { token, signal: activeSignal }),
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
        const token = await access(provider, activeSignal, epoch);
        // Recheck ownership immediately before this batch; cached list permissions
        // alone cannot authorize writing after a calendar has been shared/moved.
        const target = await request(base + "?$select=id,canEdit,canShare", {
          token,
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
              token,
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
                    token,
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
                token,
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
                token,
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
            if (safe.code === "reconnect_required" && s.epoch === epoch)
              s.tokens = null;
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
        if (safe.code === "reconnect_required" && s.epoch === epoch)
          s.tokens = null;
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
      if (!states[provider].calendars.has(calendarId))
        throw fail(
          "unknown_calendar",
          "Bitte zuerst einen gelisteten Kalender auswählen.",
        );
      return read(provider, signal, async (token, activeSignal) => {
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
            token,
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
      if (provider !== "google" || !states.google.config?.driveEnabled)
        throw fail(
          "drive_not_enabled",
          "Google Drive muss separat mit Leserechten verbunden werden.",
          403,
        );
      return read("google", signal, async (token, activeSignal) => {
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
          token,
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
      });
    },
    async driveText(provider, value, signal) {
      providerID(provider);
      object(value, ["fileId"]);
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
      return read("google", signal, async (token, activeSignal) => {
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
          token,
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
      });
    },
  };
}
