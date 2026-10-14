import test from 'node:test';
import assert from 'node:assert/strict';
import {readCourseSpace} from '../dist/companion.js';
import {cleanMemory,encryptMemory,decryptMemory} from '../dist/companion-memory.js';

const url='https://spaces.th-koeln.de/alpha/';
const project={id:'alpha',name:'Kurs Alpha',links:[{tool:'spaces',url,title:'Kurs-Space'}]};
const page=(extra={})=>({url,title:'Kurs Alpha',text:'Synthetischer Kursbeleg.',offset:0,hasMore:false,links:[],controls:[],...extra});

test('manual read binds the first returned URL to the requested course before caching any text',async()=>{
  for(const redirected of ['https://spaces.th-koeln.de/beta/','https://spaces.th-koeln.de/wp/blog/other-course/','https://spaces.th-koeln.de/members/person/']){
    const calls=[];
    const result=await readCourseSpace({project,request:async command=>{calls.push(command);return page({url:redirected,text:'OTHER COURSE MUST NOT BE STORED'});}});
    assert.deepEqual(calls,[{command:'start',url}]);assert.equal(result.sources.length,0);assert.equal(result.coverage[0].status,'error');
    assert.ok(!JSON.stringify(result).includes('OTHER COURSE MUST NOT BE STORED'));
  }
});

test('manual read uses one bounded course view, with matching offset/title/URL for the optional tail',async()=>{
  const calls=[];
  const offered={links:[{url:url+'other/',title:'Other section'}],controls:[{id:'secondary-swap-menu-label',title:'Orga'}]};
  const result=await readCourseSpace({project,request:async command=>{
    calls.push(command);
    return command.command==='start'?page({text:'A'.repeat(5000),hasMore:true,...offered}):page({text:'B'.repeat(5000),offset:5000,...offered});
  }});
  assert.deepEqual(calls,[{command:'start',url},{command:'read',offset:5000}]);assert.equal(result.sources.length,1);
  assert.equal(result.sources[0].projectId,'alpha');assert.equal(result.sources[0].url,url);assert.equal(result.sources[0].text,'A'.repeat(5000)+'B'.repeat(5000));assert.equal(result.sources[0].status,'full');
  assert.equal(result.coverage[0].status,'partial','offered but unread views remain an explicit coverage limit');
});

test('manual reads preserve four 5k sections without opening any additional course view',async()=>{
  const calls=[],result=await readCourseSpace({project,request:async command=>{
    calls.push(command);const offset=command.offset||0;
    return page({offset,text:String(offset/5000).repeat(5000),hasMore:offset<15000});
  }});
  assert.deepEqual(calls,[{command:'start',url},{command:'read',offset:5000},{command:'read',offset:10000},{command:'read',offset:15000}]);
  assert.equal(result.sources.length,1);assert.equal(result.sources[0].text,['0','1','2','3'].map(c=>c.repeat(5000)).join(''));
  assert.equal(result.sources[0].status,'full');assert.equal(result.coverage[0].status,'read');assert.equal(result.coverage[0].pages,1);
  const memory=cleanMemory({liveSources:result.sources,scanCoverage:result.coverage}),key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  const restored=await decryptMemory(await encryptMemory(memory,key),key);assert.equal(restored.liveSources[0].text,result.sources[0].text);assert.equal(restored.liveSources[0].projectId,'alpha');
});

test('manual reads stop at a terminal third section or honestly mark remaining text after 20k',async()=>{
  for(const terminal of [10000,20000]){
    const calls=[],result=await readCourseSpace({project,request:async command=>{const offset=command.offset||0;calls.push(command);return page({offset,text:'x'.repeat(5000),hasMore:offset<terminal});}});
    assert.equal(calls.length,terminal===10000?3:4);assert.equal(result.sources[0].text.length,terminal===10000?15000:20000);
    assert.equal(result.sources[0].status,terminal===10000?'full':'excerpt');assert.equal(result.coverage[0].status,terminal===10000?'read':'partial');
    if(terminal===20000)assert.match(result.coverage[0].message,/20\.000.*weiterer Seitentext/);
  }
});

test('every later manual section must match the exact course URL, title, offset and native bounds',async()=>{
  const patches=[{url:url+'other/'},{url:'https://spaces.th-koeln.de/beta/'},{title:'Different title'},{offset:0},{offset:undefined},{links:undefined},{controls:Array(31).fill({id:'primary-swap-menu-label'})},{text:'x'.repeat(5001)},{hasMore:'true'}];
  for(const badOffset of [10000,15000])for(const patch of patches){
    const calls=[],result=await readCourseSpace({project,request:async command=>{
      const offset=command.offset||0;calls.push(command);
      return page({offset,text:offset===badOffset?'UNSAFE LATER SECTION':'s'.repeat(5000),hasMore:true,...(offset===badOffset?patch:{})});
    }});
    assert.equal(calls.length,badOffset/5000+1);assert.equal(result.coverage[0].status,'error');assert.equal(result.sources[0].status,'excerpt');assert.equal(result.sources[0].text,'s'.repeat(badOffset));
    assert.ok(!JSON.stringify(result).includes('UNSAFE LATER SECTION'));
  }
});

