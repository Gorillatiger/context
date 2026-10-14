import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createCalendarProviders,
  CalendarError,
  validateOAuthCallback,
} from "../connectors/calendar.mjs";
import { createDesktopCalendar } from "../desktop/calendar.mjs";
import { validateCalendarEvents } from "../dist/calendar-engine.js";

const googleId = "123456789-context.apps.googleusercontent.com",
  outlookId = "12345678-1234-1234-1234-123456789abc";
const from = "2026-10-01T00:00:00+02:00",
  to = "2026-11-01T00:00:00+01:00";
function fixture({
  provider = "google",
  driveEnabled = false,
  data,
  clock = () => 0,
  tokenData,
  callbackFactory,
  openExternal,
} = {}) {
  const calls = [],
    urls = [];
  const client = createCalendarProviders({
    now: clock,
    callbackFactory:
      callbackFactory ||
      (async ({ provider, state }) => ({
        redirectURI:
          "http://" +
          (provider === "google" ? "127.0.0.1" : "localhost") +
          ":54321/oauth/callback",
        result: Promise.resolve("synthetic-code"),
        close() {},
      })),
    openExternal: openExternal || (async (url) => urls.push(new URL(url))),
    fetcher: async (url, options) => {
      calls.push({ url, options });
      if (url.includes("/token"))
        return Response.json(
          tokenData || {
            access_token: "synthetic-access-token",
            refresh_token: "synthetic-refresh-token",
            expires_in: 3600,
            token_type: "Bearer",
            scope: urls.at(-1)?.searchParams.get("scope"),
          },
        );
      if (data) return data(url, options);
      if (url.includes("/calendarList"))
        return Response.json({
          items: [
            {
              id: "course@group.calendar.google.com",
              summary: "Interaction Design",
              timeZone: "Europe/Berlin",
              primary: true,
            },
          ],
        });
      if (url.includes("/me/calendars?"))
        return Response.json({
          value: [
            {
              id: "Calendar-123",
              name: "Interaction Design",
              isDefaultCalendar: true,
            },
          ],
        });
      if (url.includes("/events?"))
        return Response.json({
          items: [
            {
              id: "event1",
              summary: "Projektpräsentation",
              description: "<b>Bitte vorbereiten</b>",
              location: "Raum 201",
              htmlLink: "https://calendar.google.com/calendar/event?eid=event1",
              start: { dateTime: "2026-10-12T10:00:00+02:00" },
              end: { dateTime: "2026-10-12T12:00:00+02:00" },
            },
            {
              id: "event2",
              summary: "Abgabe",
              start: { date: "2026-10-15" },
              end: { date: "2026-10-16" },
            },
          ],
        });
      if (url.includes("/calendarView?"))
        return Response.json({
          value: [
            {
              id: "event1",
              subject: "Projektpräsentation",
              start: {
                dateTime: "2026-10-12T08:00:00.0000000",
                timeZone: "UTC",
              },
              end: { dateTime: "2026-10-12T10:00:00.0000000", timeZone: "UTC" },
              isAllDay: false,
              location: { displayName: "Raum 201" },
              webLink: "https://outlook.office.com/calendar/item/event1",
            },
            {
              id: "event2",
              subject: "Abgabe",
              start: {
                dateTime: "2026-10-14T22:00:00.0000000",
                timeZone: "UTC",
              },
              end: { dateTime: "2026-10-15T22:00:00.0000000", timeZone: "UTC" },
              originalStartTimeZone: "W. Europe Standard Time",
              originalEndTimeZone: "W. Europe Standard Time",
              isAllDay: true,
            },
          ],
        });
      if (url.includes("/drive/v3/files?"))
        return Response.json({
          files: [
            {
              id: "doc-123",
              name: "Kursplan",
              mimeType: "application/vnd.google-apps.document",
              webViewLink: "https://docs.google.com/document/d/doc-123/edit",
            },
            {
              id: "sheet-123",
              name: "Termine",
              mimeType: "application/vnd.google-apps.spreadsheet",
              webViewLink:
                "https://docs.google.com/spreadsheets/d/sheet-123/edit",
            },
            { id: "plain-123", name: "Plan.csv", mimeType: "text/csv" },
          ],
        });
      if (url.includes("/drive/v3/files/doc-123/export?"))
        return new Response("2026-10-15 Abgabe", {
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      if (url.includes("/drive/v3/files/sheet-123/export?"))
        return new Response("date,title\n2026-10-15,Abgabe", {
          headers: { "Content-Type": "text/csv" },
        });
      if (url.endsWith("/drive/v3/files/plain-123?alt=media"))
        return new Response("date,title\n2026-10-15,Abgabe", {
          headers: { "Content-Type": "text/csv" },
        });
      throw new Error("Unexpected synthetic route");
    },
  });
  client.configure(
    provider,
    provider === "google"
      ? { clientId: googleId, driveEnabled }
      : { clientId: outlookId },
  );
  return { client, calls, urls };
}

test("Calendar providers show missing registration honestly and reject URL/token/client injection", async () => {
  const client = createCalendarProviders({
    fetcher: async () => {
      throw new Error("Must not call network");
    },
  });
  assert.equal(client.status().google.connected, false);
  assert.equal(client.status().outlook.configured, false);
  await assert.rejects(
    client.connect("google"),
    (e) => e.code === "registration_required",
  );
  for (const value of [
    { clientId: "https://evil.test" },
    { clientId: googleId, accessToken: "secret" },
    { clientId: googleId, driveEnabled: "yes" },
  ])
    assert.throws(() => client.configure("google", value));
  assert.throws(() =>
    client.configure("outlook", { clientId: outlookId, tenant: "../evil" }),
  );
  assert.throws(() => client.status("__proto__"));
  client.configure("google", {
    clientId: googleId,
    clientSecret: "synthetic-desktop-secret",
  });
  assert.ok(
    !JSON.stringify(client.status()).includes("synthetic-desktop-secret"),
  );
});

test("OAuth callback enforces state, origin, path, singular code, and safe denial errors", () => {
  const options = {
    state: "synthetic-state",
    redirectURI: "http://127.0.0.1:54321/oauth/callback",
  };
  assert.equal(
    validateOAuthCallback(
      "/oauth/callback?state=synthetic-state&code=synthetic-code",
      options,
    ),
    "synthetic-code",
  );
  for (const url of [
    "/oauth/callback?state=wrong&code=a",
    "/elsewhere?state=synthetic-state&code=a",
    "https://evil.test/oauth/callback?state=synthetic-state&code=a",
    "/oauth/callback?state=synthetic-state&state=synthetic-state&code=a",
    "/oauth/callback?state=synthetic-state&code=a&code=b",
    "/oauth/callback?state=synthetic-state&code=bad%0Acode",
  ])
    assert.throws(() => validateOAuthCallback(url, options));
  assert.throws(
    () =>
      validateOAuthCallback(
        "/oauth/callback?state=synthetic-state&error=access_denied&error_description=secret",
        options,
      ),
    (e) => e.code === "oauth_denied" && !e.message.includes("secret"),
  );
});

test("Google uses native PKCE, its fixed endpoints and only optional read-only Drive permission; tokens never return", async () => {
  const { client, calls, urls } = fixture({ driveEnabled: true });
  const result = await client.connect("google");
  assert.equal(result.connected, true);
  const url = urls[0];
  assert.equal(url.origin, "https://accounts.google.com");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.match(url.searchParams.get("state"), /^[\w-]{43}$/);
  const form = new URLSearchParams(calls[0].options.body);
  assert.equal(form.get("grant_type"), "authorization_code");
  assert.equal(
    createHash("sha256").update(form.get("code_verifier")).digest("base64url"),
    url.searchParams.get("code_challenge"),
  );
  assert.equal(form.get("redirect_uri"), url.searchParams.get("redirect_uri"));
  assert.equal(calls[0].url, "https://oauth2.googleapis.com/token");
  assert.equal(calls[0].options.redirect, "error");
  const scope = url.searchParams.get("scope");
  assert.ok(scope.includes("calendar.events.readonly"));
  assert.ok(scope.includes("drive.readonly"));
  assert.ok(!scope.includes("calendar.events "));
  assert.ok(!JSON.stringify(result).includes("synthetic-access-token"));
  client.disconnect("google");
  assert.equal(client.status("google").connected, false);
  assert.equal(client.status("google").configured, true);
});

test("Microsoft uses registered public-client PKCE and minimal Calendars.ReadBasic permissions", async () => {
  const { client, calls, urls } = fixture({ provider: "outlook" });
  await client.connect("outlook");
  assert.equal(urls[0].origin, "https://login.microsoftonline.com");
  assert.equal(urls[0].pathname, "/common/oauth2/v2.0/authorize");
  assert.equal(
    urls[0].searchParams.get("redirect_uri"),
    "http://localhost:54321/oauth/callback",
  );
  assert.equal(
    urls[0].searchParams.get("scope"),
    "offline_access https://graph.microsoft.com/Calendars.ReadBasic",
  );
  assert.equal(
    new URLSearchParams(calls[0].options.body).has("client_secret"),
    false,
  );
  assert.equal(
    calls[0].url,
    "https://login.microsoftonline.com/common/oauth2/v2.0/token",
  );
});

test("Calendar list and occurrences normalize timed/all-day Google and Microsoft events without attachments or writes", async () => {
  for (const provider of ["google", "outlook"]) {
    const { client, calls } = fixture({ provider });
    await client.connect(provider);
    const { calendars } = await client.calendars(provider);
    assert.equal(calendars[0].title, "Interaction Design");
    const answer = await client.events(provider, {
      calendarId: calendars[0].id,
      from,
      to,
    });
    assert.equal(answer.complete, true);
    assert.equal(answer.events.length, 2);
    assert.equal(answer.events[0].start, "2026-10-12T08:00:00.000Z");
    assert.equal(answer.events[0].end, "2026-10-12T10:00:00.000Z");
    assert.equal(answer.events[0].timeZone, "Europe/Berlin");
    assert.equal(answer.events[0].source.kind, provider);
    assert.equal(answer.events[1].start, "2026-10-15");
    assert.equal(answer.events[1].end, "2026-10-16");
    assert.equal(answer.events[1].allDay, true);
    assert.ok(answer.events.every((e) => e.source.url.startsWith("https://")));
    for (const c of calls.slice(1)) {
      assert.equal(c.options.method, "GET");
      assert.equal(c.options.redirect, "error");
      assert.equal(
        c.options.headers.Authorization,
        "Bearer synthetic-access-token",
      );
      assert.ok(
        ["www.googleapis.com", "graph.microsoft.com"].includes(
          new URL(c.url).hostname,
        ),
      );
    }
    if (provider === "outlook")
      assert.equal(
        calls.at(-1).options.headers.Prefer,
        'outlook.timezone="UTC"',
      );
  }
});

test("API calls require listed calendar selections and bounded ranges before any network operation", async () => {
  const { client, calls } = fixture();
  await client.connect("google");
  const calendar = (await client.calendars("google")).calendars[0].id,
    count = calls.length;
  for (const value of [
    { calendarId: "unknown", from, to },
    { calendarId: calendar, from: "2026-10-01", to },
    { calendarId: calendar, from, to: "2028-01-01T00:00:00Z" },
    { calendarId: calendar, from: to, to: from },
    { calendarId: calendar, from, to, url: "https://evil.test" },
  ])
    await assert.rejects(client.events("google", value));
  assert.equal(calls.length, count);
});

test("Normalized provider data matches local engine limits, including multiline and long names", async () => {
  const { client } = fixture({
    data: async (url) =>
      url.includes("/calendarList")
        ? Response.json({
            items: [
              { id: "cal", summary: "Multiline\nKalender" + ".".repeat(300) },
            ],
          })
        : Response.json({
            items: [
              {
                id: "e".repeat(600),
                summary: "Multiline\nTermin" + ".".repeat(500),
                description: "Details".repeat(2000),
                htmlLink: "https://calendar.google.com/" + ".".repeat(2500),
                start: { date: "2026-10-15" },
                end: { date: "2026-10-16" },
              },
            ],
          }),
  });
  await client.connect("google");
  await client.calendars("google");
  const result = await client.events("google", { calendarId: "cal", from, to });
  assert.equal(validateCalendarEvents(result.events).length, 1);
  assert.ok(result.events[0].title.length <= 240);
  assert.ok(result.events[0].source.externalId.length <= 512);
  assert.ok(result.events[0].source.excerpt.length <= 4000);
});

test("Outlook all-day events preserve original foreign calendar dates and disclose unsupported zones", async () => {
  const { client } = fixture({
    provider: "outlook",
    data: async (url) =>
      url.includes("/me/calendars?")
        ? Response.json({ value: [{ id: "cal", name: "Kurs" }] })
        : Response.json({
            value: [
              {
                id: "tokyo",
                subject: "Tokyo Ganztag",
                start: { dateTime: "2026-10-14T15:00:00.0000000" },
                end: { dateTime: "2026-10-15T15:00:00.0000000" },
                isAllDay: true,
                originalStartTimeZone: "Tokyo Standard Time",
                originalEndTimeZone: "Tokyo Standard Time",
              },
              {
                id: "unknown",
                subject: "Unknown Ganztag",
                start: { dateTime: "2026-10-14T15:00:00.0000000" },
                end: { dateTime: "2026-10-15T15:00:00.0000000" },
                isAllDay: true,
                originalStartTimeZone: "tzone://Microsoft/Custom",
              },
            ],
          }),
  });
  await client.connect("outlook");
  await client.calendars("outlook");
  const result = await client.events("outlook", {
    calendarId: "cal",
    from,
    to,
  });
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].start, "2026-10-15");
  assert.equal(result.events[0].end, "2026-10-16");
  assert.equal(result.complete, false);
  assert.ok(result.warnings[0].includes("Zeitzone"));
});

