import test from "node:test";
import assert from "node:assert/strict";
import { createCalendarProviders } from "../connectors/calendar.mjs";
import { createDesktopCalendar } from "../desktop/calendar.mjs";
import {
  berlinLocalToInstant,
  berlinLocalInput,
} from "../dist/calendar-engine.js";

const clientId = "12345678-1234-1234-1234-123456789abc";
const namespace = "abcabcab-1234-1234-1234-abcabcabcabc";
const requestId = "defdefde-1234-1234-1234-defdefdefdef";
const calendarId = "own-calendar";
const event = (id = "photo:deadline") => ({
  id,
  title: "Prototyp abgeben",
  projectId: "interaction-design",
  start: "2026-10-15T08:00:00.000Z",
  end: "2026-10-15T09:00:00.000Z",
  allDay: false,
  timeZone: "Europe/Berlin",
  readonly: false,
  source: {
    kind: "photo",
    title: "Abgabeplan",
    excerpt: "Abgabe am 15.10., 10 Uhr",
  },
});
const batch = (events = [event()]) => ({ calendarId, namespace, events });

function fixture({ syncEnabled = true, owns = true, hooks = {} } = {}) {
  const calls = [],
    urls = [],
    remote = new Map(),
    transactions = new Map(),
    payloads = new Map();
  let version = 0;
  const permissions = { canEdit: true, canShare: owns };
  const headers = { "Content-Type": "application/json" };
  const reply = (value, status = 200) =>
    new Response(JSON.stringify(value), { status, headers });
  const normalized = (payload, id) => {
    const start = payload.isAllDay
      ? berlinLocalToInstant(payload.start.dateTime.slice(0, 10), "00:00")
      : payload.start.dateTime + "Z";
    const end = payload.isAllDay
      ? berlinLocalToInstant(payload.end.dateTime.slice(0, 10), "00:00")
      : payload.end.dateTime + "Z";
    return {
      id,
      subject: payload.subject,
      body: payload.body,
      start: { dateTime: start.slice(0, -1), timeZone: "UTC" },
      end: { dateTime: end.slice(0, -1), timeZone: "UTC" },
      isAllDay: payload.isAllDay,
      originalStartTimeZone: payload.start.timeZone,
      originalEndTimeZone: payload.end.timeZone,
      attendees: [],
      isOrganizer: true,
      isCancelled: false,
      isOnlineMeeting: false,
      type: "singleInstance",
      recurrence: null,
      location: payload.location,
      singleValueExtendedProperties: payload.singleValueExtendedProperties,
      webLink: "https://outlook.office.com/calendar/item/" + id,
      "@odata.etag": 'W/"synthetic-' + ++version + '"',
    };
  };
  const client = createCalendarProviders({
    now: () => 0,
    callbackFactory: async () => ({
      redirectURI: "http://localhost:54321/oauth/callback",
      result: Promise.resolve("synthetic-code"),
      close() {},
    }),
    openExternal: async (url) => urls.push(new URL(url)),
    fetcher: async (url, options) => {
      const parsed = new URL(url);
      const call = {
        url: parsed,
        method: options.method,
        options,
        body:
          options.body && options.headers["Content-Type"] === "application/json"
            ? JSON.parse(options.body)
            : undefined,
      };
      calls.push(call);
      const intercepted = await hooks.before?.(call, {
        remote,
        transactions,
        permissions,
      });
      if (intercepted) return intercepted;
      if (parsed.pathname.endsWith("/token"))
        return reply({
          access_token: "synthetic-access",
          refresh_token: "synthetic-refresh",
          token_type: "Bearer",
          expires_in: 3600,
          scope: urls.at(-1).searchParams.get("scope"),
        });
      assert.equal(parsed.hostname, "graph.microsoft.com");
      assert.equal(options.redirect, "error");
      assert.equal(options.headers.Authorization, "Bearer synthetic-access");
      if (parsed.pathname === "/v1.0/me/calendars")
        return reply({
          value: [{ id: calendarId, name: "Context", ...permissions }],
        });
      if (parsed.pathname === "/v1.0/me/calendars/" + calendarId)
        return reply({ id: calendarId, ...permissions });
      const collection = "/v1.0/me/calendars/" + calendarId + "/events";
      if (parsed.pathname === collection && options.method === "GET") {
        const prefix = parsed.searchParams
          .get("$filter")
          .match(/startswith\(ep\/value,'([^']+)'\)/)[1];
        assert.equal(parsed.searchParams.get("$top"), "2");
        assert.ok(parsed.searchParams.has("$expand"));
        assert.ok(!parsed.searchParams.has("$select"));
        return reply({
          value: [...remote.values()].filter((e) =>
            e.singleValueExtendedProperties.some((p) =>
              p.value.startsWith(prefix),
            ),
          ),
        });
      }
      if (parsed.pathname === collection && options.method === "POST") {
        assert.ok(!Object.hasOwn(call.body, "attendees"));
        const id =
          transactions.get(call.body.transactionId) ||
          "event-" + (remote.size + 1);
        if (!transactions.has(call.body.transactionId)) {
          transactions.set(call.body.transactionId, id);
          payloads.set(id, call.body);
          remote.set(id, normalized(call.body, id));
        }
        await hooks.afterWrite?.(call, { remote, transactions });
        return reply(remote.get(id), 201);
      }
      if (parsed.pathname.startsWith(collection + "/")) {
        const id = decodeURIComponent(
          parsed.pathname.slice(collection.length + 1),
        );
        assert.ok(remote.has(id));
        if (options.method === "GET") {
          const value = remote.get(id);
          if (
            options.headers.Prefer.includes(
              'outlook.timezone="W. Europe Standard Time"',
            )
          )
            return reply({
              ...value,
              start: {
                dateTime:
                  berlinLocalInput(value.start.dateTime + "Z") + ":00.0000000",
                timeZone: "W. Europe Standard Time",
              },
              end: {
                dateTime:
                  berlinLocalInput(value.end.dateTime + "Z") + ":00.0000000",
                timeZone: "W. Europe Standard Time",
              },
            });
          return reply(value);
        }
        if (options.method === "PATCH") {
          assert.ok(!Object.hasOwn(call.body, "attendees"));
          assert.ok(!Object.hasOwn(call.body, "transactionId"));
          if (options.headers["If-Match"] !== remote.get(id)["@odata.etag"])
            return reply({ error: { message: "private provider error" } }, 412);
          const previous = remote.get(id),
            merged = { ...payloads.get(id), ...call.body };
          payloads.set(id, merged);
          remote.set(id, {
            ...previous,
            ...normalized(merged, id),
            originalStartTimeZone: previous.originalStartTimeZone,
            originalEndTimeZone: previous.originalEndTimeZone,
            ...(!call.body.location ? { location: previous.location } : {}),
            ...(!call.body.body ? { body: previous.body } : {}),
          });
          await hooks.afterWrite?.(call, { remote, transactions });
          return reply(remote.get(id));
        }
      }
      throw new Error("Unexpected synthetic route");
    },
  });
  client.configure("outlook", { clientId, syncEnabled });
  return {
    client,
    calls,
    urls,
    remote,
    permissions,
    transactions,
    async ready() {
      await client.connect("outlook");
      await client.calendars("outlook");
    },
    writes() {
      return calls.filter((c) => c.body);
    },
  };
}

