const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const SPEECH_DEFAULTS=Object.freeze({model:'small',gpu:'auto',pauseMs:1800,autoSend:false,saveTranscript:false});
const SETTINGS_KEY='context-local-speech-settings-v1',ACTIVE=new Set(['loading','requesting','recording','processing','cancelling']),MAX_QUEUED_SAMPLES=32000,MAX_CAPTURE_MS=180000;
const messageFor=error=>({NotAllowedError:'Der Mikrofonzugriff wurde nicht erlaubt. Aktiviere ihn in den Systemeinstellungen für Context Browser.',PermissionDeniedError:'Der Mikrofonzugriff wurde nicht erlaubt. Aktiviere ihn in den Systemeinstellungen für Context Browser.',NotFoundError:'Kein Mikrofon gefunden. Verbinde ein Aufnahmegerät und versuche es erneut.',DevicesNotFoundError:'Kein Mikrofon gefunden. Verbinde ein Aufnahmegerät und versuche es erneut.',NotReadableError:'Das Mikrofon ist gerade nicht verfügbar. Prüfe, ob eine andere App es verwendet.',AbortError:'Die Aufnahme wurde unterbrochen.',TimeoutError:'Die Mikrofonfreigabe hat zu lange gedauert. Bitte erneut starten.'}[error?.name]||error?.message||'Die lokale Spracheingabe ist fehlgeschlagen.');
function settings(value={}){return {model:['small','large-v3-turbo'].includes(value.model)?value.model:'small',gpu:value.gpu==='cpu'?'cpu':'auto',pauseMs:Math.max(600,Math.min(5000,Math.round(Number(value.pauseMs)||1800))),autoSend:value.autoSend===true,saveTranscript:value.saveTranscript===true};}
function normalizeModels(rows){return (Array.isArray(rows)?rows:[]).filter(row=>row&&['small','large-v3-turbo'].includes(row.id)).map(row=>({...row,title:row.label||row.title||row.id,bytes:Number(row.totalBytes||row.bytes)||0,installed:row.available===true||row.installed===true}));}
const abortError=()=>new DOMException('Aufnahme abgebrochen.','AbortError');
function timeout(promise,ms,timers){let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=timers.setTimeout(()=>reject(new DOMException('Die lokale Sprachverarbeitung antwortet nicht.','TimeoutError')),ms);})]).finally(()=>timers.clearTimeout(timer));}

export async function createMicrophoneCapture({onAudio,isCurrent,mediaDevices=globalThis.navigator?.mediaDevices,AudioContextClass=globalThis.AudioContext||globalThis.webkitAudioContext,AudioWorkletNodeClass=globalThis.AudioWorkletNode,timers=globalThis,permissionTimeoutMs=20000}){
  if(!mediaDevices?.getUserMedia)throw new Error('Mikrofonaufnahme ist in diesem Fenster nicht verfügbar. Öffne die Context-Desktop-App.');
  if(!AudioContextClass||!AudioWorkletNodeClass)throw new Error('Diese Browser-Version unterstützt die lokale Audioaufnahme nicht.');
  let stream,context,source,node,gain,stopped=false,connected=false,flushResolve;
  const stopTracks=()=>{for(const track of stream?.getTracks?.()||[]){track.onended=null;track.stop();}};
  const close=async({flush=false}={})=>{
    if(stopped)return;stopped=true;stopTracks();
    try{if(node&&flush){let flushTimer;try{await new Promise(resolve=>{flushResolve=resolve;node.port.postMessage({type:'flush'});flushTimer=timers.setTimeout(resolve,300);});}finally{timers.clearTimeout(flushTimer);flushResolve=null;}}else node?.port.postMessage({type:'cancel'});}finally{
      if(node){node.port.onmessage=null;node.port.close?.();}for(const item of [source,node,gain])try{item?.disconnect();}catch{}
      if(context&&context.state!=='closed')try{await context.close();}catch{}stream=null;source=null;node=null;gain=null;context=null;
    }
  };
  try{
    const pending=mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
    pending.then(result=>{if(!isCurrent()||stopped)for(const track of result.getTracks())track.stop();},()=>{});
    try{stream=await timeout(pending,permissionTimeoutMs,timers);}catch(error){stopped=true;throw error;}
    if(!isCurrent()){await close();throw abortError();}
    if(!stream.getAudioTracks().length)throw new DOMException('Kein Aufnahmegerät verfügbar.','NotFoundError');
    try{context=new AudioContextClass({latencyHint:'interactive',sampleRate:16000});}catch{context=new AudioContextClass({latencyHint:'interactive'});}
    await context.audioWorklet.addModule(new URL('./speech-worklet.js',import.meta.url));
    if(!isCurrent()){await close();throw abortError();}
    source=context.createMediaStreamSource(stream);node=new AudioWorkletNodeClass(context,'context-speech-capture',{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[1],processorOptions:{chunkSize:1536}});gain=context.createGain();gain.gain.value=0;
    node.port.onmessage=({data})=>{if(data?.type==='audio'&&data.samples instanceof Float32Array&&!(!connected||!isCurrent()))onAudio(data.samples);if(data?.type==='flushed')flushResolve?.();};
    return {start:async()=>{if(stopped||!isCurrent())throw abortError();for(const track of stream.getAudioTracks())track.onended=()=>{if(!stopped)onAudio(null,new DOMException('Das Aufnahmegerät wurde getrennt.','AbortError'));};source.connect(node);node.connect(gain);gain.connect(context.destination);connected=true;await context.resume();},close};
  }catch(error){await close();throw error;}
}

