import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_DIARY_DAYS, MAX_DEV_DIARIES, MAX_DIARY_DAYS,
  devDiaryCourses, devDiaryDateKey, draftDevDiary, createDevDiary,
  validateDevDiary, validateDevDiaries, updateDailyEntry,
  compileDevDiaryMarkdown, suggestDevDiaryPeriod,
  devDiaryReminderKey, devDiaryReminderNotifications, acknowledgeDevDiaryReminder,
} from "../dist/dev-diary-engine.js";

const url = "https://spaces.th-koeln.de/prototyping-things-w26/";
const project = (patch = {}) => ({ id: "pt", name: "Prototyping Things", archived: false,
  links: [{ tool: "spaces", url }], ...patch });
const workspace = (patch = {}) => ({ projects: [project()], calendarEvents: [], activeCourse: "pt", ...patch });
const makeDiary = (patch = {}, options = {}) => createDevDiary({ projectId: "pt", courseUrl: url,
  startDate: "2026-10-13", ...patch }, workspace(), { id: "diary-one", now: "2026-10-13T10:00:00Z", ...options });
const event = (patch = {}) => ({ id: "class-one", title: "Prototyping Things · Kurs",
  projectId: "pt", allDay: true, start: "2026-10-20", end: "2026-10-21",
  source: { kind: "local" }, ...patch });
const suggestion = (events, options = {}, state = {}) => suggestDevDiaryPeriod(workspace({ calendarEvents: events, ...state }),
  { projectId: "pt", today: "2026-10-13", ...options });
const boundRemote = (patch = {}) => ({ postId: "post-123", url: url + "posts/post-123/",
  lastPublishedHash: "a".repeat(64), status: "published", ...patch });
const freeze = (value) => { if (value && typeof value === "object") {
  Object.values(value).forEach(freeze); Object.freeze(value);
} return value; };

test("default draft gives fourteen inclusive daily templates and an everyday Berlin reminder", () => {
  const draft = draftDevDiary({}, workspace(), { now: "2026-10-12T22:15:00Z" });
  assert.equal(DEFAULT_DIARY_DAYS, 14);
  assert.equal(draft.id, "draft");
  assert.equal(draft.startDate, "2026-10-13");
  assert.equal(draft.endDate, "2026-10-26");
  assert.equal(draft.entries.length, 14);
  assert.deepEqual(draft.entries[0], { date: "2026-10-13", done: "", learned: "", problems: "", next: "", completed: false, updatedAt: "" });
  assert.deepEqual(draft.reminder, { enabled: true, time: "18:00", weekdays: [0, 1, 2, 3, 4, 5, 6], acknowledged: [] });
  assert.deepEqual(draft.remote, { postId: "", url: "", lastPublishedHash: "", status: "draft" });
});

test("calendar proposals do not silently change a newly created diary", () => {
  const state = workspace({ calendarEvents: [event({ start: "2026-10-20", end: "2026-11-03" })] });
  const draft = draftDevDiary({}, state, { now: "2026-10-13T10:00:00Z" });
  assert.equal(draft.startDate, "2026-10-13");
  assert.equal(draft.endDate, "2026-10-26");
  const proposal = suggestDevDiaryPeriod(state, { projectId: "pt", today: "2026-10-13" });
  const accepted = createDevDiary({ projectId: "pt", startDate: proposal.startDate, endDate: proposal.endDate }, state,
    { id: "accepted", now: "2026-10-13T10:00:00Z" });
  assert.equal(accepted.startDate, "2026-10-20");
  assert.equal(accepted.endDate, "2026-11-02");
});

test("manual durations count calendar dates across leap day and DST instead of 24-hour intervals", () => {
  assert.equal(makeDiary({ startDate: "2028-02-20" }).endDate, "2028-03-04");
  assert.equal(makeDiary({ startDate: "2026-03-22" }).endDate, "2026-04-04");
  assert.equal(makeDiary({ startDate: "2026-10-20" }).endDate, "2026-11-02");
  assert.equal(makeDiary({ days: 1 }).endDate, "2026-10-13");
  assert.equal(makeDiary({ endDate: "2026-10-15" }).entries.length, 3);
});

