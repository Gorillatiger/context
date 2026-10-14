import test from 'node:test';
import assert from 'node:assert/strict';
import * as files from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {createDesktopDevDiary,diaryCourseURL,readableDiaryContent} from '../desktop/dev-diary.mjs';

const courseURL='https://spaces.th-koeln.de/course-w26/',runId='run-2026-10',nonce='test_nonce_secret_only_fixture';
const entry={op:'prepare',courseURL,runId,title:'Dev Diary · Kurs',content:'# Dev Diary\n\n## 13.10.2026\nHeute habe ich gelernt.'};
const hash=value=>createHash('sha256').update(value).digest('hex');
const cloned=value=>JSON.parse(JSON.stringify(value));
async function fixture(t,{fs=files}={}){
 const directory=await files.mkdtemp(path.join(os.tmpdir(),'context-dev-diary-')),calls=[],posts=[];
 let time=Date.parse('2026-10-13T10:00:00Z'),nextId=100;
 const index={routes:{
  '/wp/v2/posts':{methods:['GET','POST'],schema:{properties:{meta:{properties:{scoped_notify_notify_others:{type:'string',enum:['yes','no']}}}}}},
  '/wp/v2/posts/(?P<id>[\\d]+)':{methods:['GET','POST']},
  '/wp/v2/categories':{methods:['GET']},'/wp/v2/users/me':{methods:['GET']}
 }};
 const server={index,user:{id:7,capabilities:{edit_posts:true,publish_posts:true}},categories:[{id:28,name:'DevDiary'}],pageRoot:courseURL+'wp-json/',apiLink:courseURL+'wp-json/',login:false,beforeWrite:null,afterWrite:null,totalPages:1};
 const response=(value,status=200,headers={})=>new Response(typeof value==='string'?value:JSON.stringify(value),{status,headers});
 const providerSession={async fetch(address,options){
  const url=new URL(address),method=options.method,body=options.body?JSON.parse(options.body):null;
  calls.push({url:url.href,method,body,headers:options.headers});assert.equal(options.redirect,'manual');assert.equal(options.credentials,'include');
  assert.equal(url.origin,'https://spaces.th-koeln.de');assert(url.pathname.startsWith('/course-w26/'));
  if(url.href===courseURL){
   assert.equal(options.headers['X-WP-Nonce'],undefined);
   if(server.login)return response('',302,{Location:'https://login.th-koeln.de/'});
   return response(`<link rel="https://api.w.org/" href="${server.apiLink}"><script id="wp-api-request-js-extra">var wpApiSettings = ${JSON.stringify({root:server.pageRoot,nonce,versionString:'wp/v2/'})};</script>`);
  }
  assert.equal(options.headers['X-WP-Nonce'],nonce);
  const route=url.pathname.slice('/course-w26/wp-json'.length);
  if(route==='/')return response(server.index);
  if(route==='/wp/v2/users/me')return response(server.user);
  if(route==='/wp/v2/categories'){if(url.searchParams.get('context')==='edit'&&server.user.capabilities.manage_categories!==true)return response({code:'rest_forbidden_context'},403);return response(server.categories);}
  if(route.startsWith('/wp/v2/posts')){
   const postId=Number(route.split('/')[4]||0);
   if(method==='GET'){
    if(postId){const found=posts.find(post=>post.id===postId);return found?response(cloned(found)):response({message:nonce},404);}
    let found=posts.filter(post=>post.author===Number(url.searchParams.get('author')));
    if(url.searchParams.has('slug'))found=found.filter(post=>post.slug===url.searchParams.get('slug'));
    if(url.searchParams.has('search'))found=found.filter(post=>post.content.raw.includes(url.searchParams.get('search')));
    return response(cloned(found),200,{'x-wp-totalpages':String(server.totalPages)});
   }
   assert.equal(method,'POST');await server.beforeWrite?.({body,postId});
   let post;
   if(postId){post=posts.find(value=>value.id===postId);if(!post)return response({},404);Object.assign(post,{title:{raw:body.title},content:{raw:body.content},modified_gmt:new Date(time+=1000).toISOString().slice(0,-1)});}
   else{post={id:++nextId,type:'post',author:body.author,categories:body.categories,slug:body.slug,status:body.status,title:{raw:body.title},content:{raw:body.content},modified_gmt:new Date(time+=1000).toISOString().slice(0,-1),link:courseURL+'2026/10/13/'+body.slug+'/'};posts.push(post);}
   await server.afterWrite?.({post,body,postId});return response(cloned(post));
  }
  throw new Error('An unverified endpoint was requested.');
 }};
 const create=()=>createDesktopDevDiary({providerSession,directory,fs,now:()=>time});
 const publisher=create();t.after(async()=>{await publisher.dispose();await files.rm(directory,{recursive:true,force:true});});
 const writes=()=>calls.filter(call=>call.method==='POST');
 return {publisher,create,server,calls,posts,directory,writes,advance:value=>time+=value};
}
async function firstPost(f,content=entry.content){const prepared=await f.publisher.handle({...entry,content});return {prepared,result:await f.publisher.handle({op:'publish',reviewToken:prepared.reviewToken})};}

