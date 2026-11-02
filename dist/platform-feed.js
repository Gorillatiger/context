import {parseFeedSnapshot,boundNotificationFeed} from './feed-state.js';
export {boundNotificationFeed} from './feed-state.js';

export function feedCourseScopes(projects=[],imported=[]){
  const scopes=new Map();
  for(const project of projects){
    if(project.archived)continue;
    for(const link of project.links||[])if(link.tool==='spaces'){
      try{const url=new URL(link.url);if(url.origin==='https://spaces.th-koeln.de'&&/^\/[a-z0-9][a-z0-9-]{0,100}\/?$/.test(url.pathname)&&!url.search&&!url.hash&&!url.username&&!url.password&&!['wp-admin','wp-json','public','home','hilfe','app'].includes(url.pathname.split('/')[1])){url.pathname=url.pathname.replace(/\/?$/,'/');scopes.set(url.href,{id:project.id,name:project.name,url:url.href});}}catch{}
    }
  }
  for(const course of Array.isArray(imported)?imported:[]){
    if(projects.some(project=>project.archived&&(project.id===course.id||project.links?.some(link=>link.url===course.url))))continue;
    for(const value of feedCourseScopes([{id:course.id,name:course.name,links:[{tool:'spaces',url:course.url}]}]))if(!scopes.has(value.url))scopes.set(value.url,value);
  }
  return [...scopes.values()].slice(0,20);
}

export async function readUnifiedFeed({fetcher=fetch,bridge=globalThis.window?.contextDesktop,projects=[],manual=false,signal,serverTimeoutMs=10000}={}){
  let base;
  try{
    const serverSignal=AbortSignal.any([AbortSignal.timeout(serverTimeoutMs),...(signal?[signal]:[])]);
    let cancel;
    const aborted=new Promise((_,reject)=>{cancel=()=>reject(serverSignal.reason);serverSignal.addEventListener('abort',cancel,{once:true});if(serverSignal.aborted)cancel();});
    try{base=await Promise.race([(async()=>{
      const response=await fetcher('/api/notifications'+(manual?'?refresh=1':''),{credentials:'same-origin',cache:'no-store',signal:serverSignal});
      if(!response.ok||!response.headers.get('content-type')?.includes('application/json'))throw new Error('no_connector');
      const value=await response.json();parseFeedSnapshot(value);return value;
    })(),aborted]);}finally{serverSignal.removeEventListener('abort',cancel);}
  }catch(error){
    if(signal?.aborted||typeof bridge?.notifications!=='function')throw error;
    base={items:[],sources:[{source:'webmail',status:'error',message:'Lokaler Mail-Connector nicht erreichbar.'}],courses:[]};
  }
  if(signal?.aborted)throw new DOMException('Abgebrochen','AbortError');
  if(typeof bridge?.notifications!=='function')return base;
  let result;
  try{result=await bridge.notifications({action:'sync',courses:feedCourseScopes(projects,base.courses),manual});}catch{result={ok:false};}
  if(signal?.aborted)throw new DOMException('Abgebrochen','AbortError');
  if(!result?.ok)result={ok:true,value:{items:[],sources:['spaces','mattermost','gitlab','sciebo','miro','whatsapp','signal'].map(source=>({source,status:'error',itemsAuthoritative:true,complete:false,message:'Browser-Synchronisierung nicht erreichbar. Context Browser erneut öffnen und aktualisieren.'}))}};
  const native=parseFeedSnapshot(result.value),selected=new Map(base.sources.map(source=>[source.source,source]));
  for(const source of native.sources){
    // An explicitly configured API token remains a useful alternative if a
    // website session is unavailable. Live data always supersedes snapshots.
    if(source.status==='connected'||selected.get(source.source)?.status!=='connected')selected.set(source.source,source);
  }
  const items=[...base.items.filter(item=>!native.sources.some(source=>source.source===item.source&&selected.get(item.source)===source)),...native.items.filter(item=>selected.get(item.source)===native.sources.find(source=>source.source===item.source))];
  return {...boundNotificationFeed(items,[...selected.values()]),courses:base.courses||[],checkedAt:result.value.checkedAt,perSourceRetry:true};
}
