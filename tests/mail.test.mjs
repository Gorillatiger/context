import test from 'node:test';
import assert from 'node:assert/strict';
import {createMailClient,validateDraft,MailError,runMailPython} from '../connectors/mail.mjs';
import {collectNotifications} from '../connectors/notifications.mjs';
import {mailRecipients} from '../dist/mail.js';
import {mkdtemp,copyFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';

const connection={user:'qa-user',password:'synthetic-private-password',address:'qa@smail.th-koeln.de'};
const draft={to:['to@example.org'],subject:'Hallo Köln',text:'Testnachricht'};
const target={folder:'SU5CT1g',uid:'45',uidValidity:'123'};

test('mail setup validates IMAP before retaining session-only credentials and disconnect clears them',async()=>{
  const calls=[];
  const client=createMailClient({env:{},runner:async payload=>{calls.push(payload);return {smtpReady:true,folders:[]};}});
  assert.equal(client.status().configured,false);
  const result=await client.configure(connection);assert.equal(result.configured,true);assert.equal(result.storage,'session');
  assert.ok(!JSON.stringify(result).includes(connection.password));assert.equal(calls[0].action,'connect');
  await client.configure({disconnect:true});assert.equal(client.status().configured,false);
  await assert.rejects(()=>client.message(target),error=>error.code==='not_configured');
  const failing=createMailClient({env:{},runner:async()=>{throw new Error('provider echoed '+connection.password);}});
  await assert.rejects(()=>failing.configure(connection),error=>error.code==='connection_failed'&&!error.message.includes(connection.password));
  assert.equal(failing.status().configured,false);
});

test('mail setup rejects non-campus identities and malformed credentials before contacting a server',async()=>{
  let calls=0;const client=createMailClient({env:{},runner:async()=>{calls++;}});
  for(const change of [{user:'x\r\nLOGOUT'},{address:'qa@example.org'},{address:'qa@smail.th-koeln.de.evil.org'},{password:''},{password:'x\0'},{password:'x\r\nLOGOUT'},{user:'x'.repeat(101)}])await assert.rejects(()=>client.configure({...connection,...change}),error=>error.code==='invalid_request');
  assert.equal(calls,0);
});

test('mail draft validation rejects header injection, invalid recipients and attachment traversal/size',()=>{
  assert.equal(validateDraft(draft).subject,'Hallo Köln');
  for(const change of [{to:[]},{to:['x@example.org\r\nX: yes']},{subject:'Subject\nBcc: evil@example.org'},{text:'x\0'},{inReplyTo:'<id>\nX: yes'},{attachments:[{name:'../x',data:'eA=='}]},{attachments:[{name:'file',data:'not-base64'}]},{attachments:[{name:'x',data:Buffer.alloc(8*1024*1024+1).toString('base64')}]}])assert.throws(()=>validateDraft({...draft,...change}),MailError);
  assert.deepEqual(mailRecipients(' a@example.org; b@example.org, a@example.org '),['a@example.org','b@example.org']);
  assert.throws(()=>mailRecipients('Name <a@example.org>'));
});

test('UID operations reject invalid identifiers, search controls and malformed flags',async()=>{
  let calls=0;const client=createMailClient({env:{TH_MAIL_USER:'qa',TH_MAIL_PASSWORD:'synthetic'},runner:async()=>{calls++;}});
  for(const change of [{folder:'INBOX\n'},{uid:'1:*'},{uidValidity:'123\n'}])assert.throws(()=>client.message({...target,...change}),MailError);
  assert.throws(()=>client.flag({...target,unread:'false'}),MailError);
  assert.throws(()=>client.attachment({...target,part:'1 STORE'}),MailError);
  for(const change of [{offset:-1},{query:'x\r\n'},{query:'x'.repeat(201)},{unread:'yes'}])await assert.rejects(()=>client.list({folder:target.folder,...change}),MailError);
  assert.equal(calls,0);
});

test('concurrent identical sends share one result and a changed payload cannot reuse its id',async()=>{
  let sends=0,release;const client=createMailClient({env:{},runner:async p=>{if(p.action==='connect')return {folders:[],smtpReady:true};sends++;return new Promise(resolve=>release=resolve);}});
  await client.configure(connection);
  const data={requestId:'synthetic-request-0001',draft};const first=client.send(data),second=client.send(data);
  assert.equal(sends,1);release({accepted:1,refused:[],sentCopySaved:true});assert.deepEqual(await first,await second);
  await client.send(data);assert.equal(sends,1);
  await assert.rejects(()=>client.send({...data,draft:{...draft,text:'changed'}}),MailError);
});

test('uncertain SMTP outcome remains idempotent and does not automatically retry',async()=>{
  let sends=0;const client=createMailClient({env:{},runner:async p=>{if(p.action==='connect')return {folders:[]};sends++;throw new MailError('delivery_unknown');}});
  await client.configure(connection);const data={requestId:'synthetic-request-0002',draft};
  for(let i=0;i<2;i++)await assert.rejects(()=>client.send(data),error=>error.code==='delivery_unknown');
  assert.equal(sends,1);
});

test('disconnect cancels active reads and prevents a pending setup from retaining credentials',async()=>{
  let ready,release;const started=new Promise(resolve=>ready=resolve);
  const client=createMailClient({env:{},runner:async(_,signal)=>{ready();return new Promise(resolve=>{release=resolve;signal.addEventListener('abort',()=>resolve({smtpReady:true,folders:[]}));});}});
  const pending=client.configure(connection);await started;await client.configure({disconnect:true});
  await assert.rejects(()=>pending,error=>error.code==='cancelled');assert.equal(client.status().configured,false);release({});
});

test('central notifications use the session mail connector and point to full messages without copying bodies',async()=>{
  const client=createMailClient({env:{TH_MAIL_USER:'qa-user',TH_MAIL_PASSWORD:'synthetic'},runner:async()=>({folder:target.folder,uidValidity:'123',items:[{uid:'45',subject:'[THspaces] Kurs',sender:'TH-Spaces',date:'2026-10-12T10:00:00Z',text:'should not leak body'}]})});
  const feed=await collectNotifications({}, {mailClient:client});
  assert.equal(feed.sources.find(s=>s.source==='webmail').status,'connected');assert.equal(feed.items[0].mailTarget.uid,'45');
  assert.ok(!JSON.stringify(feed).includes('should not leak'));assert.ok(!JSON.stringify(feed).includes('synthetic'));
});

test('Python adapter works in folders with spaces and returns a safe error without network or credential echo',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'context mail QA '));
  try{
    for(const name of ['mail.mjs','mail-client.py'])await copyFile(new URL('../connectors/'+name,import.meta.url),join(folder,name));
    const adapter=await import(pathToFileURL(join(folder,'mail.mjs')).href);
    await assert.rejects(()=>adapter.runMailPython({action:'connect',user:'invalid\n',password:connection.password}),error=>error.code==='invalid_request'&&!error.message.includes(connection.password));
  }finally{await rm(folder,{recursive:true,force:true});}
});
test('undated central mail headers remain undated instead of looking newly received',async()=>{
 const client=createMailClient({env:{TH_MAIL_USER:'qa-user',TH_MAIL_PASSWORD:'synthetic'},runner:async()=>({folder:target.folder,uidValidity:'123',items:[{uid:'45',subject:'Undatiert',sender:'Kurs',date:''},{uid:'46',subject:'Ungültiges Datum',sender:'Kurs',date:'bad date'}]})});
 const result=await client.notifications();assert.deepEqual(result.map(n=>n.createdAt),['','']);assert.equal(result.length,2);
});
