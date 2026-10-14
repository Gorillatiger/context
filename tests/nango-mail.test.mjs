import test from 'node:test';
import assert from 'node:assert/strict';
import {createNangoMailClient} from '../connectors/nango-mail.mjs';

const binding = {connected:true, integrationId:'qa-integration', connectionId:'qa-local-connection', revision:'1:0', capabilities:{mailRead:true, mailModify:false, mailSend:false}};
const json = (data, status = 200) => ({status, headers:{'content-type':'application/json'}, data});
const b64 = value => Buffer.from(value).toString('base64url');
const delay = () => { let resolve, reject; const promise = new Promise((yes,no) => {resolve=yes; reject=no;}); return {promise,resolve,reject}; };
const tick = async () => { for (let i=0;i<50;i++) await Promise.resolve(); };
const draft = (extra = {}) => ({to:['recipient@example.test'], cc:[], bcc:[], subject:'Synthetic subject', text:'Local test only.', attachments:[], ...extra});
function fixture(service, handler, initial = binding) {
  let state = structuredClone(initial); const calls = [], disconnected = [];
  let profile = service === 'gmail' ? {emailAddress:'qa@example.test', messagesTotal:23} : {id:'account-opaque', mail:'qa@example.test'};
  const nango = {
    status:async selected => {assert.equal(selected, service); return structuredClone(state);},
    proxy:async (selected, request, signal) => {
      assert.equal(selected, service); assert.ok(signal instanceof AbortSignal);
      assert.equal(request.identity?.revision, state.revision);
      calls.push({service:selected, request:structuredClone(request), signal});
      if (request.path === '/gmail/v1/users/me/profile' || request.path === '/v1.0/me') return typeof profile === 'function' ? profile(request, signal) : json(structuredClone(profile));
      return handler(request, signal);
    },
    disconnect:async selected => {disconnected.push(selected); state = {...state, connected:false};},
  };
  const client = createNangoMailClient({nango, service});
  return {client, nango, calls, disconnected, setState:value => {state = structuredClone(value);}, setProfile:value => {profile=value;}, getState:() => structuredClone(state), target:async (uid='opaque-msg', folder='INBOX') => ({folder, uid, uidValidity:(await client.status()).uidValidity})};
}
function gmailMessage(extra = {}) {
  return {id:'opaque-msg', labelIds:['INBOX','UNREAD'], internalDate:'1791878400000', sizeEstimate:300,
    payload:{mimeType:'text/plain', headers:[
      {name:'Subject',value:'=?UTF-8?B?R3LDvMOfZQ==?='}, {name:'From',value:'"Doe, Jane" <jane@example.test>'},
      {name:'To',value:'QA <qa@example.test>'}, {name:'Cc',value:'Copy <copy@example.test>'},
      {name:'Reply-To',value:'Support <support@example.test>'}, {name:'Message-ID',value:'<opaque-original@example.test>'},
      {name:'Date',value:'Mon, 12 Oct 2026 10:00:00 +0200'},
    ], body:{size:14,data:b64('Plain message.')}}, ...extra};
}
function graphMessage(extra = {}) {
  return {id:'opaque-msg', subject:'Graph subject', from:{emailAddress:{name:'Jane',address:'jane@example.test'}},
    toRecipients:[{emailAddress:{address:'qa@example.test'}}], ccRecipients:[{emailAddress:{address:'copy@example.test'}}],
    replyTo:[{emailAddress:{name:'Support',address:'support@example.test'}}], receivedDateTime:'2026-10-12T10:00:00+02:00',
    internetMessageId:'<graph-original@example.test>', isRead:false, body:{contentType:'text',content:'Graph message.'}, hasAttachments:false, ...extra};
}
const errorCode = code => error => {assert.equal(error.code, code); assert.ok(!error.message.includes('SECRET')); return true;};
const reviewed = async (f, requestId, value = draft()) => ({requestId, draft:value, accountKey:(await f.client.status()).accountKey});

test('unbound/read-disabled connections never fetch private profile or messages', async () => {
  for (const state of [{...binding,connected:false}, {...binding,capabilities:{mailRead:'true',mailSend:true}}]) {
    const f = fixture('gmail', () => assert.fail('provider must not be called'), state);
    const status = await f.client.status(); assert.equal(status.configured,false); assert.equal(status.address,''); assert.equal(status.smtpReady,false);
    await assert.rejects(f.client.folders(), errorCode(state.connected ? 'permission_denied' : 'not_configured'));
    assert.equal(f.calls.length,0);
  }
});

test('profile normalizes status and only boolean mailSend grants sending', async () => {
  const f = fixture('outlook', () => assert.fail('unexpected'), {...binding,capabilities:{mailRead:true,mailSend:'yes'}});
  const status = await f.client.status(); assert.equal(status.address,'qa@example.test'); assert.equal(status.storage,'nango'); assert.equal(status.smtpReady,false); assert.match(status.uidValidity,/^[a-f0-9]{64}$/);
  await f.client.status(); assert.equal(f.calls.length,4,'status refreshes the provider profile instead of retaining a stale sender');
  f.setState({...binding,connectionId:'another-connection',capabilities:{mailRead:true,mailSend:true}});
  const changed = await f.client.status(); assert.notEqual(changed.uidValidity,status.uidValidity); assert.equal(changed.smtpReady,true); assert.equal(f.calls.length,6);
});

