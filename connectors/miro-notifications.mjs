import {createHash} from 'node:crypto';
import {MiroError,miroPlainText,safeMiroBoard} from './miro.mjs';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const date=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&/^\d{4}-\d\d-\d\dT/.test(value)?new Date(value).toISOString():'';
const auth=status=>({integrationId:status.integrationId,connectionId:status.connectionId,revision:status.revision,capabilities:{boardRead:status.capabilities?.boardRead===true}});
const signature=status=>hash(auth(status||{}));
const check=signal=>{if(signal?.aborted)throw new MiroError('cancelled',499);};

/** One documented board metadata GET. No board items, attachments or comments. */
export async function miroBoardMetadata({nango,url,signal}){
  const target=safeMiroBoard(url);check(signal);
  const before=await nango.status('miro');check(signal);
  if(before?.connected!==true)throw new MiroError('not_connected',409);
  if(before.capabilities?.boardRead!==true)throw new MiroError('permission_denied',403);
  const response=await nango.proxy('miro',{method:'GET',path:'/v2/boards/'+encodeURIComponent(target.id),params:{},identity:auth(before)},signal);check(signal);
  if([401,403].includes(response?.status))throw new MiroError('permission_denied',response.status);
  if(response?.status!==200||response.data?.id!==target.id||typeof response.data?.name!=='string'||response.data.name.length>100000)throw new MiroError('invalid_response',502);
  if(signature(await nango.status('miro'))!==signature(before))throw new MiroError('connection_changed',409);check(signal);
  return {url:target.url,id:target.id,title:miroPlainText(response.data.name,200)||'Miro-Board',description:miroPlainText(response.data.description,20000),modifiedAt:date(response.data.modifiedAt),createdAt:date(response.data.createdAt)};
}

export async function miroNotifications({nango,scope=[],signal,previous=[],snapshots=[]}){
  if(!scope.length)return {items:[],status:'not_configured',complete:false,message:'Verknüpfe ein Miro-Board mit einem aktiven Kurs.'};
  const status=await nango?.status?.('miro'),items=[],warnings=[];
  const linked=scope.slice(0,20),account=signature(status),visitor=snapshots.filter(snapshot=>snapshot.basis==='visitor-overview'&&linked.some(board=>board.url===snapshot.url&&board.projectId===snapshot.projectId));
  if(scope.length>linked.length)warnings.push('Bis zu 20 verknüpfte Miro-Boards werden pro Prüfung berücksichtigt. Weitere Boards bleiben im Quellenbereich verfügbar.');
  function snapshotRows(){
    return visitor.map(board=>({id:'miro_'+hash([board.projectId,board.url]).slice(0,32),revision:board.revision,source:'miro',title:miroPlainText(board.title,200)||'Miro-Board',summary:'Eingelesener Board-Stand',content:'',contentStatus:'summary',url:board.url,createdAt:date(board.modifiedAt),observedAt:date(board.fetchedAt),kind:'board-snapshot',timeKind:'observed',mode:'snapshot',capturedAt:date(board.fetchedAt),projectId:board.projectId,groupId:hash(board.url).slice(0,20),groupName:miroPlainText(board.title,200)||'Miro-Board'}));
  }
  if(status?.connected!==true||status.capabilities?.boardRead!==true){
    const rows=snapshotRows();return {items:rows,status:rows.length?'snapshot':'not_configured',complete:false,warnings,capturedAt:rows.map(row=>row.capturedAt).sort().at(-1)||'',message:rows.length?'Zuletzt als Besucher eingelesene Boards. Aktualisiere den Inhalt im Quellenbereich.':'Board-Änderungen benötigen eine Miro-API-Verbindung. Öffentliche Boards können im Quellenbereich als Besucher gelesen werden.'};
  }
  let cursor=0;
  await Promise.all(Array.from({length:Math.min(3,linked.length)},async()=>{while(cursor<linked.length){
    const linkedBoard=linked[cursor++];
    try{
      const board=await miroBoardMetadata({nango,url:linkedBoard.url,signal});
      items.push({id:'miro_'+hash([account,linkedBoard.projectId,board.id]).slice(0,32),revision:hash([board.modifiedAt,board.title,board.description]),source:'miro',title:'Board · '+board.title.slice(0,190),summary:board.modifiedAt?'Zuletzt geänderter Board-Stand':'Board-Metadaten',content:board.description,contentStatus:'summary',url:board.url,createdAt:board.modifiedAt||board.createdAt,projectId:linkedBoard.projectId,groupId:hash(board.url).slice(0,20),groupName:board.title,kind:'board-update',mode:'api'});
    }catch(error){
      check(signal);if(['connection_changed','connection_mismatch','cancelled'].includes(error?.code))throw Object.assign(new Error('Miro-Verbindung geändert.'),{code:'ACCOUNT_CHANGED'});
      warnings.push(miroPlainText(linkedBoard.title,160)+': Board-Änderungen konnten nicht gelesen werden.');
      if(![401,403].includes(error?.status))items.push(...previous.filter(item=>item.url===linkedBoard.url&&item.projectId===linkedBoard.projectId&&item.mode==='api').map(item=>({...item,stale:true})));
    }
  }}));
  const updated=items.some(item=>!item.stale);
  return {items,status:updated?'connected':'error',complete:false,warnings,message:updated?'Änderungsstände deiner verknüpften Miro-Boards synchronisiert.':'Miro-Board-Änderungen konnten nicht aktualisiert werden.'};
}
