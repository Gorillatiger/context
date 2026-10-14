import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createDesktopSpeech,speechPacket,speechPermission} from '../desktop/speech.mjs';
const id='a6f44cf8-90cd-4ba2-9253-a924cbdb89c0';
async function fixture(t,{status}={}){
 const directory=await mkdtemp(path.join(os.tmpdir(),'context-speech-test-')),helper=path.join(directory,'helper');await writeFile(helper,'fixture');
 const events=[],commands=[],audio=[];let spawns=0,p;
 const store={status:status|| (async()=>({models:[{id:'small',available:true}],vad:{available:true}})),ensure:async()=>({modelPath:'small',vadPath:'silero'}),download:async()=>({})};
 function spawn(){spawns++;p=new EventEmitter();p.stdout=new PassThrough();p.stderr=new PassThrough();p.kill=()=>{p.emit('exit',0);return true;};p.stdin=new Writable({write(packet,_encoding,callback){assert.equal(packet.readUInt32LE(0),packet.length-4);if(packet[4]===1){const command=JSON.parse(packet.subarray(5));commands.push(command);if(command.op==='load')queueMicrotask(()=>p.stdout.write(JSON.stringify({event:'ready',metrics:{loadMs:30}})+'\n'));if(command.op==='start')queueMicrotask(()=>p.stdout.write(JSON.stringify({event:'started',id:command.id})+'\n'));}else audio.push(Buffer.from(packet.subarray(5)));callback();}});return p;}
 const speech=createDesktopSpeech({directory,helperPath:helper,store,spawnImpl:spawn,emit:event=>events.push(event)});
 t.after(async()=>{speech.dispose();await rm(directory,{recursive:true,force:true});});
 return {speech,events,commands,audio,spawns:()=>spawns,crash:()=>p.emit('exit',1),send:event=>p.stdout.write(JSON.stringify(event)+'\n')};
}
test('microphone permission is limited to audio in the trusted main window',()=>{
 const wc={};const allowed={webContents:wc,expected:wc,permission:'media',origin:'http://127.0.0.1:4318',mediaTypes:['audio'],mainFrame:true};assert(speechPermission(allowed));
 for(const patch of [{webContents:{}},{mainFrame:false},{origin:'https://spaces.th-koeln.de'},{origin:'http://localhost:4318'},{permission:'camera'},{mediaTypes:['audio','video']},{mediaTypes:[]}])assert.equal(speechPermission({...allowed,...patch}),false);
});
test('binary wire framing is explicit length-prefixed PCM',()=>{const packet=speechPacket(2,Buffer.from([1,2,3]));assert.equal(packet.readUInt32LE(),4);assert.equal(packet[4],2);assert.deepEqual([...packet.subarray(5)],[1,2,3]);});
test('model is resident over repeat recording, finals delivered exactly once',async t=>{
 const f=await fixture(t);const status=await f.speech({type:'status'});assert(status.available);assert(status.models[0].available);
 await f.speech({type:'load',model:'small'});await f.speech({type:'load',model:'small'});assert.equal(f.spawns(),1);assert.equal(f.commands.filter(c=>c.op==='load').length,1);
 await f.speech({type:'start',id,pauseMs:1800});await f.speech({type:'audio',id,samples:new Float32Array(1536)});assert.equal(f.audio[0].subarray(0,36).toString(),id);
 await f.speech({type:'stop',id});f.send({event:'final',id,text:'Hallo Welt'});f.send({event:'final',id,text:'duplicate'});assert.equal(f.events.filter(e=>e.event==='final').length,1);
 assert.equal((await f.speech({type:'status'})).state,'ready');await assert.rejects(f.speech({type:'start',id}),{code:'BAD_REQUEST'});
});
test('cancel fences late results, keeps model ready and releases capture session',async t=>{
 const f=await fixture(t);await f.speech({type:'load'});await f.speech({type:'start',id});await f.speech({type:'cancel',id});f.send({event:'final',id,text:'must not leak'});f.send({event:'error',id,message:'late'});
 assert.equal(f.events.filter(e=>e.event==='final').length,0);assert.equal(f.events.filter(e=>e.event==='cancelled').length,1);assert.equal((await f.speech({type:'status'})).state,'ready');
 const second='05f5db03-98e4-43bf-bc9c-453e6b90699a';await f.speech({type:'start',id:second});await assert.rejects(f.speech({type:'start',id}),{code:'BUSY'});
});
test('rejects unbounded or invalid PCM and avoids accepting stale sessions',async t=>{
 const f=await fixture(t);await f.speech({type:'load'});await f.speech({type:'start',id});
 for(const samples of [new Float32Array(9000),new Float32Array([NaN]),new Float32Array([2]),[],new Uint8Array(512)])await assert.rejects(f.speech({type:'audio',id,samples}),{code:'BAD_AUDIO'});
 assert.deepEqual(await f.speech({type:'audio',id:'wrong',samples:new Float32Array(512)}),{ignored:true});assert.equal(f.audio.length,0);
});
test('no paths or arbitrary command are accepted from the renderer',async t=>{const f=await fixture(t);await assert.rejects(f.speech({type:'exec',path:'/etc/passwd'}),{code:'BAD_REQUEST'});await assert.rejects(f.speech({type:'start',id:'invalid'}),{code:'BAD_REQUEST'});});