test('disconnect removes only the selected local binding; no provider delete/revoke request', async () => {
  const f = fixture('gmail', () => assert.fail('no provider mutation')); await f.client.status();
  const result = await f.client.configure({disconnect:true}); assert.equal(result.connected,false); assert.deepEqual(f.disconnected,['gmail']);
  assert.ok(f.calls.every(call => call.request.method === 'GET'));
  assert.throws(() => f.client.configure({disconnect:true,user:'SECRET'}), errorCode('invalid_request'));
});

test('Gmail labels preserve opaque IDs and expose inbox/sent/custom folders', async () => {
  const f = fixture('gmail', request => {assert.equal(request.path,'/gmail/v1/users/me/labels'); return json({labels:[{id:'Label_opaque',name:'Project / Course'},{id:'UNREAD',name:'UNREAD'},{id:'SENT',name:'Sent'},{id:'INBOX',name:'Inbox'}]});});
  assert.deepEqual((await f.client.folders()).folders,[{id:'INBOX',label:'Inbox',kind:'inbox'},{id:'Label_opaque',label:'Project / Course',kind:'folder'},{id:'SENT',label:'Sent',kind:'sent'}]);
});

test('Outlook enumerates nested/paginated folders and resolves localized inbox by stable alias', async () => {
  const f = fixture('outlook', request => {
    if (/\/mailFolders\/(inbox|sentitems|drafts|deleteditems|junkemail)$/.test(request.path)) return request.path.endsWith('/inbox') ? json({id:'localized-inbox=='}) : json({},404);
    if (request.path.endsWith('/parent-folder/childFolders')) return json({value:[{id:'child-opaque==',displayName:'Kurs',childFolderCount:0}]});
    assert.equal(request.path,'/v1.0/me/mailFolders');
    return request.params.$skiptoken ? json({value:[{id:'parent-folder',displayName:'Projekte',childFolderCount:1}]}) : json({value:[{id:'localized-inbox==',displayName:'Posteingang',childFolderCount:0}], '@odata.nextLink':'https://graph.microsoft.com/v1.0/me/mailFolders?$skiptoken=provider-marker'});
  });
  const result = await f.client.folders(); assert.deepEqual(result.folders,[{id:'localized-inbox==',label:'Posteingang',kind:'inbox'},{id:'parent-folder',label:'Projekte',kind:'folder'},{id:'child-opaque==',label:'Projekte / Kurs',kind:'folder'}]);
  assert.ok(f.calls.every(call => call.request.method === 'GET'));
});

test('Gmail lists metadata only, preserves envelope fields and forwards opaque pagination markers', async () => {
  const marker = 'opaque:page%+token==';
  const f = fixture('gmail', request => {
    if (request.path.endsWith('/messages/opaque-msg')) {assert.equal(request.params.format,'metadata'); return json(gmailMessage());}
    assert.equal(request.path,'/gmail/v1/users/me/messages'); assert.deepEqual(request.params.labelIds,['INBOX']);
    if (request.params.pageToken) {assert.equal(request.params.pageToken,marker); return json({messages:[],resultSizeEstimate:1});}
    assert.equal(request.params.q,'"Course" is:unread'); return json({messages:[{id:'opaque-msg'}],nextPageToken:marker,resultSizeEstimate:1});
  });
  const first = await f.client.list({folder:'INBOX',query:'Course',unread:true});
  assert.equal(first.items[0].subject,'Grüße'); assert.deepEqual(first.items[0].from,[{name:'Doe, Jane',address:'jane@example.test'}]);
  assert.equal(first.items[0].replyTo[0].address,'support@example.test'); assert.equal(first.items[0].messageId,'<opaque-original@example.test>'); assert.equal(first.items[0].date,'2026-10-13T08:00:00.000Z');
  assert.equal(first.items[0].unread,true); assert.equal(first.items[0].text,undefined); assert.equal(first.nextOffset,40); assert.equal(first.estimated,true);
  const second = await f.client.list({folder:'INBOX',query:'Course',unread:true,offset:first.nextOffset}); assert.equal(second.nextOffset,null);
  await assert.rejects(f.client.list({folder:'INBOX',offset:40}),errorCode('invalid_request'));
  assert.ok(f.calls.every(call => call.request.method === 'GET'));
});

test('Gmail bounds parallel metadata reads and keeps provider order when slow reads finish out of order', async () => {
  const gates = Array.from({length:8}, () => delay()), started = [];
  let inFlight = 0, maximum = 0;
  const f = fixture('gmail', async request => {
    if (request.path.endsWith('/messages')) return json({messages:gates.map((_,index) => ({id:'msg-' + index})),resultSizeEstimate:8});
    const index = Number(request.path.split('/').at(-1).slice(4));
    assert.equal(request.params.format,'metadata'); started.push(index); maximum = Math.max(maximum,++inFlight);
    try { await gates[index].promise; return json(gmailMessage({id:'msg-' + index,labelIds:index === 2 ? ['SENT'] : ['INBOX']})); }
    finally { inFlight--; }
  });
  const reading = f.client.list({folder:'INBOX'});
  try {
    await tick(); assert.ok(started.length > 1,'a slow first message must not serialize the entire page'); assert.ok(started.length <= 4);
    for (const index of [3,2,1,0]) { gates[index].resolve(); await tick(); }
    for (const index of [7,6,5,4]) { gates[index].resolve(); await tick(); }
    const result = await reading;
    assert.deepEqual(result.items.map(item => item.uid),[0,1,3,4,5,6,7].map(index => 'msg-' + index));
    assert.ok(maximum > 1 && maximum <= 4); assert.equal(started.length,8);
  } finally { for (const gate of gates) gate.resolve(); await reading.catch(() => {}); }
});

