import test from "node:test";
import assert from "node:assert/strict";
import { initialState, validateState } from "../dist/core.js";
import {
  calendarActionEvents,
  validateCalendarTool,
  prepareCalendarAction,
  undoCalendarEvents,
  calendarICSForIds,
} from "../dist/calendar-agent.js";
import { validateAgentReply, runProjectAgent } from "../dist/knowledge.js";
import {
  cleanChat,
  recoverChat,
  encryptChat,
  decryptChat,
} from "../dist/chat-archive.js";
import { importICS } from "../dist/calendar-engine.js";
import { validateChat } from "../connectors/ki.mjs";
import { webcrypto } from "node:crypto";
const quote = "16.10.2026\t09:00–11:00\tPrototyping im Labor";
const doc = {
  id: "photo:fixture",
  kind: "photo",
  title: "Terminplan.png",
  projectId: "prototyping",
  status: "excerpt",
  text: "Wintersemester 2026/27\n" + quote,
};
const entry = {
  title: "Prototyping im Labor",
  start: "2026-10-16T09:00:00+02:00",
  end: "2026-10-16T11:00:00+02:00",
  allDay: false,
  sourceId: doc.id,
  excerpt: quote,
};
const args = () => ({ projectId: "prototyping", events: [{ ...entry }] });
const action = () => ({
  id: "action-1",
  tool: "create_calendar",
  scope: "prototyping",
  args: args(),
  sources: [doc],
});
const reply = (tool, a) => ({
  content: JSON.stringify({ type: "tool", tool, args: a }),
});
const answer = () => ({
  content: JSON.stringify({
    type: "answer",
    text: "Zwei Schritte abgeschlossen.",
    citations: [doc.id],
  }),
});
test("photo timetable makes sourced canonical events and a valid roundtrip ICS", () => {
  const s = initialState(),
    events = calendarActionEvents(args(), [doc], s, "prototyping");
  assert.equal(events.length, 1);
  assert.equal(events[0].start, "2026-10-16T07:00:00.000Z");
  assert.equal(events[0].source.kind, "photo");
  assert.equal(events[0].source.excerpt, quote);
  s.calendarEvents = events;
  const ics = calendarICSForIds(
    events.map((e) => e.id),
    s,
  );
  assert.match(ics, /BEGIN:VEVENT/);
  const imported = importICS(ics);
  assert.equal(imported.events[0].start, events[0].start);
  assert.equal(imported.events[0].end, events[0].end);
  assert.deepEqual(validateState(s).calendarEvents, events);
});
test("equivalent offsets and repeated source processing keep identity; bulk import and undo preserve prior events", () => {
  const s = initialState(),
    a = action(),
    first = prepareCalendarAction(a, s);
  s.calendarEvents = first.calendarEvents;
  a.args.events[0].start = "2026-10-16T07:00:00Z";
  a.args.events[0].end = "2026-10-16T09:00:00Z";
  const second = prepareCalendarAction(a, s);
  assert.equal(second.added.length, 0);
  assert.deepEqual(second.eventIds, first.eventIds);
  const original = { ...first.added[0], id: "preexisting" };
  assert.deepEqual(
    undoCalendarEvents([...first.calendarEvents, original], first.added),
    [original],
  );
  assert.throws(
    () =>
      undoCalendarEvents(
        [{ ...first.added[0], title: "Manuell geändert" }],
        first.added,
      ),
    /bearbeitet/,
  );
});
test("missing or contradictory year, invented end time, foreign sources and unread quotes fail atomically", () => {
  const cases = [
    { ...doc, text: quote.replace("2026", "2025") },
    { ...doc, text: quote.replace(".2026", "") },
    { ...doc, text: "2026\n" + quote.replace("2026", "2025") },
    { ...doc, text: quote.replace("11:00", "12:00") },
    { ...doc, projectId: "go-public" },
    { ...doc, kind: "projects" },
    { ...doc, status: "metadata" },
  ];
  for (const bad of cases)
    assert.throws(() =>
      calendarActionEvents(args(), [bad], initialState(), "prototyping"),
    );
  const a = args();
  a.events.push({ ...entry, end: "2026-10-16T12:00:00+02:00" });
  assert.throws(() =>
    prepareCalendarAction({ ...action(), args: a }, initialState()),
  );
  assert.throws(() =>
    calendarActionEvents(args(), [], initialState(), "prototyping"),
  );
});
test("shared-year header works, all-day end is exclusive, invalid tool fields and impossible dates are rejected", () => {
  const short = "16.10. 09:00–11:00 Prototyping im Labor",
    a = args();
  a.events[0].excerpt = short;
  assert.equal(
    calendarActionEvents(
      a,
      [{ ...doc, text: "Semester 2026\n" + short }],
      initialState(),
    ).length,
    1,
  );
  const b = args();
  b.events = [
    {
      ...entry,
      start: "2026-10-16",
      end: "2026-10-17",
      allDay: true,
      excerpt: "16.10.2026 Präsentation",
    },
  ];
  assert.equal(
    calendarActionEvents(
      b,
      [{ ...doc, text: b.events[0].excerpt }],
      initialState(),
    )[0].end,
    "2026-10-17",
  );
  for (const bad of [
    { ...args(), url: "https://evil.example" },
    { ...args(), events: [] },
    { ...args(), events: [{ ...entry, password: "secret" }] },
    { ...args(), events: [{ ...entry, start: "2026-02-30T09:00:00Z" }] },
  ])
    assert.throws(() => validateCalendarTool(bad));
  assert.equal(
    validateAgentReply(reply("create_calendar", args()).content).tool,
    "create_calendar",
  );
});
test("agent reads photo then directly imports calendar while general task writes remain disabled", async () => {
  const actions = [],
    outputs = [
      reply("read_source", { id: doc.id }),
      reply("create_calendar", args()),
      answer(),
    ];
  const result = await runProjectAgent({
    prompt: "Erstelle Termine aus diesem Foto und importiere sie.",
    documents: [doc],
    workspace: initialState(),
    projectId: "prototyping",
    allowCalendarActions: true,
    allowActions: false,
    complete: async (messages) => {
      validateChat({ model: "test", messages });
      return outputs.shift();
    },
    execute: (a) => {
      actions.push(a);
      return { id: a.id, saved: true, eventIds: ["agent-cal-test"] };
    },
  });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].sources[0].text, doc.text);
  assert.equal(result.proposals.length, 0);
  assert.equal(result.steps[1].action.saved, true);
});
test("calendar proposal includes actual source evidence and never applies unknown or unseen text", async () => {
  let writes = 0;
  const outputs = [
    reply("read_source", { id: doc.id }),
    reply("create_calendar", args()),
    answer(),
  ];
  const result = await runProjectAgent({
    prompt: "Termine vorschlagen",
    documents: [doc],
    workspace: initialState(),
    projectId: "prototyping",
    complete: async () => outputs.shift(),
    execute: () => writes++,
  });
  assert.equal(writes, 0);
  assert.equal(result.proposals[0].sources[0].id, doc.id);
  const long = { ...doc, text: "Andere Information. ".repeat(500) + quote };
  const replies = [reply("create_calendar", args()), answer()];
  const invalid = await runProjectAgent({
    prompt: "Bitte Termine ausgeben",
    documents: [long],
    workspace: initialState(),
    projectId: "prototyping",
    allowCalendarActions: true,
    complete: async () => replies.shift(),
    execute: () => writes++,
  });
  assert.equal(writes, 0);
  assert.equal(invalid.steps[0].status, "error");
});
test("archive encrypts source OCR, proposal and calendar result without storing original photo or connection secrets", async () => {
  const raw = {
    version: 1,
    id: "photo-chat",
    messages: [
      { role: "user", content: "Importiere Foto", sources: [doc] },
      {
        role: "assistant",
        content: "Übernommen",
        steps: [
          {
            id: 0,
            tool: "create_calendar",
            status: "done",
            action: {
              id: "action-1",
              saved: true,
              eventIds: ["agent-cal-test"],
              count: 1,
            },
          },
        ],
        proposals: [action()],
      },
    ],
    attachments: [{ ...doc, dataURL: "data:image/png;base64,PRIVATE" }],
    calendarDirect: true,
    apiKey: "PRIVATE",
  };
  const clean = cleanChat(raw);
  assert.equal(clean.attachments[0].text, doc.text);
  assert.equal(clean.messages[1].proposals[0].sources[0].text, doc.text);
  assert.ok(!JSON.stringify(clean).includes("PRIVATE"));
  const key = await webcrypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  assert.deepEqual(
    await decryptChat(await encryptChat(clean, key, webcrypto), key, webcrypto),
    clean,
  );
  assert.equal(
    recoverChat(clean).messages[1].steps[0].action.eventIds[0],
    "agent-cal-test",
  );
});
