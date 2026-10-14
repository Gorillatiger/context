import test from "node:test";
import assert from "node:assert/strict";
import { createMailView, mailRecipients } from "../dist/mail.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const inbox = "SU5CT1g", other = "U2VudA", validity = "111";
const status = { configured: true, address: "synthetic@smail.th-koeln.de", smtpReady: true };
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
const attr = (source, name) => decode(source.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`))?.[1] || "");
const item = (uid, patch = {}) => ({ uid, subject: "Synthetic " + uid, sender: uid + "@example.org",
  from: [{ address: uid + "@example.org" }], date: "2026-10-13T10:00:00Z", unread: true, ...patch });
const message = (uid, patch = {}) => ({ ...item(uid), uidValidity: validity,
  to: [{ address: "synthetic@smail.th-koeln.de" }], cc: [], replyTo: [], messageId: `<${uid}@example.org>`,
  text: "Synthetic message " + uid, attachments: uid === "101" ? [{ part: "2", name: "synthetic.txt", size: 10 }] : [], ...patch });
const list = (folder = inbox) => ({ folder, uidValidity: validity, total: 2, matched: 2, nextOffset: null,
  items: folder === inbox ? [item("101"), item("102")] : [item("201"), item("202")] });
const ok = (body) => ({ ok: true, status: 200, json: async () => structuredClone(body) });
const fail = (code, text = code) => ({ ok: false, status: 502, json: async () => ({ error: code, message: text }) });
const syntheticFile = (name, size = 1, pending) => ({ name, size,
  arrayBuffer: () => pending ? pending.promise : Promise.resolve(new Uint8Array(size).buffer) });

function fixture(t, hook, options = {}) {
  const previous = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch };
  const handlers = new Map(), windowHandlers = new Map(), nodes = new Map();
  const requests = [], changes = [], focus = [], cleanups = [];
  let html = "", connections = 0, view, activeService = options.service || "th";
  const views = new Map();
  const document = {
    activeElement: null,
    addEventListener(type, fn) { handlers.set(type, [...(handlers.get(type) || []), fn]); },
    getElementById(id) { return nodes.get(id) || null; },
    dispatch(type, target) {
      for (const fn of handlers.get(type) || []) fn({ target, preventDefault() {} });
    },
  };
  function node(tag, source, value = "") {
    const id = attr(source, "id"), name = attr(source, "name");
    const element = { id, name, tagName: tag.toUpperCase(), value: decode(value), checked: /(?:^|\s)checked(?:\s|$)/.test(source), files: [],
      dataset: { mailField: attr(source, "data-mail-field") },
      focus(options) { document.activeElement = element; focus.push({ id, options, visibleIntent: options?.preventScroll !== true }); } };
    if (id) nodes.set(id, element);
    return element;
  }
  function mount(content) {
    html = content; nodes.clear();
    for (const tag of content.matchAll(/<([a-z][\w-]*)\b([^>]*\sid="[^"]+"[^>]*)>/gi)) node(tag[1], tag[2], attr(tag[2], "value"));
    for (const textarea of content.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/g)) node("textarea", textarea[1], textarea[2]);
    for (const form of content.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)) {
      const id = attr(form[1], "id"), element = { id, elements: {} };
      for (const input of form[2].matchAll(/<input\b([^>]*)>/g)) {
        const control = nodes.get(attr(input[1], "id")) || node("input", input[1], attr(input[1], "value"));
        if (control.name) element.elements[control.name] = control;
      }
      nodes.set(id, element);
    }
  }
  globalThis.document = document;
  globalThis.window = { addEventListener(type, fn) { windowHandlers.set(type, [...(windowHandlers.get(type) || []), fn]); } };
  globalThis.fetch = async (path, options = {}) => {
    assert.match(path, /^\/api\/mail\/[a-z-]+$/, "all mail requests are handled by this synthetic fixture");
    const request = { action: path.slice("/api/mail/".length), body: options.body ? JSON.parse(options.body) : undefined };
    requests.push(structuredClone(request));
    if (hook) {
      const handled = hook(request, requests);
      if (handled !== undefined) return handled;
    }
    if (request.action === "status") return ok(status);
    if (request.action === "folders") return ok({ folders: [{ id: inbox, kind: "inbox", label: "Inbox" }, { id: other, kind: "sent", label: "Synthetic other folder" }] });
    if (request.action === "list") return ok(list(request.body.folder));
    if (request.action === "message") return ok(message(request.body.uid));
    if (request.action === "connection") return ok({ configured: false });
    if (request.action === "attachment-link") return ok({ url: "/api/mail/download/" + "a".repeat(64) });
    if (request.action === "flag") return ok({ unread: request.body.unread });
    if (request.action === "send") return ok({ accepted: 1, refused: [], sentCopySaved: true });
    throw new Error("Unhandled synthetic mail request: " + request.action);
  };
  function createView(service = "th", request) {
    let controller;
    controller = createMailView({ service, isActive: () => activeService === service,
      ...(request ? { request: async (action, body) => { requests.push(structuredClone({service,action,body})); return request(action,body); } } : {}),
      onChange(options = {}) { changes.push(options); if(activeService === service)mount(controller.render()); }, onConnection() { connections++; } });
    views.set(service, controller); return controller;
  }
  view = createView(activeService, options.request);
  t.after(async () => {
    for (const cleanup of cleanups) await cleanup();
    await tick(); Object.assign(globalThis, previous);
  });
  const click = (mailAction, id) => {
    const button = { dataset: { mailAction, id }, closest(selector) { return selector === "[data-mail-action]" ? button : null; } };
    document.dispatch("click", button);
  };
  return {
    get view() {return view;}, document, requests, changes, focus, click,
    get html() { return html; }, get connections() { return connections; },
    async load() { await view.load(); await tick(); },
    input(id, value) { const input = nodes.get(id); assert.ok(input, id); input.value = value; document.dispatch("input", input); },
    submit(id = "mail-compose") { const form = nodes.get(id); assert.ok(form, id); document.dispatch("submit", form); },
    attach(files) { const input = nodes.get("mail-files"); assert.ok(input); input.files = files; document.dispatch("change", input); },
    beforeUnload() {
      const event = { prevented: false, preventDefault() { this.prevented = true; } };
      for (const fn of windowHandlers.get("beforeunload") || []) fn(event);
      return event;
    },
    cleanup(fn) { cleanups.push(fn); }, async flush() { await tick(); },
    compose() { click("compose"); },
    fillDraft() { this.input("mail-to", "to@example.org"); this.input("mail-subject", "Synthetic subject"); this.input("mail-text", "Synthetic body"); },
    addView(service, request) {return createView(service, request);},
    activate(service) {assert.ok(views.has(service));activeService=service;view=views.get(service);mount(view.render());},
  };
}

for (const stage of ["status", "folders"]) test(`a late refresh ${stage} reply cannot restore a disconnected account`, async (t) => {
  const pending = deferred(); let held = false;
  const f = fixture(t, (request, requests) => {
    if (request.action === stage && requests.filter((r) => r.action === stage).length === 2) { held = true; return pending.promise; }
  });
  f.cleanup(async () => { if (!pending.settled) pending.resolve(ok(stage === "status" ? status : { folders: [] })); await tick(); });
  await f.load(); const refreshing = f.view.load(true); await f.flush(); assert.equal(held, true);
  f.click("disconnect"); await f.flush(); const requestCount = f.requests.length;
  assert.match(f.html, /id="mail-connect"/);
  pending.resolve(ok(stage === "status" ? status : { folders: [{ id: inbox, kind: "inbox", label: "Stale inbox" }] }));
  await refreshing; await f.flush();
  assert.match(f.html, /id="mail-connect"/);
  assert.doesNotMatch(f.html, /class="mail-workspace/);
  assert.equal(f.requests.length, requestCount, "stale refresh must not continue reading the disconnected account");
});

test("racing external open targets cannot read the first UID using the second target's folder", async (t) => {
  const pending = deferred(); let lists = 0;
  const f = fixture(t, (request) => {
    if (request.action === "list" && ++lists === 2) return pending.promise;
  });
  f.cleanup(async () => { if (!pending.settled) pending.resolve(ok(list(inbox))); await tick(); });
  await f.load();
  const first = f.view.open({ folder: inbox, uid: "101", uidValidity: validity }); await f.flush();
  await f.view.open({ folder: other, uid: "202", uidValidity: validity });
  pending.resolve(ok(list(inbox))); await first; await f.flush();
  assert.deepEqual(f.requests.filter((r) => r.action === "message").map((r) => ({ folder: r.body.folder, uid: r.body.uid })), [{ folder: other, uid: "202" }]);
  assert.match(f.html, /Synthetic message 202/);
  assert.doesNotMatch(f.html, /Synthetic message 101/);
});

test("a late message A cannot replace message B or steal its intentional heading focus", async (t) => {
  const pending = deferred();
  const f = fixture(t, (request) => request.action === "message" && request.body.uid === "101" ? pending.promise : undefined);
  f.cleanup(async () => { if (!pending.settled) pending.resolve(ok(message("101"))); await tick(); });
  await f.load(); f.click("open", "101"); await f.flush(); f.click("open", "102"); await f.flush();
  const headingFocuses = f.focus.filter((entry) => entry.id === "mail-message-heading").length;
  pending.resolve(ok(message("101"))); await f.flush();
  assert.match(f.html, /Synthetic message 102/);
  assert.doesNotMatch(f.html, /Synthetic message 101/);
  assert.equal(f.focus.filter((entry) => entry.id === "mail-message-heading").length, headingFocuses);
});

test("a late message response cannot pull focus out of a newly opened and typed composer", async (t) => {
  const pending = deferred();
  const f = fixture(t, (request) => request.action === "message" ? pending.promise : undefined);
  f.cleanup(async () => { if (!pending.settled) pending.resolve(ok(message("101"))); await tick(); });
  await f.load(); f.click("open", "101"); await f.flush(); f.compose();
  f.input("mail-subject", "Writing during a read"); f.input("mail-text", "Draft text survives the late response");
  const focuses = f.focus.length;
  pending.resolve(ok(message("101", { text: "BODY OF LATE MESSAGE" }))); await f.flush();
  assert.match(f.html, /id="mail-compose"/);
  assert.equal(f.document.getElementById("mail-text").value, "Draft text survives the late response");
  assert.equal(f.document.getElementById("mail-subject").value, "Writing during a read");
  assert.doesNotMatch(f.html, /BODY OF LATE MESSAGE/);
  assert.equal(f.focus.length, focuses, "background completion must not issue a fresh reader-focus intent");
});

test("a failed folder list is shown as a retryable read error rather than a genuinely empty folder", async (t) => {
  let unavailable = true;
  const f = fixture(t, (request) => request.action === "list" && request.body.folder === other && unavailable
    ? fail("list_failed", "Synthetic folder temporarily unavailable") : undefined);
  await f.load(); f.click("folder", other); await f.flush();
  assert.match(f.html, /Synthetic folder temporarily unavailable/);
  assert.doesNotMatch(f.html, /Dieser Ordner ist leer|Keine Mails zu dieser Suche|Keine ungelesenen Mails/);
  assert.match(f.html, /data-mail-action="retry-list"/);
  unavailable = false; f.click("retry-list"); await f.flush();
  assert.match(f.html, /Synthetic 201/);
  assert.doesNotMatch(f.html, /Synthetic folder temporarily unavailable/);
});

for (const field of ["subject", "cc", "bcc"]) test(`${field}-only drafts survive replying to another message and guard window close`, async (t) => {
  const f = fixture(t); await f.load(); f.compose();
  const value = field === "subject" ? "Unsent subject only" : `${field}@example.org`;
  f.input("mail-" + field, value);
  assert.equal(f.beforeUnload().prevented, true);
  f.click("close-compose"); f.click("open", "101"); await f.flush(); f.click("reply");
  assert.equal(f.document.getElementById("mail-" + field).value, value);
  assert.match(f.html, /Entwurf bleibt erhalten/);
  f.click("discard"); assert.equal(f.beforeUnload().prevented, false);
});

test("pending attachment reads block review and send; finishing does not silently approve a new review", async (t) => {
  const pending = deferred();
  const f = fixture(t); f.cleanup(async () => { if (!pending.settled) pending.resolve(new Uint8Array([1]).buffer); await tick(); });
  await f.load(); f.compose(); f.fillDraft(); f.attach([syntheticFile("pending.txt", 1, pending)]);
  f.submit(); f.click("send"); await f.flush();
  assert.doesNotMatch(f.html, /VOR DEM VERSAND/);
  assert.equal(f.requests.filter((r) => r.action === "send").length, 0);
  pending.resolve(new Uint8Array([1]).buffer); await f.flush();
  assert.doesNotMatch(f.html, /VOR DEM VERSAND/);
  const previousPicker = f.document.getElementById("mail-files");
  f.submit(); assert.match(f.html, /VOR DEM VERSAND/);
  let reads = 0;
  assert.equal(f.document.getElementById("mail-files"), null, "a frozen review exposes no upload control");
  previousPicker.files = [{ name: "must-not-change-review.txt", size: 1, arrayBuffer: async () => { reads++; return new Uint8Array([2]).buffer; } }];
  f.document.dispatch("change", previousPicker);
  await f.flush(); assert.equal(reads, 0);
  f.click("send"); await f.flush();
  const sent = f.requests.find((r) => r.action === "send");
  assert.deepEqual(sent.body.draft.attachments.map((a) => a.name), ["pending.txt"]);
});

test("concurrent file selections enforce the final ten-file limit instead of checking two stale snapshots", async (t) => {
  const first = deferred(), second = deferred();
  const f = fixture(t); f.cleanup(async () => {
    if (!first.settled) first.resolve(new Uint8Array([1]).buffer);
    if (!second.settled) second.resolve(new Uint8Array([2]).buffer); await tick();
  });
  await f.load(); f.compose(); f.fillDraft();
  f.attach(Array.from({ length: 6 }, (_, n) => syntheticFile(`first-${n}.txt`, 1, n === 0 ? first : undefined)));
  f.attach(Array.from({ length: 6 }, (_, n) => syntheticFile(`second-${n}.txt`, 1, n === 0 ? second : undefined)));
  first.resolve(new Uint8Array([1]).buffer); second.resolve(new Uint8Array([2]).buffer); await f.flush();
  f.submit(); f.click("send"); await f.flush();
  const sent = f.requests.find((r) => r.action === "send");
  assert.ok(sent); assert.equal(sent.body.draft.attachments.length, 6);
  assert.ok(sent.body.draft.attachments.every((a) => a.name.startsWith("first-")) || sent.body.draft.attachments.every((a) => a.name.startsWith("second-")));
});

test("concurrent file reads recheck the aggregate eight-megabyte limit on commit", async (t) => {
  const first = deferred(), second = deferred(), size = 5 * 1024 * 1024;
  const f = fixture(t); f.cleanup(async () => {
    if (!first.settled) first.resolve(new Uint8Array(size).buffer);
    if (!second.settled) second.resolve(new Uint8Array(size).buffer); await tick();
  });
  await f.load(); f.compose(); f.fillDraft();
  f.attach([syntheticFile("first-large.bin", size, first)]); f.attach([syntheticFile("second-large.bin", size, second)]);
  first.resolve(new Uint8Array(size).buffer); second.resolve(new Uint8Array(size).buffer); await f.flush();
  f.submit(); f.click("send"); await f.flush();
  const sent = f.requests.find((r) => r.action === "send");
  assert.ok(sent); assert.equal(sent.body.draft.attachments.length, 1);
});

test("partial delivery preserves refused recipients in their original roles with the full draft and files", async (t) => {
  const f = fixture(t, (request) => request.action === "send" ? ok({ accepted: 2, refused: ["refused@example.org", "bcc-refused@example.org"], sentCopySaved: true }) : undefined);
  await f.load(); f.compose(); f.fillDraft();
  f.input("mail-to", "accepted@example.org, refused@example.org"); f.input("mail-cc", "cc-accepted@example.org"); f.input("mail-bcc", "bcc-refused@example.org");
  f.attach([syntheticFile("keep.txt")]); await f.flush(); f.submit(); f.click("send"); await f.flush();
  assert.match(f.html, /id="mail-compose"/);
  assert.deepEqual(mailRecipients(f.document.getElementById("mail-to").value), ["refused@example.org"]);
  assert.deepEqual(mailRecipients(f.document.getElementById("mail-cc").value), []);
  assert.deepEqual(mailRecipients(f.document.getElementById("mail-bcc").value), ["bcc-refused@example.org"]);
  assert.equal(f.document.getElementById("mail-subject").value, "Synthetic subject");
  assert.equal(f.document.getElementById("mail-text").value, "Synthetic body");
  assert.match(f.html, /keep\.txt/);
  assert.equal(f.beforeUnload().prevented, true);
  assert.equal(f.requests.filter((r) => r.action === "send").length, 1);
});

for (const operation of ["attachment-link", "flag"]) test(`a stale ${operation} error does not contaminate a newly selected message`, async (t) => {
  const pending = deferred();
  const f = fixture(t, (request) => request.action === operation ? pending.promise : undefined);
  f.cleanup(async () => { if (!pending.settled) pending.resolve(fail("synthetic_old_error", "OLD MESSAGE OPERATION FAILED")); await tick(); });
  await f.load(); f.click("open", "101"); await f.flush();
  f.click(operation === "flag" ? "flag" : "download", operation === "flag" ? undefined : "2"); await f.flush();
  f.click("open", "102"); await f.flush();
  pending.resolve(fail("synthetic_old_error", "OLD MESSAGE OPERATION FAILED")); await f.flush();
  assert.match(f.html, /Synthetic message 102/);
  assert.doesNotMatch(f.html, /OLD MESSAGE OPERATION FAILED/);
  assert.doesNotMatch(f.html, /mail-save-file/);
  const request = f.requests.find((r) => r.action === operation);
  assert.equal(request.body.uid, "101");
});

test("a stale successful download cannot expose a file belonging to another message", async (t) => {
  const pending = deferred();
  const f = fixture(t, (request) => request.action === "attachment-link" ? pending.promise : undefined);
  f.cleanup(async () => { if (!pending.settled) pending.resolve(ok({ url: "/api/mail/download/" + "b".repeat(64) })); await tick(); });
  await f.load(); f.click("open", "101"); await f.flush(); f.click("download", "2");
  f.click("open", "102"); await f.flush(); pending.resolve(ok({ url: "/api/mail/download/" + "b".repeat(64) })); await f.flush();
  assert.doesNotMatch(f.html, /mail-save-file/);
  assert.equal(f.focus.some((entry) => entry.id === "mail-save-file"), false);
});

test("fresh reader, compose, review and ready-download focus is intentional and can be made visible", async (t) => {
  const f = fixture(t); await f.load(); f.click("open", "101"); await f.flush();
  assert.equal(f.focus.at(-1).id, "mail-message-heading"); assert.equal(f.focus.at(-1).visibleIntent, true);
  f.click("download", "2"); await f.flush();
  assert.equal(f.focus.at(-1).id, "mail-save-file"); assert.equal(f.focus.at(-1).visibleIntent, true);
  f.compose(); assert.equal(f.focus.at(-1).id, "mail-to"); assert.equal(f.focus.at(-1).visibleIntent, true);
  f.fillDraft(); f.submit(); assert.equal(f.focus.at(-1).id, "mail-send-now"); assert.equal(f.focus.at(-1).visibleIntent, true);
  assert.ok(f.changes.some((change) => change.intentFocus === "mail-send-now"));
});

for (const network of [false, true]) test(`${network ? "unclassified network failure" : "unknown delivery"} remains blocked after edit and review until explicit discard`, async (t) => {
  const f = fixture(t, (request) => {
    if (request.action === "send") {
      if (network) return Promise.reject(new TypeError("Synthetic connection lost after write"));
      return fail("delivery_unknown", "SMTP outcome is unknown");
    }
  });
  await f.load(); f.compose(); f.fillDraft(); f.submit(); f.click("send"); await f.flush();
  f.click("send"); f.click("edit"); f.submit(); f.click("send"); await f.flush();
  assert.equal(f.requests.filter((r) => r.action === "send").length, 1);
  f.click("discard"); assert.equal(f.beforeUnload().prevented, false);
  f.fillDraft(); f.submit(); f.click("send"); await f.flush();
  assert.equal(f.requests.filter((r) => r.action === "send").length, 2, "a discarded draft starts an explicitly new message");
});

test('a legacy plain-text HTTP 403 explains the local session problem and preserves the draft',async t=>{
 const f=fixture(t,request=>request.action==='message'?{ok:false,status:403,json:async()=>{throw new SyntaxError('Unauthorized');}}:undefined);
 await f.load();f.compose();f.fillDraft();f.click('close-compose');f.click('open','101');await f.flush();
 assert.match(f.html,/lokale Sitzung ist nicht mehr gültig/);assert.doesNotMatch(f.html,/Mailserver ist nicht erreichbar/);
 f.compose();assert.equal(f.document.getElementById('mail-subject').value,'Synthetic subject');assert.equal(f.beforeUnload().prevented,true);
});

const cloudKey = service => (service === 'gmail' ? 'a' : 'b').repeat(64);
function cloudRequest(service, hook, getStatus = () => ({configured:true,address:service+'@example.org',smtpReady:true,accountKey:cloudKey(service),capabilities:{mailRead:true,mailSend:true,mailModify:true}})) {
  return async (action,body) => {
    if(hook){const result=hook({action,body});if(result!==undefined)return result;}
    const account=getStatus();
    if(action==='status')return structuredClone(account);
    if(action==='folders')return {folders:[{id:'INBOX',kind:'inbox',label:service+' inbox'},{id:'SENT',kind:'sent',label:service+' sent'}]};
    if(action==='list')return {...list(inbox),folder:body.folder,uidValidity:account.accountKey};
    if(action==='message')return {...message(body.uid),uidValidity:account.accountKey,to:[{address:account.address}]};
    if(action==='connection')return {configured:false};
    if(action==='attachment')return new Blob(['synthetic file'],{type:'text/plain'});
    if(action==='flag')return {unread:body.unread};
    if(action==='send')return {accepted:1,refused:[],deliveryConfirmed:false,sentCopySaved:false,sentCopyRequested:true};
    assert.fail('unexpected native cloud action '+action);
  };
}

test('an unconnected cloud mailbox routes to Connections without a campus password form or TH fetch',async t=>{
  const f=fixture(t,undefined,{service:'gmail',request:cloudRequest('gmail',undefined,()=>({configured:false,smtpReady:false,accountKey:'',capabilities:{mailRead:false,mailSend:false,mailModify:false}}))});
  await f.load();assert.match(f.html,/Gmail-Postfach/);assert.match(f.html,/data-view="connections"/);assert.match(f.html,/OAuth-Tokens verwaltet Nango/);
  assert.doesNotMatch(f.html,/mail-connect|mail-password|campusID|TH KÖLN/);assert.deepEqual(f.requests.map(r=>[r.service,r.action]),[['gmail','status']]);
});

test('read-only cloud permissions hide marking and block review/send even for forged actions',async t=>{
  const f=fixture(t,undefined,{service:'outlook',request:cloudRequest('outlook',undefined,()=>({configured:true,address:'readonly@example.org',smtpReady:false,accountKey:cloudKey('outlook'),capabilities:{mailRead:true,mailSend:false,mailModify:false}}))});
  await f.load();f.click('open','101');await f.flush();assert.doesNotMatch(f.html,/data-mail-action="flag"/);f.click('flag');
  f.compose();f.fillDraft();assert.match(f.html,/Berechtigung unter Verbindungen freigeben/);f.submit();f.click('send');await f.flush();
  assert.doesNotMatch(f.html,/VOR DEM VERSAND/);assert.equal(f.requests.filter(r=>['flag','send'].includes(r.action)).length,0);assert.doesNotMatch(f.html,/TH-Mailserver|SMTP|campusID/);
});

test('cloud send binds the reviewed account and reports acceptance/requested copy without delivery claims',async t=>{
  const f=fixture(t,undefined,{service:'outlook',request:cloudRequest('outlook')});await f.load();f.compose();f.fillDraft();f.submit();
  assert.match(f.html,/Versand über Outlook/);f.click('send');await f.flush();
  const sent=f.requests.find(r=>r.action==='send');assert.equal(sent.body.accountKey,cloudKey('outlook'));assert.equal(sent.body.draft.subject,'Synthetic subject');
  assert.match(f.html,/von Outlook angenommen/);assert.match(f.html,/Zustellung ist noch nicht bestätigt/);assert.match(f.html,/Kopie für den Gesendet-Ordner wurde angefordert/);
  assert.doesNotMatch(f.html,/Eine Kopie liegt|konnte nicht im Gesendet-Ordner|TH-Mailserver/);
});

test('service-scoped controllers isolate every draft/input/action and namespace all scroll areas',async t=>{
  const f=fixture(t);await f.load();f.compose();f.input('mail-subject','TH private draft');
  const thDraftKey=attr(f.html.match(/<div id="mail-reader"[^>]*>/)[0],'data-mail-scroll-key');assert.equal(thDraftKey,'draft');
  f.addView('gmail',cloudRequest('gmail'));f.activate('gmail');await f.load();f.compose();f.fillDraft();f.input('mail-subject','Gmail private draft');
  const gmailKeys=[...f.html.matchAll(/data-mail-scroll-key="([^"]+)"/g)].map(m=>decode(m[1]));assert.ok(gmailKeys.every(key=>key.includes('gmail')));assert.ok(gmailKeys.every(key=>key.includes(cloudKey('gmail'))));
  f.submit();const reviewKey=attr(f.html.match(/<div id="mail-reader"[^>]*>/)[0],'data-mail-scroll-key');assert.match(reviewKey,/gmail.*review/);assert.doesNotMatch(f.html,/TH private draft/);
  f.addView('outlook',cloudRequest('outlook'));f.activate('outlook');await f.load();f.compose();f.input('mail-subject','Outlook private draft');
  const outlookKeys=[...f.html.matchAll(/data-mail-scroll-key="([^"]+)"/g)].map(m=>decode(m[1]));assert.ok(outlookKeys.every(key=>key.includes('outlook')));assert.ok(outlookKeys.every(key=>!gmailKeys.includes(key)));
  f.activate('th');assert.equal(f.document.getElementById('mail-subject').value,'TH private draft');assert.equal(f.requests.filter(r=>r.action==='send').length,0);
  f.activate('outlook');assert.equal(f.document.getElementById('mail-subject').value,'Outlook private draft');
  f.activate('gmail');f.click('edit');assert.equal(f.document.getElementById('mail-subject').value,'Gmail private draft');
});

test('inactive mail controllers keep their own unload guard while ignoring active-view file/submit/click events',async t=>{
  const f=fixture(t);await f.load();f.addView('gmail',cloudRequest('gmail'));f.activate('gmail');await f.load();f.compose();f.input('mail-subject','Hidden Gmail draft');
  f.activate('th');f.compose();assert.equal(f.document.getElementById('mail-subject').value,'');assert.equal(f.beforeUnload().prevented,true,'inactive Gmail draft still protects closing the app');
  f.fillDraft();f.attach([syntheticFile('TH-only.txt')]);await f.flush();f.submit();f.click('send');await f.flush();
  const sends=f.requests.filter(r=>r.action==='send');assert.equal(sends.length,1);assert.equal(sends[0].service,undefined);assert.deepEqual(sends[0].body.draft.attachments.map(a=>a.name),['TH-only.txt']);assert.equal(sends[0].body.accountKey,undefined);
  f.activate('gmail');assert.equal(f.document.getElementById('mail-subject').value,'Hidden Gmail draft');assert.doesNotMatch(f.html,/TH-only.txt/);
});

test('late cloud reads cannot repaint the active TH composer or issue hidden-controller focus',async t=>{
  const pending=deferred(),f=fixture(t);f.cleanup(async()=>{if(!pending.settled)pending.resolve({...message('101'),uidValidity:cloudKey('gmail')});await tick();});
  await f.load();f.addView('gmail',cloudRequest('gmail',r=>r.action==='message'?pending.promise:undefined));f.activate('gmail');await f.load();f.click('open','101');await f.flush();
  f.activate('th');f.compose();f.input('mail-subject','Active TH typing');const focuses=f.focus.length;
  pending.resolve({...message('101',{text:'INACTIVE CLOUD RESPONSE'}),uidValidity:cloudKey('gmail')});await f.flush();
  assert.equal(f.document.getElementById('mail-subject').value,'Active TH typing');assert.doesNotMatch(f.html,/INACTIVE CLOUD RESPONSE/);assert.equal(f.focus.length,focuses);
});

test('refreshConnection retains text/recipients while clearing old-account review and read/download state',async t=>{
  let key=cloudKey('gmail');const pending=deferred();
  const f=fixture(t,undefined,{service:'gmail',request:cloudRequest('gmail',r=>r.action==='attachment'?pending.promise:undefined,()=>({configured:true,address:'gmail@example.org',smtpReady:true,accountKey:key,capabilities:{mailRead:true,mailSend:true,mailModify:true}}))});
  f.cleanup(async()=>{if(!pending.settled)pending.resolve(new Blob(['old file']));await tick();});
  await f.load();f.click('open','101');await f.flush();f.click('download','2');await f.flush();f.compose();f.fillDraft();f.input('mail-cc','retain@example.org');f.submit();assert.match(f.html,/VOR DEM VERSAND/);
  key='c'.repeat(64);await f.view.refreshConnection();await f.flush();pending.resolve(new Blob(['old file']));await f.flush();
  assert.match(f.html,/Verbindung geändert. Entwurf vor Versand erneut prüfen/);assert.doesNotMatch(f.html,/VOR DEM VERSAND|mail-save-file/);assert.equal(f.document.getElementById('mail-subject').value,'Synthetic subject');assert.equal(f.document.getElementById('mail-cc').value,'retain@example.org');
  f.click('send');assert.equal(f.requests.filter(r=>r.action==='send').length,0);f.submit();f.click('send');await f.flush();assert.equal(f.requests.find(r=>r.action==='send').body.accountKey,key);
});

test('a direct status refresh also rejects a stale review when the account identity changes',async t=>{
  let key=cloudKey('outlook');const f=fixture(t,undefined,{service:'outlook',request:cloudRequest('outlook',undefined,()=>({configured:true,address:'outlook@example.org',smtpReady:true,accountKey:key,capabilities:{mailRead:true,mailSend:true,mailModify:true}}))});
  await f.load();f.compose();f.fillDraft();f.submit();key='d'.repeat(64);await f.view.load(true);await f.flush();
  assert.doesNotMatch(f.html,/VOR DEM VERSAND/);assert.equal(f.document.getElementById('mail-subject').value,'Synthetic subject');f.click('send');await f.flush();assert.equal(f.requests.filter(r=>r.action==='send').length,0);
  f.submit();f.click('send');await f.flush();assert.equal(f.requests.find(r=>r.action==='send').body.accountKey,key);
});

test('changing connection during an accepted send preserves an unknown draft instead of silently resending',async t=>{
  const pending=deferred();let key=cloudKey('outlook');
  const f=fixture(t,undefined,{service:'outlook',request:cloudRequest('outlook',r=>r.action==='send'?pending.promise:undefined,()=>({configured:true,address:'outlook@example.org',smtpReady:true,accountKey:key,capabilities:{mailRead:true,mailSend:true,mailModify:true}}))});
  f.cleanup(async()=>{if(!pending.settled)pending.resolve({accepted:1,deliveryConfirmed:false,sentCopyRequested:true});await tick();});
  await f.load();f.compose();f.fillDraft();f.submit();f.click('send');await f.flush();key='e'.repeat(64);await f.view.refreshConnection();
  pending.resolve({accepted:1,deliveryConfirmed:false,sentCopyRequested:true});await f.flush();f.submit();f.click('send');await f.flush();
  assert.equal(f.requests.filter(r=>r.action==='send').length,1);assert.match(f.html,/Versandstatus.*unklar/);assert.equal(f.document.getElementById('mail-text').value,'Synthetic body');assert.equal(f.beforeUnload().prevented,true);
});

test('cloud attachments go directly through the injected native read and local blob URL is revoked on navigation',async t=>{
  const previous={create:URL.createObjectURL,revoke:URL.revokeObjectURL},created=[],revoked=[];
  URL.createObjectURL=blob=>{created.push(blob);return 'blob:synthetic-cloud-file';};URL.revokeObjectURL=url=>revoked.push(url);t.after(()=>{URL.createObjectURL=previous.create;URL.revokeObjectURL=previous.revoke;});
  const f=fixture(t,undefined,{service:'gmail',request:cloudRequest('gmail')});await f.load();f.click('open','101');await f.flush();f.click('download','2');await f.flush();
  assert.equal(created.length,1);assert.ok(created[0] instanceof Blob);assert.match(f.html,/href="blob:synthetic-cloud-file"/);assert.equal(f.requests.filter(r=>r.action==='attachment').length,1);assert.equal(f.requests.filter(r=>r.action==='attachment-link').length,0);
  f.click('open','102');await f.flush();assert.deepEqual(revoked,['blob:synthetic-cloud-file']);assert.doesNotMatch(f.html,/mail-save-file/);
});

test('a stale native cloud attachment completion cannot create a URL or focus another message',async t=>{
  const pending=deferred();const f=fixture(t,undefined,{service:'gmail',request:cloudRequest('gmail',r=>r.action==='attachment'?pending.promise:undefined)});
  f.cleanup(async()=>{if(!pending.settled)pending.resolve(new Blob(['stale']));await tick();});
  await f.load();f.click('open','101');await f.flush();f.click('download','2');await f.flush();f.click('open','102');await f.flush();const focuses=f.focus.length;
  pending.resolve(new Blob(['stale']));await f.flush();assert.doesNotMatch(f.html,/mail-save-file/);assert.equal(f.focus.length,focuses);assert.match(f.html,/Synthetic message 102/);
});
