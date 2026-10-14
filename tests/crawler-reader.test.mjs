import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {readScript,crawlerURL} from '../desktop/reader.mjs';

const COURSE='https://spaces.th-koeln.de/synthetic-course/';
function element({tag='div',id='',classes=[],attributes={},parent=null,visible=true,text='',href='',form=null}={}){
  const value={tag,id,classes,attributes,parent,innerText:text,href,form,getClientRects:()=>visible?[{}]:[],getAttribute:key=>attributes[key]??null};
  const matches=(node,selector)=>{
    const name=selector.match(/^[a-z][\w-]*/i)?.[0],ident=selector.match(/#([\w-]+)/)?.[1],classNames=[...selector.matchAll(/\.([\w-]+)/g)].map(m=>m[1]),attr=selector.match(/\[([\w-]+)(?:(\^?=)([^\]]+))?\]/),attribute=attr?(attr[1]==='id'?node.id:node.attributes[attr[1]]):undefined;
    return (!name||node.tag===name)&&(!ident||node.id===ident)&&classNames.every(c=>node.classes.includes(c))&&(!attr||attribute!==undefined&&(attr[2]===undefined||attr[2]==='^='?String(attribute).startsWith(attr[3]||''):attribute===attr[3]));
  };
  value.closest=selectors=>{for(let current=value;current;current=current.parent)if(selectors.split(',').some(selector=>matches(current,selector.trim())))return current;return null;};return value;
}
const link=(index,patch={})=>element({tag:'a',href:COURSE+'post-'+index+'/',text:'Synthetic post '+index,...patch});
const control=(index,patch={})=>element({tag:'button',id:'accordion-item-'+index,text:'Synthetic section '+index,...patch});
function fixture({text='Visible course material.',nodes,links=[],menuLinks=[],sidebarLinks=[],controls=[],posts=[],password=false,url=COURSE,title='Synthetic course'}={}){
  const root=element(),bodyNodes=nodes||[{textContent:text,parentElement:element()}];
  root.querySelectorAll=selector=>selector==='a[href]'?links:selector==='article,.post'?posts:[];
  const sidebar=element({id:'defaultspace-sticky-sidebar'});sidebar.querySelectorAll=()=>sidebarLinks;
  const document={title,body:root,querySelector:selector=>selector==='input[type=password]'?(password?element({tag:'input'}):null):selector==='#defaultspace-sticky-sidebar'?(sidebarLinks.length?sidebar:null):root,querySelectorAll:selector=>selector.includes('primary-swap-menu-label')?controls:menuLinks,createTreeWalker:scope=>{const selected=scope===root?bodyNodes:bodyNodes.filter(node=>{for(let parent=node.parentElement;parent;parent=parent.parent)if(parent===scope)return true;return false;});let i=0;return {nextNode:()=>selected[i++]||null};}};
  return {document,read:async(offset=0,options={})=>vm.runInNewContext(readScript(offset,{crawler:true,courseURL:COURSE,...options}),{document,location:{hostname:new URL(url).hostname,pathname:new URL(url).pathname,href:url},NodeFilter:{SHOW_TEXT:4},URL,crypto:webcrypto,TextEncoder,Uint8Array})};
}

test('crawler discovery pages all offered safe links without changing the legacy 45-link reader',async()=>{
  const anchors=Array.from({length:98},(_,i)=>link(i)),f=fixture({links:anchors});
  const first=await f.read(),second=await f.read(0,{linkOffset:45}),last=await f.read(0,{linkOffset:90});
  assert.equal(first.links.length,45);assert.equal(second.links.length,45);assert.equal(last.links.length,8);assert.equal(first.totalLinks,98);assert.equal(first.linksHasMore,true);assert.equal(last.linksHasMore,false);assert.equal(last.linkOffset,90);
  assert.equal(new Set([...first.links,...second.links,...last.links].map(item=>item.url)).size,98);assert.equal(first.contentRevision,second.contentRevision);assert.match(first.contentRevision,/^[a-f0-9]{64}$/);
  const legacy=vm.runInNewContext(readScript(),{document:f.document,location:{hostname:'spaces.th-koeln.de',pathname:'/synthetic-course/',href:COURSE},NodeFilter:{SHOW_TEXT:4},URL});assert.equal(legacy.links.length,45);assert.equal(legacy.linkOffset,undefined);
});

test('crawler includes observed course menus and footer post pagination, excluding global navigation, account and asset routes',async()=>{
  const footer=element({tag:'footer'}),pagination=element({tag:'nav',classes:['pagination'],parent:footer}),global=element({tag:'nav'}),header=element({tag:'header'}),form=element({tag:'form'}),sidebar=element({id:'defaultspace-sticky-sidebar'}),menu=element({id:'defaultspace-main-menu',tag:'nav'});
  const links=[link('ordinary'),link('next',{href:COURSE+'page/2/',parent:pagination}),link('icon-next',{href:COURSE+'page/3/',text:'',parent:pagination}),link('global',{parent:global}),link('header',{parent:header}),link('form',{parent:form}),link('hidden',{visible:false}),link('profile',{parent:sidebar}),link('external',{href:'https://example.org/'}),link('logout',{href:COURSE+'logout/'}),link('users',{href:COURSE+'users/one/'}),link('asset',{href:COURSE+'document.svg'}),link('token',{href:COURSE+'?token=DO_NOT_READ'})];
  const page=await fixture({links,menuLinks:[link('menu',{parent:menu})]}).read();
  assert.deepEqual(Array.from(page.links,item=>item.title),['Synthetic post ordinary','Synthetic post next','Kurslink','Synthetic post menu']);assert.equal(page.totalLinks,4);assert.equal(page.linksTruncated,false);
});

test('hard discovery caps return consistent offered counts and explicit truncation flags',async()=>{
  const f=fixture({links:Array.from({length:515},(_,i)=>link(i)),controls:Array.from({length:315},(_,i)=>control(i))});
  const page=await f.read(0,{linkOffset:495,controlOffset:290});
  assert.equal(page.totalLinks,500);assert.equal(page.links.length,5);assert.equal(page.linksHasMore,false);assert.equal(page.linksTruncated,true);
  assert.equal(page.totalControls,300);assert.equal(page.controls.length,10);assert.equal(page.controlsMore,false);assert.equal(page.controlsTruncated,true);
});

test('control paging exposes only visible, explicit non-form course navigation',async()=>{
  const controls=[...Array.from({length:34},(_,i)=>control(i)),control('form',{form:{}}),control('submit',{attributes:{type:'submit'}}),control('associated',{attributes:{form:'POST_FORM'}}),control('editable',{parent:element({attributes:{contenteditable:'true'}})}),control('header',{parent:element({tag:'header'})}),control('sidebar',{parent:element({id:'defaultspace-sticky-sidebar'})}),control('global-nav',{parent:element({tag:'nav'})}),control('hidden',{visible:false}),control('invalid/path')];
  const f=fixture({controls}),first=await f.read(),last=await f.read(0,{controlOffset:30});
  assert.equal(first.controls.length,30);assert.equal(first.totalControls,34);assert.equal(first.controlsMore,true);assert.equal(last.controls.length,4);assert.equal(last.controlsMore,false);assert.ok(last.controls.every(c=>/^accordion-item-\d+$/.test(c.id)));
});

test('UTF-16 text paging reaches the course tail without splitting surrogates or losing a character',async()=>{
  const full='a'.repeat(4999)+'🧭'+'b'.repeat(5001)+'TAIL_SENSOR',f=fixture({text:full});let offset=0,joined='',hash;
  for(let i=0;i<5;i++){const page=await f.read(offset);assert.equal(page.offset,offset);assert.ok(page.text.length<=5000);assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(page.text));hash??=page.contentRevision;assert.equal(page.contentRevision,hash);joined+=page.text;if(!page.hasMore)break;assert.ok(page.nextOffset>offset);offset=page.nextOffset;}
  assert.equal(joined,full);assert.match(joined,/TAIL_SENSOR$/);assert.equal((await f.read()).nextOffset,4999);await assert.rejects(f.read(5000),/Textgrenze/);
});

