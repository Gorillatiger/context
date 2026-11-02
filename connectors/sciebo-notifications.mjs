import {createHash} from 'node:crypto';
import {miroPlainText} from './miro.mjs';

const ORIGIN='https://th-koeln.sciebo.de';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=(code,status)=>Object.assign(new Error('Sciebo konnte nicht gelesen werden.'),{code,...(status?{status}:{})});
const plain=(value,max)=>miroPlainText(typeof value==='string'?value:'',max);
const date=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,7})?(?:Z|[+-]\d\d:\d\d)$/.test(value)&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():'';

function data(response){
  const code=Number(response?.ocs?.meta?.statuscode);
  if([401,403,997].includes(code))throw fail('LOGIN_REQUIRED',401);
  if(!response?.ocs||![100,200].includes(code)||response.ocs.meta.status!=='ok')throw fail('INVALID_RESPONSE');
  return response.ocs.data;
}
export function scieboNotificationURL(value){
  try{
    const url=new URL(value,ORIGIN);
    if(url.origin!==ORIGIN||url.username||url.password||url.hash||/[\\\x00-\x20]/.test(String(value))||/%(?:2f|5c|00|2e)/i.test(url.pathname))throw fail('INVALID_RESPONSE');
    if(!/^\/(?:index\.php\/)?(?:apps\/files\/?|f\/[1-9]\d{0,17}\/?|s\/[a-zA-Z0-9_-]{6,100}\/?)$/.test(url.pathname))throw fail('INVALID_RESPONSE');
    if([...url.searchParams.keys()].some(key=>!['dir','fileid','path','scrollto','view'].includes(key)))throw fail('INVALID_RESPONSE');
    return url.href;
  }catch{return ORIGIN+'/index.php/apps/files/';}
}

/** The documented ownCloud OCS notifications contract. Never invokes actions. */
export async function scieboNotifications({read,signal}){
  if(typeof read!=='function')throw new TypeError('Sciebo benötigt einen lesenden Transport.');
  const headers={'OCS-APIRequest':'true',Accept:'application/json'};
  const request=async(path)=>{
    const response=await read(ORIGIN+path+'?format=json',{headers,signal});
    if(response.status===204)return null;
    const type=response.headers?.get('content-type')||'';
    if(!/^(?:application\/json|text\/plain)(?:;|$)/i.test(type))throw fail('LOGIN_REQUIRED',401);
    let value;try{value=JSON.parse(response.text);}catch{throw fail('INVALID_RESPONSE');}
    return data(value);
  };
  const capabilities=await request('/ocs/v2.php/cloud/capabilities');
  const routes=capabilities?.capabilities?.notifications?.['ocs-endpoints'];
  if(!Array.isArray(routes)||!routes.includes('list'))return {items:[],status:'not_configured',complete:false,message:'Sciebo bietet in dieser Sitzung keine Benachrichtigungs-API an.'};
  const rows=await request('/ocs/v2.php/apps/notifications/api/v1/notifications');
  if(rows===null)return {items:[],status:'connected',complete:true,message:'Sciebo meldet keine aktiven Benachrichtigungsanbieter.'};
  if(!Array.isArray(rows)||rows.length>2000)throw fail('INVALID_RESPONSE');
  const owners=new Set(rows.map(row=>row?.user));
  if(rows.length&&(owners.size!==1||typeof rows[0].user!=='string'||!rows[0].user||rows[0].user.length>255))throw fail('INVALID_RESPONSE');
  const account=hash(rows[0]?.user||'empty').slice(0,20),seen=new Set();
  const items=[...rows].sort((a,b)=>(Date.parse(date(b?.datetime))||0)-(Date.parse(date(a?.datetime))||0)).slice(0,50).map(row=>{
    if(!Number.isSafeInteger(row.notification_id)||row.notification_id<=0||seen.has(row.notification_id)||typeof row.subject!=='string'||row.subject.length>20000||row.message!==undefined&&typeof row.message!=='string')throw fail('INVALID_RESPONSE');
    seen.add(row.notification_id);
    const content=plain(row.message,20000),title=plain(row.subject,200)||'Sciebo-Hinweis';
    return {id:'sciebo_'+account+'_'+row.notification_id,revision:hash([row.subject,row.message,row.datetime]),source:'sciebo',title,summary:plain(row.app,160)||'Sciebo',content,contentStatus:'excerpt',url:scieboNotificationURL(row.link),createdAt:date(row.datetime),groupId:'notifications',groupName:'Dateien und Freigaben',kind:'notification',mode:'api'};
  });
  return {items,status:'connected',complete:rows.length<=50,warnings:rows.length>50?['Die neuesten 50 Sciebo-Hinweise sind enthalten. Weitere Hinweise bleiben bei Sciebo verfügbar.']:[],message:'Sciebo-Benachrichtigungen über deine Browser-Anmeldung synchronisiert.'};
}