test('publisher binds to an exact single course root and rejects account/admin/foreign URLs',()=>{
 assert.equal(diaryCourseURL(courseURL.slice(0,-1)),courseURL);
 for(const value of ['http://spaces.th-koeln.de/course/','https://evil.test/course/','https://spaces.th-koeln.de/course/?nonce=secret','https://u:p@spaces.th-koeln.de/course/','https://spaces.th-koeln.de/public/','https://spaces.th-koeln.de/course/wp-admin/','https://spaces.th-koeln.de/course%2fwp-admin/','invalid'])assert.throws(()=>diaryCourseURL(value),{code:'BAD_DIARY_SCOPE'});
});
test('get and prepare use authenticated declared endpoints but never publish or disclose the nonce',async t=>{
 const f=await fixture(t),status=await f.publisher.handle({op:'get',courseURL,runId}),prepared=await f.publisher.handle(entry);
 assert.equal(status.status,'unpublished');assert.equal(prepared.action,'create');assert.equal(prepared.preview.content,entry.content);assert.equal(prepared.notifications,'disabled');
 assert.equal(f.writes().length,0);assert.equal(f.posts.length,0);assert.equal(JSON.stringify([status,prepared]).includes(nonce),false);
 assert(f.calls.filter(call=>call.url.includes('wp-json')).every(call=>call.headers['X-WP-Nonce']===nonce));
});
test('one explicitly approved post is created, recorded before request, and repeated publish is idempotent',async t=>{
 const f=await fixture(t);f.server.beforeWrite=async()=>{
  const text=await files.readFile(path.join(f.directory,'dev-diary-publisher.json'),'utf8'),record=Object.values(JSON.parse(text).records)[0];
  assert.equal(record.pending.action,'create');assert.equal(record.postId,null);assert.equal(text.includes(nonce),false);assert.equal(text.includes('Heute habe ich gelernt'),false);
 };
 const {prepared,result}=await firstPost(f);assert.equal(result.postId,101);assert.equal(result.contentHash,hash(entry.content));assert.match(result.postURL,/course-w26\/2026/);assert.equal(f.posts.length,1);
 const again=await f.publisher.handle({op:'publish',reviewToken:prepared.reviewToken});assert.deepEqual(again,result);assert.equal(f.writes().length,1);
 assert.equal(f.writes()[0].body.meta.scoped_notify_notify_others,'no');assert.deepEqual(f.writes()[0].body.categories,[28]);assert.equal(f.writes()[0].body.author,7);
 assert.deepEqual(await files.readdir(f.directory),['dev-diary-publisher.json']);
 if(process.platform!=='win32')assert.equal((await files.stat(path.join(f.directory,'dev-diary-publisher.json'))).mode&0o777,0o600);
});
test('the next day updates the same own post without changing author, category, status or slug',async t=>{
 const f=await fixture(t);await firstPost(f);const originalId=f.posts[0].id;
 const prepared=await f.publisher.handle({...entry,content:entry.content+'\n\n## 14.10.2026\nZweiter Tag.'});assert.equal(prepared.action,'update');
 const result=await f.publisher.handle({op:'publish',reviewToken:prepared.reviewToken});assert.equal(result.postId,originalId);assert.equal(f.posts.length,1);assert.equal(f.writes().length,2);
 const update=f.writes()[1];assert.match(update.url,/wp\/v2\/posts\/101$/);assert.deepEqual(Object.keys(update.body).sort(),['content','meta','title']);
 assert.equal(f.posts[0].categories[0],28);assert.equal(f.posts[0].author,7);assert.equal(f.posts[0].status,'publish');
});
test('Markdown is rendered safely in native code; HTML input and image syntax cannot execute',async t=>{
 const f=await fixture(t),content='<script>alert(1)</script>\n\n![foto](https://example.org/tracker.png)\n\n[unsafe](javascript:alert(1))\n\n[[Notiz]]';
 await firstPost(f,content);const html=f.posts[0].content.raw;
 assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script|<img|href="javascript:|data-action="note"/);assert.match(html,/wiki-missing/);
});
test('unconfirmed roots/routes and missing or ambiguous DevDiary categories never write',async t=>{
 const f=await fixture(t);f.server.pageRoot='https://spaces.th-koeln.de/other-course/wp-json/';
 let status=await f.publisher.handle({op:'get',courseURL,runId});assert.equal(status.code,'UNVERIFIED_SPACES_API');assert.equal(f.calls.length,1);
 f.server.pageRoot=courseURL+'wp-json/';f.server.index.routes['/wp/v2/posts'].methods=['GET'];status=await f.publisher.handle({op:'get',courseURL,runId});assert.equal(status.supported,false);
 f.server.index.routes['/wp/v2/posts'].methods=['GET','POST'];f.server.categories=[{id:28,name:'Allgemein'}];status=await f.publisher.handle({op:'get',courseURL,runId});assert.equal(status.code,'DIARY_CATEGORY_REQUIRED');
 f.server.categories=[{id:28,name:'DevDiary'},{id:29,name:'Dev Diary'}];await assert.rejects(f.publisher.handle(entry),{code:'DIARY_CATEGORY_REQUIRED'});assert.equal(f.writes().length,0);
});
test('login redirects are not followed and missing publish permission reports a safe status',async t=>{
 const f=await fixture(t);f.server.login=true;let value=await f.publisher.handle({op:'get',courseURL,runId});assert.equal(value.loginRequired,true);assert.equal(f.calls.length,1);
 f.server.login=false;f.server.user.capabilities.publish_posts=false;value=await f.publisher.handle({op:'get',courseURL,runId});assert.equal(value.code,'DIARY_PERMISSION_REQUIRED');assert.equal(f.writes().length,0);assert.equal(JSON.stringify(value).includes(nonce),false);
});
test('email suppression uses only the site-advertised field; absence is disclosed before approval',async t=>{
 const f=await fixture(t);delete f.server.index.routes['/wp/v2/posts'].schema;
 const prepared=await f.publisher.handle(entry);assert.equal(prepared.notifications,'site-default');assert.match(prepared.warning,/E-Mail/);
 await f.publisher.handle({op:'publish',reviewToken:prepared.reviewToken});assert.equal(f.writes()[0].body.meta,undefined);
});
test('manual edits between preview and publish are refused without overwriting',async t=>{
 const f=await fixture(t);await firstPost(f);
 const prepared=await f.publisher.handle({...entry,content:entry.content+'\nMein nächster Tag.'});
 f.posts[0].content.raw+='\n<p>Manuelle Änderung</p>';f.posts[0].modified_gmt='2026-10-13T11:00:00';
 await assert.rejects(f.publisher.handle({op:'publish',reviewToken:prepared.reviewToken}),{code:'DIARY_REMOTE_CHANGED'});assert.match(f.posts[0].content.raw,/Manuelle Änderung/);assert.equal(f.writes().length,1);
 await assert.rejects(f.publisher.handle({...entry,content:'Neuer Inhalt'}),{code:'DIARY_REMOTE_CHANGED'});
});
test('verified own content is readable and bounded without script, style, image or comment execution',async t=>{
 const f=await fixture(t);await firstPost(f);
 f.posts[0].content.raw+='<script>hidden script secret</script><style>hidden style secret</style><template>hidden template</template><p>Extern &amp; manuell<br>zweite Zeile</p><img src="https://example.org/image" onerror="bad">';
 const status=await f.publisher.handle({op:'get',courseURL,runId});assert.equal(status.remoteChanged,true);assert.match(status.post.contentText,/Extern & manuell\nzweite Zeile/);assert.doesNotMatch(status.post.contentText,/hidden script|hidden style|hidden template|onerror|context-dev-diary/);
 assert.match(status.post.revision,/^[a-f0-9]{64}$/);assert.equal(JSON.stringify(status).includes(nonce),false);
 const bounded=readableDiaryContent('<p>'+('a'.repeat(20001))+'</p>');assert.equal(bounded.contentText.length,20000);assert.equal(bounded.contentTruncated,true);
 assert.equal(readableDiaryContent('<p>Bleibt</p><script>unterminated hidden').contentText,'Bleibt');
});
test('only exact current acknowledgement admits an external edit preview, without writing or rebasing the journal',async t=>{
 const f=await fixture(t);await firstPost(f);const previous=await files.readFile(path.join(f.directory,'dev-diary-publisher.json'),'utf8');
 const oldStatus=await f.publisher.handle({op:'get',courseURL,runId});f.posts[0].content.raw+='\n<p>Extern ergänzt</p>';f.posts[0].modified_gmt='2026-10-13T11:00:00';
 const external=await f.publisher.handle({op:'get',courseURL,runId});
 await assert.rejects(f.publisher.handle({...entry,content:'Manuell abgeglichener Inhalt',acknowledgeRevision:oldStatus.post.revision}),{code:'DIARY_REMOTE_CHANGED'});
 const prepared=await f.publisher.handle({...entry,content:'Manuell abgeglichener Inhalt',acknowledgeRevision:external.post.revision});
 assert.equal(prepared.action,'update');assert.equal(prepared.preview.baseRevision,external.post.revision);assert.equal(prepared.preview.content,'Manuell abgeglichener Inhalt');assert.equal(f.writes().length,1);
 assert.equal(await files.readFile(path.join(f.directory,'dev-diary-publisher.json'),'utf8'),previous);
 const result=await f.publisher.handle({op:'publish',reviewToken:prepared.reviewToken});assert.equal(result.postId,101);assert.equal(f.posts.length,1);assert.equal(f.writes().length,2);
 const saved=Object.values(JSON.parse(await files.readFile(path.join(f.directory,'dev-diary-publisher.json'),'utf8')).records)[0];assert.equal(saved.revision,result.post.revision);
});
test('another external edit after an acknowledged preview still blocks publishing',async t=>{
 const f=await fixture(t);await firstPost(f);f.posts[0].content.raw+='<p>Erste externe Änderung</p>';
 const external=await f.publisher.handle({op:'get',courseURL,runId}),prepared=await f.publisher.handle({...entry,content:'Abgeglichen',acknowledgeRevision:external.post.revision});
 f.posts[0].content.raw+='<p>Noch eine externe Änderung</p>';f.posts[0].modified_gmt='2026-10-13T12:00:00';
 await assert.rejects(f.publisher.handle({op:'publish',reviewToken:prepared.reviewToken}),{code:'DIARY_REMOTE_CHANGED'});assert.equal(f.writes().length,1);assert.match(f.posts[0].content.raw,/Noch eine/);
});
test('acknowledgement cannot authorize creating a missing post, override ownership or become force-edit',async t=>{
 const f=await fixture(t);
 await assert.rejects(f.publisher.handle({...entry,acknowledgeRevision:'a'.repeat(64)}),{code:'DIARY_REMOTE_CHANGED'});
 await assert.rejects(f.publisher.handle({...entry,acknowledgeRevision:'invalid'}),{code:'BAD_DIARY_ACKNOWLEDGEMENT'});
 await assert.rejects(f.publisher.handle({...entry,force:true}),{code:'BAD_DIARY_REQUEST'});
 await firstPost(f);const external=await f.publisher.handle({op:'get',courseURL,runId});f.posts[0].author=8;
 await assert.rejects(f.publisher.handle({...entry,acknowledgeRevision:external.post.revision}),{code:'DIARY_IDENTITY_MISMATCH'});assert.equal(f.writes().length,1);
});
test('a changed author, removed category or changed authenticated account cannot be overwritten',async t=>{
 const f=await fixture(t);await firstPost(f);const original=f.posts[0].author;
 f.posts[0].author=8;await assert.rejects(f.publisher.handle(entry),{code:'DIARY_IDENTITY_MISMATCH'});f.posts[0].author=original;
 f.posts[0].categories=[1];await assert.rejects(f.publisher.handle(entry),{code:'DIARY_IDENTITY_MISMATCH'});f.posts[0].categories=[28];
 const prepared=await f.publisher.handle({...entry,content:'Neuer Tag'});f.server.user.id=8;
 await assert.rejects(f.publisher.handle({op:'publish',reviewToken:prepared.reviewToken}),{code:'DIARY_IDENTITY_CHANGED'});assert.equal(f.writes().length,1);
});
test('a lost create reply is reconciled read-only and never creates a duplicate',async t=>{
 const f=await fixture(t);f.server.afterWrite=async()=>{throw new Error('transport '+nonce);};const prepared=await f.publisher.handle(entry);
 await assert.rejects(f.publisher.handle({op:'publish',reviewToken:prepared.reviewToken}),cause=>cause.code==='DIARY_OUTCOME_UNKNOWN'&&!cause.message.includes(nonce));
 assert.equal(f.posts.length,1);f.server.afterWrite=null;
 const recovered=await f.publisher.handle({op:'publish',reviewToken:prepared.reviewToken});assert.equal(recovered.recovered,true);assert.equal(recovered.postId,101);assert.equal(f.writes().length,1);
 const saved=Object.values(JSON.parse(await files.readFile(path.join(f.directory,'dev-diary-publisher.json'),'utf8')).records)[0];assert.equal(saved.pending,null);assert.equal(saved.contentHash,hash(entry.content));
});
test('an unknown create with no visible result remains blocked after restart',async t=>{
 const f=await fixture(t);f.server.beforeWrite=async()=>{throw new Error('connection ended');};const prepared=await f.publisher.handle(entry);
 await assert.rejects(f.publisher.handle({op:'publish',reviewToken:prepared.reviewToken}),{code:'DIARY_OUTCOME_UNKNOWN'});
 await f.publisher.dispose();const restarted=f.create();t.after(()=>restarted.dispose());
 const status=await restarted.handle({op:'get',courseURL,runId});assert.equal(status.status,'unknown');
 await assert.rejects(restarted.handle(entry),{code:'DIARY_OUTCOME_UNKNOWN'});assert.equal(f.writes().length,1);assert.equal(f.posts.length,0);
});
test('confirmed publisher state is recovered on restart and reuses exactly the same post',async t=>{
 const f=await fixture(t);await firstPost(f);await f.publisher.dispose();const restarted=f.create();t.after(()=>restarted.dispose());
 const status=await restarted.handle({op:'get',courseURL,runId});assert.equal(status.postId,101);assert.equal(status.contentHash,hash(entry.content));
 const prepared=await restarted.handle({...entry,content:'Der nächste Tag.'});await restarted.handle({op:'publish',reviewToken:prepared.reviewToken});assert.equal(f.posts.length,1);assert.equal(f.writes().length,2);
});
test('durable-journal failure before publishing prevents any remote write',async t=>{
 const fs={...files,writeFile:async()=>{throw new Error('disk unavailable');}},f=await fixture(t,{fs});const prepared=await f.publisher.handle(entry);
 await assert.rejects(f.publisher.handle({op:'publish',reviewToken:prepared.reviewToken}),{code:'DIARY_JOURNAL_UNAVAILABLE'});assert.equal(f.writes().length,0);assert.deepEqual(await files.readdir(f.directory),[]);
});
test('malformed local mapping refuses publishing instead of discarding idempotency history',async t=>{
 const f=await fixture(t);await files.writeFile(path.join(f.directory,'dev-diary-publisher.json'),'not JSON');
 await assert.rejects(f.publisher.handle(entry),{code:'DIARY_JOURNAL_INVALID'});assert.equal(f.calls.length,0);assert.equal(await files.readFile(path.join(f.directory,'dev-diary-publisher.json'),'utf8'),'not JSON');
});
test('tokens expire, approve immutable prepared content, and reject arbitrary write fields',async t=>{
 const f=await fixture(t),prepared=await f.publisher.handle(entry);
 for(const message of [{op:'publish',reviewToken:prepared.reviewToken,content:'Unreviewed'},{...entry,authorId:99},{op:'delete',courseURL,runId}])await assert.rejects(f.publisher.handle(message),{code:'BAD_DIARY_REQUEST'});
 f.advance(11*60_000);await assert.rejects(f.publisher.handle({op:'publish',reviewToken:prepared.reviewToken}),{code:'DIARY_REVIEW_EXPIRED'});assert.equal(f.writes().length,0);
});
test('concurrent approved previews of one run serialize and create only one own post',async t=>{
 const f=await fixture(t),first=await f.publisher.handle(entry),second=await f.publisher.handle(entry);
 const results=await Promise.all([first,second].map(review=>f.publisher.handle({op:'publish',reviewToken:review.reviewToken})));assert.equal(results[0].postId,results[1].postId);assert.equal(f.posts.length,1);assert.equal(f.writes().length,1);
});
test('an incomplete lookup never assumes a diary is absent and creates a new one',async t=>{
 const f=await fixture(t);f.server.totalPages=2;await assert.rejects(f.publisher.handle(entry),{code:'DIARY_LOOKUP_INCOMPLETE'});assert.equal(f.writes().length,0);
});
test('dispose drains accepted publications and refuses new IPC work',async t=>{
 const f=await fixture(t),prepared=await f.publisher.handle(entry);let release,entered,done=false;const gate=new Promise(resolve=>release=resolve),atRequest=new Promise(resolve=>entered=resolve);
 f.server.beforeWrite=async()=>{entered();await gate;};const pending=f.publisher.handle({op:'publish',reviewToken:prepared.reviewToken}),disposing=f.publisher.dispose().then(()=>{done=true;});
 try{await atRequest;await new Promise(resolve=>setImmediate(resolve));assert.equal(done,false);await assert.rejects(f.publisher.handle({op:'get',courseURL,runId}),{code:'DIARY_PUBLISHER_CLOSED'});}
 finally{release();await Promise.all([pending,disposing]);}
 assert.equal(f.posts.length,1);const record=Object.values(JSON.parse(await files.readFile(path.join(f.directory,'dev-diary-publisher.json'),'utf8')).records)[0];assert.equal(record.pending,null);
});


