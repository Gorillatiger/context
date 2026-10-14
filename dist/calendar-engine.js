// Calendar data only: no network requests, alarms, credentials or provider writes.
export const CALENDAR_TIME_ZONE = "Europe/Berlin";
export const MAX_CALENDAR_EVENTS = 2000;
const SOURCE_KINDS = new Set([
  "local",
  "spaces",
  "drive",
  "outlook",
  "google",
  "ics",
  "photo",
]);
const encoder = new TextEncoder();
const berlin = new Intl.DateTimeFormat("en-GB", {
  timeZone: CALENDAR_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value, name, max, { empty = true, multiline = false } = {}) {
  if (value === undefined && empty) return "";
  if (
    typeof value !== "string" ||
    value.length > max ||
    (multiline ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/ : /[\x00-\x1f\x7f]/).test(
      value,
    )
  )
    throw new Error(`${name} ist ungültig oder zu lang.`);
  const out = value.trim();
  if (!empty && !out) throw new Error(`${name} fehlt.`);
  return out;
}
function date(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    value.startsWith("0000")
  )
    throw new Error("Ein gültiges Datum mit Jahreszahl wird benötigt.");
  const instant = new Date(value + "T12:00:00Z");
  if (
    !Number.isFinite(instant.getTime()) ||
    instant.toISOString().slice(0, 10) !== value
  )
    throw new Error("Ungültiges Kalenderdatum.");
  return value;
}
function nextDay(value) {
  const instant = new Date(date(value) + "T12:00:00Z");
  instant.setUTCDate(instant.getUTCDate() + 1);
  const result = instant.toISOString().slice(0, 10);
  return date(result);
}
function clock(value) {
  if (typeof value !== "string" || !/^\d{2}:\d{2}(?::\d{2})?$/.test(value))
    throw new Error("Ungültige Uhrzeit.");
  const [hour, minute, second = 0] = value.split(":").map(Number);
  if (hour > 23 || minute > 59 || second > 59)
    throw new Error("Ungültige Uhrzeit.");
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
}
function instant(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    )
  )
    throw new Error(
      "Termine mit Uhrzeit benötigen einen ISO-Zeitpunkt mit Zeitzone.",
    );
  date(value.slice(0, 10));
  clock(value.slice(11).replace(/(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/, ""));
  const offset = value.match(/[+-](\d{2}):(\d{2})$/);
  if (
    offset &&
    (Number(offset[1]) > 14 ||
      Number(offset[2]) > 59 ||
      (Number(offset[1]) === 14 && Number(offset[2]) !== 0))
  )
    throw new Error("Ungültiger Zeitzonenversatz.");
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()))
    throw new Error("Ungültiger ISO-Zeitpunkt.");
  return parsed.toISOString();
}
function parts(value) {
  return Object.fromEntries(
    berlin.formatToParts(new Date(value)).map((p) => [p.type, p.value]),
  );
}
function localString(value) {
  const p = parts(value);
  return `${p.year.padStart(4, "0")}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}
export function berlinLocalToInstant(day, time) {
  day = date(day);
  time = clock(time);
  const local = `${day}T${time}`,
    base = Date.parse(local + "Z");
  // Derive actual IANA offsets around the date, including both sides of a DST
  // transition, rather than assuming an offset or consulting the host timezone.
  const offsets = [
    ...new Set(
      [-36, 0, 36]
        .map((hours) => {
          const probe = base + hours * 3600000;
          return Date.parse(localString(probe) + "Z") - probe;
        })
        .filter(Number.isFinite),
    ),
  ];
  const candidates = offsets
    .map((offset) => new Date(base - offset).toISOString())
    .filter((value) => localString(value) === local);
  if (!candidates.length)
    throw new Error(
      "Diese Ortszeit existiert in Europe/Berlin wegen der Zeitumstellung nicht.",
    );
  if (candidates.length > 1)
    throw new Error(
      "Diese Ortszeit ist wegen der Zeitumstellung in Europe/Berlin doppeldeutig. Verwende einen ISO-Zeitpunkt mit explizitem Versatz.",
    );
  return candidates[0];
}
export function berlinDateTime(local) {
  if (
    typeof local !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(local)
  )
    throw new Error(
      "Ein Datum und eine Uhrzeit in Europe/Berlin werden benötigt.",
    );
  return berlinLocalToInstant(local.slice(0, 10), local.slice(11));
}
export function berlinLocalInput(value) {
  const p = parts(instant(value));
  return `${p.year.padStart(4, "0")}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
function url(value) {
  if (value === undefined || value === "") return "";
  if (
    typeof value !== "string" ||
    value.length > 2000 ||
    /[\x00-\x20\x7f]/.test(value)
  )
    throw new Error("Ungültiger Kalender-Quellenlink.");
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Ungültiger Kalender-Quellenlink.");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password)
    throw new Error("Quellenlinks benötigen HTTPS ohne Zugangsdaten.");
  return parsed.href;
}
function projectId(value, options) {
  const result = text(value, "Kurs-ID", 80);
  if (result && !/^[a-zA-Z0-9_-]+$/.test(result))
    throw new Error("Ungültige Kurs-ID.");
  if (
    result &&
    options.projectIds !== undefined &&
    (!Array.isArray(options.projectIds) || !options.projectIds.includes(result))
  )
    throw new Error("Der Kalendertermin gehört zu einem unbekannten Kurs.");
  return result;
}
export function validateCalendarEvent(value, options = {}) {
  if (!object(value)) throw new Error("Ungültiger Kalendertermin.");
  const id = text(value.id, "Termin-ID", 160, { empty: false });
  if (!/^[a-zA-Z0-9_:.@-]+$/.test(id)) throw new Error("Ungültige Termin-ID.");
  if (value.allDay !== undefined && typeof value.allDay !== "boolean")
    throw new Error("Ungültiger Ganztagsstatus.");
  if (value.readonly !== undefined && typeof value.readonly !== "boolean")
    throw new Error("Ungültiger Schreibschutz.");
  if (value.timeZone !== undefined && value.timeZone !== CALENDAR_TIME_ZONE)
    throw new Error("Der Kalender verwendet Europe/Berlin.");
  const allDay = value.allDay === true;
  const start = allDay ? date(value.start) : instant(value.start);
  const end = allDay ? date(value.end) : instant(value.end);
  if (end <= start)
    throw new Error(
      "Das Terminende muss nach dem Beginn liegen; bei Ganztagsterminen ist es exklusiv.",
    );
  const source = value.source === undefined ? { kind: "local" } : value.source;
  if (!object(source) || !SOURCE_KINDS.has(source.kind))
    throw new Error("Ungültige Kalenderquelle.");
  return {
    id,
    title: text(value.title, "Termintitel", 240, { empty: false }),
    projectId: projectId(value.projectId, options),
    start,
    end,
    allDay,
    timeZone: CALENDAR_TIME_ZONE,
    source: {
      kind: source.kind,
      title: text(source.title, "Quellentitel", 240),
      url: url(source.url),
      excerpt: text(source.excerpt, "Quellenbeleg", 4000, { multiline: true }),
      externalId: text(source.externalId, "Externe Termin-ID", 512),
    },
    readonly: value.readonly === true,
  };
}
export function validateCalendarEvents(values, options = {}) {
  if (!Array.isArray(values) || values.length > MAX_CALENDAR_EVENTS)
    throw new Error("Der Kalender unterstützt höchstens 2000 Termine.");
  const ids = new Set();
  return values.map((value) => {
    const event = validateCalendarEvent(value, options);
    if (ids.has(event.id)) throw new Error("Doppelte Kalender-Termin-ID.");
    ids.add(event.id);
    return event;
  });
}
// Stable IDs are identity keys, not cryptographic authentication.
function stableId(value) {
  const bytes = encoder.encode(JSON.stringify(value));
  const mask = (1n << 64n) - 1n;
  const hash = (seed) => {
    let n = seed;
    for (const b of bytes) n = ((n ^ BigInt(b)) * 1099511628211n) & mask;
    return n.toString(16).padStart(16, "0");
  };
  return hash(14695981039346656037n) + hash(7809847782465536322n);
}
function boundedInput(value) {
  if (
    typeof value !== "string" ||
    value.length > 2 * 1024 * 1024 ||
    value.includes("\0") ||
    encoder.encode(value).length > 2 * 1024 * 1024
  )
    throw new Error("Der Terminplan ist ungültig oder größer als 2 MiB.");
  return value.replace(/^\uFEFF/, "");
}
function unescapeICS(value) {
  return value.replace(/\\([\\,;nN])/g, (_, c) =>
    c === "n" || c === "N" ? "\n" : c,
  );
}
function escapeICS(value) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}
function splitQuoted(value, delimiter) {
  const result = [];
  let quoted = false,
    start = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '"') quoted = !quoted;
    if (value[i] === delimiter && !quoted) {
      result.push(value.slice(start, i));
      start = i + 1;
    }
  }
  if (quoted) throw new Error("Ungültige Anführungszeichen in ICS.");
  result.push(value.slice(start));
  return result;
}
function property(line) {
  const colon = (() => {
    let quote = false;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') quote = !quote;
      if (line[i] === ":" && !quote) return i;
    }
    return -1;
  })();
  if (colon < 1) throw new Error("Ungültige ICS-Eigenschaft.");
  const tokens = splitQuoted(line.slice(0, colon), ";"),
    name = tokens.shift().toUpperCase();
  if (!/^[A-Z0-9-]+$/.test(name)) throw new Error("Ungültige ICS-Eigenschaft.");
  const params = {};
  for (const token of tokens) {
    const equal = token.indexOf("="),
      key = token.slice(0, equal).toUpperCase();
    if (equal < 1 || !/^[A-Z0-9-]+$/.test(key) || Object.hasOwn(params, key))
      throw new Error("Ungültige ICS-Parameter.");
    const value = token.slice(equal + 1);
    params[key] =
      value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
  }
  return { name, params, value: line.slice(colon + 1) };
}
function icsDate(prop) {
  const valueType = prop.params.VALUE || "DATE-TIME";
  if (valueType === "DATE") {
    if (!/^\d{8}$/.test(prop.value) || prop.params.TZID)
      throw new Error("Ungültiges ganztägiges ICS-Datum.");
    return {
      allDay: true,
      value: date(
        `${prop.value.slice(0, 4)}-${prop.value.slice(4, 6)}-${prop.value.slice(6, 8)}`,
      ),
    };
  }
  if (valueType !== "DATE-TIME" || !/^\d{8}T\d{6}Z?$/.test(prop.value))
    throw new Error("Ungültiger ICS-Zeitpunkt.");
  const day = `${prop.value.slice(0, 4)}-${prop.value.slice(4, 6)}-${prop.value.slice(6, 8)}`;
  const time = `${prop.value.slice(9, 11)}:${prop.value.slice(11, 13)}:${prop.value.slice(13, 15)}`;
  if (prop.value.endsWith("Z")) {
    if (prop.params.TZID)
      throw new Error("ICS kombiniert UTC und TZID widersprüchlich.");
    return { allDay: false, value: instant(`${day}T${time}Z`) };
  }
  if (prop.params.TZID !== CALENDAR_TIME_ZONE)
    throw new Error(
      "ICS-Zeiten benötigen UTC oder TZID=Europe/Berlin; andere oder fehlende Zeitzonen werden nicht geraten.",
    );
  return { allDay: false, value: berlinLocalToInstant(day, time) };
}
export function importICS(
  input,
  { projectId: course = "", sourceTitle = "", sourceURL = "", projectIds } = {},
) {
  const body = boundedInput(input),
    sourceLink = url(sourceURL),
    events = [],
    warnings = [],
    uids = new Set();
  projectId(course, { projectIds });
  text(sourceTitle, "Quellentitel", 240);
  const lines = [];
  for (const line of body.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^[ \t]/.test(line)) {
      if (!lines.length)
        throw new Error("ICS beginnt mit einer ungültigen Fortsetzungszeile.");
      lines[lines.length - 1] += line.slice(1);
    } else if (line) lines.push(line);
    if (lines.at(-1)?.length > 20000)
      throw new Error("Eine ICS-Zeile ist zu lang.");
  }
  if (
    lines[0]?.toUpperCase() !== "BEGIN:VCALENDAR" ||
    lines.at(-1)?.toUpperCase() !== "END:VCALENDAR"
  )
    throw new Error("Die Datei ist kein vollständiger ICS-Kalender.");
  const versions = lines
    .filter((line) => /^VERSION[;:]/i.test(line))
    .map(property);
  if (
    versions.length !== 1 ||
    versions[0].value !== "2.0" ||
    Object.keys(versions[0].params).length
  )
    throw new Error("ICS benötigt genau VERSION:2.0.");
  let current = null,
    nested = [],
    outside = [],
    count = 0;
  function finish() {
    const label = `ICS-Termin ${++count}`;
    try {
      if (current.error) throw new Error(current.error);
      if (
        ["RRULE", "RDATE", "EXDATE", "RECURRENCE-ID"].some((name) =>
          current.props.some((p) => p.name === name),
        )
      )
        throw new Error(
          "Wiederholungsserie nicht importiert. RRULE/RDATE/EXDATE/RECURRENCE-ID müssen vorher in einzelne Vorkommen aufgelöst werden.",
        );
      const single = (name) => {
        const matches = current.props.filter((p) => p.name === name);
        if (matches.length > 1)
          throw new Error(`Mehrfache ICS-Eigenschaft ${name}.`);
        return matches[0];
      };
      const uid = single("UID"),
        begin = single("DTSTART"),
        ending = single("DTEND"),
        summary = single("SUMMARY");
      if (!uid || !begin || !summary)
        throw new Error("UID, DTSTART oder SUMMARY fehlt.");
      const externalId = text(
        unescapeICS(uid.value),
        "Externe Termin-ID",
        512,
        { empty: false },
      );
      if (uids.has(externalId))
        throw new Error("Doppelte UID nicht erneut importiert.");
      if (single("STATUS")?.value.toUpperCase() === "CANCELLED")
        throw new Error("Abgesagter Termin nicht importiert.");
      if (single("DURATION"))
        throw new Error(
          "DURATION wird nicht unterstützt; ein explizites DTEND wird benötigt.",
        );
      const start = icsDate(begin);
      if (!ending && !start.allDay)
        throw new Error("Termin mit Uhrzeit hat kein explizites Ende.");
      const end = ending
        ? icsDate(ending)
        : { allDay: true, value: nextDay(start.value) };
      if (end.allDay !== start.allDay)
        throw new Error("DTSTART und DTEND haben verschiedene Datumstypen.");
      const description = single("DESCRIPTION"),
        link = single("URL");
      const event = validateCalendarEvent(
        {
          id: "ics-" + stableId([sourceLink, externalId]),
          title: unescapeICS(summary.value),
          projectId: course,
          allDay: start.allDay,
          start: start.value,
          end: end.value,
          source: {
            kind: "ics",
            title: sourceTitle,
            url: link ? link.value : sourceLink,
            excerpt: description ? unescapeICS(description.value) : "",
            externalId,
          },
        },
        { projectIds },
      );
      if (events.length >= MAX_CALENDAR_EVENTS)
        throw new Error(
          "Mehr als 2000 Termine; weitere Termine nicht übernommen.",
        );
      events.push(event);
      uids.add(externalId);
      if (current.alarm)
        warnings.push(
          `${label}: Alarm ignoriert; Context übernimmt keine Alarme.`,
        );
    } catch (error) {
      warnings.push(`${label}: ${error.message}`);
    }
  }
  for (const line of lines.slice(1, -1)) {
    let prop;
    try {
      prop = property(line);
    } catch (error) {
      if (current) current.error = error.message;
      else warnings.push(error.message);
      continue;
    }
    if (prop.name === "BEGIN") {
      const kind = prop.value.toUpperCase();
      if (kind === "VCALENDAR")
        throw new Error(
          "Verschachtelte ICS-Kalender werden nicht unterstützt.",
        );
      if (kind === "VEVENT" && !current && !outside.length)
        current = { props: [], alarm: false };
      else if (current) {
        if (kind === "VALARM") current.alarm = true;
        else
          current.error =
            "Unbekannte oder verschachtelte ICS-Komponente im Termin.";
        nested.push(kind);
      } else {
        if (!outside.length && kind !== "VTIMEZONE")
          warnings.push(`ICS-Komponente ${kind} nicht als Termin importiert.`);
        outside.push(kind);
      }
      continue;
    }
    if (prop.name === "END") {
      const kind = prop.value.toUpperCase();
      if (nested.length) {
        if (nested.pop() !== kind && current)
          current.error = "Unvollständige verschachtelte ICS-Komponente.";
      } else if (kind === "VEVENT" && current) {
        finish();
        current = null;
      } else if (current) current.error = "Unvollständiger ICS-Termin.";
      else if (!outside.length || outside.pop() !== kind)
        throw new Error("Unvollständige ICS-Komponentenstruktur.");
      continue;
    }
    if (current && !nested.length) current.props.push(prop);
  }
  if (current || nested.length)
    warnings.push("Unvollständiger ICS-Termin nicht importiert.");
  if (outside.length)
    throw new Error("Unvollständige ICS-Komponentenstruktur.");
  return { events: validateCalendarEvents(events, { projectIds }), warnings };
}
function foldICS(line) {
  const lines = [];
  let current = "",
    length = 0;
  for (const character of line) {
    const size = encoder.encode(character).length;
    if (length + size > 75) {
      lines.push(current);
      current = " ";
      length = 1;
    }
    current += character;
    length += size;
  }
  lines.push(current);
  return lines.join("\r\n");
}
function icsInstant(value) {
  const normalized = instant(value);
  if (!normalized.endsWith(".000Z"))
    throw new Error(
      "ICS unterstützt hier nur volle Sekunden; Millisekunden werden nicht still abgeschnitten.",
    );
  return normalized.replace(/[-:]/g, "").replace(/\.000Z$/, "Z");
}
export function exportICS(
  values,
  { generatedAt = "1970-01-01T00:00:00Z" } = {},
) {
  const events = validateCalendarEvents(values),
    stamp = icsInstant(generatedAt);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Context//Local Calendar//DE",
    "CALSCALE:GREGORIAN",
  ];
  for (const event of events) {
    // Provider IDs may be reused across accounts or calendars. Context event IDs
    // are unique within this export and remain stable when titles/times change.
    lines.push(
      "BEGIN:VEVENT",
      "UID:" + escapeICS(event.id + "@context.local"),
      "DTSTAMP:" + stamp,
      "SUMMARY:" + escapeICS(event.title),
      event.allDay
        ? "DTSTART;VALUE=DATE:" + event.start.replace(/-/g, "")
        : "DTSTART:" + icsInstant(event.start),
      event.allDay
        ? "DTEND;VALUE=DATE:" + event.end.replace(/-/g, "")
        : "DTEND:" + icsInstant(event.end),
    );
    if (event.source.excerpt)
      lines.push("DESCRIPTION:" + escapeICS(event.source.excerpt));
    if (event.source.url) lines.push("URL:" + event.source.url);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldICS).join("\r\n") + "\r\n";
}

