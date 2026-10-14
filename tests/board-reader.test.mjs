import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {readScript} from '../desktop/reader.mjs';
function run({comment=false,form=false,encoded=false,sidebarOnly=false,spacesMarkup=false,sidebarText=false,epoch='1791552875'}={}){
 const post={querySelector:s=>s.startsWith('a[rel=bookmark]')?{href:'https://spaces.th-koeln.de/course/post/'}:s.includes('entry-title')?{innerText:'Workshop'}:s.includes('rel=author')?{innerText:spacesMarkup?'Alex Beispiel':'Alex'}:s==='time[datetime]'?(spacesMarkup?null:{getAttribute:()=> '2026-10-12T09:00:00Z'}):s==='.time_ago[data-timestamp]'?(spacesMarkup?{getAttribute:()=>epoch}:null):null};
 const anchor={href:encoded?'https://miro.com/app/board/abcd%3D/?token=private':'https://miro.com/app/board/abcd/?token=private#secret',innerText:'Kursboard',getClientRects:()=>[{}],getAttribute:()=>null,closest:s=>s.includes('.comment')?(comment?{}:null):s==='article,.post'&&!sidebarOnly?post:null};
 const control={id:'secondary-swap-menu-label',innerText:'Orga',getClientRects:()=>[{}],getAttribute:()=>null,form:form?{}:null,closest:()=>null};
 const root={querySelectorAll:()=>sidebarOnly?[]:[anchor]},sidebar={querySelectorAll:()=>[anchor]};
 const privateNode={textContent:'Sidebar Mitglied Profil',parentElement:{closest:s=>s.includes('#defaultspace-sticky-sidebar')?{}:null,getClientRects:()=>[{}]}};
 const doc={title:'Kursseite',body:root,querySelector:s=>s==='input[type=password]'?null:s==='#defaultspace-sticky-sidebar'?sidebar:root,querySelectorAll:s=>s.includes('swap-menu-label')?[control]:[],createTreeWalker:()=>{let delivered=false;return {nextNode:()=>sidebarText&&!delivered?(delivered=true,privateNode):null};}};
 return vm.runInNewContext(readScript(),{document:doc,location:{hostname:'spaces.th-koeln.de',pathname:'/course/',href:'https://spaces.th-koeln.de/course/'},NodeFilter:{SHOW_TEXT:4},URL});
}
test('native reader preserves link metadata from an actual containing post, without invitation keys',()=>{const page=run();assert.equal(page.boardLinks.length,1);const b=page.boardLinks[0];assert.equal(b.url,'https://miro.com/app/board/abcd/');assert.equal(b.postedBy,'Alex');assert.equal(b.postedAt,'2026-10-12T09:00:00Z');assert.equal(b.sourceURL,'https://spaces.th-koeln.de/course/post/');assert.equal(page.links.length,0);assert.equal(page.controls.length,1);});
test('a comment link cannot inherit the enclosing post author or timestamp',()=>{const b=run({comment:true}).boardLinks[0];assert.equal(b.postedBy,'');assert.equal(b.postedAt,'');assert.equal(b.sourceURL,'https://spaces.th-koeln.de/course/');});
test('form-associated navigation controls are never offered to the scanner',()=>{assert.equal(run({form:true}).controls.length,0);});
test('native scan view is outside user tabs and clicks recheck form binding at execution time',async()=>{
 const source=await readFile(new URL('../desktop/main.mjs',import.meta.url),'utf8'),scan=source.slice(source.indexOf('function scanTab()'),source.indexOf('async function loaded'));
 assert.doesNotMatch(scan,/tabs\.set|select\(|active=/);assert.match(scan,/providerPreferences\(\)/);assert.match(source,/message\.scan===true\?scanTab\(\)/);
 assert.match(scan,/focusOnNavigation:false/);assert.match(source,/scanningView\.setBackgroundThrottling\(false\)/);assert.match(source,/finally\{[^\n]*scanningView\.setBackgroundThrottling\(true\)/);
 const code=source.match(/code:`(new Promise\(resolve=>\{const el=[\s\S]*?setTimeout\(resolve,2200\);\}\))`/)[1].replace('${JSON.stringify(id)}','"secondary-swap-menu-label"');
 let clicked=false;const el={closest:()=>null,form:{},getAttribute:()=>null,click:()=>{clicked=true;}};
 await assert.rejects(vm.runInNewContext(code,{document:{getElementById:()=>el},setTimeout}),/keine lesende Navigation/);assert.equal(clicked,false);
});

test('native reader normalizes encoded equals in genuine Miro board IDs',()=>{assert.equal(run({encoded:true}).boardLinks[0].url,'https://miro.com/app/board/abcd=/');});
test('course sidebar Miro links are indexed once without inventing post attribution',()=>{const page=run({sidebarOnly:true});assert.equal(page.boardLinks.length,1);assert.equal(page.boardLinks[0].postedBy,'');assert.equal(page.boardLinks[0].postedAt,'');assert.equal(page.boardLinks[0].sourceURL,'https://spaces.th-koeln.de/course/');assert.equal(run().boardLinks.length,1);});
test('current Spaces post markup supplies its actual author and epoch timestamp',()=>{const b=run({spacesMarkup:true}).boardLinks[0];assert.equal(b.postedBy,'Alex Beispiel');assert.equal(b.postedAt,new Date(1791552875*1000).toISOString());assert.equal(b.sourceTitle,'Workshop');assert.equal(b.sourceURL,'https://spaces.th-koeln.de/course/post/');});
test('malformed Spaces timestamps and comment attribution remain unknown',()=>{assert.equal(run({spacesMarkup:true,epoch:'179155287500'}).boardLinks[0].postedAt,'');const b=run({spacesMarkup:true,comment:true}).boardLinks[0];assert.equal(b.postedAt,'');assert.equal(b.postedBy,'');});
test('sidebar profile text stays excluded even when the reader falls back to a broad text root',()=>{assert.equal(run({sidebarText:true}).text,'');assert.equal(run({sidebarText:true}).boardLinks.length,1);});