test('an author can select the existing Diary category without category-management permission',async t=>{
 const f=await fixture(t);assert.equal(f.server.user.capabilities.manage_categories,undefined);
 const status=await f.publisher.handle({op:'get',courseURL,runId});assert.equal(status.supported,true);
 const prepared=await f.publisher.handle(entry);await f.publisher.handle({op:'publish',reviewToken:prepared.reviewToken});
 assert.equal(f.posts.length,1);assert.deepEqual(f.posts[0].categories,[28]);
 for(const call of f.calls.filter(c=>c.url.includes('/wp/v2/categories')))assert.equal(new URL(call.url).searchParams.get('context'),'view');
});

test('the native publisher preserves date-only disclosure HTML and keeps user HTML escaped',async t=>{
 const f=await fixture(t),content='# Diary\n\n<details>\n<summary>14.10.2026</summary>\n\n### Ergebnisse\n\n&lt;script&gt;bad()&lt;/script&gt;\n\n</details>\n';
 await firstPost(f,content);
 assert.match(f.posts[0].content.raw,/<details class="dev-diary-day"><summary>14\.10\.2026<\/summary>/);
 assert.match(f.posts[0].content.raw,/<h3>Ergebnisse<\/h3>/);
 assert.doesNotMatch(f.posts[0].content.raw,/<script>/);
 assert.equal(f.posts.length,1);
});