test("Calendar-list truncation stays visible and repeated event cursors fail atomically", async () => {
  const { client, calls } = fixture({
    data: async (url) =>
      url.includes("calendarList")
        ? Response.json({
            items: [{ id: "cal", summary: "Kurs" }],
            nextPageToken: "opaque",
          })
        : Response.json({ items: [], nextPageToken: "opaque" }),
  });
  await client.connect("google");
  const list = await client.calendars("google");
  assert.equal(list.complete, false);
  assert.equal(list.truncated, true);
  await assert.rejects(client.events("google", { calendarId: "cal", from, to }), { code: 'invalid_response' });
  assert.equal(calls.length, 4);
});

test("Drive is an explicit separately consented read capability and imports only listed selected native/text files", async () => {
  const disabled = fixture();
  await disabled.client.connect("google");
  assert.ok(!disabled.urls[0].searchParams.get("scope").includes("drive"));
  await assert.rejects(
    disabled.client.driveFiles("google"),
    (e) => e.code === "drive_not_enabled",
  );
  const { client, calls } = fixture({ driveEnabled: true });
  await client.connect("google");
  const { files } = await client.driveFiles("google");
  assert.equal(files.length, 3);
  const before = calls.length;
  await assert.rejects(
    client.driveText("google", { fileId: "evil" }),
    (e) => e.code === "unknown_file",
  );
  assert.equal(calls.length, before);
  for (const file of files) {
    const result = await client.driveText("google", { fileId: file.id });
    assert.equal(result.title, file.title);
    assert.equal(result.url, file.url);
    assert.ok(result.text.includes("2026-10-15"));
    if (file.mimeType === "application/vnd.google-apps.spreadsheet")
      assert.ok(result.warnings[0].includes("erste Tabellenblatt"));
  }
  assert.ok(calls.some((c) => c.url.includes("mimeType=text%2Fplain")));
  assert.ok(calls.some((c) => c.url.includes("mimeType=text%2Fcsv")));
  assert.ok(calls.some((c) => c.url.endsWith("plain-123?alt=media")));
  assert.ok(calls.every((c) => !c.url.includes("evil")));
});

