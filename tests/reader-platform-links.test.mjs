import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createHash,webcrypto} from 'node:crypto';
import {offeredPlatformURL,readScript,readerSHA256,normalReaderURL,crawlerURL} from '../desktop/reader.mjs';
import {normalizePlatformURL,platformCatalog} from '../dist/source-catalog.js';
import {coursePlatformFindings} from '../dist/platform-links.js';

const COURSE='https://spaces.th-koeln.de/synthetic-course/',PAGE=COURSE+'orga/resources/';
const board='https://miro.com/app/board/synthetic-board=/',repo='https://git.coco.study/course/project',folder='https://th-koeln.sciebo.de/s/Synthetic_share?path=%2FCourse',channel='https://chat.coco.study/students/channels/robotics';
function element({tag='div',id='',classes=[],attrs={},parent=null,visible=true,text='',href='',style={},nodeType}={}){
  const el={tag,id,classes,attrs,parent,innerText:text,href,style,nodeType,getClientRects:()=>visible?[{}]:[],getAttribute:key=>attrs[key]??null};
  const matches=(el,selector)=>{
    const name=selector.match(/^[a-z][\w-]*/i)?.[0],ident=selector.match(/#([\w-]+)/)?.[1],classes=[...selector.matchAll(/\.([\w-]+)/g)].map(m=>m[1]),attribute=selector.match(/\[([\w-]+)(?:(\^?=)([^\]]+))?\]/);
    const value=attribute?(attribute[1]==='id'?el.id:el.attrs[attribute[1]]):undefined;
    return (!name||el.tag===name)&&(!ident||el.id===ident)&&classes.every(c=>el.classes.includes(c))&&(!attribute||value!==undefined&&(attribute[2]===undefined||attribute[2]==='^='?String(value).startsWith(attribute[3]||''):value===attribute[3]));
  };
  el.closest=selectors=>{for(let current=el;current;current=current.parent)if(selectors.split(',').some(selector=>matches(current,selector.trim())))return current;return null;};return el;
}
const link=(href,patch={})=>element({tag:'a',text:'Kursressource',href,...patch});
function post({permalink=PAGE+'article/',title='Aufgaben Woche 1',poster='Anna Lehrerin',date='2026-10-14T09:00:00+02:00',epoch,hidden=false}={}){
  const el=element({tag:'article',visible:!hidden}),values={heading:element({parent:el,text:title}),author:element({parent:el,text:poster}),time:date?{getAttribute:()=>date}:null,permalink:permalink?{href:permalink}:null,epoch:epoch?{getAttribute:()=>epoch}:null};
  el.querySelector=selector=>selector.startsWith('a[rel=bookmark]')?values.permalink:selector.includes('entry-title')&&!selector.includes('updated')?values.heading:selector.includes('rel=author')?values.author:selector==='time[datetime]'?values.time:selector==='.time_ago[data-timestamp]'?values.epoch:null;return el;
}
function fixture({links=[],sidebarLinks=[],menuLinks=[],nodes,controls=[],posts=[],url=PAGE,title='Kursressourcen',password=false}={}){
  const root=element(),sidebar=element({id:'defaultspace-sticky-sidebar'}),bodyNodes=nodes||[{textContent:'Aufgabenstellung und Ressourcen',parentElement:root}],visited={total:0,root:0,labels:0};
  root.querySelectorAll=selector=>selector==='a[href]'?links:selector==='article,.post'?posts:[];sidebar.querySelectorAll=()=>sidebarLinks;
  const document={title,body:root,querySelector:selector=>selector==='input[type=password]'?(password?element({tag:'input'}):null):selector==='#defaultspace-sticky-sidebar'?(sidebarLinks.length?sidebar:null):root,querySelectorAll:selector=>selector.includes('primary-swap-menu-label')?controls:menuLinks,createTreeWalker:scope=>{
    const selected=scope===root?bodyNodes:bodyNodes.filter(node=>{for(let p=node.parentElement;p;p=p.parent)if(p===scope)return true;return false;});let index=0;
    return {nextNode:()=>{visited.total++;visited[scope===root?'root':'labels']++;return selected[index++]||null;}};
  }};
  const state={document,visited,read:async(crawler=false,offset=0,options={})=>vm.runInNewContext(readScript(offset,{crawler,...(crawler?{courseURL:COURSE}:{}),...options}),{document,location:{hostname:new URL(url).hostname,pathname:new URL(url).pathname,href:url},URL,NodeFilter:{SHOW_TEXT:4},crypto:webcrypto,TextEncoder,Uint8Array,getComputedStyle:el=>({display:'block',visibility:'visible',opacity:'1',...el.style})})};return state;
}

test('strict platform discovery canonicalizes only pinned read-only board, repository, folder/share and channel links',()=>{
  const valid=[board+'?share_link_id=PRIVATE_INVITE#fragment',repo,repo+'/-/issues/5?page=2',repo+'/-/blob/main/README.md',folder,'https://th-koeln.sciebo.de/index.php/apps/files/?dir=%2FCourse&fileid=42',channel,'https://chat.coco.study/students/pl/'+'a'.repeat(26)];
  for(const href of valid){const found=offeredPlatformURL(href);assert.equal(normalizePlatformURL(found.service,found.url),found.url);assert.doesNotMatch(found.url,/PRIVATE_INVITE|fragment/);}
  assert.deepEqual(offeredPlatformURL('https://www.miro.com/app/board/abcd%3D/?token=SECRET'),{service:'miro',url:'https://miro.com/app/board/abcd=/'});
  assert.equal(offeredPlatformURL('https://th-koeln.sciebo.de/').url,'https://th-koeln.sciebo.de/index.php/apps/files/?dir=%2F');
});

test('discovery rejects authentication/errors, writes, secrets, arbitrary files, API/download URLs and host/path/query tricks',()=>{
  const unsafe=['https://miro.com/app/board/abcd/../other/','https://miro.com/app/board/abcd%252fprivate/','https://miro.com/login/',repo+'/-/issues/new',repo+'/-/issues/5/edit',repo+'/-/raw/main/README.md',repo+'/-/blob/main/.env.production',repo+'/-/tree/main/.aws/',repo+'/-/blob/main/secrets/README.md',repo+'/-/blob/main/api-key.txt',repo+'?access_token=PRIVATE',repo+'?page=1&page=2',repo+'?page=not-a-number','https://git.coco.study/users/anna',repo+'/../../admin/','https://th-koeln.sciebo.de/f/42','https://th-koeln.sciebo.de/index.php/f/42','https://th-koeln.sciebo.de/remote.php/dav/files/user/Course','https://th-koeln.sciebo.de/s/Synthetic_share/download?files=README.md',folder+'&password=PRIVATE','https://th-koeln.sciebo.de/s/Synthetic_share?path=%252F..%252Fprivate','https://th-koeln.sciebo.de/index.php/apps/files/?dir=%2F.aws',channel+'?token=PRIVATE','https://chat.coco.study/error?message=PRIVATE','https://chat.coco.study/students/channels/robotics/logout','http://git.coco.study/course/project','https://git.coco.study.evil.test/course/project','https://u:p@git.coco.study/course/project','https://git.coco.study:444/course/project','https://__proto__/','https://chat.coco.study/students/channels/robotics\\private'];
  for(const href of unsafe)assert.throws(()=>offeredPlatformURL(href),href);
});

for(const crawler of [false,true]){
  const mode=crawler?'crawler':'normal reader';
  test(`${mode}: actual visible offered links retain course-page witness and post provenance without creator guesses`,async()=>{
    const owner=post(),links=[link(board+'?token=PRIVATE',{parent:owner,text:'Aufgabenboard'}),link(repo,{parent:owner,text:'Quellcode'}),link(folder,{parent:owner,text:'Abgabeordner'}),link(channel,{parent:owner,text:'Kurschat'})];
    const page=await fixture({links,posts:[owner]}).read(crawler);assert.equal(page.platformLinks.length,4);assert.equal(page.platformLinksMore,false);assert.match(page.contentRevision,/^[a-f0-9]{64}$/);
    assert.deepEqual(Array.from(page.platformLinks,x=>x.service),['miro','gitlab','sciebo','mattermost']);
    for(const row of page.platformLinks){assert.equal(row.sourceURL,PAGE);assert.equal(row.sourceTitle,'Aufgaben Woche 1');assert.equal(row.postedBy,'Anna Lehrerin');assert.equal(row.postedAt,'2026-10-14T07:00:00.000Z');assert.equal(row.creator,undefined);assert.deepEqual(Object.keys(row),['service','url','title','sourceURL','sourceTitle','postedBy','postedAt']);}
    assert.equal(page.boardLinks.length,1);assert.equal(page.boardLinks[0].sourceURL,PAGE+'article/');assert.doesNotMatch(JSON.stringify(page),/PRIVATE|document.cookie|localStorage/);
  });
  test(`${mode}: comment/sidebar/hidden/ambiguous attribution stays unknown; form/editable/navigation links stay excluded`,async()=>{
    const owner=post(),comment=element({classes:['comment-body'],parent:owner}),sidebar=element({id:'defaultspace-sticky-sidebar',parent:owner}),ambiguous=post({permalink:''}),foreign=post({permalink:'https://spaces.th-koeln.de/another-course/post/'}),hiddenOwner=post({hidden:true});
    const safe=[link(board,{parent:comment}),link(repo,{parent:ambiguous}),link(folder,{parent:foreign}),link(channel,{parent:hiddenOwner})],side=link(repo+'-sidebar',{parent:sidebar});
    const unsafe=[link(repo+'-hidden',{visible:false}),link(repo+'-aria',{parent:element({attrs:{'aria-hidden':'true'}})}),link(repo+'-css',{style:{visibility:'hidden'}}),link(repo+'-opacity',{style:{opacity:'0'}}),link(repo+'-form',{parent:element({tag:'form'})}),link(repo+'-editable',{parent:element({attrs:{contenteditable:'true'}})}),...['nav','header','footer'].map(tag=>link(repo+'-'+tag,{parent:element({tag})}))];
    const page=await fixture({links:[...safe,...unsafe],sidebarLinks:[side]}).read(crawler);assert.equal(page.platformLinks.length,5);
    for(const row of page.platformLinks){assert.equal(row.sourceURL,PAGE);assert.equal(row.postedBy,'');assert.equal(row.postedAt,'');}
    assert.equal(page.platformLinks.find(row=>row.url===repo+'-sidebar').sourceTitle,'Kursressourcen');
  });
  test(`${mode}: revision fences href-only changes, including beyond the 100 returned rows, and ignores stripped invitation rotation`,async()=>{
    const anchor=link(board+'?token=FIRST_PRIVATE'),f=fixture({links:[anchor]});const first=await f.read(crawler);anchor.href=board+'?token=SECOND_PRIVATE';assert.equal((await f.read(crawler)).contentRevision,first.contentRevision);
    anchor.href=repo;const changed=await f.read(crawler);assert.notEqual(changed.contentRevision,first.contentRevision);anchor.href=repo+'-changed';assert.notEqual((await f.read(crawler)).contentRevision,changed.contentRevision);
    const links=Array.from({length:101},(_,n)=>link(repo+'-'+n)),capped=fixture({links}),before=await capped.read(crawler);assert.equal(before.platformLinks.length,100);assert.equal(before.platformLinksMore,true);
    links[100].href=repo+'-last-changed';const after=await capped.read(crawler);assert.notEqual(after.contentRevision,before.contentRevision);assert.equal(JSON.stringify(after.platformLinks),JSON.stringify(before.platformLinks));
    const paged=await capped.read(crawler,5000,{linkOffset:45});assert.equal(paged.contentRevision,after.contentRevision);assert.equal(JSON.stringify(paged.platformLinks),JSON.stringify(after.platformLinks));
  });
  test(`${mode}: duplicate anchors/URLs have one finding and exactly 100 complete rows remain complete`,async()=>{
    const links=Array.from({length:100},(_,n)=>link(repo+'-'+n)),page=await fixture({links:[...links,links[0],link(repo+'-0')],sidebarLinks:[links[1]]}).read(crawler);
    assert.equal(page.platformLinks.length,100);assert.equal(page.platformLinksMore,false);assert.equal(new Set(page.platformLinks.map(row=>row.url)).size,100);
  });
  test(`${mode}: anchor/DOM budgets include empty and excluded entries, and report unknown remaining coverage`,async()=>{
    const hidden=link(repo,{visible:false}),anchors=Array(5000).fill(hidden);anchors.push(link(repo+'-late'));const page=await fixture({links:anchors}).read(crawler);assert.equal(page.platformLinks.length,0);assert.equal(page.platformLinksMore,true);
    const nodes=Array.from({length:50001},()=>({textContent:'',parentElement:element({tag:'form'})})),f=fixture({nodes});const empty=await f.read(crawler);assert.equal(empty.text,'');assert.equal(empty.textTruncated,true);assert.equal(f.visited.root,50001);if(crawler)assert.equal(empty.totalLengthKnown,false);
  });
  test(`${mode}: actual DOM labels never include nested form values or hidden draft text and have independent traversal budgets`,async()=>{
    const anchor=link(repo,{nodeType:1,text:'IGNORED_INNERTEXT_PRIVATE'}),draft=element({parent:anchor,attrs:{contenteditable:'true'}}),input=element({tag:'textarea',parent:anchor}),visible=element({parent:anchor});
    const nodes=[{textContent:'Abgabeprojekt',parentElement:visible},{textContent:'PRIVATE_DRAFT',parentElement:draft},{textContent:'PRIVATE_FORM',parentElement:input}];anchor.querySelector=()=>null;
    const page=await fixture({links:[anchor],nodes}).read(crawler);assert.equal(page.platformLinks[0].title,'Abgabeprojekt');assert.doesNotMatch(JSON.stringify(page),/PRIVATE_/);
    const huge=Array.from({length:5001},()=>({textContent:'',parentElement:input}));huge.push({textContent:'PRIVATE_AFTER_LABEL_BUDGET',parentElement:visible});const capped=fixture({links:[anchor],nodes:huge});const result=await capped.read(crawler);assert.equal(result.platformLinks[0].title,'');assert.doesNotMatch(JSON.stringify(result.platformLinks),/PRIVATE_AFTER/);assert.ok(capped.visited.labels<=10002);
  });
  test(`${mode}: login/error/admin pages never provide source bodies, links or a misleading revision`,async()=>{
    for(const params of [{password:true},{url:COURSE+'error/'},{url:COURSE+'wp-admin/'},{url:COURSE+'login/'}]){
      const result=await fixture({...params,links:[link(repo)],nodes:[{textContent:'PRIVATE_DENIED_BODY',parentElement:element()}]}).read(crawler);assert.equal(result.text,'');assert.equal(result.platformLinks.length,0);assert.equal(result.contentRevision,undefined);assert.doesNotMatch(JSON.stringify(result),/PRIVATE_DENIED_BODY/);
    }
  });
  test(`${mode}: reader → current finding catalog makes all four observed course services usable and revokes them after relink`,async()=>{
    const workspace={projects:[{id:'course',links:[{tool:'spaces',url:COURSE}]}],tools:[],boardFindings:[],platformFindings:[]};
    const page=await fixture({links:[board,repo,folder,channel].map(href=>link(href))}).read(crawler);workspace.platformFindings=coursePlatformFindings(page,{workspace,projectId:'course',now:'2026-10-14T10:00:00Z'});
    assert.equal(workspace.platformFindings.length,4);assert.deepEqual(platformCatalog(workspace).map(row=>row.service),['miro','gitlab','sciebo','mattermost']);assert.ok(platformCatalog(workspace).every(row=>row.projectId==='course'));
    workspace.projects[0].links[0].url='https://spaces.th-koeln.de/relinked/';assert.equal(platformCatalog(workspace).length,0);
  });
}

test('normal revision SHA-256 matches the platform implementation for UTF-8, surrogates and padding boundaries',()=>{
  for(const text of ['', 'abc','Grüße aus Köln 🧭','\uD800','\uDC00','a'.repeat(55),'a'.repeat(56),'a'.repeat(63),'a'.repeat(64),'Ö'.repeat(10000)])assert.equal(readerSHA256(text),createHash('sha256').update(text,'utf8').digest('hex'));
});

test('normal Spaces search retains one short German query after strict path validation; the crawler still rejects search routes',async()=>{
  const input=PAGE+'?s=Pr%C3%BCfung+%C3%9Cbung&paged=2',canonical=PAGE+'?paged=2&s=Pr%C3%BCfung+%C3%9Cbung';assert.equal(normalReaderURL(input),canonical);
  assert.equal(normalReaderURL(PAGE+'?s=Suche',COURSE+'?s=Start'),PAGE+'?s=Suche');
  const result=await fixture({url:input,links:[link(repo)]}).read(false);assert.equal(result.url,canonical);assert.equal(result.platformLinks.length,1);assert.equal(result.platformLinks[0].sourceURL,canonical);
  for(const url of [PAGE+'?s=eins&s=zwei',PAGE+'?s='+('a'.repeat(201)),PAGE+'?s=privat%0Asecret',PAGE+'?s=privat%7Fsecret',PAGE+'?s=gut&token=PRIVATE',COURSE+'../another-course/?s=Deutsch',COURSE+'%252e%252e/another-course/?s=Deutsch']){
    assert.throws(()=>normalReaderURL(url),url);const denied=await fixture({url}).read(false);assert.equal(denied.text,'');assert.equal(denied.platformLinks.length,0);assert.equal(denied.contentRevision,undefined);
  }
  assert.throws(()=>normalReaderURL(PAGE+'?s=Suche',COURSE+'?s=eins&s=zwei'));
  assert.throws(()=>crawlerURL(input,COURSE));await assert.rejects(fixture({url:input}).read(true),/lesender Kursinhalte/);
});

test('discovery never fetches, navigates, mutates page content, accesses cookies/storage or invokes page-owned JavaScript',()=>{
  for(const crawler of [false,true])assert.doesNotMatch(readScript(0,{crawler,...(crawler?{courseURL:COURSE}:{})}),/document\.cookie|localStorage|sessionStorage|fetch\(|\.click\(|\.submit\(|\.value\b|innerHTML|outerHTML|eval\(/);
});
