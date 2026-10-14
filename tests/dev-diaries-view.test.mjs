import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createDevDiaryView } from "../dist/dev-diaries.js";
import { createDevDiary, updateDailyEntry, validateDevDiary, compileDevDiaryMarkdown } from "../dist/dev-diary-engine.js";
import { initialState, validateState, searchState, notificationCourse } from "../dist/core.js";
import { planImport, applyImport } from "../dist/importers.js";

const courseURL = "https://spaces.th-koeln.de/prototyping-things-w26/";
const date = "2026-10-13";
const instant = "2026-10-13T10:00:00Z";
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject, settled = false;
  const promise = new Promise((yes, no) => {
    resolve = (value) => { settled = true; yes(value); };
    reject = (error) => { settled = true; no(error); };
  });
  return { promise, resolve, reject, get settled() { return settled; } };
}
const decode = (value) => String(value).replace(/&(amp|lt|gt|quot|#39);/g,
  (_, key) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[key]);
const attribute = (source, name) => decode(source.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] || "");

// A small document fixture preserves browser event ordering: close() queues its
// close event, so closing and immediately showing a different dialog can be
// distinguished from a real dismissal. No controller implementation is mocked.
function fakeDocument() {
  const handlers = new Map(), nodes = new Map();
  const document = {
    activeElement: null,
    addEventListener(type, listener) {
      handlers.set(type, [...(handlers.get(type) || []), listener]);
    },
    removeEventListener(type, listener) {
      handlers.set(type, (handlers.get(type) || []).filter((fn) => fn !== listener));
    },
    getElementById(id) { return id === "modal" ? modal : nodes.get(id) || null; },
    querySelector(selector) {
      if (selector === ".dd-local-state") return nodes.get("local-state") || null;
      if (selector === ".dd-review" && /class="dd-review"/.test(modal.innerHTML))
        return { remove() {
          const section = modal.html.match(/<section class="dd-review"[\s\S]*?<\/section>/)?.[0] || "";
          for (const match of section.matchAll(/\bid="([^"]+)"/g)) nodes.delete(match[1]);
          modal.html = modal.html.replace(section, "");
        } };
      if (selector.split(",").some((part) => modal.innerHTML.includes(`class="${part.trim().slice(1)}`))) return { exists: true };
      return null;
    },
    dispatch(type, target) {
      const event = { target, preventDefault() {}, stopPropagation() {} };
      for (const listener of handlers.get(type) || []) listener(event);
    },
    handlers,
  };
  const modalHandlers = new Map();
  const modal = {
    id: "modal", open: false, html: "", closeCount: 0,
    addEventListener(type, listener) { modalHandlers.set(type, [...(modalHandlers.get(type) || []), listener]); },
    removeEventListener(type, listener) { modalHandlers.set(type, (modalHandlers.get(type) || []).filter((fn) => fn !== listener)); },
    get innerHTML() { return this.html; },
    set innerHTML(html) { this.html = html; mountForms(html); },
    querySelector(selector) { return document.querySelector(selector); },
    close() {
      if (!this.open) return;
      this.open = false; this.closeCount++;
      queueMicrotask(() => { for (const listener of modalHandlers.get("close") || []) listener({ target: this }); });
    },
    show() { this.open = true; },
    showModal() { this.open = true; },
  };
  function field(form, source, value, checkbox = false) {
    const name = attribute(source, "name"), id = attribute(source, "id");
    const node = { id, name, value: decode(value), checked: checkbox && /\bchecked(?:\s|$)/.test(source),
      closest(selector) { return form && selector === "#" + form.id ? form : null; },
      matches(selector) { return selector === "[data-dd-course]" && /data-dd-course/.test(source); },
      focus() { document.activeElement = node; } };
    if (name && form) form.elements[name] = node;
    if (id) nodes.set(id, node);
    return node;
  }
  function mountForms(html) {
    nodes.clear(); nodes.set("local-state", { textContent: "" });
    for (const match of html.matchAll(/<form\b([^>]*\bid="[^"]+"[^>]*)>([\s\S]*?)<\/form>/g)) {
      const form = { id: attribute(match[1], "id"), elements: {}, dataset: { diaryId: attribute(match[1], "data-diary-id") } };
      nodes.set(form.id, form);
      for (const textarea of match[2].matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/g)) field(form, textarea[1], textarea[2]);
      for (const input of match[2].matchAll(/<input\b([^>]*)>/g)) field(form, input[1], attribute(input[1], "value"), attribute(input[1], "type") === "checkbox");
      for (const select of match[2].matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
        const options = [...select[2].matchAll(/<option\b([^>]*)>/g)], selected = options.find((o) => /\bselected\b/.test(o[1])) || options[0];
        field(form, select[1], selected ? attribute(selected[1], "value") : "");
      }
    }
    // Conflict acknowledgement and the date picker deliberately live outside
    // a form. They are document controls, never part of persisted diary data.
    for (const input of html.matchAll(/<input\b([^>]*)>/g)) {
      const id = attribute(input[1], "id");
      if (id && !nodes.has(id)) field(null, input[1], attribute(input[1], "value"), attribute(input[1], "type") === "checkbox");
    }
  }
  return { document, modal };
}
function fixture(t, options = {}) {
  const previousDocument = globalThis.document, { document, modal } = fakeDocument();
  globalThis.document = document;
  let state = initialState(), changes = 0, sequence = 0;
  const calls = [], saved = [], saveAttempts = [], notices = [], paints = [], prepared = new Map(), cleanups = [];
  const make = (id, start = date) => createDevDiary({ projectId: "prototyping", startDate: start, days: 3 }, state, { id, now: instant });
  state.devDiaries = [make("diary-alpha")];
  if (options.second) state.devDiaries.push(make("diary-beta", "2026-10-20"));
  if (options.seed) state.devDiaries[0] = updateDailyEntry(state.devDiaries[0], date, { done: options.seed }, { now: instant });
  const bridge = { async devDiary(request) {
    calls.push(structuredClone(request));
    if (options.bridge) return options.bridge(request, { getState: () => state });
    if (request.op === "prepare") {
      const reviewToken = "review-" + (++sequence); prepared.set(reviewToken, structuredClone(request));
      return { ok: true, value: { reviewToken, action: state.devDiaries.find((d) => d.id === request.runId)?.remote.postId ? "update" : "create",
        preview: { title: request.title, content: request.content } } };
    }
    if (request.op === "publish") {
      const payload = prepared.get(request.reviewToken);
      assert.ok(payload, "publish requires the actual reviewed token");
      prepared.delete(request.reviewToken);
      return { ok: true, value: { postId: 123, postURL: courseURL + "posts/123/",
        contentHash: createHash("sha256").update(payload.content).digest("hex") } };
    }
    throw new Error("Unexpected native diary operation");
  } };
  const view = createDevDiaryView({ getState: () => state, bridge,
    onSave(value) {
      saveAttempts.push(structuredClone(value));
      if (options.save && options.save(value) !== true) return false;
      const diary = validateDevDiary(value, state.projects);
      state = { ...state, devDiaries: [...state.devDiaries.filter((d) => d.id !== diary.id), diary] };
      saved.push(structuredClone(diary)); return true;
    },
    onChange() { changes++; }, onNotice(message) { notices.push(message); },
    onModal(title, subtitle, html, projectId) {
      paints.push({ title, subtitle, html, projectId });
      // Mirrors app.js's in-place diary adapter, avoiding generic close/reopen.
      if (modal.open && modal.querySelector(".dd-setup,.dd-studio,.dd-empty")) modal.innerHTML = html;
      else { if (modal.open) modal.close(); modal.innerHTML = html; modal.showModal(); }
    },
  });
  t.after(async () => { for (const cleanup of cleanups) await cleanup(); await tick(); globalThis.document = previousDocument; });
  const click = (action, data = {}) => {
    const button = { dataset: { ddAction: action, ...data }, closest(selector) { return selector === "[data-dd-action]" ? button : null; } };
    document.dispatch("click", button);
  };
  return {
    view, document, modal, calls, saved, saveAttempts, notices, paints, click,
    get state() { return state; }, get changes() { return changes; },
    entry() { return document.getElementById("dd-entry-form"); },
    input(name, value, type = "input") {
      const input = this.entry().elements[name];
      if (name === "completed") input.checked = value; else input.value = value;
      document.activeElement = input; document.dispatch(type, input);
    },
    check(id, value) {
      const input = document.getElementById(id);
      assert.ok(input, `visible checkbox ${id} exists`);
      input.checked = value; document.activeElement = input; document.dispatch("change", input);
    },
    submit() { document.dispatch("submit", this.entry()); },
    open(id = "diary-alpha", selectedDate = date) { view.open(id, selectedDate); },
    async close() { modal.close(); await tick(); },
    async navigateOtherModal() {
      modal.close(); modal.innerHTML = '<section class="other-modal">Anderer Kurskontext</section>'; modal.showModal(); await tick();
    },
    async flush() { await tick(); },
    cleanup(fn) { cleanups.push(fn); },
  };
}
const published = { ok: true, value: { postId: 123, postURL: courseURL + "posts/123/", contentHash: "a".repeat(64) } };

