import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const LIMIT=8*1024*1024;
const addressPattern=/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/;
const errors={
  not_configured:[409,'Verbinde zuerst dein TH-Mailkonto.'],
  invalid_request:[400,'Bitte prüfe die Mail-Eingaben.'],
  auth_failed:[401,'Anmeldung abgelehnt. Prüfe campusID und Passwort.'],
  connection_failed:[502,'Der TH-Mailserver ist nicht erreichbar. Prüfe deine Verbindung und versuche es später erneut.'],
  folder_unavailable:[404,'Dieser Ordner ist nicht verfügbar. Aktualisiere die Ordnerliste.'],
  mailbox_changed:[409,'Das Postfach wurde verändert. Aktualisiere die Nachrichtenliste.'],
  message_unavailable:[404,'Diese Nachricht oder dieser Anhang ist nicht mehr verfügbar.'],
  message_too_large:[413,'Diese Nachricht ist größer als 12 MB. Öffne sie in TH-Webmail.'],
  attachment_too_large:[413,'Anhänge dürfen zusammen höchstens 8 MB groß sein.'],
  search_failed:[502,'Der Mailserver konnte die Suche nicht ausführen.'],
  busy:[429,'Es laufen bereits Mail-Anfragen. Bitte kurz warten.'],
  send_failed:[502,'Der Mailserver hat den Versand abgelehnt. Die Nachricht wurde nicht versendet.'],
  delivery_unknown:[502,'Der Versandstatus ist unklar. Prüfe den Empfänger oder TH-Webmail, bevor du erneut sendest; sonst kann die Mail doppelt ankommen.'],
  cancelled:[409,'Die Mail-Verbindung wurde getrennt.'],
};
export class MailError extends Error{
  constructor(code){const safe=errors[code]?code:'connection_failed';super(errors[safe][1]);this.code=safe;this.status=errors[safe][0];}
}
function validAddress(value){return typeof value==='string'&&value.length<=254&&addressPattern.test(value);}
function clean(value,max){return typeof value==='string'?value.slice(0,max):'';}
export function validateDraft(draft){
  if(!draft||typeof draft!=='object'||Array.isArray(draft))throw new MailError('invalid_request');
  const result={};let count=0;
  for(const field of ['to','cc','bcc']){
    const values=draft[field]??[];
    if(!Array.isArray(values)||values.some(v=>!validAddress(v))||values.length>50)throw new MailError('invalid_request');
    result[field]=[...new Set(values)];count+=result[field].length;
  }
  if(!result.to.length||count>50||typeof draft.subject!=='string'||!draft.subject.trim()||draft.subject.length>300||/[\x00-\x1f\x7f]/.test(draft.subject)||typeof draft.text!=='string'||!draft.text.trim()||draft.text.length>100000||draft.text.includes('\0'))throw new MailError('invalid_request');
  result.subject=draft.subject;result.text=draft.text;
  if(draft.inReplyTo){if(typeof draft.inReplyTo!=='string'||!/^<[^<>\s\x00-\x1f]{1,480}>$/.test(draft.inReplyTo))throw new MailError('invalid_request');result.inReplyTo=draft.inReplyTo;}
  const files=draft.attachments??[];if(!Array.isArray(files)||files.length>10)throw new MailError('invalid_request');
  let total=0;
  result.attachments=files.map(file=>{
    if(!file||typeof file.name!=='string'||!file.name||file.name.length>180||/[\x00-\x1f\x7f/\\]/.test(file.name)||typeof file.data!=='string'||file.data.length>Math.ceil(LIMIT/3)*4||file.data.length%4||/[^A-Za-z0-9+/=]/.test(file.data))throw new MailError('invalid_request');
    const bytes=Buffer.from(file.data,'base64');if(bytes.toString('base64')!==file.data)throw new MailError('invalid_request');
    total+=bytes.length;if(total>LIMIT)throw new MailError('attachment_too_large');
    return {name:file.name,data:file.data};
  });
  return result;
}
export function runMailPython(payload,signal){
  return new Promise((resolve,reject)=>{
    const child=spawn('python3',['-B',fileURLToPath(new URL('./mail-client.py',import.meta.url)).replace(/app\.asar\//,'app.asar.unpacked/')],{env:{PATH:process.env.PATH},stdio:['pipe','pipe','ignore'],windowsHide:true});
    let settled=false,size=0;const chunks=[];
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(value);};
    const abort=()=>{child.kill();finish(new MailError(payload.action==='send'?'delivery_unknown':'cancelled'));};
    const timer=setTimeout(()=>{child.kill();finish(new MailError(payload.action==='send'?'delivery_unknown':'connection_failed'));},45000);
    if(signal?.aborted){abort();return;}signal?.addEventListener('abort',abort,{once:true});
    child.on('error',()=>finish(new MailError('connection_failed')));
    child.stdout.on('data',chunk=>{size+=chunk.length;if(size>20*1024*1024){child.kill();finish(new MailError('connection_failed'));}else chunks.push(chunk);});
    child.on('close',code=>{
      if(settled)return;
      try{if(code!==0)throw new Error();const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!value||typeof value!=='object')throw new Error();if(value.error)return finish(new MailError(value.error));finish(null,value);}
      catch{finish(new MailError(payload.action==='send'?'delivery_unknown':'connection_failed'));}
    });
    child.stdin.on('error',()=>{});
    // No credentials in argv, inherited environment, logs or temporary files.
    child.stdin.end(JSON.stringify(payload));
  });
}
const folder=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,1024}$/.test(value);
const uid=value=>typeof value==='string'&&/^[1-9][0-9]{0,19}$/.test(value);
const validity=value=>typeof value==='string'&&/^\d{1,20}$/.test(value);
export function createMailClient({runner=runMailPython,env=process.env}={}){
  let credentials=env.TH_MAIL_USER&&env.TH_MAIL_PASSWORD?{user:env.TH_MAIL_USER,password:env.TH_MAIL_PASSWORD,address:env.TH_MAIL_ADDRESS||''}:null;
  let smtpReady=false,epoch=0,configuring=false;const active=new Set(),sent=new Map();
  const status=()=>({configured:!!credentials,address:credentials?.address||'',smtpReady,storage:credentials?'session':''});
  async function run(action,data={},candidate=credentials){
    if(!candidate)throw new MailError('not_configured');
    if(active.size>=3)throw new MailError('busy');
    const controller=new AbortController(),version=epoch;active.add(controller);
    try{
      const result=await runner({...candidate,...data,action},controller.signal);
      if(epoch!==version)throw new MailError(action==='send'?'delivery_unknown':'cancelled');
      if(result?.error)throw new MailError(result.error);
      return result;
    }catch(error){throw error instanceof MailError?error:new MailError(action==='send'?'delivery_unknown':'connection_failed');}
    finally{active.delete(controller);}
  }
  const target=data=>{
    if(!data||!folder(data.folder)||!uid(data.uid)||!validity(data.uidValidity))throw new MailError('invalid_request');
    return {folder:data.folder,uid:data.uid,uidValidity:data.uidValidity};
  };
  async function list(data){
    if(!data||!folder(data.folder)||!Number.isSafeInteger(data.offset??0)||(data.offset??0)<0||(data.offset??0)>10000000||typeof (data.query??'')!=='string'||(data.query??'').length>200||/[\x00-\x1f\x7f]/.test(data.query??'')||data.unread!==undefined&&typeof data.unread!=='boolean')throw new MailError('invalid_request');
    return run('list',{folder:data.folder,offset:data.offset??0,query:data.query??'',unread:!!data.unread});
  }
  return {
    status,
    async configure(data){
      if(data?.disconnect===true){epoch++;credentials=null;smtpReady=false;for(const controller of active)controller.abort();sent.clear();return status();}
      if(configuring||active.size)throw new MailError('busy');
      if(!data||typeof data.user!=='string'||!/^[A-Za-z0-9._-]{1,100}$/.test(data.user)||typeof data.password!=='string'||!data.password||data.password.length>2048||/[\x00-\x1f\x7f]/.test(data.password)||!validAddress(data.address)||!data.address.toLowerCase().endsWith('@smail.th-koeln.de'))throw new MailError('invalid_request');
      configuring=true;const version=epoch,candidate={user:data.user,password:data.password,address:data.address};
      try{const result=await run('connect',{},candidate);if(version!==epoch)throw new MailError('cancelled');credentials=candidate;smtpReady=!!result.smtpReady;sent.clear();return {...status(),folders:result.folders,smtpWarning:!!result.smtpWarning};}
      finally{configuring=false;}
    },
    folders:()=>run('folders'),list,
    message:data=>run('message',target(data)),
    attachment(data){const selected=target(data);if(typeof data.part!=='string'||!/^\d{1,3}$/.test(data.part))throw new MailError('invalid_request');return run('attachment',{...selected,part:data.part});},
    flag(data){const selected=target(data);if(typeof data.unread!=='boolean')throw new MailError('invalid_request');return run('flag',{...selected,unread:data.unread});},
    async send(data){
      if(!credentials)throw new MailError('not_configured');
      if(!validAddress(credentials.address)||!data||typeof data.requestId!=='string'||!/^[a-zA-Z0-9-]{16,80}$/.test(data.requestId))throw new MailError('invalid_request');
      const draft=validateDraft(data.draft),digest=createHash('sha256').update(JSON.stringify(draft)).digest('hex');
      const previous=sent.get(data.requestId);
      if(previous){if(previous.digest!==digest)throw new MailError('invalid_request');return previous.result;}
      if(sent.size>=100||active.size>=3)throw new MailError('busy');
      const result=run('send',{draft});sent.set(data.requestId,{digest,result});
      // Rejected sends retain their request id too; a retry cannot silently send twice.
      result.catch(()=>{});return result;
    },
    async notifications(){
      const account=credentials?.user||'';
      const result=await list({folder:Buffer.from('INBOX').toString('base64url'),unread:true});
      const hash=createHash('sha256').update(account).digest('hex').slice(0,12);
      return result.items.map(item=>({id:'webmail_'+hash+'_'+result.uidValidity+'_'+item.uid,revision:'1',source:'webmail',title:clean(item.subject,300)||'(Kein Betreff)',summary:clean(item.sender,300),url:'https://webmail.th-koeln.de/',createdAt:typeof item.date==='string'&&item.date&&!Number.isNaN(Date.parse(item.date))?new Date(item.date).toISOString():'',relatedTool:clean(item.subject,300).includes('[THspaces]')?'spaces':'',mailTarget:{folder:result.folder,uid:item.uid,uidValidity:result.uidValidity}}));
    }
  };
}