test('Gmail stops queued metadata batches when a connection is replaced', async () => {
  const gates = Array.from({length:8}, () => delay()), started = [];
  const f = fixture('gmail', async request => {
    if (request.path.endsWith('/messages')) return json({messages:gates.map((_,index) => ({id:'msg-' + index}))});
    const index = Number(request.path.split('/').at(-1).slice(4)); started.push(index);
    await gates[index].promise; return json(gmailMessage({id:'msg-' + index}));
  });
  const reading = f.client.list({folder:'INBOX'}), rejected = assert.rejects(reading,errorCode('cancelled'));
  await tick(); f.setState({...binding,connectionId:'replacement-user'}); await f.client.status();
  for (const gate of gates) gate.resolve(); await rejected;
  assert.ok(started.length > 1 && started.length <= 4,'replacement must prevent the next batch from reading private metadata');
});

test('Outlook follows the exact nextLink skip instead of recomputing provider offsets', async () => {
  const path = '/v1.0/me/mailFolders/folder%2B%2F%3D/messages';
  const f = fixture('outlook', request => {
    assert.equal(request.path,path); assert.match(request.headers.Prefer,/ImmutableId/); assert.match(request.headers.Prefer,/body-content-type="text"/);
    if (request.params.$skip) {assert.equal(request.params.$skip,'73'); return json({value:[], '@odata.count':2});}
    assert.equal(request.params.$top,40); return json({value:[graphMessage()], '@odata.count':2, '@odata.nextLink':'https://graph.microsoft.com' + path + '?$skip=73&$top=40'});
  });
  const first = await f.client.list({folder:'folder+/='}); assert.equal(first.items[0].uid,'opaque-msg'); assert.equal(first.items[0].date,'2026-10-12T08:00:00.000Z');
  await f.client.list({folder:'folder+/=',offset:first.nextOffset});
});

test('provider continuation cannot escape the chosen folder, host or parameter allowlist', async () => {
  for (const next of ['https://attacker.example/v1.0/me/messages?$skip=2','https://graph.microsoft.com/v1.0/me/messages?$skip=2','https://graph.microsoft.com/v1.0/me/mailFolders/INBOX/messages?access_token=SECRET']) {
    const f = fixture('outlook', () => json({value:[], '@odata.nextLink':next}));
    await assert.rejects(f.client.list({folder:'INBOX'}),errorCode('invalid_response')); assert.equal(f.calls.filter(call=>call.request.path.endsWith('/messages')).length,1);
  }
});

test('message reads use GET, preserve unread status, and never invoke modify/PATCH', async () => {
  for (const service of ['gmail','outlook']) {
    const f = fixture(service, request => request.path.endsWith('/attachments') ? json({value:[]}) : json(service === 'gmail' ? gmailMessage() : graphMessage()));
    const selected = await f.target(); const result = await f.client.message(selected);
    assert.equal(result.uid,'opaque-msg'); assert.equal(result.uidValidity,selected.uidValidity); assert.equal(result.replyTo[0].address,'support@example.test');
    assert.equal(result.text,service === 'gmail' ? 'Plain message.' : 'Graph message.'); assert.equal(result.convertedHTML,false);
    assert.ok(f.calls.every(call => call.request.method === 'GET')); assert.ok(f.calls.every(call => !call.request.path.endsWith('/modify')));
  }
});

test('encoded display names cannot inject additional reply recipients through decoded commas',async()=>{
  const base=gmailMessage(),name='name@example.test, Doe, Jane';
  base.payload.headers.find(field=>field.name==='From').value=`=?UTF-8?B?${Buffer.from(name).toString('base64')}?= <actual@example.test>`;
  base.payload.headers.find(field=>field.name==='Reply-To').value=`=?UTF-8?Q?Other=2C_Name?= <reply@example.test>`;
  const f=fixture('gmail',()=>json(base)),view=await f.client.message(await f.target());
  assert.deepEqual(view.from,[{name,address:'actual@example.test'}]);assert.deepEqual(view.replyTo,[{name:'Other, Name',address:'reply@example.test'}]);
});

test('malformed address tails and unclosed comments are parsed in bounded space without invented recipients',async()=>{
  const base=gmailMessage();
  base.payload.headers.find(field=>field.name==='From').value='Name <actual@example.test>'+' '.repeat(30000)+'invalid-tail';
  base.payload.headers.find(field=>field.name==='Reply-To').value='reply@example.test'+ '('.repeat(15000)+'name@example.test';
  const f=fixture('gmail',()=>json(base)),view=await f.client.message(await f.target());
  assert.deepEqual(view.from,[]);assert.deepEqual(view.replyTo,[{name:'',address:'reply@example.test'}]);
});