test("controller registers its listeners once and local drafts survive close/reopen and become durable on save", async (t) => {
  const f = fixture(t);
  for (const type of ["input", "change", "submit", "click"]) assert.equal(f.document.handlers.get(type).length, 1);
  f.open(); f.input("done", "Ungesicherter Prototyp <v2>");
  assert.equal(f.view.hasUnsaved(), true);
  assert.equal(f.state.devDiaries[0].entries[0].done, "");
  await f.close(); f.open();
  assert.equal(f.entry().elements.done.value, "Ungesicherter Prototyp <v2>");
  f.submit();
  assert.equal(f.view.hasUnsaved(), false);
  assert.equal(f.state.devDiaries[0].entries[0].done, "Ungesicherter Prototyp <v2>");
  await f.close(); f.open();
  assert.equal(f.entry().elements.done.value, "Ungesicherter Prototyp <v2>");
  assert.equal(f.calls.length, 0);
  assert.equal(f.modal.closeCount, 2, "paints update the open studio without closing it");
});

test("switching days keeps separate drafts and saving commits each date once", async (t) => {
  const f = fixture(t);
  f.open(); f.input("done", "Dienstag gebaut");
  f.click("day", { ddDay: "2026-10-14" }); f.input("learned", "Mittwoch getestet");
  await f.close(); f.open("diary-alpha", date);
  assert.equal(f.entry().elements.done.value, "Dienstag gebaut");
  f.submit();
  const diary = f.state.devDiaries[0];
  assert.equal(diary.entries.length, 3);
  assert.equal(diary.entries.filter((entry) => entry.date === date).length, 1);
  assert.equal(diary.entries.find((entry) => entry.date === date).done, "Dienstag gebaut");
  assert.equal(diary.entries.find((entry) => entry.date === "2026-10-14").learned, "Mittwoch getestet");
  assert.equal(f.view.hasUnsaved(), false);
});

