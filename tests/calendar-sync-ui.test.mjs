import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { validateCalendarEvent } from "../dist/calendar-engine.js";
import {
  initialCalendarSync,
  validateCalendarSync,
  calendarLocalFingerprint,
  syncEligibleEvents,
  syncCandidates,
  mergeSyncResults,
  filterSelfSyncedEvents,
  writableOutlookCalendars,
  createCalendarSynchronizer,
} from "../dist/calendar-sync.js";
import { calendarRequest, createCalendarView } from "../dist/calendar.js";

const instant = "2026-10-16T08:00:00.000Z",
  end = "2026-10-16T09:00:00.000Z",
  now = "2026-10-12T14:00:00.000Z";
const event = (id = "photo-1", patch = {}) =>
  validateCalendarEvent({
    id,
    title: "Werkstatttermin",
    projectId: "course",
    start: instant,
    end,
    allDay: false,
    source: {
      kind: "photo",
      title: "Terminplan-Foto",
      excerpt: "16.10.2026 10:00–11:00",
    },
    ...patch,
  });
const workspace = (events = [event()]) => ({
  projects: [
    { id: "course", name: "Prototyping", archived: false },
    { id: "archived", name: "Archiv", archived: true },
  ],
  calendarEvents: events,
  calendarSync: {
    ...initialCalendarSync(),
    automatic: true,
    target: { calendarId: "own", title: "Context" },
  },
});
async function resultFor(e, status = "created") {
  return {
    id: e.id,
    status,
    remoteId: "remote-" + e.id,
    syncedAt: now,
    url: "https://outlook.office.com/calendar/item/" + e.id,
    lastFingerprint: await calendarLocalFingerprint(e),
    retrySafe: true,
  };
}
function fixture(events = [event()], hooks = {}) {
  let ws = workspace(events),
    saves = 0;
  const calls = [];
  const request = async (action, options = {}) => {
    calls.push({ action, options });
    if (hooks[action])
      return hooks[action](options, {
        get workspace() {
          return ws;
        },
      });
    if (action === "status")
      return { connected: true, syncEnabled: true, readOnly: false };
    if (action === "calendars")
      return {
        calendars: [
          { id: "own", title: "Context", writable: true, canEdit: true },
        ],
      };
    if (action === "sync")
      return {
        results: await Promise.all(
          options.body.events.map((e) => resultFor(e)),
        ),
        complete: true,
        cancelled: false,
      };
    throw new Error("Unexpected request");
  };
  const sync = createCalendarSynchronizer({
    getWorkspace: () => ws,
    saveSettings: (v) => {
      saves++;
      if (hooks.save) return hooks.save(v);
      ws = { ...ws, calendarSync: validateCalendarSync(v) };
      return true;
    },
    request,
    onProgress: hooks.progress,
  });
  return {
    sync,
    calls,
    get saves() {
      return saves;
    },
    get ws() {
      return ws;
    },
    set ws(v) {
      ws = v;
    },
  };
}