test('multipart alternative chooses plain text, keeps distinct sections, and excludes attachment text', async () => {
  const base = gmailMessage(); base.payload = {...base.payload,mimeType:'multipart/mixed',body:{},parts:[
    {mimeType:'multipart/alternative',parts:[{mimeType:'text/html',body:{data:b64('<p>HTML duplicate</p>')}},{mimeType:'text/plain',body:{data:b64('Plain alternative')}}]},
    {mimeType:'text/plain',body:{data:b64('Second section')}},
    {mimeType:'text/plain',filename:'private.txt',body:{attachmentId:'attachment-opaque',size:99}},
  ]};
  const f = fixture('gmail', () => json(base)); const result = await f.client.message(await f.target());
  assert.equal(result.text,'Plain alternative\n\nSecond section'); assert.equal(result.convertedHTML,false);
  assert.deepEqual(result.attachments,[{part:'attachment-opaque',name:'private.txt',size:99,type:'text/plain'}]);
  assert.ok(!f.calls.some(call => call.request.path.includes('/attachments/')),'attachment bytes are fetched only on request');
});

test('HTML-only bodies become inert text without scripts/styles, URLs, images or remote fetches', async () => {
  const source = '<html><head><style>SECRET style</style></head><body><p>Hello &amp; Grü&#223;e</p><script>SECRET script; fetch("https://example.test")</script><iframe>SECRET frame</iframe><svg>SECRET SVG</svg><a href="javascript:SECRET">Link</a><img src="https://example.test/SECRET"><p>&lt;b&gt;literal&lt;/b&gt;</p><!-- SECRET comment --></body></html>';
  for (const service of ['gmail','outlook']) {
    const base = service === 'gmail' ? gmailMessage({payload:{headers:gmailMessage().payload.headers,mimeType:'text/html',body:{data:b64(source)}}}) : graphMessage({body:{contentType:'html',content:source}});
    const f = fixture(service, request => request.path.endsWith('/attachments') ? json({value:[]}) : json(base));
    const result = await f.client.message(await f.target()); assert.equal(result.convertedHTML,true); assert.ok(result.text.includes('Hello & Grüße')); assert.ok(result.text.includes('<b>literal</b>')); assert.ok(result.text.includes('Link')); assert.ok(!result.text.includes('SECRET')); assert.ok(!result.text.includes('https://'));
    assert.ok(f.calls.every(call => !call.request.path.startsWith('http')));
  }
});

test('malformed HTML and repeated unmatched hidden tags stay bounded and cannot expose script text',async()=>{
  for(const source of ['<'.repeat(1000000),'<script>'.repeat(30000)+'</style>'.repeat(30000)+'SECRET hidden content']){
    const f=fixture('gmail',()=>json(gmailMessage({payload:{headers:gmailMessage().payload.headers,mimeType:'text/html',body:{data:b64(source)}}})));
    const result=await f.client.message(await f.target());assert.equal(result.convertedHTML,true);assert.equal(result.text,'');
  }
});

test('body charset decoding and text limits are independent of malicious date/header content', async () => {
  const base = gmailMessage({internalDate:'not-a-date'});
  base.payload.headers.find(field => field.name === 'Date').value = 'SECRET invalid date';
  base.payload.headers.push({name:'Content-Type',value:'text/plain; charset=iso-8859-1'});
  base.payload.body.data = Buffer.from([0x47,0x72,0xfc,0xdf,0x65]).toString('base64url');
  const f = fixture('gmail', () => json(base)); const result = await f.client.message(await f.target()); assert.equal(result.text,'Grüße'); assert.equal(result.date,'');
  for (const service of ['gmail','outlook']) {
    const text = 'x'.repeat(210000);
    const long = service === 'gmail' ? gmailMessage({payload:{...gmailMessage().payload,mimeType:'text/html',body:{data:b64('<p>' + text + '</p>')}}}) : graphMessage({body:{contentType:'html',content:'<p>' + text + '</p>'}});
    const g = fixture(service, request => request.path.endsWith('/attachments') ? json({value:[]}) : json(long));
    const cut = await g.client.message(await g.target()); assert.equal(cut.text.length,200000); assert.equal(cut.truncated,true);
  }
});

test('MIME traversal is bounded and attached multipart messages do not leak their inner content', async () => {
  const base = gmailMessage();
  base.payload = {...base.payload,mimeType:'multipart/mixed',body:{},parts:[{mimeType:'message/rfc822',filename:'forwarded.eml',body:{attachmentId:'forwarded-file',size:30},parts:[{mimeType:'text/plain',body:{data:b64('SECRET attachment')}}]}, ...Array.from({length:210},(_,index) => ({mimeType:'text/plain',body:{data:b64('section-' + index)}}))]};
  const f = fixture('gmail', () => json(base)); const result = await f.client.message(await f.target()); assert.equal(result.partsLimited,true); assert.ok(!result.text.includes('SECRET')); assert.equal(result.attachments[0].name,'forwarded.eml'); assert.ok(result.text.includes('section-0')); assert.ok(!result.text.includes('section-209'));
});

test('Outlook includes inline attachment metadata even when hasAttachments is false', async () => {
  const f = fixture('outlook', request => request.path.endsWith('/attachments') ? json({value:[{id:'inline-file=',name:'photo.png',size:20,contentType:'image/png',isInline:true,'@odata.type':'#microsoft.graph.fileAttachment'},{id:'outlook-item',name:'Event','@odata.type':'#microsoft.graph.itemAttachment'}]}) : json(graphMessage()));
  const result = await f.client.message(await f.target()); assert.equal(result.partsLimited,true); assert.deepEqual(result.attachments,[{part:'inline-file=',name:'photo.png',size:20,type:'image/png'}]);
  const call = f.calls.find(call => call.request.path.endsWith('/attachments')); assert.ok(!call.request.params.$select.includes('contentBytes'));
});

