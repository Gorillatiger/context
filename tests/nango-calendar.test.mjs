import test from "node:test";
import assert from "node:assert/strict";
import {createNangoCalendarProviders} from "../connectors/nango-calendar.mjs";
import {createDesktopCalendar} from "../desktop/calendar.mjs";
import {validateCalendarEvents, berlinLocalToInstant, berlinLocalInput} from "../dist/calendar-engine.js";
const namespace = "abcabcab-1234-1234-1234-abcabcabcabc";
const requestId = "defdefde-1234-1234-1234-defdefdefdef";
const calendarId = "own-calendar";
const event = (id = "photo:deadline") => ({
 id, title: "Prototyp abgeben", projectId: "interaction-design",
 start: "2026-10-15T08:00:00.000Z", end: "2026-10-15T09:00:00.000Z",
 allDay: false, timeZone: "Europe/Berlin", readonly: false,
 source: {kind: "photo", title: "Abgabeplan", excerpt: "Abgabe am 15.10., 10 Uhr"}
});
const batch = (events = [event()]) => ({calendarId, namespace, events});
const reply = (data, status = 200, contentType = "application/json") => ({status, headers: {"content-type": contentType}, data});
function readFixture({google = true, drive = true, outlook = true, handler} = {}) {
 const calls = [], bindings = Object.fromEntries([
  ["google-calendar", google, {calendarRead: true}],
  ["google-drive", drive, {driveRead: true}],
  ["outlook", outlook, {calendarRead: true}]
 ].map(([service, connected, capabilities]) => [service, {connected, integrationId: service + "-test", connectionId: connected ? service + "-account" : "", revision:"1:0", capabilities}]));
 const nango = {status: service => structuredClone(bindings[service]), proxy: async (service, request, signal) => {
  assert.ok(["outlook", "google-calendar", "google-drive"].includes(service));
  assert.equal(request.method, "GET");assert.equal(signal.aborted, false);
  assert.ok(request.path.startsWith("/") && !request.path.includes("://"));
  assert.equal(request.identity.revision, bindings[service].revision);
  assert.ok(!Object.keys(request.headers).some(key => /authorization|cookie|base-url|connection-id|provider-config/i.test(key)));
  calls.push({service, ...request});
  if (handler) return handler(service, request, bindings);
  if (request.path.endsWith("/calendarList")) return reply({items:[{id:calendarId, summary:"Calendar", primary:true, timeZone:"Europe/Berlin"}]});
  if (request.path === "/v1.0/me/calendars") return reply({value:[{id:calendarId, name:"Calendar", isDefaultCalendar:true, canEdit:true, canShare:true}]});
  if (request.path.endsWith("/calendarView")) return reply({value:[{id:"outlook-event", subject:"Meeting", isAllDay:false, start:{dateTime:"2026-10-15T08:00:00",timeZone:"UTC"},end:{dateTime:"2026-10-15T09:00:00",timeZone:"UTC"}}]});
  if (request.path.startsWith("/calendar/v3/calendars/")) return reply({items:[{id:"google-event",summary:"Meeting",start:{dateTime:"2026-10-15T10:00:00+02:00"},end:{dateTime:"2026-10-15T11:00:00+02:00"}},{id:"google-day",summary:"Deadline",start:{date:"2026-10-15"},end:{date:"2026-10-16"}}]});
  if (request.path === "/drive/v3/files") return reply({files:[{id:"plan-1",name:"Plan",mimeType:"application/vnd.google-apps.spreadsheet"}]});
  if (request.path === "/drive/v3/files/plan-1/export") return reply("Title,Date\nMeeting,2026-10-15",200,"text/csv");
  throw Error("Unexpected synthetic route");
 }};
 return {client:createNangoCalendarProviders({nango}), calls, bindings, nango};
}
const range = {calendarId, from:"2026-10-01T00:00:00Z", to:"2026-11-01T00:00:00Z"};
function outlookFixture({ write = true, owns = true, hooks = {} } = {}) {
  const calls = [],
    remote = new Map(),
    transactions = new Map(),
    payloads = new Map();
  let version = 0;
  const permissions = { canEdit: true, canShare: owns };
  const headers = { "Content-Type": "application/json" };
  const reply = (data, status = 200) => ({ status, headers, data });
  const connection = {connected: true, integrationId: "outlook-test", connectionId: "account-1", revision:"1:0", capabilities: {calendarRead: true, calendarWrite: write}};
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
  const nango = {
    status: service => service === "outlook" ? structuredClone(connection) : ({connected: false, integrationId: "", connectionId: "", revision:"1:0", capabilities: {}}),
    proxy: async (service, options, signal) => {
      assert.equal(service, "outlook");
      assert.equal(signal.aborted, false);
      assert.equal(options.identity.revision, connection.revision);
      const parsed = new URL("https://graph.microsoft.com" + options.path);
      for (const [key, value] of Object.entries(options.params || {})) parsed.searchParams.set(key, value);
      const call = {
        url: parsed,
        method: options.method,
        options,
        body: options.body,
      };
      calls.push(call);
      const intercepted = await hooks.before?.(call, {
        remote,
        transactions,
        permissions,
      });
      if (intercepted) return intercepted;
      assert.equal(parsed.hostname, "graph.microsoft.com");
      assert.ok(!Object.keys(options.headers).some(k => /authorization|cookie|base-url/i.test(k)));
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
  };
  const client = createNangoCalendarProviders({nango});
  return {
    client,
    calls,
    connection,
    remote,
    permissions,
    transactions,
    async ready() {
      await client.calendars("outlook");
    },
    writes() {
      return calls.filter((c) => c.body);
    },
  };
}


test("status preserves CalendarProviders fields without exporting Nango credentials", async () => {
 const f=readFixture({drive:false});f.bindings.outlook.credentials={access_token:"private-fixture-token"};
 const status=await f.client.status();assert.equal(status.google.connected,true);assert.equal(status.google.driveEnabled,false);assert.equal(status.google.readOnly,true);
 assert.equal(status.outlook.storage,"nango");assert.equal(status.outlook.syncEnabled,false);assert.equal(status.outlook.readOnly,true);
 assert.ok(!JSON.stringify(status).includes("private-fixture"));assert.equal(f.calls.length,0);
 await assert.rejects(f.client.status("gmail"),{code:"invalid_provider"});
});
test("Calendar and Drive connections are independent typed Nango services", async () => {
 const f=readFixture({google:false});const files=await f.client.driveFiles("google");assert.equal(files.files.length,1);
 assert.equal(f.calls[0].service,"google-drive");await assert.rejects(f.client.calendars("google"),{code:"reconnect_required"});
 const g=readFixture({drive:false});await g.client.calendars("google");await assert.rejects(g.client.driveFiles("google"),{code:"drive_not_enabled"});
});
test("calendar selection and normalized Google/Outlook events keep the existing UI contract", async () => {
 const f=readFixture();for(const provider of ["google","outlook"]){
  await assert.rejects(f.client.events(provider,range),{code:"unknown_calendar"});
  const c=await f.client.calendars(provider);assert.equal(c.complete,true);assert.equal(c.calendars[0].title,"Calendar");
  const result=await f.client.events(provider,range);assert.equal(result.complete,true);assert.equal(result.events[0].start,event().start);
  assert.equal(validateCalendarEvents(result.events).length,result.events.length);
 }
 const outlook=f.calls.find(c=>c.path.endsWith("/calendarView"));assert.equal(outlook.headers.Prefer,'outlook.timezone="UTC"');
 assert.equal(outlook.params.$top,"250");assert.ok(!f.calls.some(c=>c.method!=="GET"));
});
test("pagination is reported as incomplete and untrusted next links are never followed", async () => {
 const f=readFixture({handler:()=>reply({items:[{id:calendarId,summary:"C"}],nextPageToken:"private-cursor"})});
 const result=await f.client.calendars("google");assert.equal(result.complete,false);assert.equal(result.truncated,true);assert.equal(f.calls.length,1);
});
test("Drive text only uses previously selected allowed files and bounded safe exports", async () => {
 const f=readFixture();await assert.rejects(f.client.driveText("google",{fileId:"arbitrary"}),{code:"unknown_file"});
 await f.client.driveFiles("google");const text=await f.client.driveText("google",{fileId:"plan-1"});assert.match(text.text,/Meeting/);assert.equal(text.warnings.length,1);
 assert.equal(f.calls.at(-1).service,"google-drive");assert.equal(f.calls.at(-1).params.mimeType,"text/csv");
 await assert.rejects(f.client.driveText("google",{fileId:"plan-1",url:"https://evil.invalid"}),{code:"invalid_request"});
});
test("connection identity changes invalidate previously listed calendars and files", async () => {
 const f=readFixture();await f.client.calendars("google");f.bindings["google-calendar"].connectionId="other-calendar-account";
 await assert.rejects(f.client.events("google",range),{code:"unknown_calendar"});
 await f.client.driveFiles("google");f.bindings["google-drive"].connectionId="other-drive-account";
 await assert.rejects(f.client.driveText("google",{fileId:"plan-1"}),{code:"unknown_file"});
});
test("same connection IDs with a new revision invalidate calendar and Drive selections", async () => {
 const f=readFixture();await f.client.calendars("google");
 f.bindings["google-calendar"].revision="2:0";
 await assert.rejects(f.client.events("google",range),{code:"unknown_calendar"});
 await f.client.calendars("google");await f.client.events("google",range);
 assert.equal(f.calls.at(-1).identity.revision,"2:0");
 await f.client.driveFiles("google");f.bindings["google-drive"].revision="1:1";
 await assert.rejects(f.client.driveText("google",{fileId:"plan-1"}),{code:"unknown_file"});
 await f.client.driveFiles("google");await f.client.driveText("google",{fileId:"plan-1"});
 assert.equal(f.calls.at(-1).identity.revision,"1:1");
});
test("a revision change during a response discards data even when IDs stay unchanged", async () => {
 const f=readFixture({handler:(_s,request,bindings)=>{
  assert.equal(request.identity.revision,"1:0");
  bindings["google-calendar"].revision="2:0";
  return reply({items:[{id:calendarId,summary:"Old account"}]});
 }});
 await assert.rejects(f.client.calendars("google"),{code:"cancelled"});
 assert.equal(f.calls.length,1);
});
test("missing or malformed connection revisions fail closed before the proxy", async () => {
 for(const revision of [undefined,null,1,"0","01:0","1:01","1:0\n","1:2:3","private-key"]){
  const f=readFixture();f.bindings["google-calendar"].revision=revision;
  await assert.rejects(f.client.calendars("google"),{code:"invalid_response"});
  assert.equal(f.calls.length,0);
 }
});
test("a connection change during a proxy response rejects stale data", async () => {
 const f=readFixture({handler:(_s,_r,bindings)=>{bindings["google-calendar"].connectionId="switched";return reply({items:[{id:calendarId,summary:"Old account"}]});}});
 await assert.rejects(f.client.calendars("google"),{code:"cancelled"});
});
test("malformed ranges and arbitrary targets never reach proxy", async () => {
 const f=readFixture();for(const value of [{...range,to:range.from},{...range,to:"2027-10-01T00:00:00Z"},{...range,url:"https://evil.invalid"}]) await assert.rejects(f.client.events("google",value));
 await assert.rejects(f.client.driveText("outlook",{fileId:"x"}),{code:"drive_not_enabled"});assert.equal(f.calls.length,0);
});
test("missing and non-boolean capabilities do not grant provider access", async () => {
 const f=readFixture();f.bindings["google-calendar"].capabilities.calendarRead="yes";
 await assert.rejects(f.client.calendars("google"),{code:"permission_denied"});assert.equal(f.calls.length,0);
});
test("provider failures and untrusted exception messages are sanitized", async () => {
 for(const status of [401,403,412,429,502]){
  const f=readFixture({handler:()=>reply({error:"private-token-providerbody"},status)});
  await assert.rejects(f.client.calendars("google"),error=>!error.message.includes("private")&&["reconnect_required","permission_denied","conflict","provider_limit","connection_failed"].includes(error.code));
 }
 const f=readFixture({handler:()=>{throw Error("private-token-providerbody");}});await assert.rejects(f.client.calendars("google"),error=>error.code==="connection_failed"&&!error.message.includes("private"));
});
test("oversized JSON/text and active HTML responses are rejected", async () => {
 const f=readFixture({handler:()=>reply({items:[],overflow:"x".repeat(2000001)})});await assert.rejects(f.client.calendars("google"),{code:"response_limit"});
 const g=readFixture();await g.client.driveFiles("google");g.nango.proxy=async()=>reply("x".repeat(256001),200,"text/plain");await assert.rejects(g.client.driveText("google",{fileId:"plan-1"}),{code:"response_limit"});
 g.nango.proxy=async()=>reply("<script>private</script>",200,"text/html");await assert.rejects(g.client.driveText("google",{fileId:"plan-1"}),{code:"invalid_response"});
});
test("pre-aborted reads never reach Nango proxy", async () => {
 const f=readFixture();const controller=new AbortController();controller.abort();await assert.rejects(f.client.calendars("google",controller.signal),{code:"cancelled"});assert.equal(f.calls.length,0);
});
test("existing native bridge can delegate request operations and cancellation to this adapter", async () => {
 const f=readFixture();const handle=createDesktopCalendar({providers:f.client});const status=await handle({action:"status",provider:"google"});assert.equal(status.connected,true);
 const result=await handle({action:"calendars",provider:"google",id:requestId});assert.equal(result.calendars.length,1);
});
test("Outlook sync is optional; Google writes remain unsupported", async () => {
 const f=outlookFixture({write:false});await f.ready();await assert.rejects(f.client.sync("outlook",batch()),{code:"sync_not_enabled"});
 await assert.rejects(f.client.sync("google",batch()),{code:"sync_not_enabled"});assert.equal(f.writes().length,0);
});
test("sync refuses shared/read-only or no-longer-owned calendars before writing", async () => {
 const f=outlookFixture({owns:false});await f.ready();await assert.rejects(f.client.sync("outlook",batch()),{code:"readonly_calendar"});assert.equal(f.writes().length,0);
 const g=outlookFixture();await g.ready();g.permissions.canShare=false;const r=await g.client.sync("outlook",batch());assert.equal(r.results[0].code,"readonly_calendar");assert.equal(g.writes().length,0);
});
test("invalid/readonly batches are validated before any publication", async () => {
 const f=outlookFixture();await f.ready();for(const value of [batch([{...event(),readonly:true}]),batch([event(),event()]),{...batch(),force:true},batch([{...event(),attendees:["private@example.org"]}])]) await assert.rejects(f.client.sync("outlook",value));
 assert.equal(f.writes().length,0);
});
test("same namespace/local IDs create once, skip unchanged and update with etag", async () => {
 const f=outlookFixture();await f.ready();const first=await f.client.sync("outlook",batch());assert.equal(first.results[0].status,"created");
 const same=await f.client.sync("outlook",batch());assert.equal(same.results[0].status,"unchanged");assert.equal(f.writes().length,1);
 const updated=await f.client.sync("outlook",batch([{...event(),title:"Changed title"}]));assert.equal(updated.results[0].status,"updated");
 assert.ok(f.writes()[1].options.headers["If-Match"]);assert.ok(!f.calls.some(c=>c.method==="DELETE"));assert.ok(!Object.hasOwn(f.writes()[0].body,"attendees"));
});
test("external changes and absent etags block mutation of existing own events", async () => {
 const f=outlookFixture();await f.ready();await f.client.sync("outlook",batch());const remote=[...f.remote.values()][0];remote.subject="External edit";
 const changed=await f.client.sync("outlook",batch([{...event(),title:"Local edit"}]));assert.equal(changed.results[0].status,"conflict");assert.equal(f.writes().length,1);
 const g=outlookFixture();await g.ready();await g.client.sync("outlook",batch());delete [...g.remote.values()][0]["@odata.etag"];
 const missing=await g.client.sync("outlook",batch([{...event(),title:"Local edit"}]));assert.equal(missing.results[0].status,"conflict");assert.equal(g.writes().length,1);
});
test("412 conditional-write failure is reported as conflict, never blindly retried", async () => {
 const f=outlookFixture({hooks:{before:call=>call.method==="PATCH"?reply({error:"private"},412):undefined}});await f.ready();await f.client.sync("outlook",batch());
 const r=await f.client.sync("outlook",batch([{...event(),title:"Changed"}]));assert.equal(r.results[0].status,"conflict");assert.equal(f.writes().length,2);
});
test("lost create replies reconcile the own marker before any further write", async () => {
 let lose=true;const f=outlookFixture({hooks:{afterWrite:()=>{if(lose){lose=false;throw Error("private unknown result");}}}});await f.ready();
 const first=await f.client.sync("outlook",batch());assert.equal(first.results[0].status,"unknown");assert.equal(f.remote.size,1);
 const retry=await f.client.sync("outlook",batch());assert.equal(retry.results[0].status,"unchanged");assert.equal(f.writes().length,1);
});
test("all-day own Outlook events retain Berlin dates across DST conversion", async () => {
 const f=outlookFixture();await f.ready();const day={...event(),allDay:true,start:"2026-10-25",end:"2026-10-26"};
 const first=await f.client.sync("outlook",batch([day]));assert.equal(first.results[0].status,"created");const same=await f.client.sync("outlook",batch([day]));assert.equal(same.results[0].status,"unchanged");
});
test("write capability/account changes invalidate cached writable selections", async () => {
 const f=outlookFixture();await f.ready();f.connection.capabilities.calendarWrite=false;await assert.rejects(f.client.sync("outlook",batch()),{code:"sync_not_enabled"});assert.equal(f.writes().length,0);
 const g=outlookFixture();await g.ready();g.connection.connectionId="another-account";await assert.rejects(g.client.sync("outlook",batch()),{code:"readonly_calendar"});assert.equal(g.writes().length,0);
});
test("new revisions revoke Outlook writable selections with unchanged connection IDs", async () => {
 const f=outlookFixture();await f.ready();f.connection.revision="2:0";
 await assert.rejects(f.client.sync("outlook",batch()),{code:"readonly_calendar"});
 assert.equal(f.writes().length,0);
});
test("revision switches after event lookup prevent a write into a rebound Outlook account", async () => {
 const f=outlookFixture({hooks:{before:call=>{
  if(call.method==="GET" && call.url.pathname.endsWith("/events")) f.connection.revision="1:1";
 }}});await f.ready();const result=await f.client.sync("outlook",batch());
 assert.equal(result.complete,false);assert.equal(result.cancelled,true);
 assert.equal(f.writes().length,0);assert.equal(f.remote.size,0);
});
test("connection switching after own-event lookup prevents publication into the new account", async () => {
 const f=outlookFixture({hooks:{before:call=>{
  if(call.method==="GET" && call.url.pathname.endsWith("/events")) f.connection.connectionId="switched-before-create";
 }}});await f.ready();const result=await f.client.sync("outlook",batch());
 assert.equal(result.complete,false);assert.equal(result.cancelled,true);assert.equal(f.writes().length,0);assert.equal(f.remote.size,0);
});
test("native cancellation aborts a pending Nango proxy read without clearing account state", async () => {
 const f=readFixture();let started;const pending=new Promise(resolve=>started=resolve);
 f.nango.proxy=async(_service,_request,signal)=>{started();return new Promise((_resolve,reject)=>signal.addEventListener("abort",()=>reject(Object.assign(Error("private"),{name:"AbortError"})),{once:true}));};
 const handle=createDesktopCalendar({providers:f.client});const read=handle({action:"calendars",provider:"google",id:requestId});await pending;
 await handle({action:"cancel",id:requestId});await assert.rejects(read,{code:"cancelled"});assert.equal((await f.client.status("google")).connected,true);
});