test("invalid dates, reversed and excessive periods, clocks and weekdays are rejected", () => {
  for (const patch of [{ startDate: "2026-02-29" }, { startDate: "2026-02-30" }, { startDate: "0000-01-01" },
    { startDate: "2026-1-1" }, { endDate: "2026-10-12" }, { days: 0 }, { days: MAX_DIARY_DAYS + 1 }, { days: 1.5 },
    { reminder: { time: "24:00" } }, { reminder: { time: "18:60" } }, { reminder: { weekdays: [1, 1] } },
    { reminder: { weekdays: ["1"] } }, { reminder: { weekdays: [7] } }, { reminder: { weekdays: [] } }])
    assert.throws(() => makeDiary(patch));
  assert.deepEqual(makeDiary({ reminder: { enabled: false, weekdays: [] } }).reminder.weekdays, []);
});

test("course destinations come only from existing exact-host Spaces project links", () => {
  const projects = [project(), project({ id: "archived", archived: true }), project({ id: "generic", links: [{ tool: "web", url }] }),
    project({ id: "bad", links: [{ tool: "spaces", url: "https://spaces.th-koeln.de.evil.test/course/" }] })];
  assert.deepEqual(devDiaryCourses(projects), [{ projectId: "pt", courseName: "Prototyping Things", courseUrl: url }]);
  assert.throws(() => makeDiary({ projectId: "missing" }));
  assert.throws(() => makeDiary({ courseUrl: "https://spaces.th-koeln.de/another-course/" }));
  assert.throws(() => validateDevDiary(makeDiary(), [project({ links: [] })]));
  assert.doesNotThrow(() => validateDevDiary(makeDiary(), [project({ archived: true })]));
});

test("course and post links reject credentials, query secrets, fragments, path escapes and deceptive hosts", () => {
  for (const unsafe of ["http://spaces.th-koeln.de/course/", "https://user:pass@spaces.th-koeln.de/course/",
    "https://spaces.th-koeln.de:444/course/", "https://spaces.th-koeln.de.evil.test/course/", "https://spaces.th-koeln.de/",
    url + "?nonce=secret", url + "#access-token", url + "%2fother", url + "%2e%2e/other", url + "\\post",
    "javascript:alert(1)", "data:text/html,unsafe"]) {
    assert.throws(() => validateDevDiary({ ...makeDiary(), courseUrl: unsafe }));
    assert.throws(() => makeDiary({ remote: boundRemote({ url: unsafe }) }));
  }
  assert.throws(() => makeDiary({ remote: boundRemote({ url: "https://spaces.th-koeln.de/prototyping-things-w26-other/post/" }) }));
});

test("validation bounds local content, dates and collections and rejects duplicate day identities", () => {
  const diary = makeDiary();
  assert.throws(() => validateDevDiary({ ...diary, entries: [diary.entries[0], diary.entries[0]] }), /Doppeltes/);
  assert.throws(() => validateDevDiary({ ...diary, entries: [{ ...diary.entries[0], date: "2026-10-27" }] }), /außerhalb/);
  assert.throws(() => updateDailyEntry(diary, "2026-10-13", { done: "x".repeat(4001) }));
  assert.throws(() => updateDailyEntry(diary, "2026-10-13", { done: "unsafe\u0000" }));
  assert.throws(() => validateDevDiaries([diary, diary]), /Doppelte/);
  assert.equal(validateDevDiaries(Array.from({ length: MAX_DEV_DIARIES }, (_, n) => ({ ...diary, id: "diary-" + n }))).length, MAX_DEV_DIARIES);
  assert.throws(() => validateDevDiaries(Array.from({ length: MAX_DEV_DIARIES + 1 }, (_, n) => ({ ...diary, id: "diary-" + n }))));
  const large = makeDiary({ days: 30 });
  assert.throws(() => validateDevDiary({ ...large, entries: large.entries.map((entry) => ({ ...entry, done: "x".repeat(4000) })) }), /100000/);
});

