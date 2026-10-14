import test from 'node:test';
import assert from 'node:assert/strict';
import {createInventoryView,isInventoryEntryURL} from '../dist/inventory-browser.js';

const tick=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));};
function eventTarget(){const listeners=new Map();return {innerWidth:1200,innerHeight:900,addEventListener(type,fn){if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type).add(fn);},removeEventListener(type,fn){listeners.get(type)?.delete(fn);},dispatch(type,detail){for(const fn of listeners.get(type)||[])fn({detail});},listenerCount:type=>listeners.get(type)?.size||0};}
function deferred(){let resolve;return {promise:new Promise(done=>{resolve=done;}),resolve:value=>resolve(value)};}
function fixture({handler,rerender=false,capability=true,browserMethod=true}={}){
 const events=eventTarget(),docEvents=eventTarget(),observers=[],calls=[],errors=[],classes=new Set();
 let present=true,rect={x:240,y:220,width:880,height:520},slot={isConnected:true,getBoundingClientRect:()=>rect},blocked=false,notices=0,loopStopped=false,generation=0,view;
 const detail={active:'owned',tabs:[{id:'owned',title:'Synthetic Inventory',url:'https://inventory.coco.study/items/test',loading:false,back:true,forward:false}]};
 const document={body:{classList:{contains:value=>classes.has(value)}},visibilityState:'visible',querySelector:selector=>selector==='#inventory-page-slot'&&present?slot:selector==='dialog[open]'&&blocked?{}:null,querySelectorAll:()=>[],addEventListener:docEvents.addEventListener.bind(docEvents),removeEventListener:docEvents.removeEventListener.bind(docEvents)};
 class Observer {constructor(fn){this.fn=fn;this.disconnected=false;observers.push(this);}observe(){}disconnect(){this.disconnected=true;}trigger(){if(!this.disconnected)this.fn();}}
 const defaultReply=message=>{
  if(message.type==='inventory'&&['attach','home'].includes(message.action)){view.receive(detail);return {ok:true,value:{tabId:'owned',surfaceToken:generation}};}
  if(message.type==='inventory'&&message.action==='detach')generation++;
  return {ok:true};
 };
 const bridge={inventoryBrowser:capability,...(browserMethod?{browser:async message=>{calls.push(message);const reply=handler?await handler(message,{defaultReply,detail}):undefined;return reply===undefined?defaultReply(message):reply;}}:{})};
 const change=()=>{notices++;if(notices>25){loopStopped=true;view.hide();return;}if(rerender){slot.isConnected=false;slot={isConnected:true,getBoundingClientRect:()=>rect};view.mount();}};
 view=createInventoryView({bridge,eventTarget:events,document,Resize:Observer,Mutation:Observer,onChange:change,onError:message=>errors.push(message)});
 return {view,bridge,calls,errors,observers,events,docEvents,document,detail,classes,notices:()=>notices,loopStopped:()=>loopStopped,setBlocked:value=>{blocked=value;},setRect:value=>{rect=value;},removeSlot:()=>{present=false;slot.isConnected=false;},trigger:()=>observers.forEach(observer=>observer.trigger())};
}

test('only the canonical inventory entry opens the inline route, preserving authentication and item links',()=>{
 for(const value of ['https://inventory.coco.study','https://inventory.coco.study/','https://inventory.coco.study:443/'])assert.equal(isInventoryEntryURL(value),true);
 for(const value of ['https://inventory.coco.study/?code=synthetic','https://inventory.coco.study/#item','https://inventory.coco.study/items/camera','https://inventory.coco.study/login','https://user@inventory.coco.study/','https://inventory.coco.study.evil.test/','http://inventory.coco.study/','not a URL'])assert.equal(isInventoryEntryURL(value),false);
});

test('embedded inventory needs an explicit native capability and renders no external iframe',async()=>{
 for(const options of [{capability:false},{browserMethod:false}]){const f=fixture(options);assert.equal(f.view.available(),false);f.view.mount();await tick();assert.deepEqual(f.calls,[]);assert.doesNotMatch(f.view.render(),/<iframe\b|<webview\b/);assert.match(f.view.render(),/aktualisierte Mac-App/);}
 const f=fixture();assert.equal(f.view.available(),true);assert.match(f.view.render(),/id="inventory-page-slot"/);assert.doesNotMatch(f.view.render(),/<iframe\b|<webview\b/);
});

