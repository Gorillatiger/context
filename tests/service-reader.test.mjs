import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {randomUUID,webcrypto} from 'node:crypto';
import vm from 'node:vm';
import {createServiceReader,validateServiceSources,serviceURL,serviceFileURL,serviceReadScript,SERVICE_READER_LIMITS} from '../desktop/service-reader.mjs';

const REPO='https://git.coco.study/course/robotics',ISSUE=REPO+'/-/issues/7',SCIEBO='https://th-koeln.sciebo.de/index.php/apps/files/?dir=%2FCourse',RAW=REPO+'/-/raw/main/README.md';
const request=(action,patch={})=>({action,id:randomUUID(),sourceId:'course-git',...patch});

function element({tag='div',classes=[],attrs={},parent=null,visible=true,text='',href=''}={}){
  const el={tag,classes,attrs,parent,innerText:text,href,getClientRects:()=>visible?[{}]:[],getAttribute:key=>attrs[key]??null};
  const matches=(node,selector)=>{const tag=selector.match(/^[a-z][\w-]*/i)?.[0],cls=[...selector.matchAll(/\.([\w-]+)/g)].map(match=>match[1]),attr=selector.match(/\[([\w-]+)(?:=([^\]]+))?\]/);return (!tag||node.tag===tag)&&cls.every(value=>node.classes.includes(value))&&(!attr||node.attrs[attr[1]]!==undefined&&(attr[2]===undefined||node.attrs[attr[1]]===attr[2]));};
  el.closest=selectors=>{for(let value=el;value;value=value.parent)if(selectors.split(',').some(selector=>matches(value,selector.trim())))return value;return null;};el.querySelector=()=>null;return el;
}
const link=(url,title='Kurslink',patch={})=>element({tag:'a',href:url,text:title,...patch});
function documentFixture({text='Aufgabe: Baue einen Roboter.',nodes,links=[],title='Robotikkurs',password=false,url=REPO}={}){
  const root=element(),bodyNodes=nodes||[{textContent:text,parentElement:element()}];root.querySelectorAll=()=>links;
  const document={title,body:root,querySelector:selector=>selector==='input[type=password]'?(password?element({tag:'input'}):null):root,createTreeWalker:scope=>{let i=0;const list=scope===root?bodyNodes:bodyNodes.filter(node=>{for(let parent=node.parentElement;parent;parent=parent.parent)if(parent===scope)return true;return false;});return {nextNode:()=>list[i++]||null};}};
  return {document,location:{href:url,pathname:new URL(url).pathname,hostname:new URL(url).hostname},URL,NodeFilter:{SHOW_TEXT:4},TextEncoder,Uint8Array,crypto:webcrypto};
}
const evaluate=(url,data,script)=>vm.runInNewContext(script,documentFixture({...data,url}));
function fixture({pages={},grants,loadHook,readHook,fetchText,createHook,statuses={}}={}){
  const state={grants:grants||[{id:'course-git',service:'gitlab',url:REPO,projectId:'robotics',title:'Robotikkurs',revision:'one'}],authRevision:0,views:[],opened:[],fetches:[],destroyed:[],reads:0,loads:[],pageByURL:{[REPO]:{links:[link(ISSUE,'Aufgabe sieben'),link(RAW,'README')]},[ISSUE]:{text:'Löse die Kinematik-Aufgabe.',links:[]},...pages}};
  function createView(options){
    const wc=new EventEmitter();Object.assign(wc,{url:'about:blank',closed:false,stops:0,isDestroyed:()=>wc.closed,getURL:()=>wc.url,setWindowOpenHandler:handler=>wc.popup=handler,stop:()=>wc.stops++,close:()=>{wc.closed=true;wc.emit('destroyed');},loadURL:async url=>{state.loads.push(url);wc.emit('did-start-navigation',{},url,false,true);await loadHook?.(wc,url,state);wc.url=url;wc.emit('did-navigate',{},url,statuses[url]||200);},executeJavaScriptInIsolatedWorld:async(world,scripts)=>{assert.equal(world,1002);state.reads++;await readHook?.(wc,state);return evaluate(wc.url,state.pageByURL[wc.url]||{},scripts[0].code);}});
    const view={webContents:wc,setVisible:value=>{view.visible=value;},options};state.views.push(view);return createHook?createHook(view,state):view;
  }
  state.api=createServiceReader({createView,destroyView:view=>{state.destroyed.push(view);view.webContents.close();},getSources:()=>state.grants,openVisible:async(url,metadata)=>state.opened.push({url,metadata}),fetchText:async(url,options)=>{state.fetches.push({url,options});return fetchText?fetchText(url,options,state):{text:'# Robotik\nDies ist die eigentliche Aufgabenstellung.',contentType:'text/markdown; charset=utf-8',url};},getAuthRevision:()=>state.authRevision,settleMs:0,now:()=> '2026-10-14T12:00:00Z'});return state;
}
function gate(){let release,enter;return {promise:new Promise(resolve=>release=resolve),entered:new Promise(resolve=>enter=resolve),release:()=>release(),enter:()=>enter()};}

