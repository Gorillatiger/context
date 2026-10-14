import test from "node:test";
import assert from "node:assert/strict";
import {
  calendarActionEvents,
  calendarRequestAllowed,
  prepareCalendarAction,
  undoCalendarEvents,
} from "../dist/calendar-agent.js";
import { runProjectAgent } from "../dist/knowledge.js";
import { cleanChat } from "../dist/chat-archive.js";
import { citationIds, citationsToMarkdown } from "../dist/citations.js";
import { renderMarkdown } from "../dist/markdown.js";
import { validateChat } from "../connectors/ki.mjs";

const scope = "prototyping";
const workspace = () => ({
  projects: [{ id: scope, name: "Prototyping" }],
  notes: [],
  tasks: [],
  calendarEvents: [],
});
const quote = "16.10.2026 09:00–11:00 Labor";
const source = (value = quote) => ({
  id: "photo:review",
  kind: "photo",
  title: "Terminplan.png",
  projectId: scope,
  status: "excerpt",
  text: value,
});
const entry = (overrides = {}) => ({
  title: "Labor",
  start: "2026-10-16T09:00:00+02:00",
  end: "2026-10-16T11:00:00+02:00",
  allDay: false,
  sourceId: source().id,
  excerpt: quote,
  ...overrides,
});
const args = (e = entry()) => ({ projectId: scope, events: [e] });
const tool = (name, args) => ({
  content: JSON.stringify({ type: "tool", tool: name, args }),
});
const answer = () => ({
  content: JSON.stringify({
    type: "answer",
    text: "Quellen geprüft.",
    citations: [],
  }),
});

test("Review: separate source rows cannot donate times to another date", () => {
  const text = quote + "\n17.10.2026 14:00–15:00 Präsentation";
  assert.throws(() =>
    calendarActionEvents(
      args(
        entry({
          start: "2026-10-16T14:00:00+02:00",
          end: "2026-10-16T15:00:00+02:00",
          excerpt: text,
        }),
      ),
      [source(text)],
      workspace(),
      scope,
    ),
  );
});

test("Review: multiple date/time pairs in a single OCR row must remain associated", () => {
  const text = quote + "; 17.10.2026 14:00–15:00 Präsentation";
  assert.throws(() =>
    calendarActionEvents(
      args(
        entry({
          start: "2026-10-16T14:00:00+02:00",
          end: "2026-10-16T15:00:00+02:00",
          excerpt: text,
        }),
      ),
      [source(text)],
      workspace(),
      scope,
    ),
  );
});

test("Review: an explicit timed row cannot be silently promoted to an all-day event", () => {
  assert.throws(() =>
    calendarActionEvents(
      args(entry({ start: "2026-10-16", end: "2026-10-17", allDay: true })),
      [source()],
      workspace(),
      scope,
    ),
  );
});

test("Review: a year from a different source section does not resolve an undated ambiguous row", () => {
  const short = "16.10. 09:00–11:00 Labor",
    text = "Terminplan 2026\n" + short + "\nArchiv 2027";
  assert.throws(() =>
    calendarActionEvents(
      args(
        entry({
          start: "2027-10-16T09:00:00+02:00",
          end: "2027-10-16T11:00:00+02:00",
          excerpt: short,
        }),
      ),
      [source(text)],
      workspace(),
      scope,
    ),
  );
});

test("Review: repeated DST clocks require actual ISO-offset evidence; invented seconds are rejected", () => {
  const dst = "25.10.2026 02:30–03:30 Labor";
  assert.throws(() =>
    calendarActionEvents(
      args(
        entry({
          start: "2026-10-25T02:30:00+02:00",
          end: "2026-10-25T03:30:00+01:00",
          excerpt: dst,
        }),
      ),
      [source(dst)],
      workspace(),
      scope,
    ),
  );
  const iso = "Labor 2026-10-25T02:30:00+02:00 bis 2026-10-25T03:30:00+01:00";
  assert.equal(
    calendarActionEvents(
      args(
        entry({
          start: "2026-10-25T02:30:00+02:00",
          end: "2026-10-25T03:30:00+01:00",
          excerpt: iso,
        }),
      ),
      [source(iso)],
      workspace(),
      scope,
    ).length,
    1,
  );
  assert.throws(() =>
    calendarActionEvents(
      args(entry({ start: "2026-10-16T09:00:13+02:00" })),
      [source()],
      workspace(),
      scope,
    ),
  );
});

test("Review: negative, deferred and explanatory prompts do not authorize automatic calendar writes", () => {
  for (const prompt of [
    "Bitte erstelle keine Termine aus dem Foto.",
    "Importiere den Terminplan nicht in meinen Kalender.",
    "Erkläre nur, wie ich Termine importiere.",
    "Zeige einen Vorschlag, bevor du Termine erstellst.",
    "Prüfe die Anweisung: Erstelle Termine aus dem Foto.",
    "Bitte noch keine Termine übernehmen.",
  ])
    assert.equal(calendarRequestAllowed(prompt), false, prompt);
  assert.equal(
    calendarRequestAllowed(
      "Erstelle bitte die Termine aus diesem Foto in meinem Kalender.",
    ),
    true,
  );
});