test('login and cancellation during later sections retain only previously verified text',async()=>{
  for(const kind of ['login','cancel','error']){
    const controller=new AbortController(),result=await readCourseSpace({project,signal:controller.signal,request:async command=>{
      const offset=command.offset||0;
      if(offset<10000)return page({offset,text:'s'.repeat(5000),hasMore:true});
      if(kind==='login')return {loginRequired:true,text:'LOGIN LATE PRIVATE'};
      if(kind==='cancel'){controller.abort();return page({offset,text:'LATE PRIVATE',hasMore:false});}
      throw new Error('Synthetischer Lesefehler');
    }});
    assert.equal(result.sources[0].text,'s'.repeat(10000));assert.equal(result.sources[0].status,'excerpt');assert.ok(!JSON.stringify(result).includes('PRIVATE'));
    assert.equal(result.coverage[0].status,kind==='login'?'login_required':kind==='cancel'?'partial':'error');assert.equal(result.interrupted,kind==='cancel');
  }
});

test('drifting or unidentified manual tail sections retain only the safe first excerpt',async()=>{
  for(const patch of [{url:'https://spaces.th-koeln.de/beta/'},{title:'Another course section'},{offset:0},{offset:undefined}]){
    const result=await readCourseSpace({project,request:async command=>command.command==='start'?page({hasMore:true,text:'SAFE FIRST EXCERPT'}):page({offset:5000,text:'UNRELATED TAIL',...patch})});
    assert.equal(result.coverage[0].status,'error');assert.equal(result.sources.length,1);assert.equal(result.sources[0].text,'SAFE FIRST EXCERPT');assert.equal(result.sources[0].status,'excerpt');
    assert.ok(!JSON.stringify(result).includes('UNRELATED TAIL'));
  }
});

test('manual first sections require a trustworthy offset and reject malformed bounds',async()=>{
  for(const patch of [{offset:undefined},{offset:3},{text:'x'.repeat(5001)},{links:undefined},{hasMore:'yes'}]){
    const result=await readCourseSpace({project,request:async()=>page(patch)});assert.equal(result.sources.length,0);assert.equal(result.coverage[0].status,'error');
  }
});

test('manual source login and cancellation never cache login text or an unsafe tail',async()=>{
  const login=await readCourseSpace({project,request:async()=>({loginRequired:true,text:'LOGIN MUST NOT BE STORED'})});
  assert.equal(login.sources.length,0);assert.equal(login.coverage[0].status,'login_required');assert.ok(!JSON.stringify(login).includes('LOGIN MUST NOT BE STORED'));
  const controller=new AbortController(),stopped=await readCourseSpace({project,signal:controller.signal,request:async command=>{
    if(command.command==='start')return page({text:'SAFE BEFORE STOP',hasMore:true});controller.abort();throw new DOMException('Abgebrochen','AbortError');
  }});
  assert.equal(stopped.interrupted,true);assert.equal(stopped.sources[0].text,'SAFE BEFORE STOP');assert.equal(stopped.sources[0].status,'excerpt');
});

test('manual source validation keeps credentials out of encrypted memory and preserves course provenance',async()=>{
  const secret='ghp_'+'a'.repeat(30),result=await readCourseSpace({project,request:async()=>page({text:'Beleg. '+secret})});
  const memory=cleanMemory({liveSources:result.sources,scanCoverage:result.coverage});assert.ok(!JSON.stringify(memory).includes(secret));
  const key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  const restored=await decryptMemory(await encryptMemory(memory,key),key);assert.equal(restored.liveSources[0].projectId,'alpha');assert.equal(restored.liveSources[0].url,url);
});

test('archived, unlinked and generic-root manual targets never invoke the browser',async()=>{
  let calls=0;const request=async()=>{calls++;return page();};
  await assert.rejects(readCourseSpace({project:{...project,archived:true},request}));await assert.rejects(readCourseSpace({project:{...project,links:[]},request}));
  const root=await readCourseSpace({project:{...project,links:[{tool:'spaces',url:'https://spaces.th-koeln.de/'}]},request});
  assert.equal(root.coverage[0].status,'error');assert.equal(root.sources.length,0);assert.equal(calls,0);
});
