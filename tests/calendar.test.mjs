import test from "node:test";
import assert from "node:assert/strict";
import {
  validateCalendarEvent,
  validateCalendarEvents,
  berlinLocalToInstant,
  berlinDateTime,
  berlinLocalInput,
  importICS,
  exportICS,
  proposeCalendarEvents,
  taskEvents,
} from "../dist/calendar-engine.js";

const event = (overrides = {}) => ({
  id: "event-one",
  title: "Prototyping · Kurs",
  projectId: "studio",
  allDay: false,
  start: "2026-10-16T09:00:00+02:00",
  end: "2026-10-16T11:00:00+02:00",
  source: { kind: "local" },
  ...overrides,
});
const calendar = (...components) =>
  [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Test//Calendar//DE",
    ...components.flat(),
    "END:VCALENDAR",
    "",
  ].join("\r\n");
const component = (lines = []) => [
  "BEGIN:VEVENT",
  "UID:lesson-1@example.org",
  "SUMMARY:Kursvorbereitung",
  "DTSTART:20261016T070000Z",
  "DTEND:20261016T090000Z",
  ...lines,
  "END:VEVENT",
];

test("validated timed events preserve absolute instants and use Berlin independently of host settings", () => {
  const normalized = validateCalendarEvent(event(), { projectIds: ["studio"] });
  assert.equal(normalized.start, "2026-10-16T07:00:00.000Z");
  assert.equal(normalized.end, "2026-10-16T09:00:00.000Z");
  assert.equal(normalized.timeZone, "Europe/Berlin");
  assert.deepEqual(normalized.source, {
    kind: "local",
    title: "",
    url: "",
    excerpt: "",
    externalId: "",
  });
  assert.equal(normalized.readonly, false);
  assert.equal(berlinLocalInput(normalized.start), "2026-10-16T09:00");
  assert.equal(berlinDateTime("2026-01-16T09:00"), "2026-01-16T08:00:00.000Z");
  assert.equal(
    berlinDateTime("2026-07-16T09:00:30"),
    "2026-07-16T07:00:30.000Z",
  );
});

test("all-day ends are exclusive and calendar dates are genuinely validated", () => {
  const normalized = validateCalendarEvent(
    event({ allDay: true, start: "2028-02-29", end: "2028-03-01" }),
  );
  assert.equal(normalized.start, "2028-02-29");
  assert.equal(normalized.end, "2028-03-01");
  for (const override of [
    { allDay: true, start: "2026-02-29", end: "2026-03-01" },
    { allDay: true, start: "2026-10-16", end: "2026-10-16" },
    { start: "2026-10-16T24:00:00Z" },
    { start: "2026-10-16T09:00" },
    { start: "2026-10-16T09:00:00+15:00" },
    { end: "2026-10-16T06:59:59Z" },
    { allDay: "true" },
    { timeZone: "America/New_York" },
  ])
    assert.throws(() => validateCalendarEvent(event(override)));
});

test("local DST gaps and duplicate autumn clock times are rejected rather than shifted", () => {
  assert.throws(() => berlinDateTime("2026-03-29T02:30"), /existiert.*nicht/);
  assert.throws(() => berlinDateTime("2026-10-25T02:30"), /doppeldeutig/);
  assert.equal(
    berlinLocalToInstant("2026-03-29", "01:30"),
    "2026-03-29T00:30:00.000Z",
  );
  assert.equal(
    berlinLocalToInstant("2026-03-29", "03:30"),
    "2026-03-29T01:30:00.000Z",
  );
  assert.equal(berlinLocalInput("2026-10-25T00:30:00Z"), "2026-10-25T02:30");
  assert.equal(berlinLocalInput("2026-10-25T01:30:00Z"), "2026-10-25T02:30");
});

test("calendar collection enforces 2000 unique IDs and course ownership without mutating inputs", () => {
  const original = event();
  const snapshot = structuredClone(original);
  validateCalendarEvents([original], { projectIds: ["studio"] });
  assert.deepEqual(original, snapshot);
  const maximum = Array.from({ length: 2000 }, (_, index) =>
    event({ id: "event-" + index }),
  );
  assert.equal(validateCalendarEvents(maximum).length, 2000);
  assert.throws(
    () => validateCalendarEvents([...maximum, event({ id: "extra" })]),
    /2000/,
  );
  assert.throws(() => validateCalendarEvents([event(), event()]), /Doppelte/);
  assert.throws(
    () => validateCalendarEvent(event(), { projectIds: ["public"] }),
    /unbekannten Kurs/,
  );
  assert.throws(
    () => validateCalendarEvent(event({ title: "x".repeat(241) })),
    /zu lang/,
  );
  assert.throws(
    () => validateCalendarEvent(event({ id: "a".repeat(161) })),
    /zu lang/,
  );
});

