import test from "node:test";
import assert from "node:assert/strict";
import {
  PLUGIN_CATALOG,
  pluginsForContext,
  renderPluginCatalog,
} from "../dist/plugin-catalog.js";

const get = (id, context = {}) =>
  pluginsForContext(context).find((p) => p.id === id);

test("saved links, workspace sync settings and native capabilities do not claim account authentication", () => {
  const context = {
    workspace: {
      tools: [{ id: "spaces", url: "https://spaces.th-koeln.de/" }],
      calendarSync: {
        automatic: true,
        target: { calendarId: "private-calendar" },
      },
    },
    native: { browser: true, agent: true, calendar: true, ocr: true },
  };
  for (const id of [
    "spaces",
    "mattermost",
    "gitlab",
    "mail",
    "sciebo",
    "kiconnect",
    "openrouter",
    "outlook",
    "google",
  ])
    assert.notEqual(get(id, context).status.code, "connected", id);
  assert.equal(get("outlook", context).status.code, "setup");
  assert.equal(get("calendar-photo", context).status.code, "ready");
});

test("read-only connection, stored snapshot, pending login and failed fetch are distinguished", () => {
  const sourceStates = [
    { source: "mattermost", status: "connected" },
    { source: "spaces", status: "snapshot", message: "secret text" },
    { source: "gitlab", status: "login_required" },
    { source: "webmail", status: "error" },
  ];
  const context = {
    sourceStates,
    native: { calendar: true },
    accountStates: {
      calendar: {
        google: { connected: true },
        outlook: { configured: true, connected: false },
      },
    },
  };
  assert.equal(get("mattermost", context).status.code, "connected");
  assert.equal(get("spaces", context).status.code, "snapshot");
  assert.equal(get("gitlab", context).status.code, "setup");
  assert.equal(get("google", context).status.label, "Verbunden · nur lesen");
  assert.equal(get("outlook", context).status.label, "Anmeldung ausstehend");
  assert.notEqual(get("mail", context).status.code, "connected");
  assert.doesNotMatch(renderPluginCatalog(context), /secret text/);
});

test("Outlook write status requires an explicit connected account and sync grant", () => {
  for (const outlook of [
    { syncEnabled: true },
    { configured: true, syncEnabled: true },
    { connected: true, syncEnabled: false },
  ])
    assert.notEqual(
      get("outlook", {
        native: { calendar: true },
        accountStates: { calendar: { outlook } },
      }).status.label,
      "Verbunden · Abgleich freigegeben",
    );
  const context = {
    native: { calendar: true },
    accountStates: {
      calendar: { outlook: { connected: true, syncEnabled: true } },
    },
  };
  assert.equal(
    get("outlook", context).status.label,
    "Verbunden · Abgleich freigegeben",
  );
  assert.match(
    get("outlook", context).status.detail,
    /Zielkalender.*gesondert/,
  );
  assert.equal(
    get("outlook", { accountStates: context.accountStates }).status.code,
    "desktop",
  );
});