test("Expired tokens refresh in memory, rotate safely and do not surface credentials", async () => {
  let time = 0;
  const { client, calls } = fixture({ clock: () => time });
  await client.connect("google");
  time = 3590 * 1000;
  const answer = await client.calendars("google");
  assert.equal(answer.calendars.length, 1);
  assert.equal(calls.filter((c) => c.url.includes("/token")).length, 2);
  const refresh = new URLSearchParams(calls[1].options.body);
  assert.equal(refresh.get("grant_type"), "refresh_token");
  assert.equal(refresh.get("refresh_token"), "synthetic-refresh-token");
  assert.ok(
    !JSON.stringify(client.status()).includes("synthetic-refresh-token"),
  );
});

test("Rejected OAuth permissions and token/error bodies are never retained or returned", async () => {
  const missing = fixture({
    tokenData: { access_token: "secret", expires_in: 3600, scope: "profile" },
  });
  await assert.rejects(
    missing.client.connect("google"),
    (e) => e.code === "permission_denied",
  );
  assert.equal(missing.client.status("google").connected, false);
  const { client } = fixture({
    data: async () =>
      new Response("private-provider-error-token", { status: 403 }),
  });
  await client.connect("google");
  await assert.rejects(
    client.calendars("google"),
    (e) =>
      e.code === "permission_denied" &&
      !e.message.includes("private-provider-error-token"),
  );
});

