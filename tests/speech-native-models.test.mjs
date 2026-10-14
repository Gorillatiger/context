// Opt-in real model tests; no microphone, network, mocks, or audio persistence.
// CONTEXT_SPEECH_TEST_MODELS=/path/to/models node --test tests/speech-native-models.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const models=process.env.CONTEXT_SPEECH_TEST_MODELS;
const fixtures=process.env.CONTEXT_SPEECH_TEST_FIXTURES||path.resolve(root,'../../work/speech-fixtures');
const delay=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
function frame(type,payload){const body=Buffer.concat([Buffer.from([type]),payload]),header=Buffer.alloc(4);header.writeUInt32LE(body.length);return Buffer.concat([header,body]);}
function command(child,value){child.stdin.write(frame(1,Buffer.from(JSON.stringify(value))));}
function pcm(child,id,samples){const bytes=Buffer.alloc(samples.length*4);for(let i=0;i<samples.length;i++)bytes.writeFloatLE(samples[i],i*4);child.stdin.write(frame(2,Buffer.concat([Buffer.from(id),bytes])));bytes.fill(0);}
function samplesFromWav(bytes){
  assert.equal(bytes.toString('ascii',0,4),'RIFF');assert.equal(bytes.toString('ascii',8,12),'WAVE');let samples;
  for(let offset=12;offset+8<=bytes.length;){const name=bytes.toString('ascii',offset,offset+4),size=bytes.readUInt32LE(offset+4),start=offset+8;if(name==='fmt '){assert.equal(bytes.readUInt16LE(start),1);assert.equal(bytes.readUInt16LE(start+2),1);assert.equal(bytes.readUInt32LE(start+4),16000);assert.equal(bytes.readUInt16LE(start+14),16);}if(name==='data'){samples=new Float32Array(size/2);for(let i=0;i<samples.length;i++)samples[i]=bytes.readInt16LE(start+i*2)/32768;}offset=start+size+(size%2);}
  assert(samples?.length);return samples;
}
test('resident native models handle PCM tails, repeated Stop, active Cancel and restart',{skip:models?false:'Opt-in: provide CONTEXT_SPEECH_TEST_MODELS with verified offline small and Silero files.',timeout:60000},async t=>{
  const helper=path.join(root,'desktop',process.platform==='win32'?'speech-helper.exe':'speech-helper');
  const child=spawn(helper,[],{stdio:['pipe','pipe','pipe'],shell:false});let buffer='',events=[],stderr='';
  const exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});
  child.stdout.on('data',bytes=>{buffer+=bytes;let newline;while((newline=buffer.indexOf('\n'))>=0){events.push(JSON.parse(buffer.slice(0,newline)));buffer=buffer.slice(newline+1);}});
  child.stderr.on('data',bytes=>{stderr+=bytes;});
  t.after(async()=>{if(child.exitCode===null)child.kill();await exited;});
  async function wait(predicate){const started=Date.now();while(Date.now()-started<20000){const event=events.find(predicate);if(event)return event;const unexpected=events.find(value=>value.event==='error');assert.equal(unexpected,undefined,JSON.stringify(unexpected));assert.equal(child.exitCode,null,'Helper exited unexpectedly');await delay(10);}throw new Error('Timed out waiting for native event');}
  async function start(id){command(child,{op:'start',id,pauseMs:5000,interimMs:750});await wait(event=>event.event==='started'&&event.id===id);}
  command(child,{op:'load',modelPath:path.resolve(models,'ggml-small.bin'),vadPath:path.resolve(models,'ggml-silero-v5.1.2.bin'),gpu:'cpu',threads:4});
  const ready=await wait(event=>event.event==='ready');assert.equal(ready.backend,'cpu');
  const short=samplesFromWav(await readFile(path.join(fixtures,'short.wav')));
  t.after(()=>short.fill(0));
  const id=randomUUID();await start(id);
  // 1231-sample chunks cannot divide the 512-sample VAD frame. The final
  // partial frame must be retained until Stop's zero-padding flush.
  for(let offset=0;offset<short.length;offset+=1231){pcm(child,id,short.subarray(offset,Math.min(offset+1231,short.length)));await delay(5);}
  command(child,{op:'stop',id});command(child,{op:'stop',id});
  const final=await wait(event=>event.event==='final'&&event.id===id);
  assert.match(final.text,/Hallo/i);assert.match(final.text,/aktuellen Kurs/i);
  assert.equal(final.reason,'stop');assert.equal(final.metrics.backend,'cpu');
  await delay(100);assert.equal(events.filter(event=>event.event==='final'&&event.id===id).length,1);
  const cancelled=randomUUID();await start(cancelled);
  // Feed enough voiced audio to schedule an interim decode, then cancel while
  // inference remains pending or running. No final result may escape afterward.
  for(let offset=0;offset<24000;offset+=1231){pcm(child,cancelled,short.subarray(offset,Math.min(offset+1231,24000)));await delay(5);}
  command(child,{op:'cancel',id:cancelled});await wait(event=>event.event==='cancelled'&&event.id===cancelled);
  await delay(900);assert.equal(events.filter(event=>event.event==='final'&&event.id===cancelled).length,0);
  for(let iteration=0;iteration<4;iteration++){
    const restarted=randomUUID();await start(restarted);pcm(child,restarted,new Float32Array(1499));command(child,{op:'stop',id:restarted});command(child,{op:'stop',id:restarted});
    const empty=await wait(event=>event.event==='final'&&event.id===restarted);assert.equal(empty.text,'');assert.equal(empty.metrics.inferenceMs,0);assert.equal(events.filter(event=>event.event==='final'&&event.id===restarted).length,1);
  }
  assert.equal(events.filter(event=>event.event==='ready').length,1,'Resident model must stay loaded across recordings');
  assert.equal(stderr,'','Native diagnostics must be disabled by default');
  command(child,{op:'shutdown'});assert.equal((await exited).code,0);
});