test('Gmail attachment download verifies membership/part then canonicalizes base64url and filenames', async () => {
  const base = gmailMessage(); base.payload.parts = [{mimeType:'application/pdf',filename:'../report.pdf',body:{size:4,attachmentId:'file-opaque'}}]; base.payload.mimeType = 'multipart/mixed'; base.payload.body = {};
  const f = fixture('gmail', request => request.path.endsWith('/attachments/file-opaque') ? json({size:4,data:b64('file')}) : json(base));
  const selected = await f.target(); const file = await f.client.attachment({...selected,part:'file-opaque'}); assert.deepEqual(file,{name:'report.pdf',data:Buffer.from('file').toString('base64')});
  const before = f.calls.length; await assert.rejects(f.client.attachment({...selected,part:'foreign-file'}),errorCode('message_unavailable')); assert.ok(!f.calls.slice(before).some(call => call.request.path.endsWith('/foreign-file')));
});

test('inline Gmail attachments use adapter part paths and never become body content', async () => {
  const base = gmailMessage(); base.payload = {...base.payload,mimeType:'multipart/mixed',body:{},parts:[{mimeType:'text/plain',body:{data:b64('body')}},{mimeType:'text/plain',filename:'file.txt',body:{size:3,data:b64('abc')}}]};
  const f = fixture('gmail', () => json(base)); const selected = await f.target();
  const view = await f.client.message(selected); assert.equal(view.text,'body'); assert.equal(view.attachments[0].part,'inline:0.1');
  assert.deepEqual(await f.client.attachment({...selected,part:view.attachments[0].part}),{name:'file.txt',data:'YWJj'});
});

test('attachment limits and malformed encoding fail before returning bytes', async () => {
  for (const value of [{size:8*1024*1024+1,contentBytes:'YQ=='},{size:1,contentBytes:'not valid SECRET'},{size:1,contentBytes:'Zh=='}]) {
    const f = fixture('outlook', () => json({'@odata.type':'#microsoft.graph.fileAttachment',id:'file-opaque',name:'file.txt',...value}));
    const selected = await f.target(); await assert.rejects(f.client.attachment({...selected,part:'file-opaque'}),errorCode(value.size > 8*1024*1024 ? 'attachment_too_large' : 'invalid_response'));
  }
  const base = gmailMessage({sizeEstimate:12*1024*1024+1}); const f = fixture('gmail', () => json(base)); await assert.rejects(f.client.message(await f.target()),errorCode('message_too_large'));
});

test('explicit marking requires mailModify and uses only documented mutations', async () => {
  for (const service of ['gmail','outlook']) {
    const f = fixture(service, request => json(service === 'gmail' ? gmailMessage() : graphMessage())); const selected = await f.target();
    await assert.rejects(f.client.flag({...selected,unread:false}),errorCode('permission_denied')); assert.ok(f.calls.every(call => call.request.method === 'GET'));
    f.setState({...binding,capabilities:{mailRead:true,mailModify:true}});
    await f.client.flag({...selected,unread:false}); const mutation = f.calls.find(call => call.request.method !== 'GET').request;
    if (service === 'gmail') {assert.equal(mutation.method,'POST'); assert.equal(mutation.path,'/gmail/v1/users/me/messages/opaque-msg/modify'); assert.deepEqual(mutation.body,{addLabelIds:[],removeLabelIds:['UNREAD']});}
    else {assert.equal(mutation.method,'PATCH'); assert.equal(mutation.path,'/v1.0/me/mailFolders/INBOX/messages/opaque-msg'); assert.deepEqual(mutation.body,{isRead:true});}
  }
});

test('messages moved out of a Gmail folder cannot be opened, downloaded or marked from stale targets', async () => {
  const f = fixture('gmail', () => json(gmailMessage({labelIds:['SENT']})), {...binding,capabilities:{mailRead:true,mailModify:true}}); const selected = await f.target();
  for (const operation of [() => f.client.message(selected),() => f.client.attachment({...selected,part:'foreign-file'}),() => f.client.flag({...selected,unread:false})]) await assert.rejects(operation(),errorCode('message_unavailable'));
  assert.ok(f.calls.every(call => call.request.method === 'GET'));
});

test('binding changes reject old targets and discard in-flight private provider responses', async () => {
  const pending = delay(), f = fixture('gmail', () => pending.promise); const selected = await f.target();
  const reading = f.client.message(selected); const rejected = assert.rejects(reading,errorCode('cancelled')); await tick();
  f.setState({...binding,connectionId:'another-user'}); await f.client.status(); pending.resolve(json(gmailMessage())); await rejected;
  assert.equal(f.calls.find(call => call.request.path.endsWith('/opaque-msg')).signal.aborted,true);
  await assert.rejects(f.client.message(selected),errorCode('mailbox_changed'));
});

test('IDs are opaque but controls, traversal and target validity injection are rejected', async () => {
  const f = fixture('gmail', () => assert.fail('invalid input reached provider')); const selected = await f.target();
  for (const fields of [{uid:'../message'},{uid:'..'},{folder:'INBOX\n'},{uid:'id%2Fsecret'},{uidValidity:'123'},{uidValidity:selected.uidValidity+'\n'}]) {
    await assert.rejects(f.client.message({...selected,...fields}),errorCode('invalid_request'));
  }
  await assert.rejects(f.client.attachment({...selected,part:'inline:0\n'}),errorCode('invalid_request'));
});