function csvRows(input, delimiter) {
  const rows = [];
  let cells = [],
    value = "",
    raw = "",
    quoted = false,
    closed = false;
  const endCell = () => {
    cells.push(value.trim());
    value = "";
    closed = false;
  };
  const endRow = () => {
    endCell();
    if (cells.some(Boolean)) rows.push({ cells, raw: raw.trim() });
    cells = [];
    raw = "";
  };
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    raw += c;
    if (quoted) {
      if (c === '"' && input[i + 1] === '"') {
        value += '"';
        raw += input[++i];
      } else if (c === '"') {
        quoted = false;
        closed = true;
      } else value += c;
    } else if (c === '"') {
      if (value.trim() || closed)
        throw new Error("Ungültige CSV-Anführungszeichen.");
      quoted = true;
    } else if (c === delimiter) endCell();
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && input[i + 1] === "\n") raw += input[++i];
      endRow();
    } else {
      if (closed && c.trim())
        throw new Error("Unerwarteter Text nach CSV-Anführungszeichen.");
      value += c;
    }
    if (rows.length > 5000)
      throw new Error("Der Terminplan hat mehr als 5000 Zeilen.");
  }
  if (quoted) throw new Error("Unvollständige CSV-Anführungszeichen.");
  if (value || cells.length || raw.trim()) endRow();
  return rows;
}
const DATE_PATTERN = /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}\.\d{1,2}\.\d{4})\b/g;
function datesIn(line) {
  return [...line.matchAll(DATE_PATTERN)].map((match) => {
    const literal = match[0],
      pieces = literal.split(".");
    return {
      literal,
      value:
        pieces.length === 3
          ? `${pieces[2]}-${pieces[1].padStart(2, "0")}-${pieces[0].padStart(2, "0")}`
          : literal,
    };
  });
}
const headerName = (value) =>
  value
    .toLocaleLowerCase("de")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z]/g, "");