test("source links reject executable protocols, malformed addresses and credentials; extra secrets are dropped", () => {
  for (const value of [
    "javascript:alert(1)",
    "data:text/html,test",
    "file:///tmp/a",
    "http://example.org/",
    "https://name:password@example.org/",
    "https://example.org/\r\nBEGIN:VEVENT",
    "https://",
  ])
    assert.throws(() =>
      validateCalendarEvent(event({ source: { kind: "spaces", url: value } })),
    );
  const normalized = validateCalendarEvent(
    event({
      apiKey: "DROP_TOP_SECRET",
      source: {
        kind: "drive",
        title: "Plan",
        url: "https://drive.google.com/file/d/example/view",
        excerpt: "Zeile 1\nZeile 2",
        externalId: "provider-event",
        cookie: "DROP_SOURCE_SECRET",
      },
    }),
  );
  assert.ok(!JSON.stringify(normalized).includes("DROP_"));
  assert.equal(normalized.source.excerpt, "Zeile 1\nZeile 2");
  assert.throws(() =>
    validateCalendarEvent(event({ source: { kind: "unknown" } })),
  );
  assert.throws(() =>
    validateCalendarEvent(
      event({ source: { kind: "local", excerpt: "x".repeat(4001) } }),
    ),
  );
});

test("ICS UTC and explicit Berlin appointments normalize correctly across the DST transition", () => {
  const utc = importICS(calendar(component()), {
    projectId: "studio",
    sourceTitle: "Stundenplan",
  });
  assert.equal(utc.events.length, 1);
  assert.deepEqual(utc.warnings, []);
  assert.equal(utc.events[0].start, "2026-10-16T07:00:00.000Z");
  assert.equal(utc.events[0].source.externalId, "lesson-1@example.org");
  const berlin = importICS(
    calendar([
      "BEGIN:VEVENT",
      "UID:berlin",
      "SUMMARY:Zeitumstellung",
      'DTSTART;TZID="Europe/Berlin":20260329T013000',
      "DTEND;TZID=Europe/Berlin:20260329T033000",
      "END:VEVENT",
    ]),
  );
  assert.equal(berlin.events.length, 1);
  assert.equal(berlin.events[0].start, "2026-03-29T00:30:00.000Z");
  assert.equal(berlin.events[0].end, "2026-03-29T01:30:00.000Z");
});

test("ICS all-day DTEND stays exclusive, with standard one-day default only for absent all-day end", () => {
  const explicit = importICS(
    calendar([
      "BEGIN:VEVENT",
      "UID:all-day",
      "SUMMARY:Blockkurs",
      "DTSTART;VALUE=DATE:20261016",
      "DTEND;VALUE=DATE:20261018",
      "END:VEVENT",
    ]),
  );
  assert.equal(explicit.events[0].start, "2026-10-16");
  assert.equal(explicit.events[0].end, "2026-10-18");
  const implicit = importICS(
    calendar([
      "BEGIN:VEVENT",
      "UID:one-day",
      "SUMMARY:Abgabe",
      "DTSTART;VALUE=DATE:20261231",
      "END:VEVENT",
    ]),
  );
  assert.equal(implicit.events[0].end, "2027-01-01");
  const ambiguous = importICS(
    calendar([
      "BEGIN:VEVENT",
      "UID:no-end",
      "SUMMARY:Kurs",
      "DTSTART:20261016T070000Z",
      "END:VEVENT",
    ]),
  );
  assert.equal(ambiguous.events.length, 0);
  assert.match(ambiguous.warnings[0], /kein explizites Ende/);
});

test("ICS unsupported or ambiguous zones never fall back to the system timezone", () => {
  for (const start of [
    "DTSTART:20261016T090000",
    "DTSTART;TZID=America/New_York:20261016T090000",
    "DTSTART;TZID=Europe/Berlin:20260329T023000",
    "DTSTART;TZID=Europe/Berlin:20261025T023000",
    "DTSTART;TZID=Europe/Berlin:20261016T090000Z",
  ]) {
    const result = importICS(
      calendar([
        "BEGIN:VEVENT",
        "UID:invalid-zone",
        "SUMMARY:Kurs",
        start,
        "DTEND:20261016T100000Z",
        "END:VEVENT",
      ]),
    );
    assert.equal(result.events.length, 0);
    assert.equal(result.warnings.length, 1);
  }
});

