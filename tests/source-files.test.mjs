import test from 'node:test';
import assert from 'node:assert/strict';
import {renderSourceFiles} from '../dist/source-files.js';
import {platformCatalog} from '../dist/source-catalog.js';

const repo='https://git.coco.study/course/robotics',folder='https://th-koeln.sciebo.de/index.php/apps/files/?dir=%2FCourse',share='https://th-koeln.sciebo.de/s/synthetic_share?path=%2FCourse';
const source=(service='gitlab',url=repo,projectId='course',title='Robotik Repository')=>platformCatalog({projects:projectId?[{id:projectId,name:'Robotik',links:[{tool:service,url,title}]}]:[],tools:projectId?[]:[{id:service,url,title}]})[0];
const files=()=>['pdf','docx','pptx','xlsx','md'].map(extension=>({url:repo+'/-/raw/main/Assignment.'+extension,title:'Aufgabe '+extension,type:extension}));
const decode=value=>value.replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>');
const buttons=html=>[...html.matchAll(/<button\b([^>]*)>/g)].map(match=>Object.fromEntries([...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(field=>[field[1],decode(field[2])])));

test('offered modern materials render compact accessible file controls with matching source identity and actual file URLs',()=>{
  const catalog=source(),html=renderSourceFiles(catalog,{files:files()});assert.match(html,/<details class="source-files">/);assert.match(html,/Materialien <span class="source-files-count">\(5\)<\/span>/);assert.match(html,/source-files-scroll/);
  const controls=buttons(html);assert.equal(controls.length,5);assert.ok(controls.every(button=>button['data-platform']==='read-file'&&button['data-source']===catalog.id&&button['aria-label'].includes('Robotik Repository')));
  assert.deepEqual(controls.map(button=>button['data-file']),files().map(file=>file.url));for(const type of ['PDF','DOCX','PPTX','XLSX','Text'])assert.match(html,new RegExp('<small>'+type+'</small>'));assert.match(html,/<svg[^>]*aria-hidden="true"/);assert.doesNotMatch(html,/<img|src=|href=/);
});

test('empty, malformed and forged source identities create no extra material blocks or unauthorized action targets',()=>{
  const catalog=source();assert.equal(renderSourceFiles(catalog),'');assert.equal(renderSourceFiles(catalog,{files:{url:repo}}),'');
  for(const altered of [undefined,{...catalog,id:'platform:'+'f'.repeat(32)},{...catalog,projectId:'other-course'},{...catalog,service:'mattermost'},source('miro','https://miro.com/app/board/synthetic-board/')])assert.equal(renderSourceFiles(altered,{files:files()}),'');
});

test('other courses, providers, repositories, normal pages, credentials, secret paths and macro/legacy formats are projected away',()=>{
  const catalog=source(),bad=[{url:repo+'/-/issues/3'},{url:repo+'/-/blob/main/README.md'},{url:repo+'-other/-/raw/main/a.pdf'},{url:'https://evil.test/a.pdf'},{url:'https://user:password@git.coco.study/course/robotics/-/raw/main/a.pdf'},{url:repo+'/-/raw/main/secrets.docx'},{url:repo+'/-/raw/main/a.pdf',projectId:'other'},{url:repo+'/-/raw/main/a.pdf',sourceId:'platform:'+'f'.repeat(32)},{url:repo+'/-/raw/main/a.pdf',service:'sciebo'},...['doc','xls','ppt','docm','xlsm','pptm','zip'].map(extension=>({url:repo+'/-/raw/main/a.'+extension}))];
  assert.equal(renderSourceFiles(catalog,{files:bad}),'');const html=renderSourceFiles(catalog,{files:[files()[0],...bad]});assert.equal(buttons(html).length,1);assert.equal(buttons(html)[0]['data-file'],files()[0].url);
});

test('all metadata and attributes remain escaped while format hints come from safe URLs instead of untrusted type labels',()=>{
  const catalog=source('gitlab',repo,'course','Repository "A" & Material'),title='Aufgabe "X" <img src=x onerror=bad()> & Details';
  const html=renderSourceFiles(catalog,{files:[{url:repo+'/-/raw/main/a.pdf',title,type:'docm',fileName:'BAD_FAKE.docm'}]});assert.doesNotMatch(html,/<img|<script|type="docm"/);assert.match(html,/&lt;img src=x onerror=bad\(\)&gt;/);assert.match(html,/<small>PDF<\/small>/);assert.match(html,/Repository &quot;A&quot; &amp; Material/);
  assert.equal(buttons(html)[0]['aria-label'],title+' lesen · Repository "A" & Material');
  const normal=renderSourceFiles(catalog,{files:[{url:repo+'/-/raw/main/a.pdf?token=PRIVATE',title}]});assert.equal(normal,'');
});

test('deduplication and native 50-link bound keep the material panel finite without adding guessed download URLs',()=>{
  const catalog=source(),same=files()[0];assert.equal(buttons(renderSourceFiles(catalog,{files:[same,same,{...same,title:'Different label'}]})).length,1);
  const offered=Array.from({length:80},(_,i)=>({url:repo+'/-/raw/main/Assignment-'+i+'.pdf',title:'Aufgabe '+i})),html=renderSourceFiles(catalog,{files:offered});assert.equal(buttons(html).length,50);assert.equal(buttons(html).at(-1)['data-file'],offered[49].url);assert.doesNotMatch(html,/Assignment-50/);
});

test('Sciebo folder/share files stay in the exact source while untyped opaque share downloads are visibly generic',()=>{
  const foldersource=source('sciebo',folder),folderURL='https://th-koeln.sciebo.de/remote.php/dav/files/user/Course/assignment.docx';assert.equal(buttons(renderSourceFiles(foldersource,{files:[{url:folderURL}]}))[0]['data-file'],folderURL);assert.equal(renderSourceFiles(foldersource,{files:[{url:folderURL.replace('/Course/','/Private/')}]}),'');
  const sharesource=source('sciebo',share),url='https://th-koeln.sciebo.de/index.php/s/synthetic_share/download?path=%2FCourse&files=Assignment.xlsx',html=renderSourceFiles(sharesource,{files:[{url}]});assert.match(html,/<small>XLSX<\/small>/);assert.equal(buttons(html)[0]['data-file'],'https://th-koeln.sciebo.de/index.php/s/synthetic_share/download?files=Assignment.xlsx&path=%2FCourse');assert.equal(renderSourceFiles(sharesource,{files:[{url:url.replace('synthetic_share','another_share')}]}),'');
  const plainShare=share.split('?')[0],opaque=renderSourceFiles(source('sciebo',plainShare),{files:[{url:plainShare+'/download',title:'Aufgabenblatt',type:'pdf'}]});assert.match(opaque,/<small>Datei<\/small>/);assert.doesNotMatch(opaque,/<small>PDF<\/small>/);
});

test('busy material controls are disabled and preserve accessible provenance and global workspace scopes',()=>{
  const catalog=source('gitlab',repo,'','Globales Repository'),html=renderSourceFiles(catalog,{files:[files()[0]],busy:true});assert.match(html,/disabled aria-busy="true"/);assert.equal(buttons(html)[0]['data-source'],catalog.id);assert.match(buttons(html)[0]['title'],/Globales Repository/);
});

test('rendering has no network, storage or native bridge side effect',()=>{
  const fetchBefore=globalThis.fetch,windowBefore=globalThis.window,storageDescriptor=Object.getOwnPropertyDescriptor(globalThis,'localStorage');let calls=0;
  try{
    globalThis.fetch=()=>{calls++;throw Error('No network during rendering');};globalThis.window={contextDesktop:new Proxy({},{get:()=>{calls++;throw Error('No IPC during rendering');}})};Object.defineProperty(globalThis,'localStorage',{configurable:true,get:()=>{calls++;throw Error('No storage during rendering');}});
    assert.equal(buttons(renderSourceFiles(source(),{files:files()})).length,5);assert.equal(calls,0);
  }finally{globalThis.fetch=fetchBefore;if(windowBefore===undefined)delete globalThis.window;else globalThis.window=windowBefore;if(storageDescriptor)Object.defineProperty(globalThis,'localStorage',storageDescriptor);else delete globalThis.localStorage;}
});