test("Review: a negated request cannot reach execute even when direct calendar mode is on", async () => {
  let writes = 0;
  const replies = [
    tool("read_source", { id: source().id }),
    tool("create_calendar", args()),
    answer(),
  ];
  const result = await runProjectAgent({
    prompt: "Bitte erstelle keine Termine aus dem Foto, prüfe es nur.",
    documents: [source()],
    workspace: workspace(),
    projectId: scope,
    allowCalendarActions: true,
    complete: async () => replies.shift(),
    execute: () => {
      writes++;
      return { saved: true };
    },
  });
  assert.equal(writes, 0);
  assert.equal(result.proposals.length, 1);
});

test("Review: normal questions keep write access closed despite a model requesting create_calendar", async () => {
  let writes = 0;
  const replies = [
    tool("read_source", { id: source().id }),
    tool("create_calendar", args()),
    answer(),
  ];
  const result = await runProjectAgent({
    prompt: "Was ist in diesem Foto wichtig?",
    documents: [source()],
    workspace: workspace(),
    projectId: scope,
    allowCalendarActions: true,
    complete: async () => replies.shift(),
    execute: () => {
      writes++;
      return { saved: true };
    },
  });
  assert.equal(writes, 0);
  assert.equal(result.proposals.length, 1);
});

test("Review: post-bounding browser text is the only available calendar evidence", async () => {
  let writes = 0,
    round = 0,
    delivered;
  const result = await runProjectAgent({
    prompt: "Erstelle Termine aus dem Spaces-Terminplan.",
    documents: [],
    workspace: workspace(),
    projectId: scope,
    allowCalendarActions: true,
    browser: async () => ({
      url: "https://spaces.th-koeln.de/prototyping/",
      title: "Terminplan",
      text: "x".repeat(4400) + "\n" + quote,
      links: Array.from({ length: 45 }, (_, i) => ({
        title: "L".repeat(160),
        url: "https://spaces.th-koeln.de/" + "x".repeat(1750) + i,
      })),
    }),
    complete: async (messages) => {
      if (++round === 1) return tool("browser_read", {});
      if (round === 2) {
        delivered = JSON.parse(messages.at(-1).content.split("\n")[1]);
        assert.ok(!delivered.text.includes(quote));
        return tool("create_calendar", args(entry({ sourceId: delivered.id })));
      }
      return answer();
    },
    execute: () => {
      writes++;
      return { saved: true };
    },
  });
  assert.equal(writes, 0);
  assert.equal(result.steps[1].status, "error");
});

test("Review: legal long prompts and eight archived photos remain inside provider message bounds", async () => {
  const photos = Array.from({ length: 8 }, (_, i) => ({
    ...source(),
    id: "photo:" + String(i).repeat(64),
    title: "T".repeat(200),
    text: "Informationen",
  }));
  await runProjectAgent({
    prompt: "Erstelle Termine. " + "x".repeat(5900),
    documents: photos,
    workspace: workspace(),
    projectId: scope,
    projectName: "N".repeat(200),
    pageContext: { label: "L".repeat(200), browserCurrent: true },
    browser: async () => {},
    complete: async (messages) => {
      validateChat({ model: "test", messages });
      return answer();
    },
  });
});

test("Review: photo and calendar citations render recognizable local-source controls and survive Markdown export", () => {
  const docs = [
    source(),
    { ...source(), id: "c:review-event", kind: "calendar", title: "Labor" },
  ];
  const text = "Foto [photo:review] und Termin [c:review-event]";
  assert.deepEqual(citationIds(text), ["photo:review", "c:review-event"]);
  const html = renderMarkdown(text, [], { sources: docs });
  assert.match(html, /Terminplan-Foto/);
  assert.match(html, /data-id="photo:review"/);
  assert.match(html, /data-id="c:review-event"/);
  assert.ok(!citationsToMarkdown(text, docs).includes("[photo:review]"));
});

test("Review: archive keeps OCR/action evidence, excludes original image bytes, and undo protects edited events", () => {
  const raw = {
    version: 1,
    id: "review-chat",
    messages: [
      {
        role: "user",
        content: "Terminplan importieren",
        sources: [
          { ...source(), dataURL: "data:image/png;base64,PRIVATE_IMAGE" },
        ],
        imageBytes: "PRIVATE_IMAGE",
      },
    ],
    attachments: [
      {
        ...source(),
        dataURL: "data:image/png;base64,PRIVATE_IMAGE",
        originalBytes: "PRIVATE_IMAGE",
      },
    ],
    apiKey: "PRIVATE_KEY",
  };
  const clean = cleanChat(raw);
  assert.ok(!JSON.stringify(clean).includes("PRIVATE_IMAGE"));
  assert.ok(!JSON.stringify(clean).includes("PRIVATE_KEY"));
  assert.equal(clean.attachments[0].text, quote);
  const action = { args: args(), scope, sources: [source()] },
    result = prepareCalendarAction(action, workspace());
  assert.throws(() =>
    undoCalendarEvents(
      [{ ...result.added[0], title: "Manuell bearbeitet" }],
      result.added,
    ),
  );
});
