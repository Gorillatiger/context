import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createMiroVisitorReader} from '../desktop/miro-visitor.mjs';
import {createDesktopMiro} from '../desktop/miro.mjs';
import {miroShotURL,validMiroShot,MIRO_SHOT_LIMITS,MIRO_VISITOR_GENERATION} from '../connectors/miro-visitor.mjs';
import {createSourceHub} from '../dist/source-hub.js';
import {platformCatalog} from '../dist/source-catalog.js';
import {cleanPlatformSources} from '../dist/source-store.js';

const BOARD='https://miro.com/app/board/uXjVShot1234=/',OTHER='https://miro.com/app/board/uXjVOther567=/',SHARE='764592011234',NOW='2026-10-14T15:00:00.000Z';
const READY={state:'ready',title:'Kursboard - Miro',truncated:false,nodes:[{id:'100',role:'region',parent:-1,label:'Woche 1, Rahmen, 1 von 2',text:'Woche 1'},{id:'101',role:'button',parent:0,label:'Aufgabe, Text, 2 von 2',text:'Aufgabe'}]};

// A picture the way Electron's nativeImage behaves: size, resize, bitmap, JPEG.
function image({width=1280,height=900,paint=1,jpeg=60000}={}){
  const self={getSize:()=>({width,height}),
    resize:({width:next})=>image({width:next,height:Math.round(height*next/width),paint,jpeg:Math.round(jpeg*(next/width)**2)}),
    toBitmap:()=>{const bitmap=Buffer.alloc(96*68*4,200);if(paint>0)for(let at=0;at<bitmap.length;at+=4)bitmap[at]=(at/4*paint)%256;return bitmap;},
    toJPEG:quality=>Buffer.concat([Buffer.from([0xff,0xd8,0xff,0xe0]),Buffer.alloc(Math.max(100,Math.round(jpeg*quality/60)),7)])};
  return self;
}
function fakeView({pictures=[image()],redirect,status=200,state=READY}={}){
  const listeners=new Map(),loads=[],css=[];let url='about:blank',closed=0,captures=0,destroyed=false;
  const wc={
    on:(event,listener)=>{listeners.set(event,[...(listeners.get(event)||[]),listener]);},
    emit:(event,...args)=>{for(const listener of listeners.get(event)||[])listener(...args);},
    loadURL:async next=>{loads.push(next);url=redirect||next;wc.emit('did-navigate',{},url,status);},getURL:()=>url,
    executeJavaScriptInIsolatedWorld:async()=>state,insertCSS:async value=>{css.push(value);},
    capturePage:async()=>pictures[Math.min(captures++,pictures.length-1)],
    setBackgroundThrottling:()=>{},setAudioMuted:()=>{},setWindowOpenHandler:()=>{},stop:()=>{},close:()=>{closed++;destroyed=true;},isDestroyed:()=>destroyed,
  };
  return {view:{webContents:wc,setVisible:()=>{}},loads,css,closed:()=>closed,captures:()=>captures,wc};
}
const reader=(fake,options={})=>createMiroVisitorReader({pollMs:1,settleMs:1,settleStepMs:1,settleTries:6,now:()=>NOW,getShareLink:async()=>SHARE,createView:()=>fake.view,destroyView:view=>view.webContents.close(),...options});

test('the shot URL targets one widget of the board',()=>{
  assert.equal(miroShotURL(BOARD,'3074457',SHARE),BOARD+'?share_link_id='+SHARE+'&moveToWidget=3074457');
  assert.equal(miroShotURL(BOARD),BOARD);
  for(const bad of ['x y','a/b','../x','x'.repeat(129),'<b>'])assert.throws(()=>miroShotURL(BOARD,bad),{code:'invalid_request'});
  assert.throws(()=>miroShotURL('https://evil.test/app/board/x/','1'));
});

test('capture opens the widget link, hides cookie layers, waits for a stable picture and returns a validated JPEG',async()=>{
  const fake=fakeView({pictures:[image({paint:0}),image({paint:1}),image({paint:2}),image({paint:2}),image({paint:2})]});
  const shot=await reader(fake).capture({url:BOARD,itemId:'3074457'});
  assert.match(fake.loads[0],/moveToWidget=3074457/);assert.match(fake.loads[0],new RegExp('share_link_id='+SHARE));assert.match(fake.css[0],/onetrust/);
  assert.equal(shot.settled,true);assert.equal(shot.mime,'image/jpeg');assert.equal(shot.width,1280);assert.equal(shot.height,900);assert.equal(shot.itemId,'3074457');assert.equal(shot.capturedAt,NOW);
  assert.ok(Buffer.from(shot.data,'base64').subarray(0,3).equals(Buffer.from([0xff,0xd8,0xff])));assert.equal(fake.captures(),4,'blank, changing, then two equal pictures');
  assert.equal(fake.closed(),1);assert.doesNotMatch(JSON.stringify(shot),/share_link_id/);validMiroShot(shot);
});

