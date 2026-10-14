import {
  validateCalendarEvent,
  validateCalendarEvents,
  berlinLocalInput,
  berlinLocalToInstant,
  exportICS,
} from "./calendar-engine.js";

const keys = (v, allowed) =>
  v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.keys(v).every((k) => allowed.includes(k));
const bounded = (v, max) =>
  typeof v === "string" &&
  v.trim() &&
  v.length <= max &&
  !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v);
export function validateCalendarTool(args) {
  if (
    !keys(args, ["projectId", "events"]) ||
    typeof args.projectId !== "string" ||
    args.projectId.length > 80 ||
    !Array.isArray(args.events) ||
    !args.events.length ||
    args.events.length > 80
  )
    throw new Error(
      "Ein Kalenderauftrag benötigt 1–80 Termine und einen Kurs.",
    );
  for (const e of args.events) {
    if (
      !keys(e, ["title", "start", "end", "allDay", "sourceId", "excerpt"]) ||
      !bounded(e.title, 200) ||
      !bounded(e.start, 40) ||
      !bounded(e.end, 40) ||
      typeof e.allDay !== "boolean" ||
      !bounded(e.sourceId, 160) ||
      !bounded(e.excerpt, 1000)
    )
      throw new Error("Ungültiger Kalendertermin oder fehlender Quellenbeleg.");
    validateCalendarEvent({
      id: "validation",
      title: e.title,
      start: e.start,
      end: e.end,
      allDay: e.allDay,
    });
  }
  return args;
}
const months = [
  "januar",
  "februar",
  "märz",
  "april",
  "mai",
  "juni",
  "juli",
  "august",
  "september",
  "oktober",
  "november",
  "dezember",
];
const plain = (t) => String(t).toLowerCase().replace(/\s+/g, " ");
function dayIsExplicit(day, quote, source) {
  const [year, month, date] = day.split("-").map(Number),
    q = plain(quote);
  if (!new RegExp(`(?:^|\\D)${year}(?:\\D|$)`).test(source)) return false;
  const explicitYear = new RegExp(`(?:${day}|0?${date}\\s*[./]\\s*0?${month}\\s*[./]\\s*(?:${year}|${String(year).slice(-2)})(?![0-9:])|0?${date}\\.?\\s+(?:${months[month-1]}|${months[month-1].slice(0,3)}\\.?)\\s+${year})`).test(q);
  const sourceYears = new Set(source.match(/\b(?:19|20|21)[0-9]{2}\b/g) || []);
  if (!explicitYear && (sourceYears.size !== 1 || !sourceYears.has(String(year)))) return false;
  if (new RegExp(`(?:^|[^0-9])${day}(?:$|[^0-9])`).test(q)) return true;
  const numeric = [
    ...q.matchAll(/(?:^|[^\d])([0-9]{1,2})\s*[./]\s*([0-9]{1,2})(?![0-9])/g),
  ];
  if (
    numeric.some((m) => {
      if (Number(m[1]) !== date || Number(m[2]) !== month) return false;
      const tail = q.slice(m.index + m[0].length),
        explicit = tail.match(/^\s*[./]\s*([0-9]{4}|[0-9]{2})(?![0-9:])/);
      return (
        !explicit ||
        Number(explicit[1]) === (explicit[1].length === 2 ? year % 100 : year)
      );
    })
  )
    return true;
  const name = months[month - 1],
    pattern = new RegExp(
      `(?:^|\\D)0?${date}\\.?\\s+(?:${name}|${name.slice(0, 3)}\\.?)(?:\\s+([0-9]{4}))?(?=$|[^0-9])`,
      "g",
    );
  return [...q.matchAll(pattern)].some((m) => !m[1] || Number(m[1]) === year);
}
function sameClock(time, quote) {
  return new RegExp(
    `(?:^|\\D)${Number(time.slice(0, 2))}\\s*[:.]\\s*${time.slice(3, 5)}(?:\\D|$)`,
  ).test(quote.replace(/\b0(?=\d[:.])/g, ""));
}
export function calendarRequestAllowed(prompt) {
  const value=String(prompt).toLocaleLowerCase('de');
  // Ambiguous, negated or explanatory requests stay reviewable proposals.
  if (/\b(?:nicht|keine?\w*|niemals|nur|später|bevor|vorschlag|erkläre|erklären|anweisung|prüfe|prüfen|wie)\b/.test(value)) return false;
  return /\b(?:kalender|termine|terminplan|ics)\b/.test(value)&&/\b(?:erstelle|erstell|erstellen|importiere|importier|importieren|übernimm|übernehmen|trage|trag|lege|leg|speichere|speicher|mach|mache)\b/.test(value);
}
function sameRow(e,start,end,source) {
  return e.excerpt.split(/\r?\n|;|\s\|\s/).some(row=>{
    if(e.allDay)return !/\b[0-2]?[0-9]\s*:\s*[0-5][0-9]\b/.test(row)&&dayIsExplicit(start,row,source)&&dayIsExplicit(end,row,source);
    const instants=row.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})/g)||[];
    if(instants.some(t=>Date.parse(t)===Date.parse(e.start))&&instants.some(t=>Date.parse(t)===Date.parse(e.end)))return true;
    const dates = [...row.matchAll(/\b([0-9]{1,2})\s*[./]\s*([0-9]{1,2})(?![0-9])/g)].filter(m=>Number(m[1])<=31&&Number(m[2])>=1&&Number(m[2])<=12).map(m=>Number(m[1])+'.'+Number(m[2]));
    const clocks=[...row.matchAll(/\b([0-2]?[0-9])\s*:\s*([0-5][0-9])\b/g)].map(m=>Number(m[1])+':'+m[2]);
    if(new Set(dates).size>1||new Set(clocks).size>2)return false;
    if(!dayIsExplicit(start.slice(0,10),row,source)||!dayIsExplicit(end.slice(0,10),row,source)||!sameClock(start.slice(11),row)||!sameClock(end.slice(11),row))return false;
    try {
      // This also rejects ambiguous/nonexistent local clocks and invented seconds.
      return Date.parse(berlinLocalToInstant(start.slice(0,10),start.slice(11)))===Date.parse(e.start)&&Date.parse(berlinLocalToInstant(end.slice(0,10),end.slice(11)))===Date.parse(e.end);
    }catch{return false;}
  });
}
function identity(values) {
  let hash = 14695981039346656037n;
  for (const b of new TextEncoder().encode(JSON.stringify(values)))
    hash = ((hash ^ BigInt(b)) * 1099511628211n) & ((1n << 64n) - 1n);
  return hash.toString(16).padStart(16, "0");
}
export function calendarActionEvents(args, sources, workspace, scope = "") {
  validateCalendarTool(args);
  if (
    (scope && args.projectId !== scope) ||
    (args.projectId &&
      !workspace.projects.some((p) => p.id === args.projectId && !p.archived))
  )
    throw new Error("Die Termine liegen außerhalb des geöffneten Kurses.");
  const events = args.events.map((e) => {
    const doc = sources.find((d) => d.id === e.sourceId);
    if (
      !doc ||
      !["photo", "browser", "updates", "notes"].includes(doc.kind) ||
      doc.status === "metadata" ||
      typeof doc.text !== "string" ||
      !doc.text.includes(e.excerpt)
    )
      throw new Error(
        "Der Terminbeleg wurde nicht in einer gelesenen Quelle gefunden.",
      );
    if (doc.projectId && doc.projectId !== args.projectId)
      throw new Error("Die Terminquelle gehört zu einem anderen Kurs.");
    const start = e.allDay ? e.start : berlinLocalInput(e.start),
      end = e.allDay
        ? new Date(Date.parse(e.end + "T12:00:00Z") - 86400000)
            .toISOString()
            .slice(0, 10)
        : berlinLocalInput(e.end);
    if (!sameRow(e,start,end,doc.text))
      throw new Error(
        "Datum, Jahr oder Uhrzeiten sind im Quellenbeleg nicht eindeutig. Es wurde kein Termin geraten.",
      );
    const canonical = validateCalendarEvent({
      id: "validation",
      title: e.title,
      projectId: args.projectId,
      start: e.start,
      end: e.end,
      allDay: e.allDay,
    });
    const title = e.title.trim(),
      id =
        "agent-cal-" +
        identity([
          args.projectId,
          doc.url || doc.id,
          canonical.start,
          canonical.end,
          title.toLowerCase().replace(/\s+/g, " "),
        ]);
    return validateCalendarEvent(
      {
        ...canonical,
        id,
        title,
        source: {
          kind:
            doc.kind === "photo"
              ? "photo"
              : doc.kind === "browser" || doc.source === "spaces"
                ? "spaces"
                : "local",
          title: doc.title,
          url: doc.url || "",
          excerpt: e.excerpt,
          externalId: doc.id,
        },
      },
      { projectIds: workspace.projects.map((p) => p.id) },
    );
  });
  return validateCalendarEvents(
    [...new Map(events.map((e) => [e.id, e])).values()],
    { projectIds: workspace.projects.map((p) => p.id) },
  );
}
export function calendarICSForIds(ids, workspace) {
  if (
    !Array.isArray(ids) ||
    ids.length > 80 ||
    ids.some((id) => typeof id !== "string")
  )
    throw new Error("Ungültige Kalenderauswahl.");
  const events = ids.map((id) =>
    (workspace.calendarEvents || []).find((e) => e.id === id),
  );
  if (events.some((e) => !e))
    throw new Error(
      "Ein Termin wurde inzwischen entfernt. Öffne den Kalender für den aktuellen ICS-Export.",
    );
  return exportICS(
    validateCalendarEvents(events, {
      projectIds: workspace.projects.map((p) => p.id),
    }),
  );
}
export function prepareCalendarAction(action, workspace) {
  const events = calendarActionEvents(
    action.args,
    action.sources || [],
    workspace,
    action.scope,
  );
  const existing = workspace.calendarEvents || [],
    added = events.filter((e) => !existing.some((old) => old.id === e.id));
  const calendarEvents = validateCalendarEvents([...existing, ...added], {
    projectIds: workspace.projects.map((p) => p.id),
  });
  return { calendarEvents, added, eventIds: events.map((e) => e.id) };
}
export function undoCalendarEvents(existing, added) {
  for (const original of added) {
    const current = existing.find((e) => e.id === original.id);
    if (current && JSON.stringify(current) !== JSON.stringify(original))
      throw new Error(
        "Ein Termin wurde inzwischen bearbeitet. Öffne den Kalender, um deine Änderungen zu behalten.",
      );
  }
  const ids = new Set(added.map((e) => e.id));
  return existing.filter((e) => !ids.has(e.id));
}