test("failed local saving keeps the draft and never sends a prepare or publish request", async (t) => {
  const f = fixture(t, { save: () => false });
  f.open(); f.input("done", "Noch nicht auf dem Datenträger"); f.click("prepare"); await f.flush();
  assert.equal(f.calls.length, 0);
  assert.equal(f.state.devDiaries[0].entries[0].done, "");
  assert.equal(f.view.hasUnsaved(), true);
  assert.match(f.modal.innerHTML, /nicht lokal gespeichert/);
  await f.close(); f.open();
  assert.equal(f.entry().elements.done.value, "Noch nicht auf dem Datenträger");
  f.click("publish"); await f.flush(); assert.equal(f.calls.length, 0);
});

test("prepare saves all daily drafts first and sends exactly the reviewed Markdown contract", async (t) => {
  const f = fixture(t);
  f.open(); f.input("done", "Vorbereitung"); f.click("day", { ddDay: "2026-10-14" }); f.input("next", "Morgen bauen");
  f.click("prepare"); await f.flush();
  assert.equal(f.calls.length, 1);
  const request = f.calls[0];
  assert.deepEqual(Object.keys(request).sort(), ["content", "courseURL", "op", "runId", "title"]);
  assert.equal(request.runId, "diary-alpha"); assert.equal(request.courseURL, courseURL);
  assert.equal(request.content, compileDevDiaryMarkdown(f.state.devDiaries[0]));
  assert.match(request.content, /13\.10\.2026[\s\S]*Vorbereitung[\s\S]*14\.10\.2026[\s\S]*Morgen bauen/);
  assert.equal(f.view.hasUnsaved(), false);
  assert.match(f.modal.innerHTML, /class="dd-review"/);
  assert.equal(f.modal.closeCount, 0);
});

