import {spawn} from 'node:child_process';
import {stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createSpeechModelStore} from './speech-models.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail=(message,code='SPEECH_ERROR')=>Object.assign(new Error(message),{code});
export function speechPermission({webContents,expected,permission,origin,mediaTypes=[],mainFrame=true}){
  return webContents===expected&&mainFrame&&origin==='http://127.0.0.1:4318'&&permission==='media'&&mediaTypes.length===1&&mediaTypes[0]==='audio';
}
export function speechPacket(type,payload){const data=Buffer.isBuffer(payload)?payload:Buffer.from(payload);const result=Buffer.allocUnsafe(data.length+5);result.writeUInt32LE(data.length+1,0);result[4]=type;data.copy(result,5);return result;}

// A single resident engine; no listening socket, shell, transcript log or audio file.
export function createDesktopSpeech({directory,emit=()=>{},spawnImpl=spawn,statImpl=stat,helperPath=fileURLToPath(new URL(process.platform==='win32'?'./speech-helper.exe':'./speech-helper',import.meta.url)),store}={}){
  helperPath=helperPath.replace(/app\.asar([/\\])/,'app.asar.unpacked$1');
  const models=store||createSpeechModelStore({directory,emit:event=>emit(event)});
  let child,buffer='',mode='idle',loaded='',gpu='',backend='',active='',operation=null,download=null,disposed=false,watchdog;
  const completed=new Set(),waiters=new Set();
  const dispatch=event=>{emit(event);for(const w of [...waiters]){if(w.accept(event)){clearTimeout(w.timer);waiters.delete(w);event.event==='error'?w.reject(fail(event.message||event.error||'Spracherkennung fehlgeschlagen.',event.code)):w.resolve(event);}}};
  const waitFor=(accept,timeout=120000)=>new Promise((resolve,reject)=>{const w={accept,resolve,reject};w.timer=setTimeout(()=>{waiters.delete(w);const error=fail('Die Spracherkennung antwortet nicht. Bitte erneut laden.','ENGINE_TIMEOUT'),id=active;reject(error);terminate({announce:false,error});mode='error';dispatch({event:'error',...(id?{id}:{}),code:error.code,message:error.message});},timeout);waiters.add(w);});
  function terminal(event){const id=event.id;if(!id||id!==active||completed.has(id))return false;completed.add(id);if(completed.size>32)completed.delete(completed.values().next().value);active='';clearTimeout(watchdog);mode=loaded?'ready':'idle';return true;}
  function receive(event){
    if(!event||typeof event!=='object'||typeof event.event!=='string')return;
    if(typeof event.text==='string'&&event.text.length>24000){const id=active,error=fail('Ungültige Antwort des lokalen Sprachdienstes.','ENGINE_PROTOCOL');terminate({announce:false,error});mode='error';dispatch({event:'error',...(id?{id}:{}),code:error.code,message:error.message});return;}
    if(event.event==='ready'){mode='ready';backend=event.backend||'cpu';}
    else if(event.event==='backend')backend=event.backend||backend;
    else if(['final','cancelled'].includes(event.event)){if(!terminal(event))return;}
    else if(event.event==='error'){if(event.id&&!terminal(event))return;mode='error';}
    else if(event.id&&event.id!==active)return;
    if(event.event==='processing')mode='processing';
    dispatch(event);
  }
  function terminate({announce=true,error=fail('Spracherkennung wurde abgebrochen.','CANCELLED')}={}){
    const previous=child;child=null;clearTimeout(watchdog);buffer='';loaded='';gpu='';backend='';mode='idle';
    if(active){const id=active;terminal({id});if(announce)dispatch({event:'cancelled',id});}
    for(const w of [...waiters]){clearTimeout(w.timer);waiters.delete(w);w.reject(error);}
    if(previous){previous.stdin?.destroy();previous.kill();const timer=setTimeout(()=>previous.kill('SIGKILL'),1000);timer.unref();previous.once('exit',()=>clearTimeout(timer));}
  }
  async function engine(token){
    if(child)return child;
    try{const file=await statImpl(helperPath);if(!file.isFile())throw new Error();}catch{throw fail('Der lokale Sprachdienst fehlt. Bitte die aktuelle Desktop-App installieren oder npm run build:speech ausführen.','ENGINE_MISSING');}
    if(disposed||operation!==token||token.controller.signal.aborted)throw fail('Laden abgebrochen.','CANCELLED');
    const p=spawnImpl(helperPath,[],{stdio:['pipe','pipe','pipe'],windowsHide:true,shell:false});child=p;buffer='';
    // whisper.cpp diagnostics may mention paths. They are deliberately not persisted or forwarded.
    p.stderr?.resume();
    p.stdout.setEncoding('utf8');p.stdout.on('data',data=>{
      if(child!==p)return;buffer+=data;if(buffer.length>131072){const id=active;terminate({announce:false});dispatch({event:'error',...(id?{id}:{}),code:'ENGINE_PROTOCOL',message:'Ungültige Antwort des lokalen Sprachdienstes.'});return;}
      for(let i;(i=buffer.indexOf('\n'))>=0;){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);try{receive(JSON.parse(line));}catch{const id=active;terminate({announce:false});dispatch({event:'error',...(id?{id}:{}),code:'ENGINE_PROTOCOL',message:'Ungültige Antwort des lokalen Sprachdienstes.'});break;}}
    });
    const gone=()=>{if(child!==p)return;const id=active,error=fail('Der lokale Sprachdienst wurde beendet. Bitte erneut starten.','ENGINE_EXIT');terminate({announce:false,error});mode='error';dispatch({event:'error',...(id?{id}:{}),code:error.code,message:error.message});};
    p.once('error',gone);p.once('exit',gone);return p;
  }
  function write(type,data){if(!child||child.stdin.destroyed)throw fail('Der lokale Sprachdienst ist nicht bereit.','NOT_READY');if(child.stdin.writableLength>256000)throw fail('Audio kann nicht schnell genug verarbeitet werden. Aufnahme bitte neu starten.','AUDIO_BACKPRESSURE');return new Promise((resolve,reject)=>child.stdin.write(speechPacket(type,data),error=>error?reject(fail('Audioübertragung wurde unterbrochen.','ENGINE_IO')):resolve()));}
  const command=data=>write(1,Buffer.from(JSON.stringify(data)));
  async function handle(message){
    if(disposed)throw fail('Sprachdienst wurde beendet.','DISPOSED');
    if(!message||typeof message!=='object')throw fail('Ungültiger Sprachauftrag.','BAD_REQUEST');
    const type=message.type;
    if(type==='status'){let available=false;try{available=(await statImpl(helperPath)).isFile();}catch{}const modelStatus=await models.status();return {available,state:mode,model:loaded,gpu,backend,...modelStatus};}
    if(type==='download'){
      if(download||operation||active)throw fail('Der Sprachdienst ist beschäftigt.','BUSY');
      const controller=new AbortController();download=controller;
      try{return await models.download(message.model,{signal:controller.signal});}finally{if(download===controller)download=null;}
    }
    if(type==='cancelDownload'){download?.abort();return;}
    if(type==='load'){
      const model=message.model||'small',device=message.gpu==='cpu'?'cpu':'auto';
      if(operation||active||download)throw fail('Der Sprachdienst ist beschäftigt.','BUSY');
      if(loaded===model&&gpu===device&&mode==='ready')return {ready:true,cached:true};
      const token={controller:new AbortController()};operation=token;mode='loading';dispatch({event:'loading',model});
      try{
        const paths=await models.ensure(model,{signal:token.controller.signal});if(operation!==token)throw fail('Laden abgebrochen.','CANCELLED');
        await engine(token);if(operation!==token)throw fail('Laden abgebrochen.','CANCELLED');
        const ready=waitFor(event=>['ready','error'].includes(event.event));void ready.catch(()=>{});await command({op:'load',modelPath:paths.modelPath,vadPath:paths.vadPath,gpu:device,threads:4});
        const value=await ready;if(operation!==token)throw fail('Laden abgebrochen.','CANCELLED');loaded=model;gpu=device;mode='ready';return value;
      }catch(error){if(operation===token){mode='error';dispatch({event:'error',code:error.code||'MODEL_ERROR',message:error.message});}throw error;}
      finally{if(operation===token)operation=null;}
    }
    if(type==='start'){
      if(!UUID.test(message.id||''))throw fail('Ungültige Aufnahme-ID.','BAD_REQUEST');
      if(active||operation||download)throw fail('Es läuft bereits eine Aufnahme.','BUSY');
      if(!loaded||mode!=='ready')throw fail('Bitte das Sprachmodell zuerst laden.','NOT_READY');
      if(completed.has(message.id))throw fail('Diese Aufnahme ist bereits abgeschlossen.','BAD_REQUEST');
      active=message.id;mode='recording';const started=waitFor(event=>event.id===message.id&&['started','error'].includes(event.event),10000);void started.catch(()=>{});
      await command({op:'start',id:active,pauseMs:Math.max(600,Math.min(5000,Number(message.pauseMs)||1800)),threshold:Math.max(.3,Math.min(.85,Number(message.threshold)||.5)),interimMs:Math.max(2000,Math.min(10000,Number(message.interimMs)||3000))});
      watchdog=setTimeout(()=>{if(active===message.id){const id=active;terminate({announce:false});dispatch({event:'error',id,code:'RECORDING_TIMEOUT',message:'Aufnahme nach drei Minuten beendet. Bitte in kürzeren Beiträgen sprechen.'});}},190000);return started;
    }
    if(type==='audio'){
      if(message.id!==active||mode!=='recording')return {ignored:true};
      const data=message.samples;let bytes;
      if(data instanceof Float32Array)bytes=Buffer.from(data.buffer,data.byteOffset,data.byteLength);
      else if(data instanceof ArrayBuffer)bytes=Buffer.from(data);
      else throw fail('Audio muss als PCM vorliegen.','BAD_AUDIO');
      if(!bytes.length||bytes.length%4||bytes.length>32768)throw fail('Ungültige Audiogröße.','BAD_AUDIO');
      for(let i=0;i<bytes.length;i+=4){const sample=bytes.readFloatLE(i);if(!Number.isFinite(sample)||Math.abs(sample)>1.001)throw fail('Ungültige Audiodaten.','BAD_AUDIO');}
      try{await write(2,Buffer.concat([Buffer.from(active,'ascii'),bytes]));}catch(error){const id=active;terminate({announce:false});dispatch({event:'error',id,code:error.code,message:error.message});throw error;}return;
    }
    if(type==='stop'){
      if(message.id!==active)return {ignored:true};const id=active;mode='processing';await command({op:'stop',id});if(active===id)dispatch({event:'processing',id});return;
    }
    if(type==='cancel'||type==='playback'){
      if(type==='cancel'&&message.id&&message.id!==active&&!operation)return {ignored:true};
      if(operation){operation.controller.abort();operation=null;terminate();return;}
      if(active){const id=active;await command({op:'cancel',id});if(terminal({id}))dispatch({event:'cancelled',id});}return;
    }
    throw fail('Unbekannter Sprachauftrag.','BAD_REQUEST');
  }
  handle.reset=()=>{download?.abort();operation?.controller.abort();operation=null;terminate();};
  handle.dispose=()=>{disposed=true;download?.abort();operation?.controller.abort();operation=null;terminate();};
  return handle;
}