test("timestamps require real dates and explicit zones; publication and credential fields are not persisted", () => {
  const diary = makeDiary();
  for (const createdAt of ["2026-10-13T10:00", "2026-02-30T10:00:00Z", "2026-10-13T24:00:00Z", "2026-10-13T10:00:00+15:00"])
    assert.throws(() => validateDevDiary({ ...diary, createdAt }));
  for (const field of ["automaticPublish", "reviewToken", "nonce", "cookie", "accessToken"])
    assert.throws(() => validateDevDiary({ ...diary, [field]: "secret" }));
  assert.throws(() => validateDevDiary({ ...diary, entries: [{ ...diary.entries[0], nonce: "secret" }] }));
  assert.throws(() => validateDevDiary({ ...diary, reminder: { ...diary.reminder, automaticPublish: true } }));
});

test("immutable daily updates replace the existing date without duplicating it", () => {
  const original = freeze(makeDiary()), before = JSON.stringify(original);
  const first = updateDailyEntry(original, "2026-10-13", { done: "Prototype gebaut", learned: "Sensoren kalibrieren" }, { now: "2026-10-13T16:00:00Z" });
  const second = updateDailyEntry(first, "2026-10-13", { done: "Prototype überarbeitet", problems: "Batterie leer" }, { now: "2026-10-13T17:00:00Z" });
  assert.equal(JSON.stringify(original), before);
  assert.equal(second.entries.length, 14);
  assert.equal(second.entries.filter((entry) => entry.date === "2026-10-13").length, 1);
  assert.equal(second.entries[0].done, "Prototype überarbeitet");
  assert.equal(second.entries[0].learned, "Sensoren kalibrieren");
  assert.equal(second.entries[0].problems, "Batterie leer");
  assert.notEqual(first.entries, second.entries);
  assert.throws(() => updateDailyEntry(original, "2026-10-12", { done: "Out of period" }));
  assert.throws(() => updateDailyEntry(original, "2026-10-13", { date: "2026-10-14" }));
});