test('known GitLab repository routes canonicalize while enforcing the selected repository boundary',()=>{
  assert.equal(serviceURL('gitlab',REPO+'/-/issues?page=2&state=opened#issue',REPO),REPO+'/-/issues?page=2&state=opened');
  assert.equal(serviceURL('gitlab',REPO+'/-/blob/main/README.md',ISSUE),REPO+'/-/blob/main/README.md');
  assert.throws(()=>serviceURL('gitlab','https://git.coco.study/course/other/-/issues',REPO),/Repository/);
  assert.throws(()=>serviceURL('gitlab',REPO+'-extra/-/issues',REPO),/Repository/);
  assert.throws(()=>serviceURL('gitlab',REPO+'/member/private',REPO),/Repository/);
});

test('URL policy rejects local, credential, arbitrary, destructive, API, download and encoded traversal destinations',()=>{
  const denied=['http://git.coco.study/course/robotics','https://git.coco.study:444/course/robotics','https://user:secret@git.coco.study/course/robotics','https://evil.test/course/robotics','https://127.0.0.1/course/robotics',REPO+'/-/issues/new',REPO+'/-/issues/7/edit',REPO+'/-/settings',REPO+'/-/raw/main/readme.md',REPO+'/-/archive/main/download.zip','https://git.coco.study/api/v4/projects','https://git.coco.study/users/sign_in',REPO+'?private_token=secret',REPO+'?page=2&page=3',REPO+'?page=-1',REPO+'/%252e%252e/private',REPO+'/%2e%2e/private',REPO+'/%25252525252525252e%25252525252525252e/private',REPO+'\\logout'];
  for(const url of denied)assert.throws(()=>serviceURL('gitlab',url,REPO),url);
});

test('secret-file navigation cannot bypass the separate file GET policy through GitLab blob or tree HTML',()=>{
  for(const route of ['blob','tree'])for(const file of ['.env','.env.local','.env.production.json','.ssh/config','.aws/credentials','secrets/README.md','credentials.json','passwords.txt','api-key.txt','private_tokens.json'])assert.throws(()=>serviceURL('gitlab',REPO+'/-/'+route+'/main/'+file,REPO),file);
  assert.equal(serviceURL('gitlab',REPO+'/-/blob/main/docs/assignment.md',REPO),REPO+'/-/blob/main/docs/assignment.md');
});

test('Sciebo folder scopes admit descendants, never adjacent folders, arbitrary file IDs or multi-action query parameters',()=>{
  assert.equal(serviceURL('sciebo','https://th-koeln.sciebo.de/'),'https://th-koeln.sciebo.de/index.php/apps/files/?dir=%2F');
  assert.match(serviceURL('sciebo','https://th-koeln.sciebo.de/index.php/apps/files/?dir=%2FCourse%2FWeek%201',SCIEBO),/Week\+1/);
  for(const url of ['https://th-koeln.sciebo.de/index.php/apps/files/?dir=%2FCourseExtra','https://th-koeln.sciebo.de/index.php/apps/files/?dir=%2FCourse%2F..%2FPrivate','https://th-koeln.sciebo.de/index.php/apps/files/?dir=%2FCourse&download=1','https://th-koeln.sciebo.de/remote.php/dav/files/user/Course/readme.md','https://th-koeln.sciebo.de/index.php/apps/files/?fileid=abc'])assert.throws(()=>serviceURL('sciebo',url,SCIEBO));
  assert.throws(()=>serviceURL('sciebo',SCIEBO+'&fileid=2',SCIEBO+'&fileid=1'),/Ordner/);
  assert.throws(()=>serviceURL('sciebo',SCIEBO+'&fileid=999',SCIEBO),/Ordner/);
  assert.equal(serviceURL('sciebo',SCIEBO+'&fileid=1',SCIEBO+'&fileid=1'),SCIEBO+'&fileid=1');
});

