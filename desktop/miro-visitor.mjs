import {providerPreferences} from './browser-session.mjs';
import {MiroError,safeMiroBoard} from '../connectors/miro.mjs';
import {miroOverviewScript,miroOverviewRevision,parseMiroOverview,miroOpenURL} from '../connectors/miro-visitor.mjs';

const miroPage=value=>{try{const u=new URL(value);return u.protocol==='https:'&&['miro.com','www.miro.com'].includes(u.hostname)&&!u.username&&!u.password&&!u.port;}catch{return false;}};
const cancelled=()=>new MiroError('cancelled',499);

/**
 * Reads one public board as a visitor in a hidden view of the website
 * partition. Only miro.com may load in the main frame; no popups, downloads or
 * typed input. One board at a time; unchanged overviews reuse the parsed result.
 */
export function createMiroVisitorReader({createView,destroyView,getShareLink=async()=>'',now=()=>new Date().toISOString(),pollMs=1000,timeoutMs=60000,clock=Date.now}={}){
  if(typeof createView!=='function')throw new TypeError('Der Miro-Besucherleser benötigt eine Ansicht.');
  let queue=Promise.resolve(),closed=false;const cache=new Map(),views=new Set();
  const check=signal=>{if(closed||signal?.aborted)throw cancelled();};
  const race=(work,signal)=>new Promise((resolve,reject)=>{const abort=()=>reject(cancelled());if(signal?.aborted)return abort();signal?.addEventListener('abort',abort,{once:true});Promise.resolve(work).then(resolve,reject).finally(()=>signal?.removeEventListener('abort',abort));});
  const pause=(ms,signal)=>race(new Promise(resolve=>{const timer=setTimeout(resolve,ms);timer.unref?.();}),signal);
  const close=view=>{views.delete(view);try{view.webContents.stop();}catch{}try{if(destroyView)destroyView(view);else if(!view.webContents.isDestroyed())view.webContents.close();}catch{}};
  async function run({url,meta={}},signal){
    const target=safeMiroBoard(url);check(signal);
    const share=await getShareLink(target.id);check(signal);
    const view=await race(createView({webPreferences:{...providerPreferences(),focusOnNavigation:false}}),signal);views.add(view);
    try{
      const wc=view.webContents;let blocked=false,status=0;
      view.setVisible?.(false);wc.setBackgroundThrottling?.(false);wc.setAudioMuted?.(true);wc.setWindowOpenHandler?.(()=>({action:'deny'}));
      const guard=(event,next)=>{if(!miroPage(next)){event.preventDefault();blocked=true;}};
      wc.on('will-navigate',guard);wc.on('will-redirect',guard);wc.on('will-attach-webview',event=>event.preventDefault());
      wc.on('did-navigate',(_event,_url,code)=>{status=Number.isInteger(code)?code:0;});
      try{await race(wc.loadURL(miroOpenURL(target.url,share)),signal);}catch(error){check(signal);if(!blocked)throw error instanceof MiroError?error:new MiroError('overview_unavailable',502);}
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
          const revision=miroOverviewRevision(value);
          // The overview fills progressively. Accept it after two identical polls
          // (three for an empty board, which may still be loading).
          if(revision===last){if(++stable>=(value.nodes.length?2:3)){snapshot=value;break;}}else{last=revision;stable=0;}
        }else if(value?.state!=='loading')throw new MiroError('overview_unavailable',502);
        if(clock()>deadline)throw new MiroError('overview_unavailable',504);
        await pause(pollMs,signal);
      }
      const revision=miroOverviewRevision(snapshot),key=target.id,metaKey=JSON.stringify([meta.title||'',meta.author||'']),hit=cache.get(key);
      if(hit?.revision===revision&&hit.metaKey===metaKey){cache.delete(key);cache.set(key,hit);return {...structuredClone(hit.result),fetchedAt:now(),cached:true};}
      const result=parseMiroOverview(snapshot,{url:target.url,meta,now});
      cache.delete(key);cache.set(key,{revision,metaKey,result:structuredClone(result)});while(cache.size>50)cache.delete(cache.keys().next().value);
      return {...result,cached:false};
    }finally{close(view);}
  }
  function read(input,signal){
    if(closed)return Promise.reject(new MiroError('closed',409));
    const pending=queue.catch(()=>{}).then(()=>run(input,signal));queue=pending.catch(()=>{});return pending;
  }
  read.dispose=()=>{closed=true;for(const view of [...views])close(view);cache.clear();};
  return read;
}