test("Calendar and Drive responses enforce size/content limits and never import unlisted file types", async () => {
  const oversized = fixture({
    driveEnabled: true,
    data: async (url) =>
      url.includes("/drive/v3/files?")
        ? Response.json({
            files: [
              { id: "plan-123", name: "Plan", mimeType: "text/plain" },
              { id: "image-123", name: "Image", mimeType: "image/png" },
            ],
          })
        : new Response("x".repeat(256001), {
            headers: { "Content-Type": "text/plain" },
          }),
  });
  await oversized.client.connect("google");
  const files = await oversized.client.driveFiles("google");
  assert.equal(files.files.length, 1);
  await assert.rejects(
    oversized.client.driveText("google", { fileId: "plan-123" }),
    (e) => e.code === "response_limit",
  );
  await assert.rejects(
    oversized.client.driveText("google", { fileId: "image-123" }),
    (e) => e.code === "unknown_file",
  );
  const invalid = fixture({
    data: async () =>
      new Response("<html>synthetic-private-provider-error</html>", {
        headers: { "Content-Type": "text/html" },
      }),
  });
  await invalid.client.connect("google");
  await assert.rejects(
    invalid.client.calendars("google"),
    (e) =>
      e.code === "invalid_response" && !e.message.includes("synthetic-private"),
  );
});

