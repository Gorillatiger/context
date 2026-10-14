import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import * as files from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import {createDesktopTheme,parseThemeSnapshot,themePreference} from '../desktop/theme.mjs';
import {hubURL} from '../desktop/policy.mjs';

class FakeNativeTheme extends EventEmitter{
 constructor(systemDark=false){super();this.systemDark=systemDark;this.source='system';}
 get shouldUseDarkColors(){return this.source==='dark'||this.source==='system'&&this.systemDark;}
 get themeSource(){return this.source;}
 set themeSource(value){this.source=value;this.emit('updated');}
 systemChange(dark){this.systemDark=dark;this.emit('updated');}
}
async function fixture(t,{systemDark=false,stored,fs=files}={}){
 const directory=await files.mkdtemp(path.join(os.tmpdir(),'context-theme-test-'));
 if(stored!==undefined)await files.writeFile(path.join(directory,'theme.json'),stored);
 const nativeTheme=new FakeNativeTheme(systemDark),events=[],applied=[];
 const theme=createDesktopTheme({nativeTheme,directory,fs,emit:value=>events.push(value),apply:value=>applied.push(value)});
 t.after(async()=>{await theme.flush();theme.dispose();await files.rm(directory,{recursive:true,force:true});});
 return {theme,nativeTheme,directory,events,applied};
}

test('theme defaults to the OS before the first window and follows later OS updates',async t=>{
 const f=await fixture(t,{systemDark:true});
 assert.deepEqual(await f.theme.initialize(),{preference:'system',resolved:'dark',configured:false});
 assert.equal(f.nativeTheme.themeSource,'system');assert.equal(f.theme.backgroundColor(),'#191417');
 f.nativeTheme.systemChange(false);
 assert.deepEqual(f.events.at(-1),{preference:'system',resolved:'light',configured:false});
 assert.equal(f.theme.backgroundColor(),'#fff7f8');
 const count=f.events.length;f.nativeTheme.emit('updated');assert.equal(f.events.length,count);
 await assert.rejects(files.stat(path.join(f.directory,'theme.json')),{code:'ENOENT'});
});

test('explicit theme overrides OS, persists locally and is restored on next startup',async t=>{
 const f=await fixture(t);await f.theme.initialize();
 assert.deepEqual(await f.theme.handle({op:'set',preference:'dark'}),{preference:'dark',resolved:'dark',configured:true});
 f.nativeTheme.systemChange(false);assert.equal(f.events.length,2);
 const stored=await files.readFile(path.join(f.directory,'theme.json'),'utf8');
 assert.deepEqual(JSON.parse(stored),{version:1,preference:'dark'});
 assert.deepEqual(await files.readdir(f.directory),['theme.json']);
 const restarted=createDesktopTheme({nativeTheme:new FakeNativeTheme(),directory:f.directory});
 t.after(()=>restarted.dispose());assert.deepEqual(await restarted.initialize(),{preference:'dark',resolved:'dark',configured:true});
 assert.deepEqual(await f.theme.handle({op:'set',preference:'system'}),{preference:'system',resolved:'light',configured:true});
 f.nativeTheme.systemChange(true);assert.deepEqual(f.events.at(-1),{preference:'system',resolved:'dark',configured:true});
});

test('persisted theme accepts only a bounded versioned preference; bad storage falls back to OS',async t=>{
 for(const preference of ['system','light','dark'])assert.equal(parseThemeSnapshot(JSON.stringify({version:1,preference})),preference);
 for(const text of ['null','[]','{',JSON.stringify({version:2,preference:'dark'}),JSON.stringify({version:1,preference:'dark',path:'/etc/passwd'}),JSON.stringify({version:1,preference:'auto'}),' '.repeat(513)])assert.throws(()=>parseThemeSnapshot(text));
 const f=await fixture(t,{systemDark:true,stored:'{"version":1,"preference":"invalid"}'});
 assert.deepEqual(await f.theme.handle({op:'get'}),{preference:'system',resolved:'dark',configured:false});
 assert.equal(await files.readFile(path.join(f.directory,'theme.json'),'utf8'),'{"version":1,"preference":"invalid"}');
 await f.theme.handle({op:'set',preference:'light'});assert.equal(f.nativeTheme.themeSource,'light');
});