test("raw recurring events are visibly skipped while expanded independent provider occurrences remain valid", () => {
  for (const recurrence of [
    "RRULE:FREQ=WEEKLY;COUNT=3",
    "RDATE:20261023T070000Z",
    "EXDATE:20261023T070000Z",
    "RECURRENCE-ID:20261016T070000Z",
  ]) {
    const independent = component().map((line) =>
      line.replace("UID:lesson-1@example.org", "UID:expanded-occurrence"),
    );
    const result = importICS(calendar(component([recurrence]), independent));
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].source.externalId, "expanded-occurrence");
    assert.match(result.warnings[0], /Wiederholungsserie nicht importiert/);
  }
});

test("ICS alarms do not become executable calendar data and cancelled events are not revived", () => {
  const result = importICS(
    calendar(
      component([
        "BEGIN:VALARM",
        "ACTION:AUDIO",
        "TRIGGER:-PT15M",
        "ATTACH:https://example.org/alarm.mp3",
        "END:VALARM",
      ]),
    ),
  );
  assert.equal(result.events.length, 1);
  assert.match(result.warnings[0], /Alarm ignoriert/);
  const exported = exportICS(result.events);
  assert.ok(!exported.includes("VALARM"));
  assert.ok(!exported.includes("ATTACH"));
  assert.equal(
    importICS(calendar(component(["STATUS:CANCELLED"]))).events.length,
    0,
  );
});

test("ICS unfolding and text escaping survive Unicode line folding without injecting components", () => {
  const original = validateCalendarEvent(
    event({
      title: "Workshop, Prototyp; „Ä“ " + "🚀".repeat(35),
      source: {
        kind: "local",
        externalId: "test;escaped,uid",
        excerpt: "Erste Zeile, mit Semikolon;\nZweite Zeile mit \\Backslash",
        url: "https://spaces.th-koeln.de/course/",
      },
    }),
  );
  const exported = exportICS([original]);
  assert.ok(
    exported
      .split("\r\n")
      .every((line) => new TextEncoder().encode(line).length <= 75),
  );
  const imported = importICS(exported);
  assert.deepEqual(imported.warnings, []);
  assert.equal(imported.events[0].title, original.title);
  assert.equal(imported.events[0].source.excerpt, original.source.excerpt);
  assert.equal(
    imported.events[0].source.externalId,
    original.id + "@context.local",
  );
  assert.equal(imported.events[0].start, original.start);
  assert.equal(imported.events[0].end, original.end);
});

test("ICS component injection and duplicate mandatory properties are rejected without importing fake appointments", () => {
  assert.throws(() => exportICS([event({ title: "Kurs\r\nBEGIN:VEVENT" })]));
  assert.throws(() =>
    exportICS([
      event({ source: { kind: "local", externalId: "uid\nEND:VEVENT" } }),
    ]),
  );
  const uidInjection = importICS(
    calendar(
      component().map((line) =>
        line.replace("UID:lesson-1@example.org", "UID:uid\\nBEGIN:VEVENT"),
      ),
    ),
  );
  assert.equal(uidInjection.events.length, 0);
  const duplicated = importICS(
    calendar(component(["DTSTART:20261017T070000Z"])),
  );
  assert.equal(duplicated.events.length, 0);
  assert.match(duplicated.warnings[0], /Mehrfache/);
  const maliciousURL = importICS(
    calendar(component(["URL:javascript:alert(1)"])),
  );
  assert.equal(maliciousURL.events.length, 0);
  assert.throws(() => importICS("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:test"));
});

test("ICS duplicate UID is deduplicated deterministically and missing IDs are visible failures", () => {
  const result = importICS(calendar(component(), component()));
  assert.equal(result.events.length, 1);
  assert.match(result.warnings[0], /Doppelte UID/);
  assert.equal(
    importICS(calendar(component())).events[0].id,
    result.events[0].id,
  );
  const noUID = component().filter((line) => !line.startsWith("UID:"));
  assert.equal(importICS(calendar(noUID)).events.length, 0);
});