test('Mattermost channel scopes never interpret error redirects, direct messages, administration or other channels as content',()=>{
  const channel='https://chat.coco.study/students/channels/robotics';assert.equal(serviceURL('mattermost',channel,channel),channel);
  for(const value of ['https://chat.coco.study/error?message=secret','https://chat.coco.study/students/channels/private','https://chat.coco.study/students/pl/abcdefghijklmnopqrstuvwxyz','https://chat.coco.study/admin_console','https://chat.coco.study/students/messages/@someone'])assert.throws(()=>serviceURL('mattermost',value,channel));
});

test('Sciebo shared links remain within the exact observed share token and optional folder, including index.php aliases',()=>{
  const scope='https://th-koeln.sciebo.de/s/share123?path=%2FCourse',alias='https://th-koeln.sciebo.de/index.php/s/share123?path=%2FCourse%2FWeek1';assert.equal(serviceURL('sciebo',alias,scope),alias);
  assert.equal(validateServiceSources([{id:'shared-course',url:scope}])[0].service,'sciebo');
  for(const value of ['https://th-koeln.sciebo.de/s/other123?path=%2FCourse','https://th-koeln.sciebo.de/s/share123?path=%2FPrivate','https://th-koeln.sciebo.de/s/share123?path=%2FCourse%2F..%2FPrivate',scope+'&password=PRIVATE','https://th-koeln.sciebo.de/index.php/apps/files/?dir=%2FCourse',scope.replace('share123','x')])assert.throws(()=>serviceURL('sciebo',value,scope));
  assert.throws(()=>serviceURL('sciebo',scope,SCIEBO));
});

test('Sciebo shared text downloads require the same share and folder with one file; archives and password routes remain unsupported',()=>{
  const scope='https://th-koeln.sciebo.de/s/share123?path=%2FCourse',file='https://th-koeln.sciebo.de/index.php/s/share123/download?path=%2FCourse&files=brief.md';assert.match(serviceFileURL('sciebo',file,scope),/files=brief.md/);
  assert.equal(serviceFileURL('sciebo','https://th-koeln.sciebo.de/s/share123/download','https://th-koeln.sciebo.de/s/share123'),'https://th-koeln.sciebo.de/s/share123/download');
  for(const value of [file.replace('share123','other123'),file.replace('%2FCourse','%2FPrivate'),file.replace('brief.md','brief.docm'),file.replace('brief.md','one.md,two.md'),file+'&password=PRIVATE','https://th-koeln.sciebo.de/s/share123/download?path=%2FCourse','https://th-koeln.sciebo.de/s/share123/download?files=../../secret.json'])assert.throws(()=>serviceFileURL('sciebo',value,scope));
});

test('shared-link DOM discovery finds only matching-share child folders and supported text downloads',async()=>{
  const scope='https://th-koeln.sciebo.de/s/share123',folder=scope+'?path=%2FCourse',file=scope+'/download?path=%2FCourse&files=brief.md',page=await vm.runInNewContext(serviceReadScript('sciebo',scope),documentFixture({url:scope,links:[link(folder,'Material'),link(file,'Aufgabenstellung'),link(scope.replace('share123','other123'),'Andere Freigabe')]}));assert.deepEqual(Array.from(page.links,item=>item.url),[folder]);assert.equal(page.fileLinks[0].url,serviceFileURL('sciebo',file,scope));
});

test('source registration accepts only typed known read scopes, rejects duplicate IDs and stays bounded',()=>{
  const value=validateServiceSources([{id:'git:course',url:REPO,projectId:'robotics'}]);assert.equal(value[0].service,'gitlab');assert.equal(value[0].title,'GitLab');assert.equal(Object.isFrozen(value[0]),true);
  for(const inputs of [null,{},[{id:'one',url:REPO,secret:'do-not-copy'}],[{id:'one',url:'https://evil.test/'}],[{id:'one',url:REPO},{id:'one',url:REPO}],Array.from({length:101},(_,i)=>({id:'source-'+i,url:REPO})),[{id:'course/escape',url:REPO}],[{id:'one',url:REPO,revision:'\ninvalid'}]])assert.throws(()=>validateServiceSources(inputs));
});