test('the 60000-character view boundary and long content are explicitly partial, never a fabricated full view',async()=>{
  const f=fixture({text:'a'.repeat(59999)+'🧭'+'b'.repeat(15000)}),page=await f.read(55000);
  assert.equal(page.totalLength,59999);assert.equal(page.nextOffset,59999);assert.equal(page.text.length,4999);assert.equal(page.hasMore,false);assert.equal(page.textTruncated,true);assert.equal(page.totalLengthKnown,false);assert.ok(page.originalObservedLength>60000);
});

test('form values, code, global navigation and sidebar profiles never enter crawler text or revision material',async()=>{
  const nodes=[{textContent:'Visible course content',parentElement:element()},...['form','script','style','nav','header','footer'].map(tag=>({textContent:'PRIVATE_'+tag,parentElement:element({parent:element({tag})})})),{textContent:'PRIVATE_sidebar',parentElement:element({parent:element({id:'defaultspace-sticky-sidebar'})})}];
  const page=await fixture({nodes}).read();assert.equal(page.text,'Visible course content');assert.doesNotMatch(JSON.stringify(page),/PRIVATE_|document.cookie|localStorage/);
  const password=await fixture({text:'DO_NOT_READ_LOGIN',password:true}).read();assert.equal(password.loginRequired,true);assert.equal(password.text,'');assert.deepEqual(Array.from(password.links),[]);
});