test('mailSend is an independent explicit gate; malformed drafts never reach a provider', async () => {
  for (const capabilities of [{mailRead:true,mailSend:false},{mailRead:true,mailSend:'true'},{mailRead:true,mailModify:true}]) {
    const f = fixture('gmail', () => assert.fail('send must not happen'), {...binding,capabilities});
    await assert.rejects(f.client.send(await reviewed(f,'blocked-send-request')),errorCode('permission_denied')); assert.ok(f.calls.every(call => call.request.method === 'GET'));
  }
  const f = fixture('gmail', () => assert.fail('bad draft reached provider'), {...binding,capabilities:{mailRead:true,mailSend:true}});
  for (const change of [{subject:'x\r\nBcc: SECRET'},{to:['recipient@example.test\n']},{inReplyTo:'<id>\r\nSECRET'},{attachments:[{name:'../SECRET',data:'YQ=='}]}]) await assert.rejects(f.client.send(await reviewed(f,'invalid-send-request',draft(change))),errorCode('invalid_request'));
  assert.ok(f.calls.every(call => call.request.method === 'GET'));
});

test('Gmail send serializes reviewed text as bounded MIME, protects headers, and preserves reply context/files', async () => {
  let payload;
  const f = fixture('gmail', request => {assert.equal(request.method,'POST'); assert.equal(request.path,'/gmail/v1/users/me/messages/send'); payload = Buffer.from(request.body.raw,'base64url').toString('utf8'); return json({id:'sent-provider-id',labelIds:['SENT']});}, {...binding,capabilities:{mailRead:true,mailSend:true}});
  const result = await f.client.send(await reviewed(f,'gmail-review-request',draft({subject:'Grüße',cc:['cc@example.test'],bcc:['bcc@example.test'],inReplyTo:'<original@example.test>',attachments:[{name:'Bericht ä.txt',data:'YWJj'}]})));
  assert.match(payload,/From: qa@example\.test/); assert.match(payload,/Cc: cc@example\.test/); assert.match(payload,/Bcc: bcc@example\.test/); assert.match(payload,/In-Reply-To: <original@example\.test>/); assert.match(payload,/References: <original@example\.test>/); assert.match(payload,/Subject: =\?UTF-8\?B\?/); assert.match(payload,/filename\*=UTF-8''Bericht%20%C3%A4.txt/); assert.match(payload,/\r\n\r\nYWJj/);
  assert.equal(result.accepted,3); assert.equal(result.providerMessageId,'sent-provider-id'); assert.equal(result.deliveryConfirmed,false); assert.equal(result.sentCopySaved,true);
});

test('Outlook JSON send accepts only 202 without claiming delivery or a saved Sent copy', async () => {
  const f = fixture('outlook', request => {assert.equal(request.method,'POST'); assert.equal(request.path,'/v1.0/me/sendMail'); assert.equal(request.body.message.body.contentType,'Text'); assert.equal(request.body.message.body.content,'Local test only.'); assert.equal(request.body.saveToSentItems,true); assert.equal(request.body.message.attachments[0].contentBytes,'YWJj'); return json(null,202);}, {...binding,capabilities:{mailRead:true,mailSend:true}});
  const result = await f.client.send(await reviewed(f,'outlook-reviewed-send',draft({attachments:[{name:'file.txt',data:'YWJj'}]})));
  assert.equal(result.providerAccepted,true); assert.equal(result.deliveryConfirmed,false); assert.equal(result.sentCopySaved,false); assert.equal(result.sentCopyRequested,true);
});

test('Outlook replies use its documented MIME mode with In-Reply-To rather than invalid custom headers', async () => {
  const f = fixture('outlook', request => {assert.equal(request.headers['Content-Type'],'text/plain'); assert.equal(typeof request.body,'string'); const source = Buffer.from(request.body,'base64').toString('utf8'); assert.match(source,/In-Reply-To: <original@example\.test>/); assert.match(source,/Content-Type: text\/plain; charset=UTF-8/); return json(null,202);}, {...binding,capabilities:{mailRead:true,mailSend:true}});
  await f.client.send(await reviewed(f,'outlook-reply-reviewed',draft({inReplyTo:'<original@example.test>'})));
});

test('long UTF-8 filenames are folded as MIME continuations rather than oversized header lines',async()=>{
  const f=fixture('gmail',request=>{
    const source=Buffer.from(request.body.raw,'base64url').toString('utf8');
    assert.match(source,/filename\*0\*=UTF-8''/);assert.match(source,/\r\n filename\*1\*=/);assert.match(source,/\r\nDate: /);
    assert.ok(source.split('\r\n').every(line=>Buffer.byteLength(line)<998));return json({id:'accepted-utf8-file'});
  },{...binding,capabilities:{mailRead:true,mailSend:true}});
  await f.client.send(await reviewed(f,'utf8-filename-review',draft({attachments:[{name:'ä'.repeat(176)+'.txt',data:'YWJj'}]})));
});