test("Disconnect aborts pending reads and blocks late cache updates and token reuse", async () => {
  let started;
  const ready = new Promise((resolve) => (started = resolve));
  const { client, calls } = fixture({
    data: async (_url, options) => {
      started();
      return new Promise((_, reject) =>
        options.signal.addEventListener(
          "abort",
          () => reject(options.signal.reason),
          { once: true },
        ),
      );
    },
  });
  await client.connect("google");
  const pending = client.calendars("google");
  await ready;
  client.disconnect("google");
  await assert.rejects(pending, (e) => e.code === "cancelled");
  const count = calls.length;
  await assert.rejects(
    client.calendars("google"),
    (e) => e.code === "not_connected",
  );
  assert.equal(calls.length, count);
  assert.equal(client.status("google").connected, false);
});

test("Cancellation closes a pending OAuth attempt without retaining a late token or claiming a connection", async () => {
  let opened,
    closed = false;
  const ready = new Promise((resolve) => (opened = resolve));
  const { client } = fixture({
    openExternal: async () => opened(),
    callbackFactory: async ({ signal }) => ({
      redirectURI: "http://127.0.0.1:54321/oauth/callback",
      result: new Promise((_, reject) =>
        signal.addEventListener(
          "abort",
          () => reject(new CalendarError(499, "cancelled", "Abgebrochen")),
          { once: true },
        ),
      ),
      close() {
        closed = true;
      },
    }),
  });
  const controller = new AbortController(),
    pending = client.connect("google", controller.signal);
  await ready;
  controller.abort();
  await assert.rejects(pending, (e) => e.code === "cancelled");
  assert.equal(closed, true);
  assert.equal(client.status("google").connected, false);
  assert.equal(client.status("google").connecting, false);
});

test("Desktop calendar bridge exposes only bounded actions with matching cancellation IDs", async () => {
  let started;
  const ready = new Promise((resolve) => (started = resolve)),
    bridge = createDesktopCalendar({
      providers: {
        status: () => ({ google: { connected: false } }),
        connect: async (_provider, signal) => {
          started();
          await new Promise((_, reject) =>
            signal.addEventListener(
              "abort",
              () => reject(new Error("cancelled")),
              { once: true },
            ),
          );
        },
      },
    });
  assert.equal((await bridge({ action: "status" })).google.connected, false);
  for (const message of [
    { action: "fetch", provider: "google", url: "https://evil.test" },
    { action: "shell", id: crypto.randomUUID() },
    { action: "connect", provider: "google", id: "x" },
    {
      action: "connect",
      provider: "google",
      id: crypto.randomUUID(),
      body: { token: "secret" },
    },
  ])
    await assert.rejects(bridge(message));
  const id = crypto.randomUUID(),
    pending = bridge({ action: "connect", provider: "google", id });
  await ready;
  await assert.rejects(bridge({ action: "connect", provider: "google", id }));
  await bridge({ action: "cancel", id });
  await assert.rejects(pending);
  await bridge({ action: "cancel", id: crypto.randomUUID() });
});

test("Outlook all-day reads disclose a changed creation timezone instead of silently shifting the day", async () => {
  const f = fixture({
    provider: "outlook",
    data: (url) =>
      Response.json(
        url.includes("/me/calendars?")
          ? { value: [{ id: "Calendar-123", name: "Context" }] }
          : {
              value: [
                {
                  id: "converted",
                  subject: "Abgabe",
                  isAllDay: true,
                  originalStartTimeZone: "UTC",
                  originalEndTimeZone: "UTC",
                  start: { dateTime: "2026-10-14T22:00:00", timeZone: "UTC" },
                  end: { dateTime: "2026-10-15T22:00:00", timeZone: "UTC" },
                },
              ],
            },
      ),
  });
  await f.client.connect("outlook");
  await f.client.calendars("outlook");
  const result = await f.client.events("outlook", {
    calendarId: "Calendar-123",
    from,
    to,
  });
  assert.equal(result.complete, false);
  assert.equal(result.events.length, 0);
  assert.match(result.warnings[0], /Zeitzone/);
});