test('post metadata uses only actual post attribution and valid provider timestamps, with unknown time remaining empty',async()=>{
  const post=element({tag:'article'});post.querySelector=selector=>selector.includes('entry-title')&&!selector.startsWith('a[')?{innerText:'Synthetic article'}:selector.includes('rel=author')?{innerText:'Synthetic author'}:selector==='time[datetime]'?{getAttribute:()=> 'invalid'}:selector.includes('time.updated')?{getAttribute:()=> '2026-10-14T09:00:00Z'}:selector.startsWith('a[rel=bookmark]')?{href:COURSE+'article/'}:null;
  const page=await fixture({posts:[post],url:COURSE+'article/'}).read();assert.equal(page.metadata.postedBy,'Synthetic author');assert.equal(page.metadata.postedAt,'');assert.equal(page.metadata.updatedAt,'2026-10-14T09:00:00.000Z');assert.equal(page.metadata.posts[0].sourceURL,COURSE+'article/');
  const feed=await fixture({posts:[post]}).read();assert.equal(feed.metadata.postedBy,'');assert.equal(feed.metadata.updatedAt,'');assert.equal(feed.metadata.posts[0].postedBy,'Synthetic author');
  post.querySelector=selector=>selector==='.time_ago[data-timestamp]'?{getAttribute:()=> '1791552875'}:null;const epoch=await fixture({posts:[post]}).read();assert.equal(epoch.metadata.postedAt,'');assert.equal(epoch.metadata.posts[0].postedAt,new Date(1791552875*1000).toISOString());
});

test('revision changes for visible text and offered navigation changes, independently of paging cursors',async()=>{
  const f=fixture({text:'Version one',links:[link('one')]}),first=await f.read();f.document.title='Changed title';const title=await f.read();assert.notEqual(title.contentRevision,first.contentRevision);
  const another=await fixture({text:'Version two',links:[link('one')]}).read();assert.notEqual(another.contentRevision,first.contentRevision);
  const nav=await fixture({text:'Version one',links:[link('two')]}).read();assert.notEqual(nav.contentRevision,first.contentRevision);
});

test('relative clock ticks leave crawler text, lengths, link labels and revisions stable without changing the legacy reader',async()=>{
  const anchor=link('clock',{text:'Beitrag vor 1 Minute'}),clock=element({classes:['time_ago'],attributes:{'data-timestamp':'1791552875'},parent:anchor}),child=element({parent:clock});anchor.querySelector=()=>clock;
  const nodes=[{textContent:'a'.repeat(5100),parentElement:element()},{textContent:'Beitrag',parentElement:anchor},{textContent:'vor',parentElement:clock},{textContent:'1 Minute',parentElement:child}],f=fixture({nodes,links:[anchor]});
  const first=await f.read(),tail=await f.read(5000),iso=new Date(1791552875*1000).toISOString();
  assert.equal(first.links[0].title,'Beitrag '+iso);assert.equal(tail.text.split(iso).length-1,1);assert.doesNotMatch(tail.text,/vor|Minute/);
  nodes[3].textContent='2 Minuten';anchor.innerText='Beitrag vor 2 Minuten';const ticked=await f.read(),tickedTail=await f.read(5000);
  assert.equal(ticked.text,first.text);assert.equal(tickedTail.text,tail.text);assert.equal(ticked.totalLength,first.totalLength);assert.equal(ticked.originalObservedLength,first.originalObservedLength);assert.equal(ticked.contentRevision,first.contentRevision);assert.equal(ticked.links[0].title,first.links[0].title);
  const legacy=vm.runInNewContext(readScript(5000),{document:f.document,location:{hostname:'spaces.th-koeln.de',pathname:'/synthetic-course/',href:COURSE},NodeFilter:{SHOW_TEXT:4},URL});assert.match(legacy.text,/vor\n2 Minuten/);
  clock.attributes['data-timestamp']='1791552935';assert.notEqual((await f.read()).contentRevision,first.contentRevision);
  clock.attributes['data-timestamp']='1791552875';nodes[0].textContent='b'+nodes[0].textContent.slice(1);assert.notEqual((await f.read()).contentRevision,first.contentRevision);
});

