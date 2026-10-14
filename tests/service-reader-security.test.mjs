import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {serviceURL,serviceFileURL,serviceReadScript} from '../desktop/service-reader.mjs';

const repo='https://git.coco.study/course/robotics',folder='https://th-koeln.sciebo.de/index.php/apps/files/?dir=%2FCourse';
test('independent review: folder grants cannot authorize a Sciebo file ID without membership evidence',()=>{
  for(const id of ['1','999','123456789012345678'])assert.throws(()=>serviceURL('sciebo',folder+'&fileid='+id,folder),{code:'OUTSIDE_SCOPE'});
  assert.equal(serviceURL('sciebo',folder+'&fileid=7',folder+'&fileid=7'),folder+'&fileid=7');
  assert.throws(()=>serviceURL('sciebo',folder+'&fileid=8',folder+'&fileid=7'),{code:'OUTSIDE_SCOPE'});
});
test('independent review: GitLab secret paths cannot bypass file protection through HTML blob/tree routes',()=>{
  const secrets=['.env','.env.local','.ssh/id_rsa','.aws/config','.git/config','secrets/key.txt','credentials/index.md','passwd','passwords.txt','tokens.txt','api-key.json'];
  for(const name of secrets){
    for(const route of ['blob','tree'])assert.throws(()=>serviceURL('gitlab',repo+'/-/'+route+'/main/'+name,repo));
    assert.throws(()=>serviceFileURL('gitlab',repo+'/-/raw/main/'+name,repo));
  }
  assert.equal(serviceURL('gitlab',repo+'/-/blob/main/README.md',repo),repo+'/-/blob/main/README.md');
});
test('independent review: encoded secret/traversal paths have the same deny decision',()=>{
  for(const suffix of ['%2eenv','%252eenv','%2eenv%2elocal','%2essh/id_rsa','%252e%252e/private/README.md'])assert.throws(()=>serviceURL('gitlab',repo+'/-/blob/main/'+suffix,repo));
});
test('independent review: shared Sciebo scopes keep both token and folder fixed and reject broad downloads',()=>{
  const share='https://th-koeln.sciebo.de/s/courseShareToken?path=%2FCourse';
  assert.throws(()=>serviceURL('sciebo','https://th-koeln.sciebo.de/s/otherShareToken?path=%2FCourse',share));
  assert.throws(()=>serviceURL('sciebo','https://th-koeln.sciebo.de/s/courseShareToken?path=%2FPrivate',share));
  assert.throws(()=>serviceFileURL('sciebo','https://th-koeln.sciebo.de/s/courseShareToken/download?path=%2FPrivate&files=README.md',share));
  assert.throws(()=>serviceFileURL('sciebo','https://th-koeln.sciebo.de/s/courseShareToken/download?path=%2FCourse&files=one.md%2Ctwo.md',share));
});
test('independent review: isolated reader bounds node inspections even when all nodes are excluded or empty',async()=>{
  let visits=0;
  const excluded={getClientRects:()=>[{}],closest:selector=>selector.includes('script')?{}:null},root={getClientRects:()=>[{}],closest:()=>null,querySelectorAll:()=>[]};
  const document={title:'Synthetic sparse source',body:root,querySelector:selector=>selector==='input[type=password]'?null:root,createTreeWalker:()=>({nextNode:()=>{visits++;return visits<=100000?{textContent:'',parentElement:excluded}:null;}})};
  const context={document,location:{href:repo,pathname:'/course/robotics'},URL,NodeFilter:{SHOW_TEXT:4},TextEncoder,Uint8Array,crypto:webcrypto};
  const result=await vm.runInNewContext(serviceReadScript('gitlab',repo),context);
  assert.ok(visits<=50001,'empty/excluded nodes also consume the node budget');assert.equal(result.text,'');assert.equal(result.textTruncated,true);
});