test("ICS export namespaces UIDs by stable calendar event ID despite reused provider identifiers", () => {
  const first = event({
    id: "outlook-primary-1",
    source: { kind: "outlook", externalId: "provider-reused-id" },
  });
  const second = event({
    id: "google-secondary-1",
    title: "Zweiter Termin",
    source: { kind: "google", externalId: "provider-reused-id" },
  });
  const third = event({
    id: "ics-import-1",
    title: "Dritter Termin",
    source: { kind: "ics", externalId: "provider-reused-id" },
  });
  const exported = exportICS([first, second, third]);
  const uids = exported.split("\r\n").filter((line) => line.startsWith("UID:"));
  assert.deepEqual(uids, [
    "UID:outlook-primary-1@context.local",
    "UID:google-secondary-1@context.local",
    "UID:ics-import-1@context.local",
  ]);
  assert.equal(new Set(uids).size, 3);
  assert.equal(exportICS([first, second, third]), exported);
  const imported = importICS(exported);
  assert.equal(imported.events.length, 3);
  assert.deepEqual(imported.warnings, []);
  assert.deepEqual(
    imported.events.map((e) => e.title),
    [first.title, second.title, third.title],
  );
  const edited = {
    ...first,
    title: "Vom Nutzer bearbeiteter Titel",
    start: "2026-10-17T09:00:00+02:00",
    end: "2026-10-17T11:00:00+02:00",
  };
  assert.equal(
    exportICS([edited])
      .split("\r\n")
      .find((line) => line.startsWith("UID:")),
    uids[0],
  );
});

test("ICS ignores timezone-definition components without mistaking their rules for events", () => {
  const timezone = [
    "BEGIN:VTIMEZONE",
    "TZID:Europe/Berlin",
    "BEGIN:DAYLIGHT",
    "DTSTART:19700329T020000",
    "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
    "TZOFFSETFROM:+0100",
    "TZOFFSETTO:+0200",
    "END:DAYLIGHT",
    "END:VTIMEZONE",
  ];
  const result = importICS(calendar(timezone, component()));
  assert.equal(result.events.length, 1);
  assert.deepEqual(result.warnings, []);
  const embedded = importICS(
    calendar([
      "BEGIN:VTIMEZONE",
      "TZID:Europe/Berlin",
      ...component(),
      "END:VTIMEZONE",
    ]),
  );
  assert.equal(embedded.events.length, 0);
  assert.throws(
    () => importICS(calendar(component()).replace("VERSION:2.0\r\n", "")),
    /VERSION/,
  );
  assert.throws(
    () =>
      importICS(calendar(["BEGIN:VCALENDAR", ...component(), "END:VCALENDAR"])),
    /Verschachtelte/,
  );
});

test("ICS export preserves all-day ranges and rejects precision it cannot represent rather than rounding", () => {
  const original = validateCalendarEvent(
    event({ allDay: true, start: "2026-10-16", end: "2026-10-18" }),
  );
  const exported = exportICS([original]);
  assert.match(exported, /DTSTART;VALUE=DATE:20261016/);
  assert.match(exported, /DTEND;VALUE=DATE:20261018/);
  const imported = importICS(exported);
  assert.equal(imported.events[0].end, "2026-10-18");
  assert.throws(
    () => exportICS([event({ start: "2026-10-16T09:00:00.123+02:00" })]),
    /Millisekunden/,
  );
});

test("plain schedule proposals use explicit years, actual Berlin time ranges and literal evidence", () => {
  const line = "Freitag, 16.10.2026 Workshop Prototyping 09:00 bis 11:00";
  const result = proposeCalendarEvents(line, {
    kind: "spaces",
    projectId: "studio",
    title: "Kurs-Space",
    url: "https://spaces.th-koeln.de/studio/",
  });
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].start, "2026-10-16T07:00:00.000Z");
  assert.equal(result.events[0].end, "2026-10-16T09:00:00.000Z");
  assert.equal(result.events[0].projectId, "studio");
  assert.equal(result.events[0].source.excerpt, line);
  assert.equal(
    result.events[0].source.url,
    "https://spaces.th-koeln.de/studio/",
  );
  assert.equal(result.events[0].source.kind, "spaces");
});

test("schedule ambiguity, impossible dates and missing years remain warnings instead of guessed appointments", () => {
  for (const line of [
    "Abgabe Freitag 16.10.",
    "Besprechung morgen 09:00 bis 10:00",
    "31.02.2026 Abgabe",
    "29.02.2027 Workshop",
    "16.10.2026 Termin 09:00",
    "16.10.2026 Termin 11:00 bis 09:00",
    "16.10.2026 bis 18.10.2026 Blockkurs",
    "29.03.2026 Workshop 02:30 bis 03:30",
    "25.10.2026 Workshop 02:30 bis 03:30",
    "16.10.2026 Termin 25:00 bis 26:00",
    "2026-10-16T09:00Z bis 2026-10-16T11:00Z Seminar",
  ]) {
    const result = proposeCalendarEvents(line);
    assert.equal(result.events.length, 0, line);
    assert.equal(result.warnings.length, 1, line);
  }
});