test('valid datetime elements and nested control clocks emit one ISO value per element without mutating the DOM',async()=>{
  const date=element({tag:'time',attributes:{datetime:'2026-10-14T09:00:00+02:00'}}),nested=element({parent:date}),button=control('clock'),clock=element({classes:['time_ago'],attributes:{'data-timestamp':'1791552875000'},parent:button});button.querySelector=()=>clock;
  const nodes=[{textContent:'vor',parentElement:date},{textContent:'einer Minute',parentElement:nested},{textContent:'Abschnitt',parentElement:button},{textContent:'vor einer Minute',parentElement:clock}],f=fixture({nodes,controls:[button]}),first=await f.read();
  assert.equal(first.text,'2026-10-14T07:00:00.000Z');assert.equal(first.controls[0].title,'Abschnitt '+new Date(1791552875000).toISOString());assert.equal(nodes[1].textContent,'einer Minute');assert.equal(date.attributes.datetime,'2026-10-14T09:00:00+02:00');
  nodes[1].textContent='zwei Minuten';nodes[3].textContent='vor zwei Minuten';assert.equal((await f.read()).contentRevision,first.contentRevision);
  date.attributes.datetime='2026-10-14T09:01:00+02:00';assert.notEqual((await f.read()).contentRevision,first.contentRevision);
});

test('invalid clock markers and ordinary numeric or datetime-like content remain visible and revision-fenced',async()=>{
  const nodes=[{textContent:'Ordentliche Zahl 1791552875',parentElement:element()},...['invalid','99','2026-02-30T09:00:00Z','2026-10-14T24:00:00Z'].map(value=>({textContent:'Originalzeit '+value,parentElement:element({tag:'time',attributes:{datetime:value}})})),{textContent:'Ungültiger Epochwert',parentElement:element({classes:['time_ago'],attributes:{'data-timestamp':'999999999999999999'}})},{textContent:'Kein bekannter Zeitmarker',parentElement:element({attributes:{'data-timestamp':'1791552875',datetime:'2026-10-14T09:00:00Z'}})}];
  const f=fixture({nodes}),first=await f.read();assert.equal(first.text,nodes.map(node=>node.textContent).join('\n'));
  nodes[1].textContent='Extern korrigierter Zeittext';assert.notEqual((await f.read()).contentRevision,first.contentRevision);
});

test('native crawler course URL validation rejects encoded traversal, nested encoding, accounts, binaries and unscoped courses',()=>{
  assert.equal(crawlerURL(COURSE+'page/2/?paged=2',COURSE),COURSE+'page/2/?paged=2');
  assert.equal(crawlerURL('https://spaces.th-koeln.de/2026/10/14/course-post/',COURSE),'https://spaces.th-koeln.de/2026/10/14/course-post/');
  for(const url of [COURSE+'../other/',COURSE+'%2e%2e/other/',COURSE+'%2525252525252e%2525252525252e/other/',COURSE+'%255cusers/',COURSE+'?paged=0',COURSE+'?paged=1&paged=2',COURSE+'?s=private',COURSE+'users/one/',COURSE+'attachment/',COURSE+'file.webm','https://spaces.th-koeln.de/other-course/','https://spaces.th-koeln.de/','https://u:p@spaces.th-koeln.de/synthetic-course/','https://example.org/synthetic-course/'])assert.throws(()=>crawlerURL(url,COURSE),url);
  assert.throws(()=>crawlerURL('https://spaces.th-koeln.de/','https://spaces.th-koeln.de/'));
});

function boardPost({sourceURL=COURSE+'article/',postedBy='Synthetic post author',postedAt='2026-10-14T09:00:00+02:00',title='Actual synthetic workshop'}={}){
  const post=element({tag:'article'});post.querySelector=selector=>selector.startsWith('a[rel=bookmark]')?(sourceURL?{href:sourceURL}:null):selector.includes('entry-title')?{innerText:title}:selector.includes('rel=author')?{innerText:postedBy}:selector==='time[datetime]'?{getAttribute:()=>postedAt}:null;return post;
}

test('rendered Miro anchor labels retain the canonical href and real enclosing-post evidence without leaking invitation tokens',async()=>{
  const post=boardPost(),anchor=element({tag:'a',parent:post,text:'Unser Miroboard',href:'https://www.miro.com/app/board/abcd%3D/?share_link_id=INVITATION_TOKEN_PRIVATE#PRIVATE_FRAGMENT'});
  const f=fixture({links:[anchor],posts:[post],nodes:[{textContent:'Unser Miroboard',parentElement:anchor}]}),page=await f.read();
  assert.equal(page.text,'Unser Miroboard');assert.equal(page.links.length,0);assert.equal(page.boardLinks.length,1);const board=page.boardLinks[0];
  assert.equal(board.url,'https://miro.com/app/board/abcd=/');assert.equal(board.title,'Unser Miroboard');assert.equal(board.postedBy,'Synthetic post author');assert.equal(board.postedAt,'2026-10-14T07:00:00.000Z');assert.equal(board.sourceTitle,'Actual synthetic workshop');assert.equal(board.sourceURL,COURSE+'article/');assert.equal(page.metadata.postedBy,'');assert.equal(page.boardLinksMore,false);
  assert.doesNotMatch(JSON.stringify(page),/INVITATION_TOKEN_PRIVATE|PRIVATE_FRAGMENT|share_link_id/);
});