test("sync defaults off, namespace survives round-trip, tokens and unknown fields are rejected", () => {
  const s = initialCalendarSync();
  assert.equal(s.automatic, false);
  assert.equal(s.target.calendarId, "");
  assert.deepEqual(validateCalendarSync(JSON.parse(JSON.stringify(s))), s);
  assert.throws(() => validateCalendarSync({ ...s, accessToken: "private" }));
  assert.throws(() => validateCalendarSync({ ...s, automatic: true }));
  assert.throws(() =>
    validateCalendarSync({ ...s, target: { ...s.target, provider: "google" } }),
  );
  assert.throws(() => validateCalendarSync({ ...s, namespace: "bad" }));
});
test("only own writable Outlook calendars qualify; imported and archived entries never push", () => {
  assert.deepEqual(
    writableOutlookCalendars([
      { id: "own", title: "A", writable: true, canEdit: true },
      { id: "shared", title: "B", writable: false, canEdit: true },
      { id: "readonly", title: "C", writable: true, canEdit: false },
    ]).map((c) => c.id),
    ["own"],
  );
  const ws = workspace([
    event(),
    event("remote", { source: { kind: "outlook" }, readonly: true }),
    event("google", { source: { kind: "google" } }),
    event("archive", { projectId: "archived" }),
    event("personal", { projectId: "" }),
  ]);
  assert.deepEqual(
    syncEligibleEvents(ws).map((e) => e.id),
    ["photo-1", "personal"],
  );
});
test("fingerprint is stable across course metadata and agrees with the provider payload; content/time changes matter", async () => {
  const e = event(),
    a = await calendarLocalFingerprint(e);
  assert.equal(a, await calendarLocalFingerprint({ ...e, projectId: "other" }));
  assert.notEqual(
    a,
    await calendarLocalFingerprint({ ...e, title: "Geänderter Titel" }),
  );
  assert.notEqual(
    a,
    await calendarLocalFingerprint({ ...e, start: "2026-10-16T07:00:00Z" }),
  );
  const body = ["Mit Context angelegt.", e.source.title, e.source.excerpt].join(
    "\n\n",
  );
  assert.equal(
    a,
    createHash("sha256")
      .update(
        JSON.stringify({
          subject: e.title,
          body,
          allDay: false,
          start: e.start,
          end: e.end,
          location: "",
        }),
      )
      .digest("hex"),
  );
});
test("a confirmed unchanged automatic run makes no provider call; explicit manual runs recheck", async () => {
  const f = fixture();
  await f.sync.run();
  assert.equal(f.ws.calendarSync.records[0].status, "created");
  f.calls.length = 0;
  assert.equal((await f.sync.run()).skipped, true);
  assert.equal(f.calls.length, 0);
  await f.sync.run({ manual: true });
  assert.deepEqual(
    f.calls.map((c) => c.action),
    ["status", "calendars", "sync"],
  );
});
test("automatic sync is bounded to 20; manual sync checks all entries in bounded batches", async () => {
  const events = Array.from({ length: 43 }, (_, i) => event("event-" + i)),
    f = fixture(events);
  const automatic = await f.sync.run();
  assert.equal(automatic.synced, 20);
  assert.equal(automatic.pending, 23);
  assert.equal(
    f.calls.find((c) => c.action === "sync").options.body.events.length,
    20,
  );
  f.calls.length = 0;
  const manual = await f.sync.run({ manual: true });
  assert.equal(manual.synced, 43);
  assert.deepEqual(
    f.calls
      .filter((c) => c.action === "sync")
      .map((c) => c.options.body.events.length),
    [20, 20, 3],
  );
  assert.equal(f.ws.calendarSync.records.length, 43);
});
test("permission loss or a shared target fails before any write", async () => {
  for (const hooks of [
    { status: () => ({ connected: true, syncEnabled: false, readOnly: true }) },
    {
      calendars: () => ({
        calendars: [
          { id: "own", title: "Shared", canEdit: true, writable: false },
        ],
      }),
    },
  ]) {
    const f = fixture([event()], hooks);
    await assert.rejects(f.sync.run({ manual: true }));
    assert.equal(
      f.calls.some((c) => c.action === "sync"),
      false,
    );
    assert.equal(f.saves, 0);
  }
});
test("partial cancelled successes stay recorded, missing rows become visible unknowns, and no deleted entries are recreated", async () => {
  const f = fixture([event("one"), event("two")], {
    sync: async (options) => ({
      results: [await resultFor(options.body.events[0])],
      cancelled: true,
      complete: false,
    }),
  });
  const r = await f.sync.run({ manual: true });
  assert.equal(r.cancelled, true);
  assert.equal(r.synced, 1);
  assert.equal(r.failed, 1);
  assert.equal(
    f.ws.calendarSync.records.find((r) => r.id === "two").status,
    "unknown",
  );
  assert.equal((await syncCandidates(f.ws, f.ws.calendarSync)).length, 0);
  f.ws = { ...f.ws, calendarEvents: [] };
  f.calls.length = 0;
  await f.sync.run();
  assert.equal(f.calls.length, 0);
  assert.equal(f.ws.calendarSync.records.length, 2);
});
test("transport uncertainty is saved as unknown and pauses auto instead of claiming rollback", async () => {
  const f = fixture([event()], {
    sync: () => {
      throw new Error("Transport gone");
    },
  });
  await assert.rejects(f.sync.run({ manual: true }), /Transport gone/);
  assert.equal(f.sync.isPaused(), true);
  assert.equal(f.ws.calendarSync.records[0].status, "unknown");
  assert.equal(f.ws.calendarSync.records[0].retrySafe, false);
  assert.match(f.ws.calendarSync.records[0].error, /bereits gespeichert/);
});
test("failure to store external-write metadata pauses sync with an explicit uncertainty message", async () => {
  const f = fixture([event()], { save: () => false });
  await assert.rejects(
    f.sync.run({ manual: true }),
    /Outlook wurde möglicherweise geändert/,
  );
  assert.equal(f.sync.isPaused(), true);
  assert.equal(
    f.calls.some((c) => c.action === "sync"),
    true,
  );
});
test("conflicts never auto-retry, while manual checks and source links remain available", async () => {
  const f = fixture([event()], {
    sync: (options) => ({
      results: [
        {
          id: options.body.events[0].id,
          status: "conflict",
          error: "In Outlook verändert",
          retrySafe: true,
        },
      ],
      cancelled: false,
    }),
  });
  await f.sync.run({ manual: true });
  f.calls.length = 0;
  await f.sync.run();
  assert.equal(f.calls.length, 0);
  await f.sync.run({ manual: true });
  assert.equal(
    f.calls.some((c) => c.action === "sync"),
    true,
  );
});
test("refresh excludes self-published remote IDs only for the correct Outlook calendar", async () => {
  const f = fixture();
  await f.sync.run();
  const ownRemote = event("pull", {
      readonly: true,
      source: { kind: "outlook", externalId: "remote-photo-1" },
    }),
    otherRemote = event("other", {
      readonly: true,
      source: { kind: "outlook", externalId: "not-ours" },
    });
  assert.deepEqual(
    filterSelfSyncedEvents(
      [ownRemote, otherRemote],
      f.ws.calendarSync,
      "own",
    ).map((e) => e.id),
    ["other"],
  );
  assert.equal(
    filterSelfSyncedEvents([ownRemote], f.ws.calendarSync, "different").length,
    1,
  );
});
test("result validation rejects foreign IDs, duplicate rows, unsafe links and credential metadata", async () => {
  const s = workspace().calendarSync,
    submitted = [
      { event: event(), fingerprint: await calendarLocalFingerprint(event()) },
    ],
    good = await resultFor(event());
  for (const row of [
    { ...good, id: "foreign" },
    { ...good, url: "javascript:alert(1)" },
    { ...good, url: "https://evil.test/" },
    { ...good, remoteId: "" },
  ])
    assert.throws(() =>
      mergeSyncResults(s, "own", { results: [row] }, submitted),
    );
  assert.throws(() =>
    mergeSyncResults(s, "own", { results: [good, good] }, submitted),
  );
  const merged = mergeSyncResults(s, "own", { results: [good] }, submitted);
  assert.throws(() =>
    validateCalendarSync({
      ...merged,
      records: [{ ...merged.records[0], token: "bad" }],
    }),
  );
  assert.throws(() =>
    validateCalendarSync({
      ...merged,
      records: [...merged.records, ...merged.records],
    }),
  );
});
test("local edits and deletion between chunks are skipped; remote deletes are never issued", async () => {
  let f;
  f = fixture(
    Array.from({ length: 21 }, (_, i) => event("event-" + i)),
    {
      progress: ({ completed }) => {
        if (completed === 20)
          f.ws = {
            ...f.ws,
            calendarEvents: f.ws.calendarEvents.filter(
              (e) => e.id !== "event-20",
            ),
          };
      },
    },
  );
  const result = await f.sync.run({ manual: true });
  assert.equal(f.calls.filter((c) => c.action === "sync").length, 1);
  assert.equal(result.pending, 0);
  assert.equal(
    f.calls.some((c) => /delete/i.test(c.action)),
    false,
  );
});
test("calendarRequest sends a cancellable sync UUID and preserves returned partial results after abort", async () => {
  const old = globalThis.window,
    calls = [];
  let finish;
  globalThis.window = {
    contextDesktop: {
      calendar: (message) => {
        calls.push(message);
        if (message.action === "cancel") return Promise.resolve({ ok: true });
        return new Promise((resolve) => (finish = resolve));
      },
    },
  };
  try {
    const controller = new AbortController(),
      promise = calendarRequest("sync", {
        provider: "outlook",
        body: {
          calendarId: "own",
          namespace: initialCalendarSync().namespace,
          events: [event()],
        },
        signal: controller.signal,
      });
    controller.abort();
    const value = {
      results: [{ id: "photo-1", status: "unknown" }],
      cancelled: true,
    };
    finish({ ok: true, value });
    assert.deepEqual(await promise, value);
    assert.match(calls[0].id, /^[a-f0-9-]{36}$/);
    assert.equal(calls[1].action, "cancel");
    assert.equal(calls[1].id, calls[0].id);
  } finally {
    globalThis.window = old;
  }
});
test("calendar UI exposes explicit Outlook permission and photo-to-agent handoff without enabling automatic writes", async () => {
  const oldDocument = globalThis.document,
    oldWindow = globalThis.window,
    handlers = new Map(),
    ws = workspace();
  ws.calendarSync.automatic = false;
  let asked = "";
  globalThis.document = {
    visibilityState: "visible",
    addEventListener: (type, fn) => handlers.set(type, fn),
    removeEventListener() {},
    getElementById: () => null,
  };
  globalThis.window = {};
  const view = createCalendarView({
    getContext: () => ({ workspace: ws, updates: [] }),
    onChange() {},
    onSave: () => true,
    onShow() {},
    onTask() {},
    onSyncSave: (v) => {
      ws.calendarSync = v;
      return true;
    },
    onAsk: (p) => (asked = p),
  });
  const click = (action) =>
    handlers.get("click")({
      target: { closest: () => ({ dataset: { calendar: action } }) },
      preventDefault() {},
    });
  try {
    click("connections");
    await Promise.resolve();
    assert.match(view.render(), /name="syncEnabled"/);
    assert.match(
      view.render(),
      /automatische Übertragung aktivierst du danach separat/,
    );
    click("photo");
    assert.match(asked, /Terminplan-Foto/);
    click("sync-panel");
    assert.match(
      view.render(),
      /id="calendar-sync-auto" type="checkbox"\s+disabled/,
    );
    assert.equal(ws.calendarSync.automatic, false);
  } finally {
    view.dispose();
    globalThis.document = oldDocument;
    globalThis.window = oldWindow;
  }
});