test("double publish is guarded while the first native write is pending", async (t) => {
  const pending = deferred();
  const f = fixture(t, { seed: "Gespeichert", bridge(request) {
    return request.op === "prepare" ? { ok: true, value: { reviewToken: "token", action: "create" } } : pending.promise;
  } });
  f.cleanup(async () => { if (!pending.settled) pending.resolve(published); await tick(); });
  f.open(); f.click("prepare"); await f.flush();
  f.click("publish"); f.click("publish");
  assert.equal(f.calls.filter((request) => request.op === "publish").length, 1);
  assert.deepEqual(f.calls.at(-1), { op: "publish", reviewToken: "token" });
  pending.resolve(published); await f.flush();
  assert.equal(f.saved.filter((diary) => diary.remote.status === "published").length, 1);
  assert.equal(f.notices.filter((message) => /auf Spaces gespeichert/.test(message)).length, 1);
  f.click("publish"); await f.flush();
  assert.equal(f.calls.filter((request) => request.op === "publish").length, 1);
});

test("a late prepare result after dismissal cannot restore its review or authorize a later publish", async (t) => {
  const pending = deferred();
  const f = fixture(t, { seed: "Lokal", bridge: () => pending.promise });
  f.cleanup(async () => { if (!pending.settled) pending.resolve({ ok: true, value: { reviewToken: "late" } }); await tick(); });
  f.open(); f.click("prepare"); const painted = f.paints.length;
  await f.close(); pending.resolve({ ok: true, value: { reviewToken: "late", action: "create" } }); await f.flush();
  assert.equal(f.modal.open, false);
  assert.equal(f.paints.length, painted);
  f.open(); assert.doesNotMatch(f.modal.innerHTML, /class="dd-review"/);
  f.click("publish"); await f.flush();
  assert.equal(f.calls.filter((request) => request.op === "publish").length, 0);
});

test("a late prepare result must not replace another modal after navigation", async (t) => {
  const pending = deferred();
  const f = fixture(t, { seed: "Lokal", bridge: () => pending.promise });
  f.cleanup(async () => { if (!pending.settled) pending.resolve({ ok: true, value: { reviewToken: "stale" } }); await tick(); });
  f.open(); f.click("prepare"); await f.navigateOtherModal();
  const other = f.modal.innerHTML, painted = f.paints.length;
  pending.resolve({ ok: true, value: { reviewToken: "stale", action: "create" } }); await f.flush();
  assert.equal(f.modal.innerHTML, other, "the next context keeps ownership of the shared modal");
  assert.equal(f.paints.length, painted, "stale preparation must not paint an old diary");
  f.click("publish"); await f.flush();
  assert.equal(f.calls.filter((request) => request.op === "publish").length, 0);
});

test("editing or changing the selected day invalidates an already prepared review", async (t) => {
  const f = fixture(t, { seed: "Stand eins" });
  f.open(); f.click("prepare"); await f.flush();
  f.input("done", "Stand zwei"); f.click("publish"); await f.flush();
  assert.equal(f.calls.filter((request) => request.op === "publish").length, 0);
  f.click("prepare"); await f.flush();
  f.click("day", { ddDay: "2026-10-14" }); f.click("publish"); await f.flush();
  assert.equal(f.calls.filter((request) => request.op === "publish").length, 0);
});

test("native errors and tokenless preparation remain reviewable failures without a remote write", async (t) => {
  const f = fixture(t, { seed: "Lokal", bridge: async () => ({ ok: true, value: { action: "create" } }) });
  f.open(); f.click("prepare"); await f.flush();
  assert.match(f.modal.innerHTML, /keine verlässliche Vorschau/);
  assert.doesNotMatch(f.modal.innerHTML, /class="dd-review"/);
  f.click("publish"); await f.flush();
  assert.equal(f.calls.filter((request) => request.op === "publish").length, 0);
});