test("one chronological Markdown post combines populated days, omits blank templates and escapes active markup", () => {
  let diary = makeDiary({ title: "Diary <img src=x>", courseName: "unused" });
  diary = updateDailyEntry(diary, "2026-10-15", { done: "<script>alert(1)</script>\n[bad](javascript:alert(1))\n```html\n<img src=x>" });
  diary = updateDailyEntry(diary, "2026-10-13", { learned: "&lt;script&gt; ist Text", next: "# Überschrift aus Notiz" });
  const markdown = compileDevDiaryMarkdown(diary);
  assert.equal((markdown.match(/^# /gm) || []).length, 1);
  assert.match(markdown, /\(14 Tage\)/);
  assert.ok(markdown.indexOf("## 13.10.2026") < markdown.indexOf("## 15.10.2026"));
  assert.doesNotMatch(markdown, /## 14\.10\.2026/);
  assert.doesNotMatch(markdown, /<(?:script|img)\b|\[bad\]\(javascript:|^```/im);
  assert.match(markdown, /&lt;script&gt;/);
  assert.match(markdown, /&amp;lt;script&amp;gt;/);
  assert.match(markdown, /Was habe ich gemacht\?/);
  assert.match(markdown, /Welche Probleme gab es\?/);
  const changedMetadata = { ...diary, entries: diary.entries.map((entry) => ({ ...entry, updatedAt: "2026-10-19T10:00:00Z" })), updatedAt: "2026-10-19T10:00:00Z" };
  assert.equal(compileDevDiaryMarkdown(changedMetadata), markdown);
});

test("local edits preserve the bound post identity and mark confirmed published content as a draft", () => {
  const published = makeDiary({ remote: boundRemote() });
  const edited = updateDailyEntry(published, "2026-10-13", { done: "Neuer Stand" });
  assert.equal(edited.remote.status, "draft");
  assert.equal(edited.remote.postId, published.remote.postId);
  assert.equal(edited.remote.lastPublishedHash, published.remote.lastPublishedHash);
  assert.equal(published.remote.status, "published");
});

test("imported remote bindings become unknown display metadata and never import publication authority", () => {
  for (const status of ["published", "pending", "unknown", "error", "draft"]) {
    const diary = makeDiary({ remote: boundRemote({ status }) });
    const imported = validateDevDiaries([diary], workspace().projects, { imported: true })[0];
    assert.equal(imported.remote.status, "unknown");
    assert.equal(imported.remote.postId, "post-123");
    assert.deepEqual(Object.keys(imported.remote).sort(), ["lastPublishedHash", "postId", "status", "url"]);
  }
  assert.equal(validateDevDiary(makeDiary(), workspace().projects, { imported: true }).remote.status, "draft");
});

test("malformed or forged post metadata is rejected rather than enabling an accidental retry", () => {
  for (const remote of [boundRemote({ postId: "" }), boundRemote({ url: "" }), boundRemote({ lastPublishedHash: "" }),
    boundRemote({ lastPublishedHash: "not-a-hash" }), boundRemote({ postId: "../other" }), boundRemote({ status: "approved" }),
    boundRemote({ approved: true }), boundRemote({ reviewToken: "replayed" }), boundRemote({ nonce: "private" }),
    boundRemote({ url: "https://spaces.th-koeln.de/other-course/posts/post-123/" })])
    assert.throws(() => validateDevDiary({ ...makeDiary(), remote }, workspace().projects, { imported: true }));
});

test("daily reminders are due only inside the period, on selected days and at or after the chosen Berlin time", () => {
  const diary = makeDiary({ reminder: { time: "18:00", weekdays: [1, 2, 3, 4, 5] } });
  const due = (now) => devDiaryReminderNotifications([diary], { now });
  assert.equal(due("2026-10-12T20:00:00Z").length, 0);
  assert.equal(due("2026-10-13T15:59:59Z").length, 0);
  assert.equal(due("2026-10-13T16:00:00Z").length, 1);
  assert.equal(due("2026-10-17T20:00:00Z").length, 0);
  assert.equal(due("2026-10-27T20:00:00Z").length, 0);
  assert.equal(devDiaryReminderNotifications([{ ...diary, archived: true }], { now: "2026-10-13T20:00:00Z" }).length, 0);
  assert.equal(devDiaryReminderNotifications([{ ...diary, reminder: { ...diary.reminder, enabled: false } }], { now: "2026-10-13T20:00:00Z" }).length, 0);
});

test("notification identity is stable throughout one day, distinct for another diary/day, and uses actual winter offset", () => {
  const diary = makeDiary({ startDate: "2026-01-13" });
  const first = devDiaryReminderNotifications([diary], { now: "2026-01-13T17:00:00Z" })[0];
  const later = devDiaryReminderNotifications([diary], { now: "2026-01-13T22:59:00Z" })[0];
  assert.deepEqual(later, first);
  assert.equal(first.createdAt, "2026-01-13T17:00:00.000Z");
  assert.equal(first.id, devDiaryReminderKey(diary.id, "2026-01-13"));
  const next = devDiaryReminderNotifications([diary], { now: "2026-01-14T17:00:00Z" })[0];
  assert.notEqual(next.id, first.id);
  assert.notEqual(devDiaryReminderNotifications([{ ...diary, id: "another" }], { now: "2026-01-13T17:00:00Z" })[0].id, first.id);
});

test("acknowledgement is immutable, idempotent and limited to the matching run/date", () => {
  const original = freeze(makeDiary()), key = devDiaryReminderKey(original.id, "2026-10-13");
  const acknowledged = acknowledgeDevDiaryReminder(original, key, { now: "2026-10-13T16:00:00Z" });
  assert.deepEqual(original.reminder.acknowledged, []);
  assert.deepEqual(acknowledged.reminder.acknowledged, ["2026-10-13"]);
  assert.deepEqual(acknowledgeDevDiaryReminder(acknowledged, key, { now: "2026-10-14T10:00:00Z" }), acknowledged);
  assert.equal(devDiaryReminderNotifications([acknowledged], { now: "2026-10-13T20:00:00Z" }).length, 0);
  assert.throws(() => acknowledgeDevDiaryReminder(original, "devdiary_other_2026-10-13"));
  assert.throws(() => acknowledgeDevDiaryReminder(original, "2026-10-27"));
  const completed = updateDailyEntry(original, "2026-10-13", { completed: true });
  assert.equal(devDiaryReminderNotifications([completed], { now: "2026-10-13T20:00:00Z" }).length, 0);
});

test("spring DST gap reminders move to the first real minute rather than firing early or disappearing", () => {
  const diary = makeDiary({ startDate: "2026-03-29", days: 1, reminder: { time: "02:30" } });
  assert.equal(devDiaryReminderNotifications([diary], { now: "2026-03-29T00:59:59Z" }).length, 0);
  const due = devDiaryReminderNotifications([diary], { now: "2026-03-29T01:00:00Z" })[0];
  assert.equal(due.createdAt, "2026-03-29T01:00:00.000Z");
  assert.equal(due.diaryDate, "2026-03-29");
});

test("autumn repeated times keep one daily key and stay due after the clock moves backward", () => {
  const diary = makeDiary({ startDate: "2026-10-25", days: 1, reminder: { time: "02:30" } });
  assert.equal(devDiaryReminderNotifications([diary], { now: "2026-10-25T00:29:59Z" }).length, 0);
  const first = devDiaryReminderNotifications([diary], { now: "2026-10-25T00:30:00Z" })[0];
  const repeatedEarlierClock = devDiaryReminderNotifications([diary], { now: "2026-10-25T01:15:00Z" })[0];
  const second = devDiaryReminderNotifications([diary], { now: "2026-10-25T01:30:00Z" })[0];
  assert.deepEqual(repeatedEarlierClock, first);
  assert.deepEqual(second, first);
  assert.equal(first.createdAt, "2026-10-25T00:30:00.000Z");
  const acknowledged = acknowledgeDevDiaryReminder(diary, first.id);
  assert.equal(devDiaryReminderNotifications([acknowledged], { now: "2026-10-25T01:30:00Z" }).length, 0);
});

test("Berlin midnight produces a fresh daily identity and never leaks a reminder beyond the inclusive end", () => {
  const diary = makeDiary({ days: 2, reminder: { time: "00:00" } });
  const before = devDiaryReminderNotifications([diary], { now: "2026-10-13T21:59:59Z" })[0];
  const after = devDiaryReminderNotifications([diary], { now: "2026-10-13T22:00:00Z" })[0];
  assert.equal(before.diaryDate, "2026-10-13");
  assert.equal(after.diaryDate, "2026-10-14");
  assert.notEqual(before.id, after.id);
  assert.equal(devDiaryReminderNotifications([diary], { now: "2026-10-14T22:00:00Z" }).length, 0);
});

test("local date handling is independent of the host process time zone", () => {
  const original = process.env.TZ;
  try {
    for (const timeZone of ["UTC", "America/Los_Angeles", "Asia/Tokyo"]) {
      process.env.TZ = timeZone;
      assert.equal(devDiaryDateKey("2026-10-12T22:30:00Z"), "2026-10-13");
      assert.equal(makeDiary({ startDate: "2026-10-20" }).endDate, "2026-11-02");
    }
  } finally { if (original === undefined) delete process.env.TZ; else process.env.TZ = original; }
});

test("calendar proposals match explicit course IDs and respect all-day exclusive ends", () => {
  const state = freeze(workspace({ calendarEvents: [event({ start: "2026-10-20", end: "2026-11-03" })] }));
  const before = JSON.stringify(state), proposed = suggestDevDiaryPeriod(state, { projectId: "pt", today: "2026-10-13" });
  assert.equal(proposed.proposal, true);
  assert.equal(proposed.source, "calendar");
  assert.equal(proposed.startDate, "2026-10-20");
  assert.equal(proposed.endDate, "2026-11-02");
  assert.equal(proposed.days, 14);
  assert.equal(proposed.evidence[0].match, "projectId");
  assert.equal(JSON.stringify(state), before);
});

test("timed calendar event dates are Berlin-local and an exact midnight end stays exclusive", () => {
  const proposed = suggestion([event({ allDay: false, start: "2026-10-19T22:30:00Z", end: "2026-10-21T22:00:00Z" })]);
  assert.equal(proposed.startDate, "2026-10-20");
  assert.equal(proposed.endDate, "2026-10-21");
  assert.equal(proposed.days, 2);
});

test("calendar URL association requires exact course path boundaries and an unambiguous project", () => {
  const linked = event({ projectId: "", title: "Studioarbeit", source: { kind: "spaces", url: url + "posts/42/" } });
  assert.equal(suggestion([linked]).evidence[0].match, "url");
  assert.equal(suggestion([{ ...linked, source: { kind: "spaces", url: "https://spaces.th-koeln.de/prototyping-things-w26-neighbour/" } }]).source, "default");
  const duplicate = project({ id: "other", name: "Anderer Kurs" });
  assert.equal(suggestion([linked], {}, { projects: [project(), duplicate] }).source, "default");
});

test("clear exact course names can propose periods; partial and ambiguous names do not", () => {
  const named = event({ projectId: "", title: "Prototyping Things · Workshop" });
  assert.equal(suggestion([named]).evidence[0].match, "name");
  for (const title of ["Prototyping", "Ein Text über Prototyping Things", "Prototyping Things Extended"])
    assert.equal(suggestion([{ ...named, title }]).source, "default");
  const duplicate = project({ id: "same-name", links: [{ tool: "spaces", url: "https://spaces.th-koeln.de/other-course/" }] });
  assert.equal(suggestion([named], {}, { projects: [project(), duplicate] }).source, "default");
});

test("explicit different course ownership overrides matching names and URLs", () => {
  const other = project({ id: "other", name: "Another Course", links: [{ tool: "spaces", url: "https://spaces.th-koeln.de/other-course/" }] });
  assert.equal(suggestion([event({ projectId: "other", source: { kind: "spaces", url } })], {}, { projects: [project(), other] }).source, "default");
});

test("proposals ignore invalid/unrelated/far-future events and break date ties deterministically", () => {
  const a = event({ id: "a", title: "Auswahl A" }), b = event({ id: "b", title: "Auswahl B" });
  assert.deepEqual(suggestion([b, a]), suggestion([a, b]));
  assert.deepEqual(suggestion([b, a]).eventIds, ["a"]);
  const invalid = [{ ...a, start: "2026-02-30" }, { ...a, start: "2027-10-13", end: "2027-10-14" },
    { ...a, projectId: "unknown" }, { ...a, end: a.start }];
  assert.equal(suggestion(invalid).source, "default");
  assert.equal(suggestion(invalid).startDate, "2026-10-13");
  assert.equal(suggestion(invalid).endDate, "2026-10-26");
  assert.equal(suggestion([a], { startDate: "2026-10-15", days: 7 }).startDate, "2026-10-15");
  assert.equal(suggestion([a], { startDate: "2026-10-15", days: 7 }).endDate, "2026-10-21");
});

test("a recent course start with a matching upcoming session proposes the current fourteen-day phase", () => {
  const beginning = event({ id: "course-start", title: "Prototyping Things · Start", allDay: false,
    start: "2026-10-12T10:00:00+02:00", end: "2026-10-12T17:00:00+02:00" });
  const continuation = event({ id: "course-followup", title: "Prototyping Things · Werkstatt", allDay: false,
    start: "2026-10-23T10:00:00+02:00", end: "2026-10-23T17:00:00+02:00" });
  const proposed = suggestion([continuation, beginning]);
  assert.equal(proposed.source, "calendar");
  assert.equal(proposed.proposal, true);
  assert.equal(proposed.startDate, "2026-10-12");
  assert.equal(proposed.endDate, "2026-10-25");
  assert.equal(proposed.days, 14);
  assert.deepEqual(proposed.eventIds, ["course-start", "course-followup"]);
  assert.equal(proposed.evidence.length, 2);
  assert.match(proposed.reason, /laufende Kursphase/);
  assert.match(proposed.reason, /12\.10\.2026[\s\S]*23\.10\.2026/);
  assert.deepEqual(proposed, suggestion([beginning, continuation]));
});

test("recent session inference requires a future course match in the same window and cannot reuse stale or unrelated starts", () => {
  const recent = event({ id: "recent", start: "2026-10-12", end: "2026-10-13" });
  const future = event({ id: "future", start: "2026-10-23", end: "2026-10-24" });
  assert.equal(suggestion([recent]).source, "default");
  assert.equal(suggestion([recent]).startDate, "2026-10-13");
  assert.equal(suggestion([recent, { ...future, start: "2026-10-28", end: "2026-10-29" }]).startDate, "2026-10-28");
  assert.equal(suggestion([{ ...recent, start: "2026-09-29", end: "2026-09-30" }, future]).startDate, "2026-10-23");
  assert.equal(suggestion([recent, { ...future, projectId: "another-course" }]).source, "default");
  assert.equal(suggestion([recent, future], { days: 7 }).startDate, "2026-10-23");
  assert.equal(suggestion([recent, future], { startDate: "2026-10-13" }).startDate, "2026-10-13");
  const endedBlock = { ...recent, start: "2026-10-10", end: "2026-10-13" };
  assert.equal(suggestion([endedBlock, future]).startDate, "2026-10-23");
});

test("an explicit ongoing multi-day calendar block takes precedence over inferred sessions and today's class", () => {
  const block = event({ id: "explicit-phase", title: "Prototyping Things · Projektphase", start: "2026-10-10", end: "2026-10-24" });
  const recent = event({ id: "recent", start: "2026-10-12", end: "2026-10-13" });
  const today = event({ id: "today", start: "2026-10-13", end: "2026-10-14" });
  const upcoming = event({ id: "future", start: "2026-10-23", end: "2026-10-24" });
  const proposed = suggestion([upcoming, today, recent, block]);
  assert.equal(proposed.startDate, "2026-10-10");
  assert.equal(proposed.endDate, "2026-10-23");
  assert.equal(proposed.days, 14);
  assert.deepEqual(proposed.eventIds, ["explicit-phase"]);
});

test('legacy diaries receive safe presentation defaults, and backup imports retain styling',()=>{
 const diary=makeDiary();delete diary.presentation;
 assert.deepEqual(validateDevDiary(diary).presentation,{layout:'sections',order:'oldest',headings:'questions',hideEmpty:false,showPeriod:true});
 const style={layout:'collapsible',order:'newest',headings:'compact',hideEmpty:true,showPeriod:false};
 assert.deepEqual(validateDevDiary({...diary,presentation:style},undefined,{imported:true}).presentation,style);
 for(const presentation of [null,[],{layout:'<script>'},{order:'random'},{headings:'html'},{hideEmpty:'yes'},{showPeriod:1},{injected:true}])assert.throws(()=>validateDevDiary({...diary,presentation}));
});

test('presentation compiles the same daily entries with ordered disclosures and no empty-field placeholders',()=>{
 let diary=makeDiary({days:3,presentation:{layout:'collapsible',order:'newest',headings:'compact',hideEmpty:true,showPeriod:false}});
 diary=updateDailyEntry(diary,'2026-10-13',{done:'Erster Tag <script>alert(1)</script>'});
 diary=updateDailyEntry(diary,'2026-10-14',{learned:'Neue Erkenntnis'});
 const md=compileDevDiaryMarkdown(diary);
 assert(md.indexOf('14.10.2026')<md.indexOf('13.10.2026'));
 assert.equal((md.match(/<details>/g)||[]).length,2);
 assert.equal((md.match(/<\/details>/g)||[]).length,2);
 assert.match(md,/### Ergebnisse/);assert.match(md,/### Erkenntnisse/);
 assert.doesNotMatch(md,/Zeitraum:|Noch nicht ausgefüllt|### Herausforderungen|<script>/);
 assert.match(md,/&lt;script&gt;/);
 assert.equal(validateDevDiary(diary).entries[0].done,'Erster Tag <script>alert(1)</script>');
});