test('a board that never stops changing or stays blank still yields a picture, marked unsettled',async()=>{
  for(const pictures of [[1,2,3,4,5,6,7].map(paint=>image({paint})),[image({paint:0})]]){
    const fake=fakeView({pictures}),shot=await reader(fake,{settleTries:4}).capture({url:BOARD});
    assert.equal(shot.settled,false);assert.equal(shot.itemId,'');assert.equal(fake.captures(),4);assert.equal(fake.closed(),1);
  }
});

test('large pictures are scaled to the width limit and recompressed to fit the size limit',async()=>{
  const fake=fakeView({pictures:[image({width:2560,height:1800,paint:2,jpeg:2000000})]});
  const shot=await reader(fake).capture({url:BOARD});
  assert.ok(shot.width<=MIRO_SHOT_LIMITS.width);assert.ok(Buffer.from(shot.data,'base64').length<=MIRO_SHOT_LIMITS.bytes);assert.equal(shot.height,Math.round(1800*shot.width/2560));
  const huge=fakeView({pictures:[image({width:1280,height:900,paint:2,jpeg:90000000})]});
  await assert.rejects(reader(huge).capture({url:BOARD}),{code:'invalid_response'});assert.equal(huge.closed(),1);
});

test('capture reports login, missing access, board switches, cancellation and bad widget ids and always closes its view',async()=>{
  const run=async(options,expected,input={url:BOARD},signal)=>{const fake=fakeView(options);await assert.rejects(reader(fake,{timeoutMs:20}).capture(input,signal),{code:expected});assert.equal(fake.closed(),1);return fake;};
  await run({redirect:'https://accounts.example.com/login'},'login_required');
  await run({status:401},'login_required');
  await run({status:404},'no_access');
  await run({state:{state:'no_access'}},'no_access');
  await run({state:{state:'loading'}},'overview_unavailable');
  await run({redirect:OTHER},'scope_changed');
  const controller=new AbortController();controller.abort();await assert.rejects(reader(fakeView()).capture({url:BOARD},controller.signal),{code:'cancelled'});
  await assert.rejects(reader(fakeView()).capture({url:BOARD,itemId:'<x>'}),{code:'invalid_request'});
  await assert.rejects(reader(fakeView()).capture({url:'https://evil.test/app/board/x/'}),{code:'invalid_request'});
  // The board changes while the picture settles: nothing is returned.
  const fake=fakeView({pictures:[image({paint:1}),image({paint:2}),image({paint:3})]});let calls=0;const capture=fake.wc.capturePage;fake.wc.capturePage=async()=>{if(++calls===2)fake.wc.getURL=()=>OTHER;return capture();};
  await assert.rejects(reader(fake).capture({url:BOARD}),{code:'scope_changed'});assert.equal(fake.closed(),1);
});

test('shots and reads share one queue: never two board views at once, and disposal stops further captures',async()=>{
  let active=0,max=0;const views=[];
  const shared=createMiroVisitorReader({pollMs:1,settleMs:1,settleStepMs:1,now:()=>NOW,createView:()=>{const fake=fakeView({pictures:[image({paint:2})]});const load=fake.wc.loadURL;fake.wc.loadURL=async next=>{active++;max=Math.max(max,active);await new Promise(resolve=>setTimeout(resolve,5));await load(next);active--;};views.push(fake);return fake.view;},destroyView:view=>view.webContents.close()});
  await Promise.all([shared.capture({url:BOARD,itemId:'1'}),shared({url:BOARD}),shared.capture({url:BOARD,itemId:'2'})]);
  assert.equal(max,1);assert.equal(views.length,3);assert.ok(views.every(view=>view.closed()===1));
  shared.dispose();await assert.rejects(shared.capture({url:BOARD}),{code:'closed'});
});

const PICTURE=()=>({mime:'image/jpeg',data:'/9j/'+'A'.repeat(400),width:1280,height:900,capturedAt:NOW,itemId:'3074457',settled:true});
const nango={status:async()=>({connected:false}),proxy:async()=>{throw new Error('not used');}};
const bridgeFor=options=>createDesktopMiro({nango,getAllowedBoards:()=>[{url:BOARD,projectId:'course-one'}],getGeneration:()=>'g1',fetchMeta:async()=>({available:false}),...options});
const shoot=(bridge,body)=>bridge({action:'shot',id:randomUUID(),body});