test("publication replaces only the matching diary binding and later days update the same post", async (t) => {
  const f = fixture(t, { seed: "Tag eins", second: true });
  const other = structuredClone(f.state.devDiaries[1]);
  f.open(); f.click("prepare"); await f.flush(); f.click("publish"); await f.flush();
  const first = f.state.devDiaries.find((diary) => diary.id === "diary-alpha");
  assert.deepEqual(first.remote, { postId: "123", url: courseURL + "posts/123/", lastPublishedHash: createHash("sha256").update(f.calls[0].content).digest("hex"), status: "published" });
  assert.deepEqual(f.state.devDiaries.find((diary) => diary.id === "diary-beta"), other);
  assert.equal(f.state.devDiaries.length, 2);
  const originalHash = first.remote.lastPublishedHash;
  f.click("day", { ddDay: "2026-10-14" }); f.input("done", "Tag zwei"); f.click("prepare"); await f.flush();
  assert.match(f.modal.innerHTML, /BESTEHENDEN BEITRAG AKTUALISIEREN/);
  f.click("publish"); await f.flush();
  const updated = f.state.devDiaries.find((diary) => diary.id === "diary-alpha");
  assert.equal(updated.remote.postId, "123"); assert.equal(updated.remote.url, first.remote.url);
  assert.notEqual(updated.remote.lastPublishedHash, originalHash);
  assert.equal(f.state.devDiaries.length, 2);
  assert.deepEqual(f.calls.filter((request) => request.op === "prepare").map((request) => request.runId), ["diary-alpha", "diary-alpha"]);
  assert.match(compileDevDiaryMarkdown(updated), /Tag eins[\s\S]*Tag zwei/);
});

test("an accepted publication reconciles its binding after navigation without reopening the old studio", async (t) => {
  const pending = deferred();
  const f = fixture(t, { seed: "Bestätigter Beitrag", bridge(request) {
    return request.op === "prepare" ? { ok: true, value: { reviewToken: "approved", action: "create" } } : pending.promise;
  } });
  f.cleanup(async () => { if (!pending.settled) pending.resolve(published); await tick(); });
  f.open(); f.click("prepare"); await f.flush(); f.click("publish");
  await f.navigateOtherModal(); const other = f.modal.innerHTML, painted = f.paints.length;
  pending.resolve(published); await f.flush();
  assert.equal(f.state.devDiaries[0].remote.postId, "123");
  assert.equal(f.state.devDiaries[0].remote.status, "published");
  assert.equal(f.saved.filter((diary) => diary.remote.status === "published").length, 1);
  assert.equal(f.modal.innerHTML, other);
  assert.equal(f.paints.length, painted);
  assert.equal(f.calls.filter((request) => request.op === "publish").length, 1);
});

test("failure to save a confirmed remote result reports local status loss without claiming nothing was published", async (t) => {
  const f = fixture(t, { seed: "Beitrag", save: (diary) => diary.remote.status !== "published" });
  f.open(); f.click("prepare"); await f.flush(); f.click("publish"); await f.flush();
  assert.equal(f.calls.filter((request) => request.op === "publish").length, 1);
  assert.equal(f.state.devDiaries[0].remote.status, "draft");
  assert.match(f.modal.innerHTML, /Spaces hat den Beitrag gespeichert/);
  assert.match(f.modal.innerHTML, /lokale Status konnte nicht gesichert/);
  assert.doesNotMatch(f.modal.innerHTML, /es wurde nichts veröffentlicht/);
  f.click("publish"); await f.flush();
  assert.equal(f.calls.filter((request) => request.op === "publish").length, 1);
});

test("workspace reload preserves local bindings; explicit backup imports downgrade them and keep diary search ownership", async () => {
  const state = initialState();
  const diary = createDevDiary({ projectId: "prototyping", startDate: date, days: 3 }, state, { id: "diary-alpha", now: instant });
  diary.remote = { postId: "123", url: courseURL + "posts/123/", lastPublishedHash: "b".repeat(64), status: "published" };
  state.devDiaries = [diary];
  assert.deepEqual(validateState(structuredClone(state)).devDiaries[0].remote, diary.remote);
  assert.equal(validateState(structuredClone(state), { diaryImported: true }).devDiaries[0].remote.status, "unknown");
  const legacy = structuredClone(state); delete legacy.devDiaries;
  assert.deepEqual(validateState(legacy).devDiaries, []);
  assert.equal(searchState(state, diary.title).find((item) => item.type === "diary").id, diary.id);
  assert.equal(notificationCourse({ source: "context", projectId: diary.projectId }, state), diary.projectId);
  const json = JSON.stringify(state), plan = await planImport("context", [{ size: Buffer.byteLength(json), text: async () => json }], initialState());
  assert.equal(validateState(applyImport(initialState(), plan)).devDiaries[0].remote.status, "unknown");
});

