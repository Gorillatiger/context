import test from 'node:test';
import assert from 'node:assert/strict';
import {platformCatalog,normalizePlatformURL,platformDocumentURL,platformSourceId,PLATFORM_SOURCE_LIMITS} from '../dist/source-catalog.js';
import {serviceURL,serviceFileURL,validateServiceSources} from '../desktop/service-reader.mjs';
const repo='https://git.coco.study/course/robotics',folder='https://th-koeln.sciebo.de/index.php/apps/files/?dir=%2FCourse',channel='https://chat.coco.study/students/channels/robotics',board='https://miro.com/app/board/synthetic-board/';
const project=(id='course',links=[])=>({id,name:'Synthetic course',links});
const link=(tool,url,title=tool)=>({id:tool,title,tool,url});

test('catalog includes only explicit active course links and genuine known boards, with no network/account operation or inferred creator',()=>{
  const state={projects:[project('course',[link('gitlab',repo),link('sciebo',folder),link('mattermost',channel),link('miro','https://miro.com/app/dashboard/'),link('web',repo),link('gitlab','https://evil.example/course/repo')]),{...project('archived',[link('miro',board)]),archived:true}],boardFindings:[{url:board,title:'Assignment',projectId:'course',postedBy:'Link poster',creator:'UNVERIFIED CREATOR'},{url:board,projectId:'archived'},{url:board,projectId:'missing'}],tools:[link('miro','https://miro.com/app/board/unlinked-board/')]};
  const rows=platformCatalog(state);assert.equal(rows.length,4);assert.deepEqual(rows.map(row=>row.service),['gitlab','sciebo','mattermost','miro']);assert.deepEqual(Object.keys(rows[3]),['id','service','url','projectId','title','revision']);assert.doesNotMatch(JSON.stringify(rows),/Link poster|UNVERIFIED CREATOR|unlinked-board|dashboard/);assert.ok(rows.every(row=>Object.isFrozen(row)));
});

test('canonical identities deduplicate equivalent links, remain stable on reordering and change when the course scope is relinked',()=>{
  const one=project('course',[link('miro',board+'?moveToWidget=item'),link('miro',board)]),two=project('second',[link('miro',board)]);
  const rows=platformCatalog({projects:[one,two]});assert.equal(rows.length,2);assert.notEqual(rows[0].id,rows[1].id);assert.equal(rows[0].url,board);
  const renamed=platformCatalog({projects:[project('course',[link('miro',board,'New title')])]})[0];assert.equal(renamed.id,rows[0].id);assert.notEqual(renamed.revision,rows[0].revision);
  const reordered=platformCatalog({projects:[two,one]}).find(row=>row.projectId==='course');assert.equal(reordered.id,rows[0].id);assert.equal(reordered.revision,rows[0].revision);
  assert.notEqual(platformSourceId({service:'gitlab',url:repo,projectId:'course'}),platformSourceId({service:'gitlab',url:repo+'-other',projectId:'course'}));
});

test('catalog honours explicit board reassignment, omits archived/missing/unassigned courses, and caps the grant list at 100',()=>{
  const boardFindings=[{url:board,title:'Board',projectId:'old',assignedProjectId:'current'},{url:board,title:'Unassigned',projectId:'old',assignedProjectId:''},{url:board,title:'Missing',projectId:'missing'}];
  assert.equal(platformCatalog({projects:[project('current'),{...project('old'),archived:true}],boardFindings})[0].projectId,'current');
  const projects=Array.from({length:5},(_,j)=>project('course-'+j,Array.from({length:40},(_,i)=>link('gitlab',repo+'-'+j+'-'+i))));assert.equal(platformCatalog({projects}).length,PLATFORM_SOURCE_LIMITS.sources);
  assert.deepEqual(platformCatalog({projects:[project('bad\nID',[link('gitlab',repo)]),project('x'.repeat(81),[link('gitlab',repo)])]}),[]);
});

test('catalog titles are redacted and links with credentials, authorization queries, edits, arbitrary hosts or encoded traversal are rejected',()=>{
  const unsafe=['http://git.coco.study/course/robotics','https://u:p@git.coco.study/course/robotics',repo+'?private_token=SECRET',repo+'/-/issues/new',repo+'/-/blob/main/.env.local',repo+'/-/tree/main/private_tokens.json',repo+'/%252e%252e/private','https://git.coco.study/api/v4/projects'];
  for(const url of unsafe)assert.throws(()=>normalizePlatformURL('gitlab',url),url);
  const [row]=platformCatalog({projects:[project('course',[link('gitlab',repo,'API Key: SECRET_TITLE')])]});assert.doesNotMatch(row.title,/SECRET_TITLE/);
  for(const service of ['whatsapp','spaces','signal','constructor'])assert.throws(()=>normalizePlatformURL(service,repo));
});