/** A single long-lived controller; rerendering the composer never restarts the microphone. */
export function createSpeechInput({bridge=globalThis.window?.contextDesktop,onChange=()=>{},onFinal=()=>{},getContextKey=()=>'',canStart=()=>true,isPlaybackActive=()=>false,captureFactory=createMicrophoneCapture,storage=globalThis.localStorage,eventTarget=globalThis.window,timers=globalThis,uuid=()=>globalThis.crypto.randomUUID(),now=()=>performance.now(),permissionTimeoutMs=20000}={}){
  let saved={};try{saved=JSON.parse(storage?.getItem(SETTINGS_KEY)||'{}');}catch{}
  const state={...settings(saved),available:typeof bridge?.speech==='function',phase:typeof bridge?.speech==='function'?'idle':'unavailable',models:[],modelReady:false,error:'',notice:'',interim:'',level:0,speaking:false,download:null,settingsOpen:false,sessionId:'',metrics:null};
  let current=null,generation=0,disposed=false,playback=false,downloadGeneration=0,watcher=null,refreshPromise=null,cancelPromise=null;
  const notify=()=>{if(!disposed)onChange(state);};
  const isCurrent=session=>!disposed&&current===session&&generation===session.generation&&getContextKey()===session.contextKey;
  const request=async payload=>{if(!state.available)throw new Error('Lokale Spracheingabe ist in der aktuellen Context-Desktop-App verfügbar.');const result=await bridge.speech(payload);if(!result?.ok){const error=new Error(result?.error||'Die lokale Sprachverarbeitung ist nicht verfügbar.');error.code=result?.code;throw error;}return result.value;};
  function clearWatcher(){if(watcher){timers.clearInterval(watcher);watcher=null;}}
  async function haltCapture(session,flush=false){if(!session)return;if(!flush)session.acceptAudio=false;const capture=session.capture;session.capture=null;await capture?.close({flush});}
  async function refresh(){if(disposed||!state.available)return state;if(refreshPromise)return refreshPromise;
    refreshPromise=(async()=>{try{const value=await request({type:'status'});if(disposed)return state;state.models=normalizeModels(value?.models);state.available=value?.available!==false;state.modelReady=value?.state==='ready'&&value?.model===state.model;state.backend=value?.backend||value?.gpu||'';if(!ACTIVE.has(state.phase)&&!state.download)state.phase=state.available?(state.modelReady?'ready':'idle'):'unavailable';if(value?.error)state.error=String(value.error);notify();return state;}catch(error){if(!disposed){state.error=messageFor(error);state.phase='error';notify();}return state;}finally{refreshPromise=null;}})();return refreshPromise;
  }
  const captureCloseError=()=>Object.assign(new Error('Das Mikrofon konnte nicht vollständig beendet werden. Bitte die Spracheingabe erneut starten.'),{code:'CAPTURE_CLOSE'});
  async function releaseSession(session){
    session.acceptAudio=false;for(const samples of session.queue)samples.fill(0);session.queue=[];session.queuedSamples=0;
    let error;try{await haltCapture(session);}catch{error=captureCloseError();}
    // Native cancellation must run even if microphone cleanup fails.
    try{await request({type:'cancel',id:session.id});}catch(nativeError){state.modelReady=false;error=error||nativeError;}
    return error;
  }
  async function fail(session,error){
    if(!isCurrent(session))return;generation++;current=null;clearWatcher();state.sessionId='';state.interim='';state.level=0;state.speaking=false;state.phase='error';state.error=messageFor(error);session.acceptAudio=false;
    cancelPromise=Promise.resolve().then(()=>releaseSession(session)).then(cleanupError=>{if(cleanupError&&!state.error)state.error=messageFor(cleanupError);}).finally(()=>{cancelPromise=null;state.phase='error';notify();});notify();await cancelPromise;
  }
  function checkContext(){if(current&&(!isCurrent(current)||!canStart()))void cancel('Der Chat-Kontext hat sich geändert. Die Spracheingabe wurde verworfen.');}
  async function drain(session){if(session.draining)return session.draining;
    session.draining=(async()=>{while(session.queue.length&&isCurrent(session)){const samples=session.queue.shift();try{await timeout(request({type:'audio',id:session.id,samples}),10000,timers);}catch(error){await fail(session,error);return;}finally{session.queuedSamples-=samples.length;samples.fill(0);}}})().finally(()=>{session.draining=null;});return session.draining;
  }
  function audio(session,samples,error){if(error){void fail(session,error);return;}if(!isCurrent(session)||!session.acceptAudio||state.phase==='processing')return;if(!(samples instanceof Float32Array)||samples.length<1||samples.length>8192){void fail(session,new Error('Ungültige Audiodaten. Die Aufnahme wurde beendet.'));return;}
    if(session.queuedSamples+samples.length>MAX_QUEUED_SAMPLES){samples.fill(0);void fail(session,new Error('Die Sprachverarbeitung ist zu langsam. Die Aufnahme wurde beendet; bitte erneut starten oder ein kleineres Modell wählen.'));return;}
    session.queue.push(samples);session.queuedSamples+=samples.length;void drain(session);
  }
  async function start(){
    if(cancelPromise)await cancelPromise;
    if(disposed||current||state.download||!canStart())return false;
    if(playback||isPlaybackActive()||globalThis.speechSynthesis?.speaking){state.error='Warte, bis die Sprachausgabe beendet ist. Das Mikrofon bleibt aus.';state.phase='error';notify();return false;}
    if(!state.available){state.phase='unavailable';notify();return false;}
    const session={id:uuid(),generation:++generation,contextKey:getContextKey(),capture:null,queue:[],queuedSamples:0,draining:null,acceptAudio:false,completed:false,autoSend:state.autoSend,saveTranscript:state.saveTranscript,startedAt:now(),stopping:false};current=session;state.sessionId=session.id;state.interim='';state.error='';state.notice='';state.metrics=null;state.phase='loading';notify();
    try{
      await refresh();if(!isCurrent(session))return false;
      const selected=state.models.find(row=>row.id===state.model);if(!selected?.installed){current=null;state.sessionId='';state.phase='idle';state.settingsOpen=true;state.notice='Lade zuerst das Sprachmodell herunter. Danach funktioniert die Erkennung offline.';notify();return false;}
      await timeout(request({type:'load',model:state.model,gpu:state.gpu}),180000,timers);if(!isCurrent(session))return false;
      state.modelReady=true;state.phase='requesting';notify();
      const capture=await captureFactory({onAudio:(samples,error)=>audio(session,samples,error),isCurrent:()=>isCurrent(session),permissionTimeoutMs,timers});
      if(!isCurrent(session)){await capture.close();return false;}session.capture=capture;
      await timeout(request({type:'start',id:session.id,pauseMs:state.pauseMs,threshold:0.5,interimMs:2000}),15000,timers);if(!isCurrent(session)){await haltCapture(session);return false;}
      session.acceptAudio=true;state.phase='recording';session.startedAt=now();await capture.start();if(!isCurrent(session))return false;
      watcher=timers.setInterval(()=>{checkContext();if(!current)return;if(playback||isPlaybackActive()||globalThis.speechSynthesis?.speaking)void cancel('Sprachausgabe erkannt. Das Mikrofon wurde ausgeschaltet.');else if(now()-session.startedAt>=MAX_CAPTURE_MS){state.notice='Aufnahme nach drei Minuten beendet. Du kannst den Text vor dem Senden prüfen.';void stop();}},250);notify();return true;
    }catch(error){if(isCurrent(session))await fail(session,error);return false;}
  }
  async function stop(){const session=current;if(!session||session.stopping)return false;if(!['recording','requesting'].includes(state.phase)){await cancel();return false;}session.stopping=true;clearWatcher();
    try{try{await haltCapture(session,true);}catch{throw captureCloseError();}session.acceptAudio=false;await drain(session);if(!isCurrent(session))return false;state.phase='processing';state.level=0;state.speaking=false;notify();await timeout(request({type:'stop',id:session.id}),120000,timers);return true;}catch(error){if(isCurrent(session))await fail(session,error);return false;}
  }
  async function cancel(notice='Spracheingabe verworfen.'){
    if(cancelPromise)return cancelPromise;
    const session=current;generation++;current=null;clearWatcher();state.sessionId='';state.interim='';state.level=0;state.speaking=false;state.error='';state.notice=notice;
    if(!session){state.phase=state.modelReady?'ready':'idle';notify();return false;}
    state.phase='cancelling';session.acceptAudio=false;for(const samples of session.queue)samples.fill(0);session.queue=[];session.queuedSamples=0;
    cancelPromise=Promise.resolve().then(async()=>{notify();const error=await releaseSession(session);if(error)state.error=messageFor(error);return true;}).finally(()=>{cancelPromise=null;state.phase=state.error?'error':state.modelReady?'ready':'idle';notify();});return cancelPromise;
  }
  function configure(patch){if(current||state.download)return false;const previousModel=state.model,previousGpu=state.gpu;Object.assign(state,settings({...state,...patch}));if(previousModel!==state.model||previousGpu!==state.gpu)state.modelReady=false;state.error='';state.notice='';try{storage?.setItem(SETTINGS_KEY,JSON.stringify(settings(state)));}catch{}notify();return true;}
  async function download(){if(disposed||current||state.download||!state.available)return false;const version=++downloadGeneration,model=state.model;state.download={model,bytes:0,totalBytes:state.models.find(row=>row.id===model)?.bytes||0,phase:'download'};state.error='';state.settingsOpen=true;notify();
    try{await request({type:'download',model});if(disposed||version!==downloadGeneration)return false;state.download=null;state.notice='Sprachmodell geprüft und lokal gespeichert. Du kannst jetzt aufnehmen.';await refresh();notify();return true;}catch(error){if(!disposed&&version===downloadGeneration){state.download=null;state.phase='error';state.error=messageFor(error);notify();}return false;}
  }
  async function cancelDownload(){if(!state.download)return;const model=state.download.model;downloadGeneration++;state.download=null;state.notice='Modelldownload angehalten. Bereits vorhandene, geprüfte Modelle bleiben verfügbar.';notify();try{await request({type:'cancelDownload',model});}catch{}await refresh();}
  function setPlaybackActive(value){playback=!!value;if(playback&&current)void cancel('Sprachausgabe aktiv. Das Mikrofon wurde ausgeschaltet.');}
  const playbackListener=event=>setPlaybackActive(event.detail?.active===true||event.detail===true);eventTarget?.addEventListener?.('context-speech-playback',playbackListener);
  const unloadListener=()=>{void dispose();};eventTarget?.addEventListener?.('pagehide',unloadListener);
  const unsubscribe=bridge?.onEvent?.(packet=>{
    if(disposed||packet?.type!=='context-speech')return;const event=packet.detail||{},type=event.event||event.type;
    if(type==='download'&&state.download&&(!event.model||event.model===state.download.model)){state.download={...state.download,bytes:Math.max(0,Number(event.bytes??event.received??event.downloaded)||0),totalBytes:Math.max(0,Number(event.totalBytes??event.total)||state.download.totalBytes),phase:event.phase||'download'};notify();return;}
    if(type==='ready'){state.modelReady=!event.model||event.model===state.model;state.backend=event.backend||event.gpu||state.backend;if(event.fallback)state.notice='Metal ist nicht verfügbar. Die Erkennung verwendet den CPU-Fallback.';if(!current&&!state.download)state.phase='ready';notify();return;}
    if(type==='error'&&!event.id){state.modelReady=false;const error=Object.assign(new Error(event.error||event.message||'Der lokale Sprachdienst ist nicht verfügbar.'),{code:event.code});if(current)void fail(current,error);else{state.phase='error';state.error=messageFor(error);notify();}return;}
    if(type==='backend'){state.backend=event.backend||state.backend;if(event.fallback)state.notice='GPU-Verarbeitung fehlgeschlagen. Die Erkennung verwendet den CPU-Fallback.';notify();return;}
    if(!current||event.id!==current.id)return;const session=current;if(!isCurrent(session)){void cancel('Der Chat-Kontext hat sich geändert. Die Spracheingabe wurde verworfen.');return;}
    if(type==='interim'&&state.phase==='recording'){state.interim=String(event.text??'').slice(0,12000);notify();}
    if(type==='vad'){const wasSpeaking=state.speaking;state.speaking=event.speaking===true||event.active===true||event.speech===true||Number(event.probability)>=0.5;state.level=Math.max(0,Math.min(1,Number(event.level)||0));if(wasSpeaking!==state.speaking)notify();}
    if(type==='processing'){session.acceptAudio=false;clearWatcher();void haltCapture(session).catch(()=>{if(isCurrent(session))void fail(session,captureCloseError());else if(!disposed&&generation===session.generation&&!current){state.phase='error';state.error=messageFor(captureCloseError());notify();}});for(const samples of session.queue)samples.fill(0);session.queue=[];state.phase='processing';state.level=0;state.speaking=false;notify();}
    if(type==='error'){if(['ENGINE_EXIT','ENGINE_TIMEOUT','ENGINE_PROTOCOL','RECORDING_TIMEOUT','AUDIO_BACKPRESSURE'].includes(event.code))state.modelReady=false;void fail(session,Object.assign(new Error(event.error||event.message||'Die lokale Sprachverarbeitung ist fehlgeschlagen.'),{code:event.code}));}
    if(type==='cancelled'){void cancel('Die Aufnahme wurde abgebrochen.');}
    if(type==='final'&&!session.completed){session.completed=true;session.acceptAudio=false;current=null;clearWatcher();void haltCapture(session).catch(()=>{if(!disposed&&generation===session.generation&&!current){state.phase='error';state.error=messageFor(captureCloseError());notify();}});for(const samples of session.queue)samples.fill(0);session.queue=[];state.sessionId='';state.interim='';state.level=0;state.speaking=false;state.phase='ready';state.metrics=event.metrics||null;const text=String(event.text??'').trim();state.notice=text?(session.autoSend?'Spracheingabe abgeschlossen.':'Text übernommen. Prüfe ihn vor dem Senden.'):'Keine Sprache erkannt. Es wurde keine Nachricht erstellt.';notify();if(text){try{onFinal({id:session.id,text,autoSend:session.autoSend,saveTranscript:session.saveTranscript,metrics:state.metrics,contextKey:session.contextKey});}catch(error){state.error=messageFor(error);state.phase='error';notify();}}}
  });
  async function dispose(){if(disposed)return;if(state.download)await cancelDownload();await cancel('');disposed=true;unsubscribe?.();eventTarget?.removeEventListener?.('context-speech-playback',playbackListener);eventTarget?.removeEventListener?.('pagehide',unloadListener);}
  function handleClick(event){const element=event.target?.closest?.('[data-speech-action]');if(!element)return false;event.preventDefault();const actions={start,stop,cancel,download,'cancel-download':cancelDownload,refresh};if(element.disabled)return true;void actions[element.dataset.speechAction]?.();return true;}
  function handleChange(event){const element=event.target;if(!element?.dataset?.speechSetting)return false;const key=element.dataset.speechSetting,value=element.dataset.speechCpu!==undefined?(element.checked?'cpu':'auto'):element.type==='checkbox'?element.checked:element.value;configure({[key]:value});return true;}
  function handleToggle(event){if(event.target?.matches?.('[data-speech-settings]'))state.settingsOpen=event.target.open;}
  Promise.resolve().then(()=>{if(!disposed&&state.available)void refresh();});
  return {state,isActive:()=>ACTIVE.has(state.phase)||!!current||!!cancelPromise,start,stop,cancel,configure,download,cancelDownload,refresh,dispose,setPlaybackActive,checkContext,handleClick,handleChange,handleToggle};
}