test('mount attaches its dedicated surface and sends only scoped geometry to the host',async()=>{
 const f=fixture();f.view.mount();await tick();
 assert.deepEqual(f.calls.filter(call=>call.type==='inventory'),[{type:'inventory',action:'attach'}]);
 const frame=f.calls.find(call=>call.type==='frame');assert.equal(frame.owner,'inventory');assert.equal(frame.id,'owned');assert.equal(frame.surfaceToken,0);assert.equal(frame.visible,true);
 assert.deepEqual(frame.rect,{x:240,y:220,width:880,height:520});assert.deepEqual(frame.clip,{x:0,y:0,width:1200,height:900});
 assert(!Object.hasOwn(frame,'url'));f.view.hide();
});

test('repeated rendering remounts observers without reattaching or reloading the item',async()=>{
 const f=fixture();f.view.mount();await tick();for(let i=0;i<12;i++)f.view.mount();await tick();
 assert.equal(f.calls.filter(call=>call.type==='inventory'&&call.action==='attach').length,1);assert.equal(f.calls.filter(call=>call.type==='frame').length,1);
 assert.equal(f.observers.filter(observer=>!observer.disconnected).length,2);assert.equal(f.events.listenerCount('resize'),1);assert.equal(f.docEvents.listenerCount('scroll'),1);
 f.view.hide();assert(f.observers.every(observer=>observer.disconnected));assert.equal(f.events.listenerCount('resize'),0);assert.equal(f.docEvents.listenerCount('scroll'),0);
});

test('hiding before attach resolves prevents a stale native frame or late rerender',async()=>{
 const gate=deferred();const f=fixture({handler:async message=>{if(message.type==='inventory'&&message.action==='attach'){await gate.promise;return {ok:true,value:{tabId:'owned',surfaceToken:0}};}}});
 f.view.mount();await tick();assert.equal(f.view.state().busy,true);f.view.hide();gate.resolve();await tick();
 assert.equal(f.view.state().mounted,false);assert.equal(f.notices(),0);assert.equal(f.calls.filter(call=>call.type==='frame').length,0);
 assert(f.calls.some(call=>call.type==='inventory'&&call.action==='detach'));
});

test('queued resize and scroll updates cannot repaint a hidden inventory surface',async()=>{
 const f=fixture();f.view.mount();await tick();const before=f.calls.filter(call=>call.type==='frame').length;
 f.setRect({x:240,y:200,width:800,height:540});f.trigger();f.events.dispatch('resize');f.docEvents.dispatch('scroll');f.view.hide();await tick();
 assert.equal(f.calls.filter(call=>call.type==='frame').length,before);assert(f.observers.every(observer=>observer.disconnected));
});

test('a disappeared mount slot detaches the old native surface instead of keeping its stale bounds',async()=>{
 const f=fixture();f.view.mount();await tick();f.removeSlot();f.view.mount();await tick();
 assert.equal(f.view.state().mounted,false);assert(f.calls.some(call=>call.type==='detach'&&call.owner==='inventory'));assert(f.observers.every(observer=>observer.disconnected));
});

test('failed attach stays visible for explicit retry rather than automatically looping on rerender',async()=>{
 let broken=true;const f=fixture({rerender:true,handler:async message=>message.type==='inventory'&&message.action==='attach'&&broken?{ok:false,error:'synthetic attach failed'}:undefined});
 f.view.mount();await tick();assert.equal(f.loopStopped(),false);assert.equal(f.calls.filter(call=>call.type==='inventory'&&call.action==='attach').length,1);assert.match(f.view.render(),/synthetic attach failed/);
 broken=false;await f.view.click('retry');await tick();assert.equal(f.view.state().error,'');assert.equal(f.calls.filter(call=>call.type==='inventory'&&call.action==='attach').length,2);assert(f.calls.some(call=>call.type==='frame'&&call.visible));f.view.hide();
});

test('failed geometry is reported once without a native-frame rerender loop',async()=>{
 const f=fixture({rerender:true,handler:async message=>message.type==='frame'?{ok:false,error:'synthetic frame failed'}:undefined});
 f.view.mount();await tick();assert.equal(f.loopStopped(),false);assert.equal(f.calls.filter(call=>call.type==='frame').length,1);assert.equal(f.view.state().error,'synthetic frame failed');
 assert(f.calls.some(call=>call.type==='detach'&&call.owner==='inventory'));f.view.hide();
});