test('separate file policy permits text files already discoverable within project or folder, never broad downloads or secrets',()=>{
  assert.equal(serviceFileURL('gitlab',RAW,REPO),RAW);
  const dav='https://th-koeln.sciebo.de/remote.php/dav/files/user/Course/README.md';assert.equal(serviceFileURL('sciebo',dav,SCIEBO),dav);
  assert.equal(serviceFileURL('sciebo','https://th-koeln.sciebo.de/index.php/apps/files/ajax/download.php?files=brief.txt&dir=%2FCourse',SCIEBO),'https://th-koeln.sciebo.de/index.php/apps/files/ajax/download.php?dir=%2FCourse&files=brief.txt');
  for(const [service,url,scope]of [['gitlab',RAW.replace('/course/robotics/','/course/other/'),REPO],['gitlab',RAW+'?token=secret',REPO],['gitlab',RAW.replace('README.md','passwords.json'),REPO],['gitlab',RAW.replace('README.md','secrets/README.md'),REPO],['gitlab',RAW.replace('README.md','brief.docm'),REPO],['sciebo',dav.replace('/Course/','/Private/'),SCIEBO],['sciebo',dav+'?download=1',SCIEBO],['sciebo','https://th-koeln.sciebo.de/index.php/apps/files/ajax/download.php?files=one.md,two.md&dir=%2FCourse',SCIEBO],['sciebo',dav.replace('README.md','../Private/README.md'),SCIEBO],['mattermost','https://chat.coco.study/file/readme.md','https://chat.coco.study/']])assert.throws(()=>serviceFileURL(service,url,scope));
});