export function proposeCalendarEvents(
  input,
  {
    kind = "spaces",
    projectId: course = "",
    title = "",
    url: sourceURL = "",
    projectIds,
  } = {},
) {
  const body = boundedInput(input),
    link = url(sourceURL),
    events = [],
    warnings = [],
    ids = new Set();
  if (!SOURCE_KINDS.has(kind)) throw new Error("Ungültige Kalenderquelle.");
  projectId(course, { projectIds });
  title = text(title, "Quellentitel", 240);
  const first = body.split(/\r?\n/, 1)[0] || "";
  const delimiter = first.includes(";")
    ? ";"
    : first.includes("\t")
      ? "\t"
      : first.includes(",")
        ? ","
        : "";
  let rows;
  try {
    rows = delimiter
      ? csvRows(body, delimiter)
      : body
          .split(/\r?\n/)
          .map((raw) => ({ cells: [raw], raw }))
          .filter((r) => r.raw.trim());
  } catch (error) {
    return { events: [], warnings: [error.message] };
  }
  if (rows.length > 5000)
    throw new Error("Der Terminplan hat mehr als 5000 Zeilen.");
  const headers = rows[0]?.cells.map(headerName) || [];
  const dateIndex = headers.findIndex((h) =>
    ["datum", "date", "startdatum", "startdate"].includes(h),
  );
  const titleIndex = headers.findIndex((h) =>
    [
      "titel",
      "title",
      "termin",
      "veranstaltung",
      "event",
      "summary",
      "bezeichnung",
    ].includes(h),
  );
  const startIndex = headers.findIndex((h) =>
    [
      "beginn",
      "start",
      "startzeit",
      "von",
      "begin",
      "starttime",
      "uhrzeit",
      "time",
    ].includes(h),
  );
  const endIndex = headers.findIndex((h) =>
    ["ende", "end", "endzeit", "bis", "endtime"].includes(h),
  );
  const hasHeader = dateIndex !== -1;
  for (const [index, row] of rows.entries()) {
    if (hasHeader && index === 0) continue;
    const label = `Zeile ${index + 1}`,
      content = row.cells.join(" ").trim(),
      evidence = row.raw.trim();
    try {
      if (evidence.length > 4000)
        throw new Error(
          "Zeile ist zu lang für einen nachvollziehbaren Quellenbeleg.",
        );
      if (hasHeader && row.cells.length !== headers.length)
        throw new Error("CSV-Spalten passen nicht zur Kopfzeile.");
      const dateText = hasHeader ? row.cells[dateIndex] : content;
      const matches = datesIn(dateText);
      if (!matches.length)
        throw new Error(
          "Kein vollständiges Datum mit Jahreszahl; keine Frist geraten.",
        );
      const uniqueDates = [...new Set(matches.map((m) => date(m.value)))];
      if (uniqueDates.length !== 1)
        throw new Error("Mehrere Daten; Beginn und Ende sind nicht eindeutig.");
      const day = uniqueDates[0];
      if (/\d{1,2}:\d{2}(?::\d{2})?Z\b|\b(?:UTC|GMT|CET|CEST)\b/i.test(content))
        throw new Error(
          "Explizite fremde Zeitangabe im Text; bitte als ICS mit Zeitzone importieren, statt eine Berliner Ortszeit zu raten.",
        );
      const normalizeClock = (value) =>
        value.padStart(
          value.includes(":", value.indexOf(":") + 1) ? 8 : 5,
          "0",
        );
      let times;
      if (hasHeader && (startIndex !== -1 || endIndex !== -1)) {
        if (startIndex === -1 || endIndex === -1)
          throw new Error(
            "CSV-Zeitspannen benötigen Beginn- und Ende-Spalten.",
          );
        const values = [row.cells[startIndex], row.cells[endIndex]];
        if (values.every((value) => !value)) times = [];
        else {
          if (values.some((value) => !/^\d{1,2}:\d{2}(?::\d{2})?$/.test(value)))
            throw new Error(
              "CSV-Zeitspanne hat ungültigen Beginn oder ungültiges Ende.",
            );
          times = values.map(normalizeClock);
        }
      } else
        times = [...content.matchAll(/\b(\d{1,2}:\d{2}(?::\d{2})?)\b/g)].map(
          (m) => normalizeClock(m[1]),
        );
      if (times.length && times.length !== 2)
        throw new Error(
          "Eine Uhrzeit allein oder mehrere Zeitspannen geben kein eindeutiges Terminende an.",
        );
      const columnTimes =
        delimiter &&
        !hasHeader &&
        row.cells.filter((cell) => /^\d{1,2}:\d{2}(?::\d{2})?$/.test(cell))
          .length === 2;
      if (
        times.length === 2 &&
        !(hasHeader && startIndex !== -1 && endIndex !== -1) &&
        !columnTimes &&
        !/\d{1,2}:\d{2}(?::\d{2})?\s*(?:Uhr\s*)?(?:bis|[–—-])\s*\d{1,2}:\d{2}/i.test(
          content,
        )
      )
        throw new Error(
          "Beginn und Ende der Zeitspanne sind nicht eindeutig verbunden.",
        );
      const allDay = times.length === 0;
      const start = allDay ? day : berlinLocalToInstant(day, times[0]);
      const end = allDay ? nextDay(day) : berlinLocalToInstant(day, times[1]);
      let eventTitle =
        hasHeader && titleIndex !== -1
          ? row.cells[titleIndex]
          : content
              .replace(DATE_PATTERN, "")
              .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, "")
              .replace(
                /\b(?:Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonntag|bis|von|Uhr)\b/gi,
                "",
              )
              .replace(/[;|\t]/g, " ")
              .replace(/^[\s,–—:-]+|[\s,–—:-]+$/g, "");
      eventTitle = (eventTitle || title || "Termin aus dem Terminplan")
        .replace(/\s+/g, " ")
        .trim();
      const id =
        "plan-" +
        stableId([
          course,
          kind,
          link,
          eventTitle.toLocaleLowerCase("de"),
          start,
          end,
        ]);
      if (ids.has(id)) {
        warnings.push(`${label}: Doppelter Termin nicht erneut vorgeschlagen.`);
        continue;
      }
      const event = validateCalendarEvent(
        {
          id,
          title: eventTitle,
          projectId: course,
          start,
          end,
          allDay,
          source: { kind, title, url: link, excerpt: evidence, externalId: id },
        },
        { projectIds },
      );
      if (events.length >= MAX_CALENDAR_EVENTS)
        throw new Error(
          "Mehr als 2000 Termine; weitere Vorschläge nicht übernommen.",
        );
      events.push(event);
      ids.add(id);
    } catch (error) {
      warnings.push(`${label}: ${error.message}`);
    }
  }
  return { events: validateCalendarEvents(events, { projectIds }), warnings };
}

export function taskEvents(workspace) {
  const tasks = workspace?.tasks || [],
    projects = workspace?.projects || [];
  const events = [];
  for (const task of tasks) {
    if (
      !task.due ||
      task.status === "done" ||
      (task.projectId &&
        !projects.some((p) => p.id === task.projectId && !p.archived))
    )
      continue;
    const day = date(task.due),
      taskId = text(task.id, "Aufgaben-ID", 80, { empty: false });
    events.push(
      validateCalendarEvent({
        id: "task-" + stableId(taskId),
        title: task.title,
        projectId: task.projectId || "",
        allDay: true,
        start: day,
        end: nextDay(day),
        readonly: true,
        source: {
          kind: "local",
          title: "Abgabefrist · Aufgabe",
          url: task.url || "",
          excerpt: task.title,
          externalId: taskId,
        },
      }),
    );
  }
  return validateCalendarEvents(events);
}