test('an old failed frame cannot detach or contaminate a newer inventory mount',async()=>{
 const gate=deferred();let first=true;const f=fixture({handler:async message=>{if(message.type==='frame'&&first){first=false;await gate.promise;return {ok:false,error:'obsolete frame failed'};}}});
 f.view.mount();await tick();f.view.hide();f.view.mount();await tick();const detachCount=f.calls.filter(call=>call.type==='detach').length;
 gate.resolve();await tick();assert.equal(f.view.state().error,'');assert.equal(f.view.state().mounted,true);assert.equal(f.calls.filter(call=>call.type==='detach').length,detachCount);f.view.hide();
});

test('modal, navigation drawer and hidden document block the embedded website',async()=>{
 const f=fixture();f.view.mount();await tick();
 for(const block of ['modal','nav','hidden']){
  if(block==='modal')f.setBlocked(true);else if(block==='nav')f.classes.add('nav-open');else f.document.visibilityState='hidden';
  f.trigger();await tick();const frame=f.calls.filter(call=>call.type==='frame').at(-1);assert.equal(frame.visible,false);assert.equal(frame.current,false);
  f.setBlocked(false);f.classes.delete('nav-open');f.document.visibilityState='visible';f.trigger();await tick();assert.equal(f.calls.filter(call=>call.type==='frame').at(-1).visible,true);
 }
 f.view.hide();
});

test('returning while the window is hidden defers attach and restores its new surface token when visible',async()=>{
 const f=fixture();f.view.mount();await tick();f.view.hide();
 f.document.visibilityState='hidden';f.view.mount();await tick();
 assert.equal(f.calls.filter(call=>call.type==='inventory'&&call.action==='attach').length,1,'a hidden return waits for the window to become visible');
 f.document.visibilityState='visible';f.docEvents.dispatch('visibilitychange');await tick();
 assert.equal(f.calls.filter(call=>call.type==='inventory'&&call.action==='attach').length,2);
 const frame=f.calls.filter(call=>call.type==='frame').at(-1);assert.equal(frame.visible,true);assert.equal(frame.current,true);assert.equal(frame.surfaceToken,1,'the return uses the native token issued after detach');f.view.hide();
});

test('closing a course modal that selected another tab reattaches the dedicated inventory once',async()=>{
 const f=fixture();f.view.mount();await tick();f.setBlocked(true);f.trigger();await tick();
 f.view.receive({active:'course',tabs:[...f.detail.tabs,{id:'course',title:'Synthetic Course',url:'https://spaces.th-koeln.de/synthetic/'}]});
 f.setBlocked(false);f.trigger();await tick();
 assert.equal(f.calls.filter(call=>call.type==='inventory'&&call.action==='attach').length,2);assert.equal(f.view.state().browser.active,'owned');assert.equal(f.calls.filter(call=>call.type==='frame').at(-1).visible,true);f.view.hide();
});

test('history and explicit home target the owned tab without arbitrary URLs or unknown actions',async()=>{
 const f=fixture();f.view.mount();await tick();const before=f.calls.length;
 for(const action of ['back','forward','reload','stop'])await f.view.click(action);
 assert.deepEqual(f.calls.slice(before),['back','forward','reload','stop'].map(type=>({type,id:'owned'})));
 await f.view.click('home');assert(f.calls.some(call=>call.type==='inventory'&&call.action==='home'));const count=f.calls.length;await f.view.click('navigate');await f.view.click('delete');assert.equal(f.calls.length,count);f.view.hide();
});

test('untrusted provider titles and URLs are escaped in inventory chrome',async()=>{
 const f=fixture();f.view.mount();await tick();f.view.receive({active:'owned',tabs:[{id:'owned',title:'<img src=x onerror=alert(1)>',url:'https://inventory.coco.study/\"<script>bad</script>',loading:false}]});
 const html=f.view.render();assert.doesNotMatch(html,/<img src=x|<script>bad/);assert.match(html,/&lt;img/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<iframe\b/);f.view.hide();
});


test('provider loading failure stays readable and retries the retained tab by reloading it',async()=>{
 const f=fixture();f.view.mount();await tick();
 f.view.receive({active:'owned',tabs:[{...f.detail.tabs[0],error:'Die Seite konnte nicht geladen werden (<test>).'}]});
 const html=f.view.render();assert.match(html,/role="alert"/);assert.match(html,/geladen werden \(&lt;test&gt;\)/);assert.match(html,/data-inventory-action="reload"/);assert.match(html,/Verbindung prüfen/);
 const before=f.calls.length;await f.view.click('reload');assert.deepEqual(f.calls.slice(before),[{type:'reload',id:'owned'}]);
 f.view.receive(f.detail);assert.doesNotMatch(f.view.render(),/role="alert"/);f.view.hide();
});