test('Outlook attachment restrictions reject large reviewed payloads before POST', async () => {
  for (const attachments of [[{name:'large.bin',data:Buffer.alloc(3*1024*1024).toString('base64')}], Array.from({length:2},(_,index) => ({name:`large-${index}.bin`,data:Buffer.alloc(2*1024*1024).toString('base64')}))]) {
    const f = fixture('outlook', () => assert.fail('large payload sent'), {...binding,capabilities:{mailRead:true,mailSend:true}});
    await assert.rejects(f.client.send(await reviewed(f,'large-reviewed-request',draft({attachments}))),errorCode('attachment_too_large')); assert.ok(f.calls.every(call => call.request.method === 'GET'));
  }
});

test('concurrent identical reviewed sends share one request; changed drafts cannot reuse an ID', async () => {
  const pending = delay(), f = fixture('gmail', () => pending.promise, {...binding,capabilities:{mailRead:true,mailSend:true}});
  const data = await reviewed(f,'one-reviewed-request'); const first = f.client.send(data), second = f.client.send(structuredClone(data));
  await tick(); await tick(); assert.equal(f.calls.filter(call => call.request.method === 'POST').length,1);
  pending.resolve(json({id:'accepted-provider-id'})); assert.deepEqual(await first,await second);
  await assert.rejects(f.client.send({...data,draft:draft({text:'Changed after review'})}),errorCode('invalid_request'));
  await f.client.send(data); assert.equal(f.calls.filter(call => call.request.method === 'POST').length,1);
});

test('a reviewed sender identity is required and cannot silently follow a replacement account', async () => {
  const f = fixture('gmail', () => assert.fail('old review must not send'), {...binding,capabilities:{mailRead:true,mailSend:true}});
  await assert.rejects(f.client.send({requestId:'missing-account-review',draft:draft()}),errorCode('invalid_request'));
  const data = await reviewed(f,'account-pinned-review');
  f.setState({...binding,connectionId:'replacement-account',capabilities:{mailRead:true,mailSend:true}});
  await assert.rejects(f.client.send(data),errorCode('mailbox_changed'));
  const replacement = await reviewed(f,data.requestId);
  await assert.rejects(f.client.send(replacement),errorCode('invalid_request'));
  assert.ok(f.calls.every(call => call.request.method === 'GET'));
});

test('missing or malformed core revisions fail closed before any provider profile request',async()=>{
  for(const revision of [undefined,0,'1','1:0\n','x:0','1:'+'0'.repeat(21)]){
    const f=fixture('gmail',()=>assert.fail('invalid revision reached provider'),{...binding,revision});
    await assert.rejects(f.client.status(),errorCode('invalid_response'));assert.equal(f.calls.length,0);
  }
});

test('same-ID local reconfiguration changes mailbox/review identity and pins the exact proxy revision',async()=>{
  for(const service of ['gmail','outlook']){
    const f=fixture(service,()=>assert.fail('stale review must not POST'),{...binding,capabilities:{mailRead:true,mailSend:true}});
    const before=await f.client.status(),data={requestId:'same-ids-new-config',draft:draft(),accountKey:before.accountKey};
    f.setState({...f.getState(),revision:'2:3'});
    const after=await f.client.status();assert.equal(after.revision,'2:3');assert.notEqual(after.uidValidity,before.uidValidity);assert.notEqual(after.accountKey,before.accountKey);
    await assert.rejects(f.client.send(data),errorCode('mailbox_changed'));assert.ok(f.calls.every(call=>call.request.method==='GET'));
    assert.equal(f.calls.at(-1).request.identity.revision,'2:3');
  }
});

test('remote OAuth account replacement under unchanged IDs/revision refreshes status and rejects the old reviewed sender',async()=>{
  for(const service of ['gmail','outlook']){
    const f=fixture(service,()=>assert.fail('replacement must not receive an old send'),{...binding,capabilities:{mailRead:true,mailSend:true}});
    const before=await f.client.status(),data={requestId:'remote-profile-review',draft:draft(),accountKey:before.accountKey};
    f.setProfile(service==='gmail'?{emailAddress:'replacement@example.test'}:{id:'replacement-profile',mail:'replacement@example.test'});
    await assert.rejects(f.client.send(data),errorCode('mailbox_changed'));
    const after=await f.client.status();assert.equal(after.address,'replacement@example.test');assert.notEqual(after.accountKey,before.accountKey);assert.notEqual(after.uidValidity,before.uidValidity);
    assert.equal(after.revision,before.revision);assert.ok(f.calls.every(call=>call.request.method==='GET'));
    await assert.rejects(f.client.message({folder:'INBOX',uid:'same-provider-id',uidValidity:before.uidValidity}),errorCode('mailbox_changed'));
  }
});

test('Outlook profile ID and displayed sender address both participate in review identity',async()=>{
  for(const profile of [{id:'other-account',mail:'qa@example.test'},{id:'account-opaque',mail:'other@example.test'}]){
    const f=fixture('outlook',()=>assert.fail('changed profile must not POST'),{...binding,capabilities:{mailRead:true,mailSend:true}}),data=await reviewed(f,'profile-id-or-address');
    f.setProfile(profile);await assert.rejects(f.client.send(data),errorCode('mailbox_changed'));assert.ok(f.calls.every(call=>call.request.method==='GET'));
  }
});