test("a changed target during an in-flight batch preserves original-target results and stops later batches", async () => {
  let f;
  f = fixture(
    Array.from({ length: 21 }, (_, i) => event("event-" + i)),
    {
      sync: async (options) => {
        const results = await Promise.all(
          options.body.events.map((e) => resultFor(e)),
        );
        f.ws = {
          ...f.ws,
          calendarSync: {
            ...f.ws.calendarSync,
            automatic: false,
            target: { calendarId: "different", title: "Different" },
          },
        };
        return { results, complete: true, cancelled: false };
      },
    },
  );
  const result = await f.sync.run({ manual: true });
  assert.equal(result.synced, 20);
  assert.equal(result.pending, 1);
  assert.equal(f.calls.filter((c) => c.action === "sync").length, 1);
  assert.equal(f.ws.calendarSync.target.calendarId, "different");
  assert.ok(f.ws.calendarSync.records.every((r) => r.calendarId === "own"));
});
test("changing the workspace namespace during a request never saves prior results into the new workspace", async () => {
  for (const fail of [false, true]) {
    let f;
    f = fixture([event()], {
      sync: async (options) => {
        f.ws = { ...f.ws, calendarSync: initialCalendarSync() };
        if (fail) throw new Error("lost transport");
        return {
          results: await Promise.all(
            options.body.events.map((e) => resultFor(e)),
          ),
          complete: true,
        };
      },
    });
    await assert.rejects(f.sync.run({ manual: true }), /Arbeitsbereich/);
    assert.equal(f.saves, 0);
    assert.equal(f.ws.calendarSync.records.length, 0);
    assert.equal(f.sync.isPaused(), true);
  }
});
test("a malformed response after an external batch produces visible uncertainty instead of a confirmed result", async () => {
  const f = fixture([event()], {
    sync: (options) => ({
      results: [
        {
          id: options.body.events[0].id,
          status: "created",
          url: "https://evil.test/",
        },
      ],
    }),
  });
  await assert.rejects(f.sync.run({ manual: true }));
  assert.equal(f.ws.calendarSync.records[0].status, "unknown");
  assert.equal(f.ws.calendarSync.records[0].retrySafe, false);
  assert.equal(f.sync.isPaused(), true);
});
test("stop pauses automatic sync even when no request is currently running", async () => {
  const f = fixture();
  f.sync.stop();
  assert.equal((await f.sync.run()).skipped, true);
  assert.equal(f.calls.length, 0);
  f.sync.resume();
  await f.sync.run();
  assert.equal(
    f.calls.some((c) => c.action === "sync"),
    true,
  );
});
