// Local data and deterministic proposals only. Remote status is display data;
// native publication requires its own reviewed request and authoritative ledger.
import { validateCalendarEvent } from "./calendar-engine.js";

export const DEV_DIARY_TIME_ZONE = "Europe/Berlin";
export const DEFAULT_DIARY_DAYS = 14;
export const MAX_DEV_DIARIES = 100;
export const MAX_DIARY_DAYS = 366;
export const MAX_DIARY_FIELD = 4000;
export const MAX_DIARY_TEXT = 100000;
const DAY = 86400000;
const FIELDS = ["done", "learned", "problems", "next"];
const REMOTE_STATUSES = new Set(["draft", "pending", "unknown", "published", "error"]);
const berlin = new Intl.DateTimeFormat("sv-SE", {
  timeZone: DEV_DIARY_TIME_ZONE,
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

function object(value, keys, name) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error(`${name} ist ungültig oder enthält unerlaubte Felder.`);
  return value;
}
function text(value, name, max, { required = false, multiline = false } = {}) {
  if (value === undefined && !required) return "";
  if (typeof value !== "string" || value.length > max ||
      (multiline ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/ : /[\x00-\x1f\x7f]/).test(value))
    throw new Error(`${name} ist ungültig oder zu lang.`);
  const out = value.replace(/\r\n?/g, "\n").trim();
  if (required && !out) throw new Error(`${name} fehlt.`);
  return out;
}
function identifier(value, name = "Diary-ID") {
  const out = text(value, name, 80, { required: true });
  if (!/^[a-zA-Z0-9_-]+$/.test(out)) throw new Error(`${name} ist ungültig.`);
  return out;
}
function day(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000"))
    throw new Error("Ein gültiges Diary-Datum wird benötigt.");
  const instant = new Date(value + "T12:00:00Z");
  if (!Number.isFinite(instant.getTime()) || instant.toISOString().slice(0, 10) !== value)
    throw new Error("Ungültiges Diary-Datum.");
  return value;
}
function shiftDay(value, count) {
  const instant = new Date(day(value) + "T12:00:00Z");
  instant.setUTCDate(instant.getUTCDate() + count);
  return day(instant.toISOString().slice(0, 10));
}
function periodDays(start, end) {
  const count = Math.round((Date.parse(day(end) + "T12:00:00Z") - Date.parse(day(start) + "T12:00:00Z")) / DAY) + 1;
  if (count < 1 || count > MAX_DIARY_DAYS)
    throw new Error(`Eine Diary-Laufzeit umfasst 1 bis ${MAX_DIARY_DAYS} Tage.`);
  return count;
}
function duration(value = DEFAULT_DIARY_DAYS) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_DIARY_DAYS)
    throw new Error(`Eine Diary-Laufzeit umfasst 1 bis ${MAX_DIARY_DAYS} Tage.`);
  return value;
}
function nowDate(value = new Date()) {
  if (!(value instanceof Date) && typeof value !== "string" && typeof value !== "number")
    throw new Error("Ungültiger Zeitpunkt.");
  if (typeof value === "string" && !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value))
    throw new Error("Zeitpunkte benötigen eine explizite Zeitzone.");
  if (typeof value === "string") {
    day(value.slice(0, 10));
    if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value))
      throw new Error("Ungültiger Diary-Zeitpunkt.");
    const offset = value.match(/[+-](\d{2}):(\d{2})$/);
    if (offset && (Number(offset[1]) > 14 || Number(offset[2]) > 59 || Number(offset[1]) === 14 && Number(offset[2]) !== 0))
      throw new Error("Ungültiger Zeitzonenversatz.");
  }
  const result = new Date(value);
  if (!Number.isFinite(result.getTime())) throw new Error("Ungültiger Zeitpunkt.");
  return result;
}
function localParts(value) {
  return Object.fromEntries(berlin.formatToParts(nowDate(value)).map((p) => [p.type, p.value]));
}
export function devDiaryDateKey(value = new Date()) {
  const p = localParts(value);
  return day(`${p.year.padStart(4, "0")}-${p.month}-${p.day}`);
}
function timestamp(value) {
  if (value === undefined || value === "") return "";
  return nowDate(text(value, "Diary-Zeitpunkt", 40)).toISOString();
}
function clock(value = "18:00") {
  if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value))
    throw new Error("Die Erinnerung benötigt eine Uhrzeit zwischen 00:00 und 23:59.");
  return value;
}
function flag(value, fallback = false) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error("Ungültiger Diary-Schalter.");
  return value;
}
function spacesURL(value, { course = false } = {}) {
  const raw = text(value, "Spaces-Link", 2000, { required: true });
  if (/[\s\\]/.test(raw) || /%(?:2f|5c|2e)/i.test(raw)) throw new Error("Ungültiger Spaces-Link.");
  let url;
  try { url = new URL(raw); } catch { throw new Error("Ungültiger Spaces-Link."); }
  if (url.protocol !== "https:" || url.hostname !== "spaces.th-koeln.de" || url.port ||
      url.username || url.password || url.search || url.hash ||
      /%(?:2f|5c|2e)/i.test(url.pathname) || url.pathname === "/")
    throw new Error("Der Kurs benötigt einen direkten HTTPS-Link auf spaces.th-koeln.de ohne Anmeldedaten.");
  if (course && !url.pathname.endsWith("/")) url.pathname += "/";
  return url.href;
}
function projectsOf(value) {
  const projects = Array.isArray(value) ? value : value?.projects;
  if (!Array.isArray(projects) || projects.length > 300)
    throw new Error("Ungültige Projektliste für das Dev Diary.");
  return projects;
}
export function devDiaryCourses(stateOrProjects) {
  const found = [], seen = new Set();
  for (const project of projectsOf(stateOrProjects)) {
    if (!project || project.archived || !Array.isArray(project.links)) continue;
    for (const link of project.links.slice(0, 40)) {
      if (link?.tool !== "spaces") continue;
      try {
        const item = { projectId: identifier(project.id, "Kurs-ID"),
          courseName: text(project.name, "Kursname", 240, { required: true }),
          courseUrl: spacesURL(link.url, { course: true }) };
        const key = JSON.stringify([item.projectId, item.courseUrl]);
        if (!seen.has(key)) { seen.add(key); found.push(item); }
      } catch { /* Invalid or non-course links do not become diary destinations. */ }
    }
  }
  return found;
}
function courseFor(input, state) {
  const courses = devDiaryCourses(state);
  const projectId = input.projectId || state?.activeCourse || courses[0]?.projectId;
  const selected = courses.filter((c) => c.projectId === projectId);
  const requested = input.courseUrl ? spacesURL(input.courseUrl, { course: true }) : "";
  const match = requested ? selected.find((c) => c.courseUrl === requested) : selected[0];
  if (!match) throw new Error("Bitte einen Kurs mit vorhandenem Spaces-Projektlink auswählen.");
  return match;
}
function validateReminder(value, start, end) {
  if (value === undefined) value = { enabled: true, time: "18:00", weekdays: [0, 1, 2, 3, 4, 5, 6], acknowledged: [] };
  object(value, ["enabled", "time", "weekdays", "acknowledged"], "Diary-Erinnerung");
  const weekdays = value.weekdays === undefined ? [0, 1, 2, 3, 4, 5, 6] : value.weekdays;
  if (!Array.isArray(weekdays) || weekdays.length > 7 ||
      weekdays.some((n) => !Number.isInteger(n) || n < 0 || n > 6) || new Set(weekdays).size !== weekdays.length)
    throw new Error("Die Erinnerung benötigt eindeutige Wochentage von 0 bis 6.");
  const enabled = flag(value.enabled, true);
  if (enabled && !weekdays.length) throw new Error("Bitte mindestens einen Erinnerungstag auswählen.");
  const acknowledged = value.acknowledged === undefined ? [] : value.acknowledged;
  if (!Array.isArray(acknowledged) || acknowledged.length > MAX_DIARY_DAYS)
    throw new Error("Zu viele bestätigte Diary-Erinnerungen.");
  const dates = acknowledged.map((value) => {
    const date = day(value);
    if (date < start || date > end) throw new Error("Die Erinnerung liegt außerhalb der Diary-Laufzeit.");
    return date;
  });
  if (new Set(dates).size !== dates.length) throw new Error("Doppelte Diary-Erinnerung.");
  return { enabled, time: clock(value.time), weekdays: [...weekdays].sort((a, b) => a - b), acknowledged: [...dates].sort() };
}
function validateRemote(value, courseUrl, imported) {
  if (value === undefined) value = { postId: "", url: "", lastPublishedHash: "", status: "draft" };
  object(value, ["postId", "url", "lastPublishedHash", "status"], "Spaces-Poststatus");
  const postId = text(value.postId, "Spaces-Post-ID", 160);
  if (postId && !/^[a-zA-Z0-9_:-]+$/.test(postId)) throw new Error("Ungültige Spaces-Post-ID.");
  const url = value.url ? spacesURL(value.url) : "";
  if (url && !url.startsWith(courseUrl)) throw new Error("Der Spaces-Post liegt außerhalb des ausgewählten Kurses.");
  const lastPublishedHash = text(value.lastPublishedHash, "Post-Fingerprint", 64).toLowerCase();
  if (lastPublishedHash && !/^[a-f0-9]{64}$/.test(lastPublishedHash)) throw new Error("Ungültiger Post-Fingerprint.");
  const status = value.status === undefined ? "draft" : value.status;
  if (!REMOTE_STATUSES.has(status) || (url && !postId) ||
      (status === "published" && (!postId || !url || !lastPublishedHash)))
    throw new Error("Ungültiger oder unvollständiger Spaces-Poststatus.");
  return { postId, url, lastPublishedHash,
    status: imported && (postId || url || lastPublishedHash || status !== "draft") ? "unknown" : status };
}
function validateEntry(value, start, end) {
  object(value, ["date", ...FIELDS, "completed", "updatedAt"], "Diary-Tagesnotiz");
  const date = day(value.date);
  if (date < start || date > end) throw new Error("Die Tagesnotiz liegt außerhalb der Diary-Laufzeit.");
  return { date, ...Object.fromEntries(FIELDS.map((key) => [key, text(value[key], "Tagesnotiz", MAX_DIARY_FIELD, { multiline: true })])),
    completed: flag(value.completed), updatedAt: timestamp(value.updatedAt) };
}
export function validateDiaryPresentation(value = {}) {
  object(value, ["layout", "order", "headings", "hideEmpty", "showPeriod"], "Beitragsgestaltung");
  const options = { layout: value.layout ?? "sections", order: value.order ?? "oldest", headings: value.headings ?? "questions" };
  if (!["sections", "collapsible"].includes(options.layout) || !["oldest", "newest"].includes(options.order) || !["questions", "compact"].includes(options.headings))
    throw new Error("Ungültige Beitragsgestaltung.");
  return { ...options, hideEmpty: flag(value.hideEmpty), showPeriod: flag(value.showPeriod, true) };
}
export function validateDevDiary(value, projects, { imported = false } = {}) {
  object(value, ["id", "projectId", "courseName", "courseUrl", "title", "startDate", "endDate", "entries", "reminder", "remote", "createdAt", "updatedAt", "archived", "presentation"], "Dev Diary");
  const id = identifier(value.id), projectId = identifier(value.projectId, "Kurs-ID");
  const courseUrl = spacesURL(value.courseUrl, { course: true });
  if (projects !== undefined && !devDiaryCourses(projectsOf(projects).map((project) => ({ ...project, archived: false }))).some((c) => c.projectId === projectId && c.courseUrl === courseUrl))
    throw new Error("Das Dev Diary gehört zu keinem vorhandenen Spaces-Kurslink.");
  const startDate = day(value.startDate), endDate = day(value.endDate);
  const count = periodDays(startDate, endDate);
  const entries = value.entries === undefined ? [] : value.entries;
  if (!Array.isArray(entries) || entries.length > count) throw new Error("Zu viele Diary-Tagesnotizen.");
  const normalized = entries.map((entry) => validateEntry(entry, startDate, endDate)).sort((a, b) => a.date.localeCompare(b.date));
  if (new Set(normalized.map((entry) => entry.date)).size !== normalized.length) throw new Error("Doppeltes Diary-Tagesdatum.");
  if (normalized.reduce((sum, entry) => sum + FIELDS.reduce((n, key) => n + entry[key].length, 0), 0) > MAX_DIARY_TEXT)
    throw new Error(`Ein Dev Diary unterstützt höchstens ${MAX_DIARY_TEXT} Zeichen Tagesnotizen.`);
  return { id, projectId, courseName: text(value.courseName, "Kursname", 240, { required: true }), courseUrl,
    title: text(value.title, "Diary-Titel", 240, { required: true }), startDate, endDate, entries: normalized,
    presentation: validateDiaryPresentation(value.presentation), reminder: validateReminder(value.reminder, startDate, endDate), remote: validateRemote(value.remote, courseUrl, imported),
    createdAt: timestamp(value.createdAt), updatedAt: timestamp(value.updatedAt), archived: flag(value.archived) };
}
export function validateDevDiaries(values = [], projects, options = {}) {
  if (!Array.isArray(values) || values.length > MAX_DEV_DIARIES)
    throw new Error(`Höchstens ${MAX_DEV_DIARIES} Dev Diaries werden unterstützt.`);
  const items = values.map((value) => validateDevDiary(value, projects, options));
  if (new Set(items.map((item) => item.id)).size !== items.length) throw new Error("Doppelte Dev-Diary-ID.");
  return items;
}
function blankEntry(date) {
  return { date, done: "", learned: "", problems: "", next: "", completed: false, updatedAt: "" };
}
export function draftDevDiary(input = {}, state, { now = new Date() } = {}) {
  const course = courseFor(input, state), instant = nowDate(now).toISOString();
  // Calendar proposals must be accepted by the caller via explicit dates.
  const startDate = day(input.startDate || devDiaryDateKey(now));
  const endDate = input.endDate ? day(input.endDate) : shiftDay(startDate, duration(input.days) - 1);
  const count = periodDays(startDate, endDate);
  return validateDevDiary({ id: input.id || "draft", ...course,
    title: input.title || `Dev Diary · ${course.courseName}`.slice(0, 240), startDate, endDate,
    entries: input.entries || Array.from({ length: count }, (_, n) => blankEntry(shiftDay(startDate, n))),
    presentation: input.presentation, reminder: input.reminder, remote: input.remote, createdAt: input.createdAt || instant,
    updatedAt: instant, archived: input.archived }, projectsOf(state));
}
export function createDevDiary(input = {}, state, { id, now = new Date() } = {}) {
  const nextId = id || (input.id && input.id !== "draft" ? input.id : globalThis.crypto?.randomUUID());
  if (!nextId) throw new Error("Eine neue Diary-ID wird benötigt.");
  return draftDevDiary({ ...input, id: identifier(nextId) }, state, { now });
}
export function updateDailyEntry(value, date, patch, { now = new Date() } = {}) {
  const diary = validateDevDiary(value);
  date = day(date);
  object(patch, [...FIELDS, "completed"], "Änderung der Tagesnotiz");
  const previous = diary.entries.find((entry) => entry.date === date) || blankEntry(date);
  const entry = validateEntry({ ...previous, ...patch, updatedAt: nowDate(now).toISOString() }, diary.startDate, diary.endDate);
  return validateDevDiary({ ...diary, entries: [...diary.entries.filter((item) => item.date !== date), entry],
    updatedAt: entry.updatedAt, remote: { ...diary.remote, status: diary.remote.status === "published" ? "draft" : diary.remote.status } });
}
function markdownText(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    // Entities remain plain text in CommonMark and the app's small renderer.
    // Backslash escapes alone are not understood by the existing renderer.
    .replace(/[\\`*_[\]#|~]/g, (character) => `&#${character.charCodeAt(0)};`)
    .replace(/(^|\n)([\t ]*)([-+])/g, (_, line, space, character) => `${line}${space}&#${character.charCodeAt(0)};`);
}
function printedDate(value) { const [year, month, date] = value.split("-"); return `${date}.${month}.${year}`; }
export function compileDevDiaryMarkdown(value) {
  const diary = validateDevDiary(value), count = periodDays(diary.startDate, diary.endDate), style = diary.presentation;
  const markdownURL = diary.courseUrl.replace(/[()]/g, (character) => character === "(" ? "%28" : "%29");
  const lines = [`# ${markdownText(diary.title)}`, "", `Kurs: [${markdownText(diary.courseName)}](${markdownURL})`, ""];
  if (style.showPeriod) lines.push(`Zeitraum: **${printedDate(diary.startDate)} – ${printedDate(diary.endDate)}** (${count} ${count === 1 ? "Tag" : "Tage"})`, "");
  const entries = diary.entries.filter((entry) => entry.completed || FIELDS.some((key) => entry[key]));
  if (style.order === "newest") entries.reverse();
  if (!entries.length) lines.push("*Für diesen Zeitraum gibt es noch keine Tagesnotizen.*", "");
  const headings = style.headings === "compact" ? ["Ergebnisse", "Erkenntnisse", "Herausforderungen", "Nächste Schritte"] : ["Was habe ich gemacht?", "Was habe ich gelernt?", "Welche Probleme gab es?", "Was ist mein nächster Schritt?"];
  for (const entry of entries) {
    if (style.layout === "collapsible") lines.push("<details>", `<summary>${printedDate(entry.date)}</summary>`, "");
    else lines.push("---", "", `## ${printedDate(entry.date)}`, "");
    FIELDS.forEach((key, n) => { if (!style.hideEmpty || entry[key]) lines.push(`### ${headings[n]}`, "", entry[key] ? markdownText(entry[key]) : "*Noch nicht ausgefüllt.*", ""); });
    if (style.layout === "collapsible") lines.push("</details>", "");
  }
  return lines.join("\n").trimEnd() + "\n";
}

function nameKey(value) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase("de-DE").replace(/\s+/g, " ").trim();
}
function eventProject(event, courses) {
  if (event.projectId) return { projectId: event.projectId, match: "projectId" };
  if (event.source.url) {
    try {
      const url = spacesURL(event.source.url), matches = courses.filter((course) => url === course.courseUrl.slice(0, -1) || url.startsWith(course.courseUrl));
      const longest = Math.max(0, ...matches.map((course) => course.courseUrl.length));
      const ids = [...new Set(matches.filter((course) => course.courseUrl.length === longest).map((course) => course.projectId))];
      if (ids.length === 1) return { projectId: ids[0], match: "url" };
      if (ids.length > 1) return null;
    } catch { /* Non-Spaces sources may still have an exact course title. */ }
  }
  const titles = [event.title, event.source.title].flatMap((title) => [title, ...title.split(/\s[·|–—-]\s|:\s+/)]).map(nameKey);
  const ids = [...new Set(courses.filter((course) => titles.includes(nameKey(course.courseName))).map((course) => course.projectId))];
  return ids.length === 1 ? { projectId: ids[0], match: "name" } : null;
}
function eventPeriod(event) {
  const startDate = event.allDay ? event.start : devDiaryDateKey(event.start);
  let endDate = event.allDay ? shiftDay(event.end, -1) : devDiaryDateKey(event.end);
  if (!event.allDay) {
    const end = localParts(event.end);
    if (endDate > startDate && end.hour === "00" && end.minute === "00" && end.second === "00") endDate = shiftDay(endDate, -1);
  }
  return { startDate, endDate, days: periodDays(startDate, endDate) };
}
export function suggestDevDiaryPeriod(state, { projectId, courseUrl, startDate, today, days = DEFAULT_DIARY_DAYS } = {}) {
  const courses = devDiaryCourses(state), anchor = day(startDate || today || devDiaryDateKey());
  const fallbackDays = duration(days);
  const selected = courses.filter((course) => (!projectId || course.projectId === projectId) && (!courseUrl || course.courseUrl === spacesURL(courseUrl, { course: true })));
  const ids = [...new Set(selected.map((course) => course.projectId))];
  const course = ids.length === 1 ? selected[0] : null;
  const base = { startDate: anchor, endDate: shiftDay(anchor, fallbackDays - 1), days: fallbackDays,
    projectId: course?.projectId || "", courseUrl: course?.courseUrl || "", source: "default", proposal: true,
    reason: `${fallbackDays} Tage ab ${printedDate(anchor)}; Kalenderdaten sind nur ein Vorschlag.`, eventIds: [], evidence: [] };
  if (!course) return base;
  const events = Array.isArray(state?.calendarEvents) ? state.calendarEvents.slice(0, 2000) : [];
  const matches = [], lookback = shiftDay(anchor, -(fallbackDays - 1));
  for (const input of events) {
    try {
      const event = validateCalendarEvent(input), association = eventProject(event, courses);
      if (association?.projectId !== course.projectId) continue;
      const period = eventPeriod(event);
      if (period.endDate < lookback || period.startDate > shiftDay(anchor, 28)) continue;
      matches.push({ event, association, period, ongoing: period.startDate <= anchor && period.endDate >= anchor });
    } catch { /* Invalid calendar data is never promoted to a diary proposal. */ }
  }
  const candidates = matches.filter((match) => match.period.endDate >= anchor);
  candidates.sort((a, b) => Number(b.ongoing) - Number(a.ongoing) ||
    (a.ongoing ? b.period.startDate.localeCompare(a.period.startDate) : a.period.startDate.localeCompare(b.period.startDate)) || a.event.id.localeCompare(b.event.id));
  const ongoingPeriod = candidates.find((match) => match.ongoing && match.period.days > 1);
  const evidence = (match) => ({ eventId: match.event.id, title: match.event.title,
    start: match.event.start, end: match.event.end, match: match.association.match });
  if (!startDate && !ongoingPeriod) {
    // A recent single-day course session plus a second, upcoming session in
    // its diary window can indicate that the current phase already started.
    // A completed explicit multi-day block is not stretched into a new phase.
    const recent = matches.filter((match) => match.period.days === 1 && match.period.startDate < anchor && match.period.startDate >= lookback)
      .sort((a, b) => a.period.startDate.localeCompare(b.period.startDate) || a.event.id.localeCompare(b.event.id));
    for (const beginning of recent) {
      const end = shiftDay(beginning.period.startDate, fallbackDays - 1);
      const continuation = candidates.filter((match) => match.period.startDate >= anchor && match.period.startDate <= end)
        .sort((a, b) => a.period.startDate.localeCompare(b.period.startDate) || a.event.id.localeCompare(b.event.id))[0];
      if (!continuation) continue;
      return { ...base, startDate: beginning.period.startDate, endDate: end, source: "calendar",
        reason: `Vorschlag für eine laufende Kursphase: „${beginning.event.title}“ am ${printedDate(beginning.period.startDate)} und „${continuation.event.title}“ am ${printedDate(continuation.period.startDate)} liegen im selben ${fallbackDays}-Tage-Fenster. Beginn und Laufzeit bitte prüfen.`,
        eventIds: [beginning.event.id, continuation.event.id], evidence: [evidence(beginning), evidence(continuation)] };
    }
  }
  const first = ongoingPeriod || candidates[0];
  if (!first) return base;
  const start = startDate ? anchor : first.period.startDate;
  const suggestedDays = !startDate && first.period.days > 1 ? first.period.days : fallbackDays;
  return { ...base, startDate: start, endDate: shiftDay(start, suggestedDays - 1), days: suggestedDays, source: "calendar",
    reason: `Vorschlag aus „${first.event.title}“. Zeitraum bitte prüfen; Kalenderdaten sind keine feste Laufzeit.`,
    eventIds: [first.event.id], evidence: [evidence(first)] };
}
export function devDiaryReminderKey(id, date) { return `devdiary_${identifier(id)}_${day(date)}`; }
function reminderInstant(date, time) {
  // On spring-forward days, deliver at the first existing minute after the
  // chosen clock time. On autumn folds, choose the first occurrence; the daily
  // identity key remains unchanged throughout both occurrences.
  const base = Date.parse(`${date}T${time}:00Z`);
  const offsets = [...new Set([-36, 0, 36].map((hours) => {
    const value = base + hours * 3600000, p = localParts(value);
    return Date.parse(`${p.year.padStart(4, "0")}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`) - value;
  }))];
  for (let n = 0; n <= 180; n++) {
    const wall = new Date(base + n * 60000).toISOString().slice(0, 19), matches = offsets.map((offset) => base + n * 60000 - offset)
      .filter((value) => {
        const p = localParts(value);
        return `${p.year.padStart(4, "0")}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}` === wall;
      });
    if (matches.length) return new Date(Math.min(...matches));
  }
  throw new Error("Die lokale Erinnerungszeit konnte nicht bestimmt werden.");
}
export function devDiaryReminderNotifications(valuesOrState, { now = new Date() } = {}) {
  const state = Array.isArray(valuesOrState) ? null : valuesOrState;
  const diaries = validateDevDiaries(state ? state.devDiaries || [] : valuesOrState, state?.projects);
  const instant = nowDate(now), today = devDiaryDateKey(instant), weekday = new Date(today + "T12:00:00Z").getUTCDay();
  return diaries.flatMap((diary) => {
    if (diary.archived || !diary.reminder.enabled || today < diary.startDate || today > diary.endDate ||
        !diary.reminder.weekdays.includes(weekday) || diary.reminder.acknowledged.includes(today) ||
        diary.entries.some((entry) => entry.date === today && entry.completed)) return [];
    const due = reminderInstant(today, diary.reminder.time);
    if (instant < due) return [];
    return [{ id: devDiaryReminderKey(diary.id, today), revision: "1", source: "context",
      title: `Dev Diary · ${diary.courseName}`, summary: "Halte kurz fest, was du heute gemacht und gelernt hast.",
      url: diary.courseUrl, createdAt: due.toISOString(), diaryId: diary.id, diaryDate: today, projectId: diary.projectId }];
  });
}
export function acknowledgeDevDiaryReminder(value, dateOrKey, { now = new Date() } = {}) {
  const diary = validateDevDiary(value), prefix = `devdiary_${diary.id}_`;
  const date = day(typeof dateOrKey === "string" && dateOrKey.startsWith(prefix) ? dateOrKey.slice(prefix.length) : dateOrKey);
  if (diary.reminder.acknowledged.includes(date)) return diary;
  const acknowledged = [...new Set([...diary.reminder.acknowledged, date])].sort();
  return validateDevDiary({ ...diary, reminder: { ...diary.reminder, acknowledged }, updatedAt: nowDate(now).toISOString() });
}
