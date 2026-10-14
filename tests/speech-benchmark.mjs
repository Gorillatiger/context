// Opt-in native benchmark. Fixtures are synthetic German speech, never user audio.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import os from 'node:os';
import assert from 'node:assert/strict';
import {createDesktopSpeech} from '../desktop/speech.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2),arg=(name,fallback)=>args.includes(name)?args[args.indexOf(name)+1]:fallback;
const modelDirectory=path.resolve(arg('--models',path.join(root,'../../work/speech-models')));
const fixtures=path.resolve(arg('--fixtures',path.join(root,'tests/fixtures/speech')));
const output=path.resolve(arg('--output',path.join(root,'../../work/qa/speech-benchmark.json')));
const pace=Number(arg('--pace','1')),model=arg('--model','small');
if(!['small','large-v3-turbo'].includes(model))throw new Error('Unknown benchmark model.');
if(!Number.isFinite(pace)||pace<0||pace>2)throw new Error('Pace must be 0..2. Use 1 for real-time latency.');
function wav(bytes){
 assert.equal(bytes.toString('ascii',0,4),'RIFF');assert.equal(bytes.toString('ascii',8,12),'WAVE');let pcm,rate,channels,bits,format;
 for(let o=12;o+8<=bytes.length;){const id=bytes.toString('ascii',o,o+4),size=bytes.readUInt32LE(o+4),start=o+8;if(id==='fmt '){format=bytes.readUInt16LE(start);channels=bytes.readUInt16LE(start+2);rate=bytes.readUInt32LE(start+4);bits=bytes.readUInt16LE(start+14);}if(id==='data')pcm=bytes.subarray(start,start+size);o=start+size+(size%2);}
 assert.equal(format,1);assert.equal(channels,1);assert.equal(rate,16000);assert.equal(bits,16);assert(pcm?.length);const values=new Float32Array(pcm.length/2);for(let i=0;i<values.length;i++)values[i]=pcm.readInt16LE(i*2)/32768;return values;
}
const load=name=>readFile(path.join(fixtures,name+'.wav')).then(wav),silence=seconds=>new Float32Array(Math.ceil(16000*seconds));
function concat(...arrays){const out=new Float32Array(arrays.reduce((n,a)=>n+a.length,0));let offset=0;for(const a of arrays){out.set(a,offset);offset+=a.length;}return out;}
function noise(samples,amplitude=.025){let seed=983;const out=new Float32Array(samples.length);for(let i=0;i<samples.length;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;out[i]=Math.max(-1,Math.min(1,samples[i]+(seed/4294967296*2-1)*amplitude));}return out;}
function wer(expected,actual){const tokenize=s=>s.toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}\s]/gu,' ').trim().split(/\s+/).filter(Boolean),a=tokenize(expected),b=tokenize(actual);let row=Array.from({length:b.length+1},(_,i)=>i);for(let i=1;i<=a.length;i++){const next=[i];for(let j=1;j<=b.length;j++)next[j]=Math.min(next[j-1]+1,row[j]+1,row[j-1]+(a[i-1]===b[j-1]?0:1));row=next;}return {wordErrorRate:row[b.length]/Math.max(1,a.length),expectedWords:a.length,actualWords:b.length};}
const expected={short:'Hallo. Zeige mir bitte die nächsten Aufgaben und Termine im aktuellen Kurs.',long:'Ich möchte meine Woche planen. Suche bitte in den Kursen nach Aufgaben, Abgabeterminen und neuen Nachrichten. Erstelle zuerst eine übersichtliche Liste und nenne bei jeder Aufgabe die ursprüngliche Quelle. Für die Projektarbeit müssen wir den Prototyp dokumentieren, eine Präsentation vorbereiten und die Ergebnisse gemeinsam besprechen. Am Mittwoch möchte ich Material in der Werkstatt abholen. Am Donnerstag soll der erste Entwurf fertig sein. Prüfe anschließend, ob es Änderungen im Stundenplan gibt. Wenn Informationen fehlen, markiere sie als unklar. Erfinde keine Fristen und sende keine E-Mail ohne meinen Auftrag.',pause:'Suche bitte die nächsten Aufgaben. Ordne sie dem richtigen Kurs zu und zeige die Quelle.'};
const short=await load('short'),long=await load('long'),pause=concat(await load('pause-one'),silence(1.2),await load('pause-two'));
const results=[],loadTimes=[];let pending=new Map(),engine,events=[];
const emit=event=>{events.push(event);if(['final','error','cancelled'].includes(event.event)&&pending.has(event.id)){const p=pending.get(event.id);pending.delete(event.id);clearTimeout(p.timer);event.event==='error'?p.reject(new Error(event.message)):p.resolve(event);}};
async function prepare(gpu){engine?.dispose();engine=createDesktopSpeech({directory:modelDirectory,emit});const started=performance.now();const ready=await engine({type:'load',model,gpu});loadTimes.push({requested:gpu,wallMs:performance.now()-started,...ready.metrics});return ready;}
async function run(name,pcm,{expectedText='',manual=false,cancelAt=0,pauseMs=1800}={}){
 const id=randomUUID();events=[];const completion=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Final timeout '+name)),120000);pending.set(id,{resolve,reject,timer});});
 const started=performance.now();await engine({type:'start',id,pauseMs,interimMs:3000});const audio=concat(pcm,silence(2.5));let lastSend=performance.now();
 for(let offset=0;offset<audio.length&&pending.has(id);offset+=1536){const samples=audio.slice(offset,Math.min(offset+1536,audio.length));const padded=samples.length%512?concat(samples,new Float32Array(512-samples.length%512)):samples;await engine({type:'audio',id,samples:padded});lastSend=performance.now();if(cancelAt&&offset>=cancelAt*16000){await engine({type:'cancel',id});break;}if(pace)await new Promise(resolve=>setTimeout(resolve,96*pace));}
 if(pending.has(id))await engine({type:'stop',id});const final=await completion;await new Promise(resolve=>setTimeout(resolve,30));
 const entry={name,requestedBackend:loadTimes.at(-1).requested,fixtureSeconds:pcm.length/16000,realTimeFeed:pace===1,wallMs:performance.now()-started,afterLastSendMs:performance.now()-lastSend,event:final.event,text:final.text||'',reason:final.reason,finalCount:events.filter(e=>e.event==='final'&&e.id===id).length,interimCount:events.filter(e=>e.event==='interim'&&e.id===id).length,metrics:final.metrics||{},...(expectedText?wer(expectedText,final.text||''):{})};
 assert.equal(entry.finalCount,cancelAt?0:1);if(['silence','noise'].includes(name))assert.equal(entry.text,'');if(cancelAt)assert.equal(final.event,'cancelled');if(expectedText)assert(entry.wordErrorRate<.3,`${name} transcription errors: ${entry.wordErrorRate}`);results.push(entry);console.log(JSON.stringify({name,event:entry.event,finalCount:entry.finalCount,interimCount:entry.interimCount,metrics:entry.metrics,wordErrorRate:entry.wordErrorRate}));return entry;
}
try{
 await prepare('auto');await run('short',short,{expectedText:expected.short});await run('repeat-short',short,{expectedText:expected.short});await run('long',long,{expectedText:expected.long});await run('thinking-pause',pause,{expectedText:expected.pause});await run('speech-with-noise',noise(short),{expectedText:expected.short});await run('silence',silence(4));await run('noise',noise(silence(4),.07));await run('cancel',long,{cancelAt:2});await run('restart-after-cancel',short,{expectedText:expected.short});
 await prepare('cpu');await run('cpu-short',short,{expectedText:expected.short});
 const report={generatedAt:new Date().toISOString(),platform:process.platform,arch:process.arch,osRelease:os.release(),cpus:os.cpus()[0]?.model,totalMemoryBytes:os.totalmem(),model,language:'de',fixture:'Synthetic Piper 1.4.2 de_DE-thorsten-medium German speech, 16kHz mono PCM. Not a live microphone accuracy test.',pace,loadTimes,results};await mkdir(path.dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');console.log('Report '+output);
}finally{engine?.dispose();for(const p of pending.values())clearTimeout(p.timer);}