test("legacy workspaces default missing diaries, while malformed diary collections cannot be silently discarded", () => {
  const legacy = initialState(); delete legacy.devDiaries;
  assert.deepEqual(validateState(legacy).devDiaries, []);
  for (const devDiaries of [null, false, 0, "invalid", {}])
    assert.throws(() => validateState({ ...legacy, devDiaries }));
});

const changedRevision = "0123456789abcdef".repeat(4);
const conflictReply = { ok: false, code: "DIARY_REMOTE_CHANGED", error: "Der Spaces-Beitrag wurde außerhalb von Context geändert." };
const externalContent = '<img src=x onerror="alert(1)">\n<script>steal()</script>\n& fremder Inhalt';
const latestPost = (revision = changedRevision) => ({ ok: true, value: { post: {
  revision, url: courseURL + "posts/123/", contentText: externalContent,
} } });

test("conflicts fetch read-only evidence and cannot acknowledge or publish without explicit checkbox confirmation", async (t) => {
  const f = fixture(t, { seed: "Mein lokaler Stand", bridge(request) {
    if (request.op === "prepare") return conflictReply;
    if (request.op === "get") return latestPost();
    throw new Error("No publication is allowed while the conflict is unchecked");
  } });
  f.open(); f.click("prepare"); await f.flush();
  assert.deepEqual(f.calls.map((request) => request.op), ["prepare", "get"]);
  assert.deepEqual(f.calls[1], { op: "get", runId: "diary-alpha", courseURL });
  assert.equal(Object.hasOwn(f.calls[0], "acknowledgeRevision"), false);
  assert.equal(f.document.getElementById("dd-conflict-checked").checked, false);
  const remoteText = f.modal.innerHTML.match(/<pre class="dd-remote-text">([\s\S]*?)<\/pre>/)?.[1];
  assert.ok(remoteText);
  assert.equal(decode(remoteText), externalContent);
  assert.doesNotMatch(remoteText, /<(?:script|img)\b/i);
  assert.match(remoteText, /&lt;script&gt;/);
  f.click("resolve-conflict"); f.click("publish"); await f.flush();
  assert.equal(f.calls.filter((request) => request.op === "prepare").length, 1);
  assert.equal(f.calls.filter((request) => request.op === "publish").length, 0);
  assert.match(f.modal.innerHTML, /externen Änderungen zuerst ab/);
  assert.equal(f.state.devDiaries[0].remote.status, "draft");
});

test("only an explicit conflict acknowledgement sends the exact revision, and the new review still needs publication", async (t) => {
  let prepares = 0;
  const f = fixture(t, { seed: "Mein lokaler Stand", bridge(request) {
    if (request.op === "prepare") {
      if (++prepares === 1) return conflictReply;
      return { ok: true, value: { reviewToken: "review-after-conflict", action: "update", preview: { title: request.title, content: request.content } } };
    }
    if (request.op === "get") return latestPost();
    if (request.op === "publish") return published;
    throw new Error("Unexpected operation");
  } });
  f.open(); f.click("prepare"); await f.flush();
  f.check("dd-conflict-checked", true);
  f.input("done", "Mein lokaler Stand mit abgeglichener externer Änderung");
  assert.equal(f.document.getElementById("dd-conflict-checked").checked, false, "editing keeps the comparison visible but clears its previous acknowledgement");
  f.submit();
  assert.equal(f.document.getElementById("dd-conflict-checked").checked, false);
  f.check("dd-conflict-checked", true); f.click("resolve-conflict"); await f.flush();
  const requests = f.calls.filter((request) => request.op === "prepare");
  assert.equal(requests.length, 2);
  assert.deepEqual(Object.keys(requests[1]).sort(), ["acknowledgeRevision", "content", "courseURL", "op", "runId", "title"]);
  assert.equal(requests[1].acknowledgeRevision, changedRevision);
  assert.match(requests[1].content, /abgeglichen/);
  assert.equal(f.calls.filter((request) => request.op === "publish").length, 0);
  assert.match(f.modal.innerHTML, /BESTEHENDEN BEITRAG AKTUALISIEREN/);
  assert.match(f.modal.innerHTML, /data-dd-action="publish"/);
  assert.equal(f.document.getElementById("dd-conflict-checked"), null);
  assert.equal(Object.hasOwn(f.state.devDiaries[0], "acknowledgeRevision"), false);
  assert.equal(Object.hasOwn(f.state.devDiaries[0].remote, "acknowledgeRevision"), false);
  f.click("publish"); await f.flush();
  assert.deepEqual(f.calls.at(-1), { op: "publish", reviewToken: "review-after-conflict" });
  assert.equal(f.state.devDiaries[0].remote.postId, "123");
});