test('renderer requests cannot set arbitrary source values, paths or operations',async t=>{
 const f=await fixture(t);await f.theme.initialize();
 for(const preference of ['auto','Dark','',null,{},true]){
  assert.throws(()=>themePreference(preference),{code:'BAD_THEME_PREFERENCE'});
  await assert.rejects(f.theme.handle({op:'set',preference}),{code:'BAD_THEME_PREFERENCE'});
 }
 for(const message of [undefined,null,[],{},{op:'toggle'},{op:'set',preference:'dark',path:'/tmp/theme.json'},{op:'get',preference:'dark'}])await assert.rejects(f.theme.handle(message),{code:'BAD_THEME_REQUEST'});
 assert.equal(f.nativeTheme.themeSource,'system');assert.deepEqual(await files.readdir(f.directory),[]);
});

test('concurrent changes are written atomically in request order and flushed before exit',async t=>{
 const writes=[];const fs={...files,writeFile:async(file,text,options)=>{writes.push({file,text,options});return files.writeFile(file,text,options);}};
 const f=await fixture(t,{fs});
 const results=await Promise.all(['dark','light','system'].map(preference=>f.theme.handle({op:'set',preference})));
 assert.deepEqual(results.map(result=>result.preference),['dark','light','system']);
 await f.theme.flush();assert.equal(f.nativeTheme.themeSource,'system');
 assert.equal(parseThemeSnapshot(await files.readFile(path.join(f.directory,'theme.json'),'utf8')),'system');
 assert.equal(writes.length,3);for(const write of writes){assert.match(path.basename(write.file),/^theme\.[a-f0-9-]{36}\.tmp$/);assert.equal(write.options.flag,'wx');assert.equal(write.options.mode,0o600);}
 assert.deepEqual(await files.readdir(f.directory),['theme.json']);
});

test('failed rename retains the last preference and file, removes temporary data and permits retry',async t=>{
 let fail=true;const fs={...files,rename:async(...args)=>{if(fail)throw Object.assign(new Error('private filesystem path'),{code:'EACCES'});return files.rename(...args);}};
 const f=await fixture(t,{stored:'{"version":1,"preference":"light"}',fs});await f.theme.initialize();
 await assert.rejects(f.theme.handle({op:'set',preference:'dark'}),{code:'THEME_SAVE_FAILED',message:'Die Darstellung konnte nicht lokal gespeichert werden.'});
 assert.equal(f.nativeTheme.themeSource,'light');assert.equal(parseThemeSnapshot(await files.readFile(path.join(f.directory,'theme.json'),'utf8')),'light');assert.deepEqual(await files.readdir(f.directory),['theme.json']);
 fail=false;assert.equal((await f.theme.handle({op:'set',preference:'dark'})).preference,'dark');
});

test('theme bridge uses the existing trusted IPC guard, which rejects remote senders and subframes',async()=>{
 const main=await files.readFile(new URL('../desktop/main.mjs',import.meta.url),'utf8');
 const preload=await files.readFile(new URL('../desktop/preload.cjs',import.meta.url),'utf8');
 assert.match(preload,/theme:message=>ipcRenderer\.invoke\('context:theme',message\)/);
 assert.match(main,/\['theme',desktopTheme\.handle\]\]\)ipcMain\.handle\('context:'\+name,async\(e,message\)=>\{trusted\(e\);/);
 const expression=main.match(/const trusted=([\s\S]*?);\nfunction state/)[1];
 const frame={url:'http://127.0.0.1:4318/#today'},webContents={mainFrame:frame},win={webContents};
 const trusted=vm.runInNewContext('('+expression+')',{win,hubURL});
 assert.doesNotThrow(()=>trusted({sender:webContents,senderFrame:frame}));
 for(const event of [{sender:{},senderFrame:frame},{sender:webContents,senderFrame:{url:frame.url}},{sender:webContents,senderFrame:{url:'https://spaces.th-koeln.de/'}}])assert.throws(()=>trusted(event),/Zugriff/);
 frame.url='https://evil.test/';assert.throws(()=>trusted({sender:webContents,senderFrame:frame}),/Zugriff/);
 assert.ok(main.indexOf('await desktopTheme.initialize()')<main.indexOf('win=new BrowserWindow'));
});

test('disposing unsubscribes native changes without leaving callbacks into closed windows',async t=>{
 const f=await fixture(t);await f.theme.initialize();assert.equal(f.nativeTheme.listenerCount('updated'),1);
 f.theme.dispose();f.nativeTheme.systemChange(true);assert.equal(f.nativeTheme.listenerCount('updated'),0);assert.equal(f.events.length,1);
});