test('Miro references in comments, sidebars and ambiguous posts cannot inherit somebody else’s author or timestamp',async()=>{
  const post=boardPost(),comment=element({classes:['comment-body'],parent:post}),sidebar=element({id:'defaultspace-sticky-sidebar'}),missing=boardPost({sourceURL:''}),foreign=boardPost({sourceURL:'https://spaces.th-koeln.de/another-course/post/'});
  const anchors=[element({tag:'a',parent:comment,text:'Comment board',href:'https://miro.com/app/board/comment/'}),element({tag:'a',parent:missing,text:'Ambiguous board',href:'https://miro.com/app/board/missing/'}),element({tag:'a',parent:foreign,text:'Foreign-source board',href:'https://miro.com/app/board/foreign/'})],side=element({tag:'a',parent:sidebar,text:'Visible sidebar board',href:'https://miro.com/app/board/sidebar/'});
  const page=await fixture({links:anchors,sidebarLinks:[side]}).read();assert.equal(page.boardLinks.length,4);
  for(const board of page.boardLinks){assert.equal(board.postedBy,'');assert.equal(board.postedAt,'');assert.equal(board.sourceURL,COURSE);}
  for(const postedAt of ['99','2026-02-30T09:00:00Z','not-a-timestamp']){const item=boardPost({postedAt}),anchor=element({tag:'a',parent:item,text:'A board',href:'https://miro.com/app/board/safe/'});assert.equal((await fixture({links:[anchor]}).read()).boardLinks[0].postedAt,'');}
});

test('Miro metadata is bounded to100 visible safe anchors and does not open Miro or collect hidden/form/navigation references',async()=>{
  const make=(index,patch={})=>element({tag:'a',text:'Board '+index,href:'https://miro.com/app/board/board'+index+'/?token=DO_NOT_COPY',...patch});
  const anchors=Array.from({length:101},(_,i)=>make(i)),page=await fixture({links:anchors}).read();assert.equal(page.boardLinks.length,100);assert.equal(page.boardLinksMore,true);assert.doesNotMatch(JSON.stringify(page),/DO_NOT_COPY/);
  assert.equal((await fixture({links:anchors.slice(0,100)}).read()).boardLinksMore,false);
  const unsafe=[make('hidden',{visible:false}),make('form',{parent:element({tag:'form'})}),make('nav',{parent:element({tag:'nav'})}),make('header',{parent:element({tag:'header'})}),make('login',{href:'https://miro.com/login/'}),make('spoof',{href:'https://miro.com.evil.invalid/app/board/abcd/'}),make('credentials',{href:'https://u:p@miro.com/app/board/abcd/'}),make('scheme',{href:'http://miro.com/app/board/abcd/'}),make('invalid-id',{href:'https://miro.com/app/board/ab/'})];
  const excluded=await fixture({links:unsafe}).read();assert.equal(excluded.boardLinks.length,0);assert.equal(excluded.boardLinksMore,false);
});

test('canonical Miro target, label and attribution changes alter the fenced revision while invitation-token rotation does not',async()=>{
  const post=boardPost(),anchor=element({tag:'a',parent:post,text:'Unser Miroboard',href:'https://miro.com/app/board/abcd/?token=FIRST_SECRET'}),f=fixture({links:[anchor]});
  const first=await f.read();anchor.href='https://miro.com/app/board/abcd/?token=SECOND_SECRET';assert.equal((await f.read()).contentRevision,first.contentRevision);
  anchor.href='https://miro.com/app/board/efgh/';const target=await f.read();assert.notEqual(target.contentRevision,first.contentRevision);
  anchor.innerText='Unser anderes Miroboard';const label=await f.read();assert.notEqual(label.contentRevision,target.contentRevision);
  post.querySelector=selector=>selector.startsWith('a[rel=bookmark]')?{href:COURSE+'article/'}:selector.includes('rel=author')?{innerText:'Different actual author'}:null;assert.notEqual((await f.read()).contentRevision,label.contentRevision);
});