test("another external change requires a fresh unchecked confirmation of the new revision", async (t) => {
  const nextRevision = "fedcba9876543210".repeat(4);
  let prepares = 0, reads = 0;
  const f = fixture(t, { seed: "Lokaler Stand", bridge(request) {
    if (request.op === "prepare") return ++prepares <= 2 ? conflictReply : { ok: true, value: { reviewToken: "latest-review", action: "update" } };
    if (request.op === "get") return latestPost(++reads === 1 ? changedRevision : nextRevision);
    throw new Error("No automatic publication during conflict resolution");
  } });
  f.open(); f.click("prepare"); await f.flush();
  f.check("dd-conflict-checked", true); f.click("resolve-conflict"); await f.flush();
  assert.equal(f.document.getElementById("dd-conflict-checked").checked, false);
  f.click("resolve-conflict"); await f.flush();
  assert.equal(prepares, 2);
  f.check("dd-conflict-checked", true); f.click("resolve-conflict"); await f.flush();
  assert.deepEqual(f.calls.filter((request) => request.op === "prepare").map((request) => request.acknowledgeRevision), [undefined, changedRevision, nextRevision]);
  assert.equal(f.calls.filter((request) => request.op === "publish").length, 0);
});

test("a late read-only conflict response cannot reopen or acknowledge an abandoned diary context", async (t) => {
  const pending = deferred();
  const f = fixture(t, { seed: "Lokaler Stand", bridge(request) {
    if (request.op === "prepare") return conflictReply;
    if (request.op === "get") return pending.promise;
    throw new Error("No publish after abandoning a conflict review");
  } });
  f.cleanup(async () => { if (!pending.settled) pending.resolve(latestPost()); await tick(); });
  f.open(); f.click("prepare"); await f.flush();
  assert.deepEqual(f.calls.map((request) => request.op), ["prepare", "get"]);
  await f.navigateOtherModal(); const other = f.modal.innerHTML, painted = f.paints.length;
  pending.resolve(latestPost()); await f.flush();
  assert.equal(f.modal.innerHTML, other);
  assert.equal(f.paints.length, painted);
  assert.equal(f.document.getElementById("dd-conflict-checked"), null);
  f.open(); f.click("resolve-conflict"); f.click("publish"); await f.flush();
  assert.equal(f.calls.filter((request) => request.op === "prepare").length, 1);
  assert.equal(f.calls.filter((request) => request.op === "publish").length, 0);
});


test("setup verifies its Spaces connection without creating a diary, reminder or publication", async t => {
 const f=fixture(t,{bridge:request=>({ok:true,value:{supported:true,category:{name:'DevDiary'}}})});
 const before=JSON.stringify(f.state);f.view.start();f.click('connection');await f.flush();
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].op,'get');assert.equal(f.calls[0].courseURL,courseURL);
 assert.equal(JSON.stringify(f.state),before);assert.equal(f.saveAttempts.length,0);
 assert.match(f.modal.innerHTML,/Verbunden · Kategorie DevDiary verfügbar/);
});

test("a connection result for an earlier selected course cannot label the new course connected", async t => {
 const gate=deferred(),f=fixture(t,{bridge:()=>gate.promise});
 f.state.projects.push({id:'second-course',name:'Designing Things',archived:false,links:[{tool:'spaces',url:'https://spaces.th-koeln.de/designing-things-w26/'}]});
 f.cleanup(()=>{if(!gate.settled)gate.resolve({ok:true,value:{supported:true}})});
 f.view.start();f.click('connection');const form=f.document.getElementById('dd-setup-form');form.elements.courseUrl.value='https://spaces.th-koeln.de/designing-things-w26/';f.document.dispatch('change',form.elements.courseUrl);
 gate.resolve({ok:true,value:{supported:true}});await f.flush();
 assert.match(f.modal.innerHTML,/Designing Things/);assert.doesNotMatch(f.modal.innerHTML,/Verbunden · Kategorie/);
 assert.match(f.modal.innerHTML,/Dev Diary anlegen/);assert.equal(f.saveAttempts.length,0);
});
