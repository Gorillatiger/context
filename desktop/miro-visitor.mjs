import {createHash} from 'node:crypto';
import {providerPreferences} from './browser-session.mjs';
import {MiroError,safeMiroBoard} from '../connectors/miro.mjs';
import {miroOverviewScript,miroOverviewRevision,parseMiroOverview,miroOpenURL,miroShotURL,validMiroShot,MIRO_SHOT_LIMITS,MIRO_SHOT_CSS} from '../connectors/miro-visitor.mjs';

const miroPage=value=>{try{const u=new URL(value);return u.protocol==='https:'&&['miro.com','www.miro.com'].includes(u.hostname)&&!u.username&&!u.password&&!u.port;}catch{return false;}};
const cancelled=()=>new MiroError('cancelled',499);

/**
 * Hidden views are not composited by Chromium, and Miro's board app never
 * finishes loading without frames. An offscreen window renders into memory:
 * nothing is shown, focusable or listed in the dock, yet the page initializes.
 */
export function miroOffscreenViews(BrowserWindow){
  return {
    createView:({webPreferences})=>{const window=new BrowserWindow({show:false,width:1280,height:900,focusable:false,skipTaskbar:true,paintWhenInitiallyHidden:true,webPreferences:{...webPreferences,offscreen:true}});window.webContents.setFrameRate?.(15);return window;},
    destroyView:window=>{if(!window.isDestroyed?.())window.destroy();},
  };
}

/**
 * Reads one public board as a visitor in a hidden view of the website
 * partition. Only miro.com may load in the main frame; no popups, downloads or
 * typed input. One board at a time; unchanged overviews reuse the parsed result.
 */