test('same-ID remote profile change invalidates opaque page markers instead of forwarding them to the replacement account',async()=>{
  const f=fixture('gmail',request=>{
    if(request.path.endsWith('/messages/opaque-msg'))return json(gmailMessage());
    if(request.path.endsWith('/messages'))return json({messages:[{id:'opaque-msg'}],nextPageToken:'account-A-page',resultSizeEstimate:2});
    assert.fail('unexpected provider operation');
  });
  const page=await f.client.list({folder:'INBOX'});assert.equal(page.nextOffset,40);
  f.setProfile({emailAddress:'replacement@example.test'});
  await assert.rejects(f.client.list({folder:'INBOX',offset:40}),errorCode('invalid_request'));
  assert.ok(!f.calls.some(call=>call.request.params?.pageToken),'account A marker must never be used under account B');
});

test('remote account change discards an in-flight old mailbox response even when connection IDs are unchanged',async()=>{
  const pending=delay(),f=fixture('gmail',()=>pending.promise),selected=await f.target();
  const reading=f.client.message(selected),rejected=assert.rejects(reading,errorCode('cancelled'));await tick();
  f.setProfile({emailAddress:'replacement@example.test'});await f.client.status();
  pending.resolve(json(gmailMessage({payload:{...gmailMessage().payload,body:{data:b64('PRIVATE REPLACEMENT BODY')}}})));await rejected;
  assert.equal(f.calls.find(call=>call.request.path.endsWith('/opaque-msg')).signal.aborted,true);
});

test('a late old profile response cannot overwrite a newer same-ID provider identity',async()=>{
  const f=fixture('gmail',()=>assert.fail('unexpected mailbox fetch'));await f.client.status();
  const pending=delay();f.setProfile(()=>pending.promise);
  const old=f.client.status(),rejected=assert.rejects(old,errorCode('cancelled'));await tick();
  f.setProfile({emailAddress:'replacement@example.test'});const replacement=await f.client.status();
  pending.resolve(json({emailAddress:'qa@example.test'}));await rejected;
  const still=await f.client.status();assert.equal(still.address,'replacement@example.test');assert.equal(still.accountKey,replacement.accountKey);
});

test('provider profile replacement after accepted POST stays unknown and cannot be retried',async()=>{
  let f;f=fixture('outlook',()=>{f.setProfile({id:'remote-replacement',mail:'replacement@example.test'});return json(null,202);},{...binding,capabilities:{mailRead:true,mailSend:true}});
  const data=await reviewed(f,'post-profile-unknown');await assert.rejects(f.client.send(data),errorCode('delivery_unknown'));await assert.rejects(f.client.send(data),errorCode('delivery_unknown'));
  assert.equal(f.calls.filter(call=>call.request.method==='POST').length,1);
});

test('unknown outcomes retain request IDs through failure and local disconnect; no automatic resend', async () => {
  for (const failure of [new Error('SECRET lost network'), Object.assign(new Error('SECRET'),{status:500})]) {
    const f = fixture('gmail', () => {throw failure;}, {...binding,capabilities:{mailRead:true,mailSend:true}});
    const data = await reviewed(f,'unknown-reviewed-send'); await assert.rejects(f.client.send(data),errorCode('delivery_unknown'));
    await assert.rejects(f.client.send(data),errorCode('delivery_unknown')); await f.client.disconnect(); f.setState({...binding,capabilities:{mailRead:true,mailSend:true}});
    await assert.rejects(f.client.send(data),errorCode('delivery_unknown')); assert.equal(f.calls.filter(call => call.request.method === 'POST').length,1);
  }
});

test('lost binding after provider acceptance remains unknown and cannot be retried with that review ID', async () => {
  const pending = delay(), f = fixture('outlook', () => pending.promise, {...binding,capabilities:{mailRead:true,mailSend:true}});
  const data = await reviewed(f,'pending-outlook-send'), sending = f.client.send(data); const rejected = assert.rejects(sending,errorCode('delivery_unknown'));
  await tick(); await tick(); f.setState({...binding,connected:false}); pending.resolve(json(null,202)); await rejected;
  await assert.rejects(f.client.send(data),errorCode('delivery_unknown')); assert.equal(f.calls.filter(call => call.request.method === 'POST').length,1);
});

test('failure to check identity after accepted POST is also unknown, never a retryable read failure',async()=>{
  const f=fixture('gmail',()=>json({id:'provider-accepted'}),{...binding,capabilities:{mailRead:true,mailSend:true}});
  const data=await reviewed(f,'post-identity-unknown');
  const original=f.nango.status;
  f.nango.status=async service=>{if(f.calls.some(call=>call.request.method==='POST'))throw new Error('SECRET status unavailable after write');return original(service);};
  await assert.rejects(f.client.send(data),errorCode('delivery_unknown'));
  await assert.rejects(f.client.send(data),errorCode('delivery_unknown'));
  assert.equal(f.calls.filter(call=>call.request.method==='POST').length,1);
});

test('definite provider rejection and malformed send acknowledgements stay distinct and idempotent', async () => {
  for (const [response,code] of [[json({error:{message:'SECRET'}},400),'send_failed'],[json({}), 'delivery_unknown']]) {
    const f = fixture('gmail', () => response, {...binding,capabilities:{mailRead:true,mailSend:true}});
    const data = await reviewed(f,'rejected-reviewed-send'); await assert.rejects(f.client.send(data),errorCode(code)); await assert.rejects(f.client.send(data),errorCode(code)); assert.equal(f.calls.filter(call => call.request.method === 'POST').length,1);
  }
});
