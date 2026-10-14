import test from 'node:test';import assert from 'node:assert/strict';
import {inspectDiaryImage,validateDiaryAttachment,DIARY_IMAGE_LIMIT} from '../dist/dev-diary-media.js';
import {workspaceImagePolicy} from '../desktop/policy.mjs';
import {renderDevDiaryPost} from '../dist/dev-diary-format.js';
const gif=()=>new Uint8Array(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64'));
test('file signatures and dimensions override filenames; scripts, malformed and oversized inputs are refused',()=>{
 assert.deepEqual(inspectDiaryImage(gif()),{mime:'image/gif',size:42,width:1,height:1});
 for(const value of [new TextEncoder().encode('<svg><script>bad()</script></svg>'),new Uint8Array(DIARY_IMAGE_LIMIT+1),[],null,new Uint8Array(30)])assert.throws(()=>inspectDiaryImage(value));
 const big=gif();big[6]=255;big[7]=255;assert.throws(()=>inspectDiaryImage(big));
 const png=new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4WQAAAAASUVORK5CYII=','base64'));assert.equal(inspectDiaryImage(png).mime,'image/png');
 const bomb=png.slice();new DataView(bomb.buffer).setUint32(16,100000);assert.throws(()=>inspectDiaryImage(bomb));
});
test('persisted attachments accept no local path, executable source or remote URL',()=>{
 const value={id:'a'.repeat(64),name:'Foto.jpg',mime:'image/jpeg',size:1234,caption:'Ein Ergebnis'};
 assert.deepEqual(validateDiaryAttachment(value),value);
 for(const patch of [{id:'../image'},{name:'../Foto.jpg'},{mime:'image/svg+xml'},{size:Infinity},{url:'https://evil.test/x'},{caption:'x\nscript'}])assert.throws(()=>validateDiaryAttachment({...value,...patch}));
});
test('only an exact trusted workspace document receives the local Blob image policy',()=>{
 const headers={'Content-Security-Policy':["default-src 'self'; img-src 'self' data:; script-src 'self';"]};
 const trusted={url:'http://127.0.0.1:4318/',resourceType:'mainFrame',responseHeaders:headers};
 assert.match(workspaceImagePolicy(trusted)['Content-Security-Policy'][0],/img-src 'self' data: blob:;/);
 assert.doesNotMatch(headers['Content-Security-Policy'][0],/blob:/);
 for(const url of ['https://spaces.th-koeln.de/','http://127.0.0.1:4319/','https://evil.test/'])assert.deepEqual(workspaceImagePolicy({...trusted,url}),headers);
 assert.deepEqual(workspaceImagePolicy({...trusted,resourceType:'image'}),headers);
});
test('media rendering uses supplied local or verified Spaces URLs and keeps arbitrary image links inert',()=>{
 const id='a'.repeat(64),text='![&lt;script&gt;](diary-media:'+id+')';
 assert.doesNotMatch(renderDevDiaryPost(text),/<img/);
 assert.match(renderDevDiaryPost(text,{media:new Map([[id,'blob:http://127.0.0.1:4318/example']])}),/<img/);
 for(const url of ['javascript:alert(1)','data:image/svg+xml,bad','https://evil.test/tracker.gif','https://user:secret@spaces.th-koeln.de/x'])assert.doesNotMatch(renderDevDiaryPost(text,{media:new Map([[id,url]])}),/<img/);
 assert.doesNotMatch(renderDevDiaryPost(text,{media:new Map([[id,'https://spaces.th-koeln.de/wp-content/uploads/test.gif']])}),/<script>/);
 assert.doesNotMatch(renderDevDiaryPost('![tracker](https://evil.test/x.gif)'),/<img/);
});