test("Outlook writing requires explicit sync scope, separate reconnect, and a listed own calendar", async () => {
  const f = fixture({ syncEnabled: false });
  await f.ready();
  assert.match(f.urls[0].searchParams.get("scope"), /Calendars\.ReadBasic/);
  assert.ok(!f.urls[0].searchParams.get("scope").includes("ReadWrite"));
  await assert.rejects(f.client.sync("outlook", batch()), {
    code: "sync_not_enabled",
  });
  assert.equal(f.writes().length, 0);
  f.client.configure("outlook", { clientId, syncEnabled: true });
  assert.equal(f.client.status("outlook").connected, false);
  await f.ready();
  assert.match(f.urls[1].searchParams.get("scope"), /Calendars\.ReadWrite/);
  assert.ok(!f.urls[1].searchParams.get("scope").includes("Mail"));
  assert.equal(f.client.status("outlook").readOnly, false);
  assert.equal(f.client.status("outlook").syncEnabled, true);
  assert.equal(f.client.status("google").readOnly, true);
  await assert.rejects(
    f.client.sync("outlook", { ...batch(), calendarId: "unlisted" }),
    { code: "readonly_calendar" },
  );
  const shared = fixture({ owns: false });
  await shared.ready();
  await assert.rejects(shared.client.sync("outlook", batch()), {
    code: "readonly_calendar",
  });
  assert.equal(shared.writes().length, 0);
});

test("Sync validates the whole bounded batch before writing; attendees, force, credentials, readonly and duplicate IDs are rejected", async () => {
  const f = fixture();
  await f.ready();
  for (const input of [
    { ...batch(), force: true },
    { ...batch(), namespace: "bad" },
    batch(Array.from({ length: 21 }, (_, i) => event("local:" + i))),
    batch([event(), { ...event("other"), attendees: ["someone@example.com"] }]),
    batch([{ ...event(), token: "bad" }]),
    batch([{ ...event(), readonly: true }]),
    batch([event(), event()]),
    batch([{ ...event(), title: "x".repeat(241) }]),
  ])
    await assert.rejects(f.client.sync("outlook", input));
  assert.equal(f.writes().length, 0);
});