test('isolated reader emits source text and observed navigation/file/Miro links without forms, cookie APIs or global chrome',async()=>{
  const form=element({tag:'form'}),nav=element({tag:'nav'}),hidden=element({visible:false}),editable=element({attrs:{contenteditable:'true'}}),anchors=[link(ISSUE,'Aufgabe'),link(RAW,'README'),link(REPO+'/-/issues/new','Neue Aufgabe'),link('https://miro.com/app/board/board123/','Gruppenboard'),link(REPO+'/-/issues/8','Versteckt',{visible:false}),link(REPO+'/-/issues/9','Profil',{parent:nav})];
  const nodes=[{textContent:'Sichtbare Aufgabe',parentElement:element()},...[[form,'PRIVATE_FORM'],[nav,'PRIVATE_NAV'],[hidden,'PRIVATE_HIDDEN'],[editable,'PRIVATE_DRAFT']].map(([parentElement,textContent])=>({textContent,parentElement}))];
  const script=serviceReadScript('gitlab',REPO),page=await vm.runInNewContext(script,documentFixture({nodes,links:anchors}));
  assert.equal(page.text,'Sichtbare Aufgabe');assert.deepEqual(Array.from(page.links,item=>item.url),[ISSUE]);assert.deepEqual(Array.from(page.fileLinks,item=>item.url),[RAW]);assert.equal(page.boardLinks[0].url,'https://miro.com/app/board/board123/');assert.equal(page.loginRequired,false);assert.match(page.contentRevision,/^[a-f0-9]{64}$/);assert.doesNotMatch(script,/document\.cookie|localStorage|sessionStorage|\.click\(|fetch\(/);
});

test('login fields and provider error pages produce redacted states with no source body or observed links',async()=>{
  for(const patch of [{password:true},{url:'https://git.coco.study/users/sign_in'},{url:'https://chat.coco.study/error?message=PRIVATE'}]){
    const page=await vm.runInNewContext(serviceReadScript('gitlab',REPO),documentFixture({text:'PRIVATE_PASSWORD',links:[link(ISSUE)],...patch}));assert.equal(page.text,'');assert.equal(page.links.length,0);assert.equal(page.items.length,0);assert.equal(page.boardLinks.length,0);assert.equal(page.loginRequired||page.permissionRequired,true);
  }
});

test('text and link paging retain hashes, bound every window, and do not split UTF-16 characters',async()=>{
  const text='a'.repeat(4999)+'🧭'+'b'.repeat(5001)+'TAIL',links=Array.from({length:95},(_,i)=>link(REPO+'/-/issues/'+(i+1))),doc=documentFixture({text,links});
  const first=await vm.runInNewContext(serviceReadScript('gitlab',REPO),doc),tail=await vm.runInNewContext(serviceReadScript('gitlab',REPO,{offset:first.nextOffset,linkOffset:45}),doc);
  assert.equal(first.text.length,4999);assert.equal(first.links.length,45);assert.equal(first.totalLinks,95);assert.equal(tail.contentRevision,first.contentRevision);assert.equal(tail.text[0],'\uD83E');assert.ok(tail.text.length<=5000);assert.equal(tail.links.length,45);
  const final=await vm.runInNewContext(serviceReadScript('gitlab',REPO,{offset:tail.nextOffset,linkOffset:90}),doc);assert.equal(first.text+tail.text+final.text,text);assert.equal(final.links.length,5);assert.equal(final.hasMore,false);assert.equal(final.linksHasMore,false);
  await assert.rejects(vm.runInNewContext(serviceReadScript('gitlab',REPO,{offset:5000}),doc),/Textgrenze/);
});

test('reader hard caps make incomplete visible views explicit, without pretending to index a full service',async()=>{
  const page=await vm.runInNewContext(serviceReadScript('gitlab',REPO),documentFixture({text:'x'.repeat(65000),links:Array.from({length:520},(_,i)=>link(REPO+'/-/issues/'+(i+1)))}));assert.equal(page.totalLength,60000);assert.equal(page.textTruncated,true);assert.equal(page.totalLinks,500);assert.equal(page.linksTruncated,true);
});

test('row attribution is observed rather than inferred, validates dates and redacts nested form drafts from snippets',async()=>{
  const row=element({tag:'article',text:'PRIVATE_ROW_FALLBACK'}),author=element({text:'Eine Lehrperson',parent:row}),posted=element({tag:'time',attrs:{datetime:'2026-10-14T10:00:00+02:00'},parent:row}),updated=element({tag:'time',attrs:{datetime:'2026-02-31T10:00:00+02:00'},parent:row}),anchor=link(ISSUE,'Aufgabe',{parent:row}),form=element({tag:'form',parent:row}),editable=element({attrs:{contenteditable:'true'},parent:row});
  row.querySelector=selector=>selector.startsWith('[rel=author]')?author:selector==='time[datetime]'?posted:selector==='time.updated[datetime]'?updated:null;
  const page=await vm.runInNewContext(serviceReadScript('gitlab',REPO),documentFixture({links:[anchor],nodes:[{textContent:'Aufgabe: Modelliere einen Greifarm.',parentElement:row},{textContent:'PRIVATE_FORM_DRAFT',parentElement:form},{textContent:'PRIVATE_EDITABLE_DRAFT',parentElement:editable}]}));
  assert.equal(page.items[0].postedBy,'Eine Lehrperson');assert.equal(page.items[0].postedAt,'2026-10-14T08:00:00.000Z');assert.equal(page.items[0].updatedAt,'');assert.equal(page.items[0].excerpt,'Aufgabe: Modelliere einen Greifarm.');assert.doesNotMatch(JSON.stringify(page),/PRIVATE_/);
});

test('read uses one hidden sandboxed persistent-profile view and annotates every returned source',async()=>{
  const f=fixture(),page=await f.api.handle(request('read'));assert.equal(page.sourceId,'course-git');assert.equal(page.projectId,'robotics');assert.equal(page.service,'gitlab');assert.equal(page.url,REPO);assert.equal(page.trust,'untrusted-source');assert.equal(page.checkedAt,'2026-10-14T12:00:00Z');assert.equal(page.coverage,'rendered-view');assert.equal(f.views.length,1);assert.equal(f.views[0].visible,false);
  assert.deepEqual(f.views[0].options.webPreferences,{partition:'persist:context-websites',nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,allowRunningInsecureContent:false,navigateOnDragDrop:false,focusOnNavigation:false});assert.deepEqual(f.views[0].webContents.popup({url:'https://evil.test/'}),{action:'deny'});
  await f.api.handle(request('read'));assert.equal(f.views.length,1);assert.equal(f.loads.length,1);f.api.dispose();assert.equal(f.destroyed.length,1);
});

test('arbitrary model URLs or scripts cannot create scopes, execute actions or bypass typed messages',async()=>{
  const f=fixture();for(const message of [null,[],{},request('post'),request('read',{url:REPO}),request('read',{script:'document.cookie'}),request('read',{sourceId:'missing'}),request('read',{offset:-1}),request('read',{expectedRevision:'not-a-hash'}),request('search',{query:''}),request('search',{query:'x',maxViews:5}),request('read-file',{url:RAW,projectId:'forged'})])await assert.rejects(async()=>f.api.handle(message));assert.equal(f.views.length,0);assert.equal(f.fetches.length,0);
});

test('opening follows only observed links tied to the same current source snapshot',async()=>{
  const f=fixture(),page=await f.api.handle(request('read'));
  await assert.rejects(f.api.handle(request('open',{url:REPO+'/-/issues/999',expectedRevision:page.contentRevision})),/gelesenen Links/);
  await assert.rejects(f.api.handle(request('open',{url:ISSUE})),/gelesenen Links/);
  const issue=await f.api.handle(request('open',{url:ISSUE,expectedRevision:page.contentRevision}));assert.equal(issue.url,ISSUE);assert.match(issue.text,/Kinematik/);assert.equal(f.loads.length,2);
});

test('changed content cannot reuse an earlier link or text paging lease',async()=>{
  const f=fixture(),page=await f.api.handle(request('read'));f.pageByURL[REPO]={text:'Geänderter Kurs',links:[link(ISSUE)]};
  await assert.rejects(f.api.handle(request('open',{url:ISSUE,expectedRevision:page.contentRevision})),error=>error.code==='CONTENT_CHANGED');assert.equal(f.loads.length,1);
  await assert.rejects(f.api.handle(request('read',{offset:1,expectedRevision:page.contentRevision})),error=>error.code==='CONTENT_CHANGED');
});

test('read-file performs an authenticated GET callback only for a current observed file and applies strict type and size checks',async()=>{
  const f=fixture(),page=await f.api.handle(request('read'));
  await assert.rejects(f.api.handle(request('read-file',{url:RAW.replace('README.md','other.md'),expectedRevision:page.contentRevision})),/angebotene Dateien/);assert.equal(f.fetches.length,0);
  const file=await f.api.handle(request('read-file',{url:RAW,expectedRevision:page.contentRevision}));assert.match(file.text,/eigentliche Aufgabenstellung/);assert.equal(file.coverage,'text-file');assert.equal(file.contentType,'text/markdown');assert.equal(f.fetches.length,1);assert.equal(f.fetches[0].options.maxBytes,2000000);assert.ok(f.fetches[0].options.signal instanceof AbortSignal);assert.equal(file.sourceId,'course-git');
  for(const value of [{text:'<script>bad</script>',contentType:'text/html'},{text:'x'.repeat(2000001),contentType:'text/plain'},{text:'okay',contentType:'text/plain',url:'https://evil.test/redirect'}]){const bad=fixture({fetchText:()=>value}),offered=await bad.api.handle(request('read'));await assert.rejects(bad.api.handle(request('read-file',{url:RAW,expectedRevision:offered.contentRevision})),error=>error.code==='UNSUPPORTED_FILE');bad.api.dispose();}
});

test('file windows reuse one bounded in-memory result, preserve UTF-16, and reject stale or account-crossing continuation',async()=>{
  const text='a'.repeat(4999)+'🧭'+'b'.repeat(5001),f=fixture({fetchText:()=>({text,contentType:'text/plain'})}),page=await f.api.handle(request('read')),file=await f.api.handle(request('read-file',{url:RAW,expectedRevision:page.contentRevision}));assert.equal(file.nextOffset,4999);
  const tail=await f.api.handle(request('read-file',{url:RAW,offset:file.nextOffset,expectedRevision:file.contentRevision})),last=await f.api.handle(request('read-file',{url:RAW,offset:tail.nextOffset,expectedRevision:file.contentRevision}));assert.equal(file.text+tail.text+last.text,text);assert.equal(f.fetches.length,1);
  await assert.rejects(f.api.handle(request('read-file',{url:RAW,offset:5000,expectedRevision:file.contentRevision})),/Textgrenze/);
  f.authRevision++;await assert.rejects(f.api.handle(request('read-file',{url:RAW,offset:4999,expectedRevision:file.contentRevision})),error=>error.code==='CONTENT_CHANGED');assert.equal(f.fetches.length,1);
});

test('large supported files are explicitly partial and retain at most 60000 characters',async()=>{
  const f=fixture({fetchText:()=>({text:'x'.repeat(90000),contentType:'application/json'})}),page=await f.api.handle(request('read')),file=await f.api.handle(request('read-file',{url:RAW,expectedRevision:page.contentRevision}));assert.equal(file.totalLength,60000);assert.equal(file.textTruncated,true);assert.equal(file.coverage,'partial');assert.equal(file.byteLength,90000);
});

test('cancelling a pending text GET aborts its signal and drops both late text and cached-file continuation',async()=>{
  const g=gate(),f=fixture({fetchText:async()=>{g.enter();await g.promise;return {text:'PRIVATE_LATE_FILE',contentType:'text/plain'};}}),page=await f.api.handle(request('read')),message=request('read-file',{url:RAW,expectedRevision:page.contentRevision}),pending=f.api.handle(message);await g.entered;await f.api.handle({action:'cancel',id:message.id});await assert.rejects(pending,error=>error.name==='AbortError');assert.equal(f.fetches[0].options.signal.aborted,true);g.release();await new Promise(resolve=>setImmediate(resolve));await assert.rejects(f.api.handle(request('read-file',{url:RAW,offset:1,expectedRevision:page.contentRevision})),error=>error.code==='CONTENT_CHANGED');
});

test('changing an account or course grant while a file GET is pending rejects the response before it enters a source cache',async()=>{
  for(const mutate of [f=>f.authRevision++,f=>f.grants=[]]){
    const g=gate(),f=fixture({fetchText:async()=>{g.enter();await g.promise;return {text:'PRIVATE_WRONG_ACCOUNT',contentType:'text/plain'};}}),page=await f.api.handle(request('read')),pending=f.api.handle(request('read-file',{url:RAW,expectedRevision:page.contentRevision}));await g.entered;mutate(f);g.release();await assert.rejects(pending,error=>['ACCOUNT_CHANGED','SOURCE_UNAVAILABLE'].includes(error.code));f.api.dispose();
  }
});

test('search walks a bounded set of only previously offered pages and returns source evidence with honest partial coverage',async()=>{
  const f=fixture(),result=await f.api.handle(request('search',{query:'Kinematik',maxViews:2}));assert.equal(result.viewsRead,2);assert.equal(result.results.length,1);assert.equal(result.results[0].url,ISSUE);assert.match(result.results[0].excerpt,/Kinematik/);assert.equal(result.coverage,'partial');assert.equal(result.bounded,true);assert.equal(result.documents[0].fileLinks[0].url,RAW);assert.equal(f.fetches.length,0);assert.ok(result.documents.every(doc=>doc.sourceId==='course-git'&&doc.text.length<=12000));
});

test('source registry changes during reads discard all late data',async()=>{
  const g=gate(),f=fixture({readHook:async()=>{g.enter();await g.promise;}}),pending=f.api.handle(request('read'));await g.entered;f.grants=[{...f.grants[0],revision:'two'}];g.release();await assert.rejects(pending,error=>error.code==='SOURCE_CHANGED');assert.equal(f.fetches.length,0);
});

test('an account revision change during processing rejects data; a new account cannot inherit observed-link leases',async()=>{
  const g=gate(),f=fixture({readHook:async()=>{g.enter();await g.promise;}}),pending=f.api.handle(request('read'));await g.entered;f.authRevision++;g.release();await assert.rejects(pending,error=>error.code==='ACCOUNT_CHANGED');
  const other=fixture(),page=await other.api.handle(request('read'));other.authRevision++;await assert.rejects(other.api.handle(request('open',{url:ISSUE,expectedRevision:page.contentRevision})),error=>error.code==='LINK_NOT_OFFERED');assert.equal(other.destroyed.length,1);assert.equal(other.loads.length,1);
});

test('navigation changes while a snapshot is pending cannot return content or retain a link lease',async()=>{
  const g=gate(),f=fixture({readHook:async()=>{g.enter();await g.promise;}}),pending=f.api.handle(request('read'));await g.entered;const wc=f.views[0].webContents;wc.emit('did-navigate-in-page',{},REPO,true);g.release();await assert.rejects(pending,error=>error.code==='NAVIGATION_CHANGED');
});

test('cancellation stops a pending native read and settles immediately without exposing a late result',async()=>{
  const g=gate(),f=fixture({readHook:async()=>{g.enter();await g.promise;}}),message=request('read'),pending=f.api.handle(message);await g.entered;assert.deepEqual(await f.api.handle({action:'cancel',id:message.id}),{cancelled:true});await assert.rejects(pending,error=>error.name==='AbortError');assert.equal(f.views[0].webContents.stops,1);g.release();await new Promise(resolve=>setImmediate(resolve));f.api.dispose();assert.equal(f.destroyed.length,1);
});

test('cancellation of a queued request does not stop the active reader',async()=>{
  const g=gate(),f=fixture({readHook:async()=>{g.enter();await g.promise;}}),first=f.api.handle(request('read'));await g.entered;const queued=request('read'),next=f.api.handle(queued);await f.api.handle({action:'cancel',id:queued.id});await assert.rejects(next,error=>error.name==='AbortError');assert.equal(f.views[0].webContents.stops,0);g.release();await first;
});

test('registry invalidation and disposal cancel native requests and remove event listeners',async()=>{
  const g=gate(),f=fixture({readHook:async()=>{g.enter();await g.promise;}}),pending=f.api.handle(request('read'));await g.entered;const wc=f.views[0].webContents;f.api.invalidate();await assert.rejects(pending,error=>error.name==='AbortError');g.release();f.api.dispose();assert.equal(wc.eventNames().length,0);await assert.rejects(f.api.handle(request('read')),error=>error.code==='DISPOSED');
});

test('a source change recycles the single hidden view and destroys the previous renderer',async()=>{
  const f=fixture();await f.api.handle(request('read'));f.grants.push({id:'sciebo-course',service:'sciebo',url:SCIEBO,projectId:'robotics'});await f.api.handle(request('read',{sourceId:'sciebo-course'}));assert.equal(f.views.length,2);assert.equal(f.destroyed.length,1);assert.equal(f.views.filter(view=>!view.webContents.closed).length,1);
});

test('async view creation that outlives cancellation is retired rather than leaking a renderer',async()=>{
  const g=gate(),f=fixture({createHook:async view=>{g.enter();await g.promise;return view;}}),message=request('read'),pending=f.api.handle(message);await g.entered;await f.api.handle({action:'cancel',id:message.id});await assert.rejects(pending,error=>error.name==='AbortError');g.release();await new Promise(resolve=>setImmediate(resolve));assert.equal(f.destroyed.length,1);assert.equal(f.views[0].webContents.closed,true);
});

test('authentication and scope redirects are blocked before reading and return only the original public source',async()=>{
  for(const redirect of ['https://git.coco.study/users/sign_in?redirect_uri=PRIVATE','https://auth.example.test/oauth/authorize?token=PRIVATE','https://git.coco.study/course/other/-/issues']){
    const f=fixture({loadHook:(wc,url)=>{let prevented=false;wc.emit('will-redirect',{preventDefault:()=>prevented=true},redirect);assert.equal(prevented,true);throw new Error('ERR_ABORTED');}}),page=await f.api.handle(request('read'));assert.equal(page.url,REPO);assert.equal(page.text,'');assert.equal(page.coverage,'none');assert.equal(page.loginRequired||page.navigationBlocked,true);assert.doesNotMatch(JSON.stringify(page),/PRIVATE|redirect_uri|authorize/);assert.equal(f.reads,0);
  }
});

test('HTTP authorization failures never get indexed as ordinary pages; unavailable pages fail honestly',async()=>{
  for(const [httpStatus,kind]of [[401,'loginRequired'],[403,'permissionRequired']]){const f=fixture({statuses:{[REPO]:httpStatus},pages:{[REPO]:{text:'PRIVATE_DENIED_BODY'}}}),page=await f.api.handle(request('read'));assert.equal(page[kind],true);assert.equal(page.text,'');assert.equal(page.coverage,'none');assert.equal(f.reads,0);f.api.dispose();}
  const f=fixture({statuses:{[REPO]:500}});await assert.rejects(f.api.handle(request('read')),error=>error.code==='HTTP_ERROR');assert.equal(f.reads,0);
});

test('a visible login handoff opens only the registered service source and collects no credentials',async()=>{
  const f=fixture(),value=await f.api.handle(request('open-login'));assert.equal(value.loginRequired,true);assert.equal(value.opened,true);assert.deepEqual(f.opened,[{url:REPO,metadata:{sourceId:'course-git',service:'gitlab'}}]);assert.equal(f.views.length,0);assert.equal(f.fetches.length,0);
});

test('pending admission and unique request IDs are bounded before any renderer work',async()=>{
  const g=gate(),f=fixture({readHook:async()=>{g.enter();await g.promise;}}),message=request('read'),first=f.api.handle(message);await g.entered;await assert.rejects(async()=>f.api.handle(message),error=>error.code==='BUSY');const queued=Array.from({length:3},()=>f.api.handle(request('read')));await assert.rejects(async()=>f.api.handle(request('read')),error=>error.code==='BUSY');g.release();await Promise.all([first,...queued]);assert.equal(SERVICE_READER_LIMITS.requests,4);
});