export function createMiroVisitorReader({createView,destroyView,getShareLink=async()=>'',now=()=>new Date().toISOString(),pollMs=1000,timeoutMs=60000,settleMs=1800,settleStepMs=700,settleTries=10,clock=Date.now}={}){
  if(typeof createView!=='function')throw new TypeError('Der Miro-Besucherleser benötigt eine Ansicht.');
  let queue=Promise.resolve(),closed=false;const cache=new Map(),views=new Set(),closedViews=new WeakSet();
  const check=signal=>{if(closed||signal?.aborted)throw cancelled();};
  const race=(work,signal)=>new Promise((resolve,reject)=>{const abort=()=>reject(cancelled());if(signal?.aborted)return abort();signal?.addEventListener('abort',abort,{once:true});Promise.resolve(work).then(resolve,reject).finally(()=>signal?.removeEventListener('abort',abort));});
  const pause=(ms,signal)=>race(new Promise(resolve=>{const timer=setTimeout(resolve,ms);timer.unref?.();}),signal);
  const close=view=>{views.delete(view);if(!view||typeof view!=='object'||closedViews.has(view))return;closedViews.add(view);try{view.webContents.stop();}catch{}try{if(destroyView)destroyView(view);else if(!view.webContents.isDestroyed())view.webContents.close();}catch{}};
  // One hidden board view: opens the (optionally widget-targeted) link, guards
  // navigation and waits until Miro's overview is complete and stable.
  async function withBoard({url,itemId=''},signal,work){
    const target=safeMiroBoard(url);check(signal);
    const share=await getShareLink(target.id);check(signal);
    const openURL=itemId?miroShotURL(target.url,itemId,share):miroOpenURL(target.url,share);
    const creation=Promise.resolve().then(()=>{check(signal);return createView({webPreferences:{...providerPreferences(),focusOnNavigation:false}});});
    creation.then(view=>{if(closed||signal?.aborted)close(view);},()=>{});
    const view=await race(creation,signal);views.add(view);
    try{
      check(signal);
      const wc=view.webContents;let blocked=false,status=0;
      const requireBoard=()=>{check(signal);let actual;try{actual=safeMiroBoard(wc.getURL());}catch{}if(actual?.id!==target.id)throw new MiroError('scope_changed',409);};
      view.setVisible?.(false);wc.setBackgroundThrottling?.(false);wc.setAudioMuted?.(true);wc.setWindowOpenHandler?.(()=>({action:'deny'}));
      const guard=(event,next)=>{if(!miroPage(next)){event.preventDefault();blocked=true;}};
      wc.on('will-navigate',guard);wc.on('will-redirect',guard);wc.on('will-attach-webview',event=>event.preventDefault());
      wc.on('did-navigate',(_event,_url,code)=>{status=Number.isInteger(code)?code:0;});
      try{await race(wc.loadURL(openURL),signal);}catch(error){check(signal);if(!blocked)throw error instanceof MiroError?error:new MiroError('overview_unavailable',502);}
      if(blocked)throw new MiroError('login_required',401);
      if(status===401)throw new MiroError('login_required',401);
      if([403,404,410].includes(status))throw new MiroError('no_access',403);
      const deadline=clock()+timeoutMs;let last='',stable=0,snapshot;
      for(;;){
        check(signal);if(blocked)throw new MiroError('login_required',401);
        if(!miroPage(wc.getURL()))throw new MiroError('login_required',401);
        const value=await race(wc.executeJavaScriptInIsolatedWorld(1003,[{code:miroOverviewScript()}]),signal);check(signal);
        if(value?.state==='login')throw new MiroError('login_required',401);
        if(value?.state==='no_access')throw new MiroError('no_access',403);
        if(value?.state==='ready'){
          requireBoard();
          const revision=miroOverviewRevision(value);
          // The overview fills progressively. Accept it after two identical polls
          // (three for an empty board, which may still be loading).
          if(revision===last){if(++stable>=(value.nodes.length?2:3)){snapshot=value;break;}}else{last=revision;stable=0;}
        }else if(value?.state!=='loading')throw new MiroError('overview_unavailable',502);
        if(clock()>deadline)throw new MiroError('overview_unavailable',504);
        await pause(pollMs,signal);
      }
      requireBoard();
      return await work({wc,target,snapshot,requireBoard});
    }finally{close(view);}
  }
  const run=({url,meta={}},signal)=>withBoard({url},signal,({target,snapshot,requireBoard})=>{
    const revision=miroOverviewRevision(snapshot),key=target.id,metaKey=JSON.stringify([meta.title||'',meta.author||'']),hit=cache.get(key);
    if(hit?.revision===revision&&hit.metaKey===metaKey){const result={...structuredClone(hit.result),fetchedAt:now(),cached:true};requireBoard();cache.delete(key);cache.set(key,hit);return result;}
    const result=parseMiroOverview(snapshot,{url:target.url,meta,now});
    requireBoard();
    cache.delete(key);cache.set(key,{revision,metaKey,result:structuredClone(result)});while(cache.size>50)cache.delete(cache.keys().next().value);
    return {...result,cached:false};
  });
  // A uniform picture (grey canvas, white page) means the board did not draw yet.
  function drawn(bitmap){let low=255,high=0;for(let at=0;at+3<bitmap.length;at+=4*7){const value=(bitmap[at]+bitmap[at+1]*2+bitmap[at+2])>>2;if(value<low)low=value;if(value>high)high=value;}return high-low>=12;}
  async function settle(wc,signal,requireBoard){
    await pause(settleMs,signal);
    let previous='',image,settled=false;
    for(let attempt=0;attempt<settleTries;attempt++){
      requireBoard();
      image=await race(wc.capturePage(),signal);check(signal);
      const bitmap=image.resize({width:96}).toBitmap(),print=createHash('sha256').update(bitmap).digest('hex');
      if(print===previous&&drawn(bitmap)){settled=true;break;}
      previous=print;await pause(settleStepMs,signal);
    }
    return {image,settled};
  }
  // Board area as picture for the chat. Cookie layers are hidden; the picture is
  // encoded locally and leaves this process only toward the chat.
  const shoot=({url,itemId=''},signal)=>withBoard({url,itemId},signal,async({wc,requireBoard})=>{
    try{await race(wc.insertCSS(MIRO_SHOT_CSS),signal);}catch{check(signal);}
    const {image,settled}=await settle(wc,signal,requireBoard);requireBoard();
    let picture=image,size=picture.getSize();
    if(size.width>MIRO_SHOT_LIMITS.width){picture=picture.resize({width:MIRO_SHOT_LIMITS.width,quality:'best'});size=picture.getSize();}
    let bytes=picture.toJPEG(MIRO_SHOT_LIMITS.quality);
    for(const quality of [60,46]){if(bytes.length<=MIRO_SHOT_LIMITS.bytes)break;bytes=picture.toJPEG(quality);}
    for(let width=960;bytes.length>MIRO_SHOT_LIMITS.bytes&&width>=480;width-=240){picture=image.resize({width,quality:'good'});size=picture.getSize();bytes=picture.toJPEG(46);}
    return validMiroShot({mime:'image/jpeg',data:bytes.toString('base64'),width:size.width,height:size.height,capturedAt:now(),itemId,settled});
  });
  const enqueue=(work,input,signal)=>{
    if(closed)return Promise.reject(new MiroError('closed',409));
    const pending=queue.catch(()=>{}).then(()=>work(input,signal));queue=pending.catch(()=>{});return pending;
  };
  function read(input,signal){return enqueue(run,input,signal);}
  read.capture=(input,signal)=>enqueue(shoot,input,signal);
  read.dispose=()=>{closed=true;for(const view of [...views])close(view);cache.clear();};
  return read;
}