test('the shot action is limited to linked course boards, validates its input and the capture result',async()=>{
  const calls=[],visitor=Object.assign(async()=>{throw new Error('reads are not used');},{capture:async(input,signal)=>{calls.push(input);assert.equal(signal.aborted,false);return PICTURE();}});
  const bridge=bridgeFor({visitor});
  const value=await shoot(bridge,{url:BOARD,projectId:'course-one',itemId:'3074457'});
  assert.deepEqual(calls,[{url:BOARD,itemId:'3074457'}]);assert.equal(value.url,BOARD);assert.equal(value.projectId,'course-one');assert.equal(value.scopeGeneration,'g1');assert.equal(value.data,PICTURE().data);
  assert.deepEqual(await shoot(bridge,{url:BOARD,projectId:'course-one'}).then(row=>row.itemId),'3074457');assert.equal(calls[1].itemId,'');
  for(const body of [{url:BOARD,projectId:'course-one',itemId:'<x>'},{url:BOARD,projectId:'course-one',itemId:7},{url:BOARD,projectId:'course-one',extra:1},{url:BOARD},{url:BOARD,projectId:''}])await assert.rejects(shoot(bridge,body),{code:'invalid_request'},JSON.stringify(body));
  await assert.rejects(shoot(bridge,{url:OTHER,projectId:'course-one'}),{code:'board_not_allowed'});
  await assert.rejects(shoot(bridge,{url:BOARD,projectId:'course-two'}),{code:'board_not_allowed'});
  assert.equal(calls.length,2,'refused requests never open a board');
  bridge.dispose();
  const bad=bridgeFor({visitor:Object.assign(async()=>{},{capture:async()=>({...PICTURE(),data:'<script>alert(1)</script>'})})});await assert.rejects(shoot(bad,{url:BOARD,projectId:'course-one'}),{code:'invalid_response'});bad.dispose();
  const none=bridgeFor({});await assert.rejects(shoot(none,{url:BOARD,projectId:'course-one'}),{code:'not_connected'});none.dispose();
});

test('a scope change during the capture discards the picture; cancelling aborts the browser view',async()=>{
  let generation=1;const bridge=bridgeFor({getGeneration:()=>generation,visitor:Object.assign(async()=>{},{capture:async()=>{generation=2;return PICTURE();}})});
  await assert.rejects(shoot(bridge,{url:BOARD,projectId:'course-one'}),{code:'scope_changed'});bridge.dispose();
  let seen;const slow=bridgeFor({visitor:Object.assign(async()=>{},{capture:(_input,signal)=>new Promise((_resolve,reject)=>{seen=signal;signal.addEventListener('abort',()=>reject(Object.assign(new Error('x'),{code:'cancelled'})),{once:true});})})});
  const id=randomUUID(),pending=slow({action:'shot',id,body:{url:BOARD,projectId:'course-one'}});await new Promise(resolve=>setImmediate(resolve));
  await slow({action:'cancel',id});await assert.rejects(pending,{code:'cancelled'});assert.equal(seen.aborted,true);slow.dispose();
});

test('the renderer source hub takes a picture of a linked Miro board and refuses foreign or stale scopes',async()=>{
  const SCOPE='a'.repeat(64),workspace={activeCourse:'course1',projects:[{id:'course1',name:'UI',links:[{tool:'miro',url:BOARD,title:'Kursboard'}]}],boardFindings:[]};
  const status={configured:false,connected:false,boardRead:false,generation:'',visitor:true,visitorGeneration:MIRO_VISITOR_GENERATION};let rows=[],revision=0,reply;const asked=[];
  const bridge={service:async message=>message.action==='registry'?{ok:true,value:{generation:SCOPE,accounts:{}}}:{ok:true,value:{cancelled:true}},
    miro:async message=>{if(message.action==='cancel')return {ok:true};if(message.action==='status')return {ok:true,value:status};asked.push(message);return reply(message);},onEvent:()=>()=>{}};
  const store={load:async()=>({rows:structuredClone(rows),revision}),save:async(next,options)=>{options.assertCurrent?.();rows=cleanPlatformSources(next);return ++revision;},close:async()=>{}};
  const hub=createSourceHub({getWorkspace:()=>workspace,bridge,store});
  try{
    await hub.load();const source=platformCatalog(workspace)[0];
    reply=message=>({ok:true,value:{...PICTURE(),url:message.body.url,projectId:message.body.projectId,scopeGeneration:SCOPE}});
    const shot=await hub.shot(source.id,{itemId:'3074457',projectId:'course1'});
    assert.deepEqual(asked.at(-1),{action:'shot',body:{url:BOARD,projectId:'course1',itemId:'3074457'},id:asked.at(-1).id});
    assert.equal(shot.sourceId,source.id);assert.equal(shot.url,BOARD);assert.equal(shot.itemId,'3074457');assert.equal(shot.data,PICTURE().data);
    await assert.rejects(hub.shot('platform:unknown'),/außerhalb des ausgewählten Kurses/);
    await assert.rejects(hub.shot(source.id,{projectId:'other'}),/außerhalb des ausgewählten Kurses/);
    await assert.rejects(hub.shot(source.id,{itemId:'<x>'}),/Ungültiger Boardbereich/);
    reply=message=>({ok:true,value:{...PICTURE(),url:message.body.url,projectId:message.body.projectId,scopeGeneration:'b'.repeat(64)}});
    await assert.rejects(hub.shot(source.id,{}),{name:'AbortError'});
    reply=()=>({ok:false,error:'Das Board ist nicht lesbar.',code:'login_required'});
    await assert.rejects(hub.shot(source.id,{}),error=>error.code==='login_required'&&/nicht lesbar/.test(error.message));
  }finally{await hub.dispose();}
});