test("CSV headers and quoted titles map to timed proposals with UTC conversion and original row evidence", () => {
  const result = proposeCalendarEvents(
    'Datum;Beginn;Ende;Titel\r\n16.10.2026;09:00;11:00;"Workshop; Prototyping"\r\n',
    {
      kind: "drive",
      projectId: "studio",
      title: "Plan.csv",
      url: "https://drive.google.com/file/d/example/view",
    },
  );
  assert.equal(result.events.length, 1);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.events[0].title, "Workshop; Prototyping");
  assert.equal(
    result.events[0].source.excerpt,
    '16.10.2026;09:00;11:00;"Workshop; Prototyping"',
  );
  assert.equal(result.events[0].start, "2026-10-16T07:00:00.000Z");
  const commas = proposeCalendarEvents(
    'Date,Start,End,Title\n2026-10-16,09:00,11:00,"Workshop, Grundlagen"',
  );
  assert.equal(commas.events[0].title, "Workshop, Grundlagen");
  assert.equal(
    proposeCalendarEvents('Datum;Titel\n16.10.2026;"Nicht geschlossen').events
      .length,
    0,
  );
});

test("CSV time headers determine chronology even when columns are reordered and titles mention other dates", () => {
  const result = proposeCalendarEvents(
    'Ende;Titel;Datum;Beginn\n11:00;"Plan für 23.10.2026";16.10.2026;09:00',
  );
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].title, "Plan für 23.10.2026");
  assert.equal(result.events[0].start, "2026-10-16T07:00:00.000Z");
  assert.equal(result.events[0].end, "2026-10-16T09:00:00.000Z");
  for (const plan of [
    "Datum;Beginn;Titel\n16.10.2026;09:00;Kurs",
    "Datum;Beginn;Ende;Titel\n16.10.2026;09:00;;Kurs",
    "Datum;Titel\n16.10.2026;Kurs;Unerwartete Spalte",
  ]) {
    const ambiguous = proposeCalendarEvents(plan);
    assert.equal(ambiguous.events.length, 0);
    assert.equal(ambiguous.warnings.length, 1);
  }
  const seconds = proposeCalendarEvents(
    "Datum;Beginn;Ende;Titel\n16.10.2026;09:00:30;11:00:40;Kurs",
  );
  assert.equal(seconds.events[0].start, "2026-10-16T07:00:30.000Z");
  assert.equal(seconds.events[0].end, "2026-10-16T09:00:40.000Z");
});

test("date-only proposals are one-day events and duplicate rows retain a single stable identity", () => {
  const plan = "Datum;Titel\n31.12.2026;Abgabe\n31.12.2026;Abgabe";
  const result = proposeCalendarEvents(plan, { projectId: "studio" });
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].allDay, true);
  assert.equal(result.events[0].start, "2026-12-31");
  assert.equal(result.events[0].end, "2027-01-01");
  assert.match(result.warnings[0], /Doppelter Termin/);
  assert.equal(
    result.events[0].id,
    proposeCalendarEvents(plan, { projectId: "studio" }).events[0].id,
  );
});

test("task deadlines are readonly one-day events separate from completed or archived-course obligations", () => {
  const workspace = {
    projects: [
      { id: "studio", archived: false },
      { id: "past", archived: true },
    ],
    tasks: [
      {
        id: "todo",
        title: "Prototyp abgeben",
        projectId: "studio",
        status: "todo",
        due: "2026-10-16",
        url: "",
      },
      {
        id: "personal",
        title: "Persönliche Aufgabe",
        projectId: "",
        status: "doing",
        due: "2026-12-31",
      },
      {
        id: "done",
        title: "Erledigt",
        projectId: "studio",
        status: "done",
        due: "2026-10-16",
      },
      {
        id: "archived",
        title: "Alter Kurs",
        projectId: "past",
        status: "todo",
        due: "2026-10-16",
      },
      {
        id: "undated",
        title: "Ohne Frist",
        projectId: "studio",
        status: "todo",
        due: "",
      },
    ],
  };
  const snapshot = structuredClone(workspace);
  const events = taskEvents(workspace);
  assert.equal(events.length, 2);
  assert.ok(
    events.every((e) => e.readonly && e.allDay && e.source.kind === "local"),
  );
  assert.deepEqual(
    events.map((e) => e.source.externalId),
    ["todo", "personal"],
  );
  assert.equal(events[0].end, "2026-10-17");
  assert.equal(events[1].end, "2027-01-01");
  assert.deepEqual(workspace, snapshot);
  assert.equal(events[0].id, taskEvents(workspace)[0].id);
});