test("Create, repeat and update use remote ownership, deterministic idempotency, source text, verification and optimistic concurrency", async () => {
  const f = fixture();
  await f.ready();
  const first = await f.client.sync("outlook", batch());
  assert.equal(first.complete, true);
  assert.equal(first.results[0].status, "created");
  assert.equal(first.results[0].id, event().id);
  assert.equal(first.results[0].remoteId, "event-1");
  assert.match(first.results[0].lastFingerprint, /^[a-f0-9]{64}$/);
  const original = f.writes()[0];
  assert.equal(original.body.responseRequested, false);
  assert.equal(original.body.allowNewTimeProposals, false);
  assert.equal(original.body.body.contentType, "text");
  assert.match(original.body.body.content, /Abgabe am 15.10./);
  assert.equal(original.body.start.timeZone, "UTC");
  assert.match(
    original.body.singleValueExtendedProperties[0].value,
    /^v1:[a-f0-9]{64}:[a-f0-9]{64}$/,
  );
  const repeated = await f.client.sync("outlook", batch());
  assert.equal(repeated.results[0].status, "unchanged");
  assert.equal(f.writes().length, 1);
  const updated = await f.client.sync(
    "outlook",
    batch([{ ...event(), title: "Neue Abgabe" }]),
  );
  assert.equal(updated.results[0].status, "updated");
  assert.equal(updated.results[0].remoteId, first.results[0].remoteId);
  assert.equal(f.writes()[1].method, "PATCH");
  assert.match(f.writes()[1].options.headers["If-Match"], /^W\/"/);
  assert.equal(f.remote.size, 1);
  assert.ok(f.calls.every((c) => ["GET", "POST", "PATCH"].includes(c.method)));
  assert.ok(!JSON.stringify(first).includes("synthetic-access"));
});

test("Published all-day dates remain exclusive midnight Berlin dates across DST", async () => {
  const f = fixture();
  await f.ready();
  const allDay = {
    ...event(),
    start: "2026-10-24",
    end: "2026-10-26",
    allDay: true,
  };
  const result = await f.client.sync("outlook", batch([allDay]));
  assert.equal(result.results[0].status, "created");
  assert.deepEqual(f.writes()[0].body.start, {
    dateTime: "2026-10-24T00:00:00",
    timeZone: "W. Europe Standard Time",
  });
  assert.equal(
    (await f.client.sync("outlook", batch([allDay]))).results[0].status,
    "unchanged",
  );
});

test("Reconnect loses no ownership identity and repeated publication still finds remote events", async () => {
  const f = fixture();
  await f.ready();
  const created = await f.client.sync("outlook", batch());
  f.client.disconnect("outlook");
  f.client.configure("outlook", { clientId, syncEnabled: true });
  await f.ready();
  const repeated = await f.client.sync("outlook", batch());
  assert.equal(repeated.results[0].remoteId, created.results[0].remoteId);
  assert.equal(repeated.results[0].status, "unchanged");
  assert.equal(f.writes().length, 1);
});

test("Converting a UTC-created timed event to Berlin all-day verifies actual dates rather than the creation timezone", async () => {
  const f = fixture();
  await f.ready();
  await f.client.sync("outlook", batch());
  const allDay = {
    ...event(),
    start: "2026-10-24",
    end: "2026-10-26",
    allDay: true,
  };
  const changed = await f.client.sync("outlook", batch([allDay]));
  assert.equal(changed.results[0].status, "updated");
  assert.equal(f.remote.get("event-1").originalStartTimeZone, "UTC");
  assert.equal(
    (await f.client.sync("outlook", batch([allDay]))).results[0].status,
    "unchanged",
  );
  const back = await f.client.sync("outlook", batch());
  assert.equal(back.results[0].status, "updated");
  assert.equal(f.remote.size, 1);
});

test("A local title update preserves provider location metadata and patches only changed managed fields", async () => {
  const f = fixture();
  await f.ready();
  await f.client.sync("outlook", batch());
  f.remote.get("event-1").location.address = { city: "Köln" };
  const result = await f.client.sync(
    "outlook",
    batch([{ ...event(), title: "Changed title" }]),
  );
  assert.equal(result.results[0].status, "updated");
  const patch = f.writes()[1].body;
  assert.deepEqual(Object.keys(patch).sort(), [
    "singleValueExtendedProperties",
    "subject",
  ]);
  assert.equal(f.remote.get("event-1").location.address.city, "Köln");
  const locationChange = await f.client.sync(
    "outlook",
    batch([{ ...event(), title: "Changed title", location: "Raum 201" }]),
  );
  assert.equal(locationChange.results[0].status, "conflict");
  assert.equal(f.writes().length, 2);
});

test("External edits, attendees, meetings, recurring events and missing fingerprints never get overwritten", async () => {
  for (const mutate of [
    (e) => (e.subject = "User edit"),
    (e) => (e.body.content = "User note"),
    (e) => (e.start.dateTime = "2026-10-15T07:00:00.000"),
    (e) =>
      (e.attendees = [{ emailAddress: { address: "friend@example.com" } }]),
    (e) => (e.isOnlineMeeting = true),
    (e) => (e.type = "seriesMaster"),
    (e) => (e.isOrganizer = false),
    (e) =>
      (e.singleValueExtendedProperties[0].value =
        e.singleValueExtendedProperties[0].value.replace(/[a-f0-9]{64}$/, "")),
  ]) {
    const f = fixture();
    await f.ready();
    await f.client.sync("outlook", batch());
    mutate(f.remote.get("event-1"));
    const result = await f.client.sync(
      "outlook",
      batch([{ ...event(), title: "New local title" }]),
    );
    assert.equal(result.results[0].status, "conflict");
    assert.equal(result.complete, false);
    assert.equal(f.writes().length, 1);
    assert.equal(f.remote.size, 1);
  }
});

test("Duplicate ownership and pagination ambiguity stop both updates and new creates", async () => {
  for (const mode of ["duplicate", "nextLink"]) {
    let lookupOverride = false;
    const f = fixture({
      hooks: {
        before: (call, { remote }) => {
          if (
            lookupOverride &&
            call.method === "GET" &&
            call.url.searchParams.has("$filter")
          )
            return Response.json(
              mode === "duplicate"
                ? {
                    value: [
                      remote.get("event-1"),
                      { ...remote.get("event-1"), id: "event-2" },
                    ],
                  }
                : {
                    value: [],
                    "@odata.nextLink": "https://evil.example/token",
                  },
            );
        },
      },
    });
    await f.ready();
    await f.client.sync("outlook", batch());
    lookupOverride = true;
    const result = await f.client.sync("outlook", batch());
    assert.equal(result.results[0].status, "conflict");
    assert.equal(f.writes().length, 1);
    assert.ok(!f.calls.some((c) => c.url.hostname === "evil.example"));
  }
});

test("Fresh calendar permission loss prevents all writes and reports every unsynced event", async () => {
  const f = fixture();
  await f.ready();
  f.permissions.canShare = false;
  const result = await f.client.sync(
    "outlook",
    batch([event(), event("second")]),
  );
  assert.equal(result.complete, false);
  assert.deepEqual(
    result.results.map((r) => r.status),
    ["failed", "failed"],
  );
  assert.equal(result.failed, 2);
  assert.equal(f.writes().length, 0);
});

test("ETag race returns conflict, hides provider error content and never retries blindly", async () => {
  let race = false;
  const f = fixture({
    hooks: {
      before: (call, { remote }) => {
        if (race && call.method === "PATCH")
          remote.get("event-1")["@odata.etag"] = 'W/"changed"';
      },
    },
  });
  await f.ready();
  await f.client.sync("outlook", batch());
  race = true;
  const result = await f.client.sync(
    "outlook",
    batch([{ ...event(), title: "New title" }]),
  );
  assert.equal(result.results[0].status, "conflict");
  assert.equal(f.remote.get("event-1").subject, event().title);
  assert.equal(f.writes().length, 2);
  assert.ok(!JSON.stringify(result).includes("private provider error"));
});

test("Missing ETag rejects updates, and malformed readback never confirms a write", async () => {
  const f = fixture();
  await f.ready();
  await f.client.sync("outlook", batch());
  delete f.remote.get("event-1")["@odata.etag"];
  const conflict = await f.client.sync(
    "outlook",
    batch([{ ...event(), title: "Changed" }]),
  );
  assert.equal(conflict.results[0].status, "conflict");
  assert.equal(f.writes().length, 1);
  const malformed = fixture({
    hooks: {
      before: (call) =>
        call.method === "GET" && call.url.pathname.endsWith("/event-1")
          ? Response.json({ id: "event-1" })
          : undefined,
    },
  });
  await malformed.ready();
  const result = await malformed.client.sync("outlook", batch());
  assert.equal(result.complete, false);
  assert.equal(result.results[0].status, "unknown");
  assert.equal(result.synced, 0);
});

test("Uncertain accepted POST is reported unknown and same-ID retry finds it without duplicate creation", async () => {
  let loseResponse = true;
  const f = fixture({
    hooks: {
      afterWrite: () => {
        if (loseResponse) {
          loseResponse = false;
          throw new Error("Synthetic connection lost after accepted write");
        }
      },
    },
  });
  await f.ready();
  const first = await f.client.sync("outlook", batch());
  assert.equal(first.results[0].status, "unknown");
  assert.equal(first.complete, false);
  assert.equal(first.results[0].retrySafe, true);
  const repeated = await f.client.sync("outlook", batch());
  assert.equal(repeated.results[0].status, "unchanged");
  assert.equal(f.remote.size, 1);
  assert.equal(f.writes().length, 1);
});

test("Provider permission denial stops the rest of a batch without claiming success", async () => {
  const f = fixture({
    hooks: {
      before: (call) =>
        call.method === "POST" && call.body
          ? Response.json({ error: "synthetic secret body" }, { status: 403 })
          : undefined,
    },
  });
  await f.ready();
  const result = await f.client.sync(
    "outlook",
    batch([event(), event("second")]),
  );
  assert.equal(result.synced, 0);
  assert.equal(result.failed, 2);
  assert.deepEqual(
    result.results.map((r) => r.status),
    ["failed", "failed"],
  );
  assert.equal(f.writes().length, 1);
  assert.ok(!JSON.stringify(result).includes("synthetic secret body"));
});

test("Abort preserves partial results; accepted in-flight write is unknown and remaining events cancelled", async () => {
  const controller = new AbortController();
  let writes = 0;
  const f = fixture({
    hooks: {
      afterWrite: () => {
        if (++writes === 2) controller.abort();
      },
    },
  });
  await f.ready();
  const result = await f.client.sync(
    "outlook",
    batch([event(), event("second"), event("third")]),
    controller.signal,
  );
  assert.equal(result.cancelled, true);
  assert.equal(result.complete, false);
  assert.equal(result.synced, 1);
  assert.deepEqual(
    result.results.map((r) => r.status),
    ["created", "unknown", "cancelled"],
  );
  assert.equal(f.remote.size, 2);
  assert.equal(f.client.status("outlook").syncing, false);
  const retry = await f.client.sync(
    "outlook",
    batch([event(), event("second"), event("third")]),
  );
  assert.deepEqual(
    retry.results.map((r) => r.status),
    ["unchanged", "unchanged", "created"],
  );
  assert.equal(f.remote.size, 3);
});

test("Desktop sync cancellation is scoped to its request UUID and retains batch result", async () => {
  let bridge;
  const f = fixture({
    hooks: {
      afterWrite: async () => {
        await bridge({ action: "cancel", id: requestId });
      },
    },
  });
  await f.ready();
  bridge = createDesktopCalendar({ providers: f.client });
  const result = await bridge({
    action: "sync",
    provider: "outlook",
    id: requestId,
    body: batch([event(), event("second")]),
  });
  assert.equal(result.cancelled, true);
  assert.deepEqual(
    result.results.map((r) => r.status),
    ["unknown", "cancelled"],
  );
  await assert.rejects(
    bridge({
      action: "sync",
      provider: "outlook",
      id: "not-a-uuid",
      body: batch(),
    }),
    { code: "invalid_request" },
  );
  await assert.rejects(
    bridge({ action: "delete", provider: "outlook", id: requestId }),
    { code: "invalid_request" },
  );
});

test("Concurrent sync is rejected, and disconnect cancels a pending batch without late writes", async () => {
  let started, release;
  const entered = new Promise((resolve) => (started = resolve));
  const f = fixture({
    hooks: {
      before: async (call) => {
        if (call.method === "GET" && call.url.searchParams.has("$filter")) {
          started();
          await new Promise((resolve) => (release = resolve));
        }
      },
    },
  });
  await f.ready();
  const pending = f.client.sync("outlook", batch([event(), event("second")]));
  await entered;
  await assert.rejects(f.client.sync("outlook", batch()), { code: "busy" });
  f.client.disconnect("outlook");
  release();
  const result = await pending;
  assert.equal(result.cancelled, true);
  assert.deepEqual(
    result.results.map((r) => r.status),
    ["cancelled", "cancelled"],
  );
  assert.equal(f.writes().length, 0);
  assert.equal(f.client.status("outlook").connected, false);
});