test("renderer excludes credential-bearing account fields, raw errors, message contents and project links", () => {
  const context = {
    native: { browser: true, agent: true, calendar: true },
    workspace: {
      activeCourse: "a",
      projects: [
        {
          id: "a",
          name: '<img src=x onerror="alert(1)"> & Kurs',
          links: [{ url: "https://example.test/?token=WORKSPACE_SECRET" }],
        },
      ],
      notes: [{ content: "PRIVATE_NOTE" }],
    },
    sourceStates: [
      {
        source: "gitlab",
        status: "error",
        message: "RAW_ERROR_SECRET",
        token: "SOURCE_SECRET",
      },
    ],
    accountStates: {
      mail: { configured: true, password: "MAIL_SECRET" },
      kiconnect: { configured: true, apiKey: "AI_SECRET" },
      calendar: {
        outlook: {
          connected: true,
          syncEnabled: true,
          accessToken: "ACCESS_SECRET",
          clientId: "CLIENT_PRIVATE",
        },
      },
    },
  };
  const html = renderPluginCatalog(context);
  assert.doesNotMatch(
    html,
    /WORKSPACE_SECRET|PRIVATE_NOTE|RAW_ERROR_SECRET|SOURCE_SECRET|MAIL_SECRET|AI_SECRET|ACCESS_SECRET|CLIENT_PRIVATE/,
  );
  assert.doesNotMatch(html, /<script\b|\sonerror=["']/);
  // Decorative logos are fixed, bundled assets; workspace text stays escaped.
  for (const image of html.matchAll(/<img\b[^>]*>/g)) {
    assert.match(image[0], /src="\.\/brands\/[a-z]+\.svg"/);
    assert.doesNotMatch(image[0], /\son\w+=/i);
  }
  assert.match(
    html,
    /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt; &amp; Kurs/,
  );
  assert.match(html, /Mailkonto verbunden/);
});

test("catalog actions remain within shipped routes and safe fixed HTTPS websites", () => {
  const views = new Set([
    "boards", "inventory",
    "projects",
    "mail",
    "ai",
    "calendar",
    "notes",
    "submissions",
  ]);
  const imports = new Set(["obsidian", "bookmarks", "projects", "context"]);
  const connectors = new Set(["mattermost", "gitlab"]);
  const calendar = new Set(["import", "connections"]);
  const hosts = new Set([
    "miro.com", "inventory.coco.study",
    "spaces.th-koeln.de",
    "chat.coco.study",
    "git.coco.study",
    "th-koeln.sciebo.de",
  ]);
  assert.equal(
    new Set(PLUGIN_CATALOG.map((p) => p.id)).size,
    PLUGIN_CATALOG.length,
  );
  for (const plugin of PLUGIN_CATALOG) {
    assert.equal(Object.isFrozen(plugin), true);
    assert.equal(Object.isFrozen(plugin.permissions), true);
    assert.match(plugin.version, /^\d+\.\d+\.\d+$/);
    for (const action of [plugin.action, plugin.secondary].filter(Boolean)) {
      if (action.type === "view") {
        assert.ok(views.has(action.id));
        if (action.calendar) assert.ok(calendar.has(action.calendar));
      } else if (action.type === "import") assert.ok(imports.has(action.id));
      else if (action.type === "connection")
        assert.ok(connectors.has(action.id));
      else if (action.type === "website") {
        const url = new URL(action.url);
        assert.equal(url.protocol, "https:");
        assert.equal(url.username + url.password + url.search + url.hash, "");
        assert.ok(hosts.has(url.hostname));
      } else assert.fail("Unknown executable catalog action");
    }
  }
  const html = renderPluginCatalog({});
  assert.match(html, /data-view="calendar" data-calendar="import"/);
  assert.match(html, /data-view="calendar" data-calendar="connections"/);
  assert.match(html, /data-action="start-import" data-id="obsidian"/);
  assert.match(html, /data-action="connection-help" data-id="gitlab"/);
  assert.doesNotMatch(
    html,
    /<script|onclick=|javascript:|type="password"|clientId|accessToken/,
  );
});

test("plugin inspection is immutable and local, with explicit unsupported capabilities", () => {
  const context = {
    workspace: { activeCourse: "missing", projects: [] },
    sourceStates: "invalid",
    native: { calendar: "pretend", ocr: false },
  };
  const before = JSON.stringify(context);
  assert.doesNotThrow(() => renderPluginCatalog(context));
  assert.equal(JSON.stringify(context), before);
  assert.equal(get("outlook", context).status.code, "desktop");
  assert.match(
    get("google", context).limitation,
    /keine automatische Schreibsynchronisierung/,
  );
  assert.match(get("obsidian", context).limitation, /Dateiimport.*Vault-Sync/);
  assert.match(
    get("github-submissions", context).limitation,
    /noch nicht eingerichtet/,
  );
  assert.match(get("sciebo", context).limitation, /API-Anbindung.*offen/);
});