test('helper failure delivers an error instead of a cancellation and invalidates the model',async t=>{
 const f=await fixture(t);await f.speech({type:'load'});await f.speech({type:'start',id});f.crash();
 assert.equal(f.events.filter(e=>e.event==='cancelled').length,0);assert.equal(f.events.filter(e=>e.event==='error'&&e.id===id&&e.code==='ENGINE_EXIT').length,1);
 assert.equal((await f.speech({type:'status'})).state,'error');await assert.rejects(f.speech({type:'start',id:'05f5db03-98e4-43bf-bc9c-453e6b90699a'}),{code:'NOT_READY'});
 await f.speech({type:'load'});assert.equal(f.spawns(),2);
});
test('cancel while helper stat is pending cannot spawn a process afterwards',async()=>{
 let release,entered,spawns=0;const gate=new Promise(resolve=>release=resolve),atStat=new Promise(resolve=>entered=resolve);
 const speech=createDesktopSpeech({directory:'/unused',store:{ensure:async()=>({modelPath:'small',vadPath:'silero'})},statImpl:async()=>{entered();await gate;return {isFile:()=>true};},spawnImpl:()=>{spawns++;throw new Error('should not spawn');}});
 const loading=speech({type:'load'});const rejection=assert.rejects(loading,{code:'CANCELLED'});await atStat;await speech({type:'cancel'});release();await rejection;assert.equal(spawns,0);speech.dispose();
});
test('dispose while helper stat is pending cannot spawn a process afterwards',async()=>{
 let release,entered,spawns=0;const gate=new Promise(resolve=>release=resolve),atStat=new Promise(resolve=>entered=resolve);
 const speech=createDesktopSpeech({directory:'/unused',store:{ensure:async()=>({modelPath:'small',vadPath:'silero'})},statImpl:async()=>{entered();await gate;return {isFile:()=>true};},spawnImpl:()=>{spawns++;throw new Error('should not spawn');}});
 const loading=speech({type:'load'});const rejection=assert.rejects(loading,{code:'CANCELLED'});await atStat;speech.dispose();release();await rejection;assert.equal(spawns,0);
});

test('status cannot resurrect model readiness while model inventory is pending',async t=>{
 let release,entered;const gate=new Promise(resolve=>release=resolve),atStatus=new Promise(resolve=>entered=resolve);
 const f=await fixture(t,{status:async()=>{entered();await gate;return {models:[],vad:{}};}});await f.speech({type:'load'});
 const status=f.speech({type:'status'});await atStatus;f.crash();release();const result=await status;assert.equal(result.state,'error');assert.equal(result.model,'');
});