const prettyBytes=bytes=>bytes>0?Math.round(bytes/1024/1024)+' MiB':'Größe wird geprüft';
export function renderSpeechControls(state,{disabled=false,providerLabel='dem gewählten KI-Anbieter'}={}){
  const active=ACTIVE.has(state.phase),recording=state.phase==='recording',selected=state.models.find(row=>row.id===state.model),installed=selected?.installed===true;
  const labels={idle:installed?'Modell lokal vorhanden':'Sprachmodell einrichten',loading:'Modell wird geladen …',requesting:'Mikrofonfreigabe …',ready:'Bereit · lokal'+(state.backend==='metal'?' · Metal':state.backend==='cpu'?' · CPU':''),recording:state.speaking?'Sprache erkannt · Aufnahme läuft':'Aufnahme läuft · Warte auf Sprache',processing:'Sprache wird lokal verarbeitet …',cancelling:'Aufnahme wird abgebrochen …',error:'Spracheingabe angehalten',unavailable:'Spracheingabe in der Desktop-App verfügbar'};
  const download=state.download,total=download?.totalBytes||0,progress=total?Math.min(100,Math.round(download.bytes/total*100)):0;
  return `<section class="speech-input" aria-label="Lokale Spracheingabe"><div class="speech-toolbar"><button type="button" class="button secondary speech-mic ${recording?'is-recording':''}" data-speech-action="${recording?'stop':'start'}" ${(!state.available||disabled&&!recording||active&&!recording||download)?'disabled':''} aria-label="${recording?'Aufnahme stoppen und Text übernehmen':'Deutsche Spracheingabe starten'}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="8" y="2" width="8" height="13" rx="4"/><path d="M5 10v1a7 7 0 0 0 14 0v-1M12 18v4M8 22h8"/></svg>${recording?'Stoppen':'Spracheingabe'}</button><span class="speech-status" role="status" aria-live="polite">${esc(labels[state.phase]||labels.idle)}</span>${active?'<button type="button" class="text-link" data-speech-action="cancel">Verwerfen</button>':''}</div>
  ${state.interim?`<div class="speech-interim" aria-label="Vorläufig erkannter Text"><span>Vorläufiger Text</span><p>${esc(state.interim)}</p><small>Wird während des Sprechens korrigiert.</small></div>`:''}
  ${state.error?`<p class="speech-error" role="alert">${esc(state.error)}</p>`:''}${state.notice?`<p class="speech-notice">${esc(state.notice)}</p>`:''}
  <details class="speech-settings" data-speech-settings ${state.settingsOpen?'open':''}><summary>Spracheingabe einstellen · Deutsch</summary><div class="speech-setting-grid"><label>Whisper-Modell<select data-speech-setting="model" ${active||download||!state.available?'disabled':''}><option value="small" ${state.model==='small'?'selected':''}>small · empfohlen</option><option value="large-v3-turbo" ${state.model==='large-v3-turbo'?'selected':''}>large-v3-turbo · höhere Genauigkeit</option></select></label><label>Sprechpause bis zum Abschluss<select data-speech-setting="pauseMs" ${active?'disabled':''}>${[...new Set([600,1000,1800,2500,3500,5000,state.pauseMs])].sort((a,b)=>a-b).map(ms=>`<option value="${ms}" ${state.pauseMs===ms?'selected':''}>${(ms/1000).toLocaleString('de-DE')} Sekunden${ms===1800?' · Standard':''}</option>`).join('')}</select></label></div>
  <div class="speech-options"><label><input type="checkbox" data-speech-setting="gpu" data-speech-cpu ${state.gpu==='cpu'?'checked':''} ${active||download?'disabled':''}> CPU statt Metal/GPU verwenden</label><label><input type="checkbox" data-speech-setting="autoSend" ${state.autoSend?'checked':''} ${active?'disabled':''}> Nach dem Sprechende automatisch senden</label><label><input type="checkbox" data-speech-setting="saveTranscript" ${state.saveTranscript?'checked':''} ${active?'disabled':''}> Spracheingaben und Antworten im lokalen Chatarchiv speichern</label></div>
  ${download?`<div class="speech-download" role="status"><strong>${download.phase==='verifying'?'Dateiintegrität wird geprüft …':'Sprachmodell wird heruntergeladen …'}</strong><progress max="100" ${total?`value="${progress}"`:''} aria-label="Modelldownload"></progress><span>${Math.round(download.bytes/1024/1024)+' MiB'}${total?' von '+prettyBytes(total)+' · '+progress+' %':''}</span><button type="button" class="text-link" data-speech-action="cancel-download">Download anhalten</button></div>`:state.available?`<div class="speech-model-download"><span>${installed?'Modell geprüft · lokal vorhanden':prettyBytes(selected?.bytes||0)+' · einmaliger Download'}</span><button type="button" class="button secondary" data-speech-action="${installed?'refresh':'download'}" ${active?'disabled':''}>${installed?'Status prüfen':'Modell herunterladen'}</button></div>`:''}
  <p class="speech-privacy">Mikrofon-Audio und Texterkennung bleiben auf diesem Gerät. Audio wird verworfen. Spracheingaben bleiben standardmäßig nur in dieser Sitzung; Speichern ist freiwillig. Erst beim Senden erhält ${esc(providerLabel)} den Text. Nach dem ersten geprüften Modelldownload funktioniert die Spracherkennung offline.</p></details></section>`;
}
