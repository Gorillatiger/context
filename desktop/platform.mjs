import {createHash} from 'node:crypto';
import {createServiceReader,validateServiceSources} from './service-reader.mjs';
import {createDesktopMiro} from './miro.mjs';
import {safeMiroBoard} from '../connectors/miro.mjs';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=(message,code='INVALID_REQUEST')=>{throw Object.assign(new Error(message),{code});};
export function createDesktopPlatform({nango,createView,destroyView,openVisible,fetchText,readDocument,miroVisitor,miroLinks,getAccountFingerprint=async()=>hash('session'),emit=()=>{}}){
  let sources=[],boards=[],scopeHash=hash([]),scopeEpoch=0,generation=hash([scopeHash,scopeEpoch]),disposed=false;
  const accounts={gitlab:'',sciebo:'',mattermost:''},accountEpochs={gitlab:0,sciebo:0,mattermost:0};
  async function account(service){const token=accountEpochs[service],value=await getAccountFingerprint(service);if(disposed||token!==accountEpochs[service])fail('Die Anmeldung wurde geändert.','ACCOUNT_CHANGED');if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))fail('Ungültige Sitzung.');if(accounts[service]&&accounts[service]!==value){reader.invalidate();accountEpochs[service]++;emit({service});}accounts[service]=value;return value;}
  const reader=createServiceReader({createView,destroyView,openVisible,fetchText,readDocument,rememberInvites:invites=>miroLinks?.remember(invites),getSources:()=>sources,getAuthRevision:service=>(accounts[service]||'')+':'+accountEpochs[service]});
  const miro=createDesktopMiro({nango,visitor:miroVisitor,shareLinks:miroLinks,getAllowedBoards:()=>boards,getGeneration:()=>generation});
  function registry(values){
    if(!Array.isArray(values)||values.length>100)fail('Zu viele Plattformquellen.');
    const all=values.map(row=>{
      if(row?.service!=='miro')return validateServiceSources([row])[0];
      if(!row||Array.isArray(row)||Object.keys(row).some(key=>!['id','service','url','title','projectId','revision'].includes(key))||typeof row.id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,159}$/.test(row.id)||typeof row.projectId!=='string'||!row.projectId||row.projectId.length>80||/[\x00-\x20\x7f]/.test(row.projectId)||typeof row.title!=='string'||row.title.length>200||/[\x00-\x1f\x7f]/.test(row.title)||typeof row.revision!=='string'||!/^[a-f0-9]{32,64}$/.test(row.revision))fail('Ungültige Miro-Kursquelle.');
      return {...row,url:safeMiroBoard(row.url).url};
    });
    if(new Set(all.map(row=>row.id)).size!==all.length)fail('Doppelte Plattformquelle.');
    const next=hash(all);if(next!==scopeHash){reader.invalidate();sources=all.filter(row=>row.service!=='miro');boards=all.filter(row=>row.service==='miro');scopeHash=next;scopeEpoch++;generation=hash([scopeHash,scopeEpoch]);}
    return {registered:all.length,generation};
  }
  async function service(message){
    if(disposed)fail('Plattformleser beendet.','DISPOSED');
    if(!message||typeof message!=='object'||Array.isArray(message))fail('Ungültiger Plattformauftrag.');
    if(message?.action==='registry'){if(Object.keys(message).some(key=>!['action','sources'].includes(key)))fail('Ungültige Quellenregistrierung.');const result=registry(message.sources),token=generation;for(const service of new Set(sources.map(row=>row.service))){await account(service);if(token!==generation||disposed)fail('Die Quellenfreigabe wurde geändert.','SOURCE_CHANGED');}return {...result,accounts:{...accounts}};}
    const row=sources.find(row=>row.id===message?.sourceId),before=generation,accountBefore=row?await account(row.service):'';
    const value=await reader.handle(message);
    if(message?.action==='cancel'||message?.action==='release')return value;
    if(before!==generation||!row||await account(row.service)!==accountBefore||before!==generation)fail('Die Quellenfreigabe wurde geändert.','SOURCE_CHANGED');
    return {...value,scopeGeneration:generation,accountGeneration:accountBefore};
  }
  function invalidate(service){if(disposed||!Object.hasOwn(accounts,service)&&service!=='miro')return;if(service!=='miro'){accounts[service]='';accountEpochs[service]++;}scopeEpoch++;generation=hash([scopeHash,scopeEpoch]);reader.invalidate();emit({service});}
  return {service,miro,invalidate,cancel:()=>reader.invalidate(),dispose:()=>{disposed=true;reader.dispose();miro.dispose();sources=[];boards=[];},generation:()=>generation};
}