test('browser and native service scope normalization agree for known repositories, folders, shared folders and channels',()=>{
  const shares='https://th-koeln.sciebo.de/s/Synthetic_token?path=%2FCourse';
  for(const [service,url,scope] of [
    ['gitlab',repo+'/-/issues?page=2&state=opened#fragment',repo],['gitlab',repo+'/-/blob/main/README.md',repo],
    ['sciebo','https://th-koeln.sciebo.de/',undefined],['sciebo',folder+'&fileid=10',folder+'&fileid=10'],['sciebo',folder.replace('Course','Course%2FWeek'),folder],
    ['sciebo',shares.replace('/s/','/index.php/s/').replace('Course','Course%2FWeek'),shares],['mattermost',channel,channel]
  ])assert.equal(normalizePlatformURL(service,url,scope),serviceURL(service,url,scope));
  assert.doesNotThrow(()=>validateServiceSources(platformCatalog({projects:[project('course',[link('gitlab',repo),link('sciebo',shares),link('mattermost',channel)])]})));
});

test('document links stay within the selected repository/folder/share/channel, including the separate safe text-file policy',()=>{
  const share='https://th-koeln.sciebo.de/s/Synthetic_token?path=%2FCourse';
  for(const [service,url,scope]of [['gitlab',repo+'/-/raw/main/docs/assignment.md',repo],['sciebo','https://th-koeln.sciebo.de/remote.php/dav/files/user/Course/assignment.txt',folder],['sciebo','https://th-koeln.sciebo.de/s/Synthetic_token/download?path=%2FCourse&files=assignment.md',share],['sciebo','https://th-koeln.sciebo.de/s/Synthetic_token/download',share.split('?')[0]]])assert.equal(platformDocumentURL(service,url,scope),serviceFileURL(service,url,scope));
  for(const [service,url,scope]of [['gitlab',repo+'-other/-/issues/5',repo],['gitlab',repo+'/-/raw/main/.env.local',repo],['sciebo',folder+'&fileid=99',folder],['sciebo','https://th-koeln.sciebo.de/remote.php/webdav/Private/file.txt',folder],['sciebo','https://th-koeln.sciebo.de/s/Other_token/download?path=%2FCourse&files=a.md',share],['sciebo','https://th-koeln.sciebo.de/s/Synthetic_token/download?path=%2FPrivate&files=a.md',share],['mattermost',channel.replace('robotics','private'),channel],['miro','https://miro.com/app/board/another-board/',board]])assert.throws(()=>platformDocumentURL(service,url,scope),url);
});

test('configured global tools are readable global entry points without fabricating course assignments; Miro remains known-course-only',()=>{
  const tools=[{id:'gitlab',url:'https://git.coco.study/'},{id:'sciebo',url:'https://th-koeln.sciebo.de/'},{id:'mattermost',url:'https://chat.coco.study/'},{id:'miro',url:board},{id:'gitlab',url:'https://evil.test/course/repo'}];
  const rows=platformCatalog({projects:[project('course',[link('gitlab',repo)])],tools});assert.equal(rows.length,4);assert.equal(rows[0].projectId,'course');assert.deepEqual(rows.slice(1).map(row=>row.service),['gitlab','sciebo','mattermost']);assert.ok(rows.slice(1).every(row=>row.projectId===''));
  const global=rows.find(row=>row.service==='gitlab'&&!row.projectId);assert.notEqual(global.id,rows[0].id);assert.doesNotThrow(()=>validateServiceSources(rows));assert.throws(()=>platformSourceId({service:'miro',url:board,projectId:''}));
  assert.equal(platformCatalog({projects:[{...project('archived',[link('gitlab',repo)]),archived:true}],tools})[0].projectId,'');
});

test('the real initial workspace exposes its configured three services globally and caps keep course grants before global entry points',async()=>{
  const {initialState}=await import('../dist/core.js');const initial=initialState(),rows=platformCatalog(initial);
  assert.equal(rows.filter(row=>row.projectId==='').length,3);assert.ok(rows.some(row=>row.service==='mattermost'&&row.projectId==='go-public'));assert.doesNotThrow(()=>validateServiceSources(rows));
  const projects=Array.from({length:3},(_,j)=>project('course-'+j,Array.from({length:40},(_,i)=>link('gitlab',repo+'-'+j+'-'+i))));const capped=platformCatalog({projects,tools:initial.tools});assert.equal(capped.length,100);assert.ok(capped.every(row=>row.projectId));
});

test('unsupported Sciebo f/id entry routes never poison a native registry with grants the reader cannot consume',()=>{
  for(const url of ['https://th-koeln.sciebo.de/f/123','https://th-koeln.sciebo.de/index.php/f/123']){assert.throws(()=>normalizePlatformURL('sciebo',url));assert.deepEqual(platformCatalog({projects:[project('course',[link('sciebo',url)])]}),[]);}
});
