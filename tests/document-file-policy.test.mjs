import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import vm from 'node:vm';
import {serviceFileURL,serviceFileMetadata,serviceURL,serviceReadScript} from '../desktop/service-reader.mjs';
import {platformDocumentURL} from '../dist/source-catalog.js';
const REPO='https://git.coco.study/course/robotics',SCIEBO='https://th-koeln.sciebo.de/index.php/apps/files/?dir=%2FCourse',SHARE='https://th-koeln.sciebo.de/s/synthetic_share?path=%2FCourse';
function element({tag='div',classes=[],attrs={},parent=null,visible=true,text='',href=''}={}){
  const el={tag,classes,attrs,parent,innerText:text,href,getClientRects:()=>visible?[{}]:[],getAttribute:key=>attrs[key]??null};
  const matches=(node,selector)=>{const tag=selector.match(/^[a-z][\w-]*/i)?.[0],cls=[...selector.matchAll(/\.([\w-]+)/g)].map(match=>match[1]),attr=selector.match(/\[([\w-]+)(?:=([^\]]+))?\]/);return (!tag||node.tag===tag)&&cls.every(value=>node.classes.includes(value))&&(!attr||node.attrs[attr[1]]!==undefined&&(attr[2]===undefined||node.attrs[attr[1]]===attr[2]));};
  el.closest=selectors=>{for(let value=el;value;value=value.parent)if(selectors.split(',').some(selector=>matches(value,selector.trim())))return value;return null;};el.querySelector=()=>null;return el;
}
const link=(url,title='Kurslink',patch={})=>element({tag:'a',href:url,text:title,...patch});
function documentFixture({text='Aufgabe: Baue einen Roboter.',nodes,links=[],title='Robotikkurs',password=false,url=REPO}={}){
  const root=element(),bodyNodes=nodes||[{textContent:text,parentElement:element()}];root.querySelectorAll=()=>links;
  const document={title,body:root,querySelector:selector=>selector==='input[type=password]'?(password?element({tag:'input'}):null):root,createTreeWalker:scope=>{let i=0;const list=scope===root?bodyNodes:bodyNodes.filter(node=>{for(let parent=node.parentElement;parent;parent=parent.parent)if(parent===scope)return true;return false;});return {nextNode:()=>list[i++]||null};}};
  return {document,location:{href:url,pathname:new URL(url).pathname,hostname:new URL(url).hostname},URL,NodeFilter:{SHOW_TEXT:4},TextEncoder,Uint8Array,crypto:webcrypto};
}

test('URL policy admits single supported modern documents and text while keeping native/cache scope normalization identical',()=>{
  for(const extension of ['pdf','docx','pptx','xlsx','PDF','DOCX','md','markdown','txt','json']){
    const urls=[['gitlab',REPO+'/-/raw/main/material/assignment.'+extension,REPO],['sciebo','https://th-koeln.sciebo.de/remote.php/dav/files/user/Course/assignment.'+extension,SCIEBO],['sciebo','https://th-koeln.sciebo.de/index.php/apps/files/ajax/download.php?files=assignment.'+extension+'&dir=%2FCourse',SCIEBO],['sciebo','https://th-koeln.sciebo.de/index.php/s/synthetic_share/download?path=%2FCourse&files=assignment.'+extension,SHARE]];
    for(const [service,url,scope]of urls)assert.equal(platformDocumentURL(service,url,scope),serviceFileURL(service,url,scope));
  }
});

test('legacy, macro, archive, executable and misleading extensions do not become provider file grants',()=>{
  for(const extension of ['doc','xls','ppt','docm','xlsm','pptm','xltm','dotm','potm','zip','rar','exe','js','pdf.exe','docx.zip','docx.docm']){
    for(const [service,url,scope]of [['gitlab',REPO+'/-/raw/main/assignment.'+extension,REPO],['sciebo','https://th-koeln.sciebo.de/s/synthetic_share/download?path=%2FCourse&files=assignment.'+extension,SHARE]]){
      assert.throws(()=>serviceFileURL(service,url,scope),url);assert.throws(()=>platformDocumentURL(service,url,scope),url);
    }
  }
});

test('modern file extensions never bypass secret-path, repository, folder, share, authorization or traversal boundaries',()=>{
  const files=[['gitlab',REPO+'-other/-/raw/main/assignment.pdf',REPO],['gitlab',REPO+'/-/raw/main/credentials.docx',REPO],['gitlab',REPO+'/-/raw/main/auth/assignment.pdf',REPO],['gitlab',REPO+'/-/raw/main/logout/assignment.docx',REPO],['gitlab',REPO+'/-/raw/main/.env.local/assignment.xlsx',REPO],['gitlab',REPO+'/-/raw/main/private_tokens.json/assignment.pptx',REPO],['gitlab',REPO+'/-/raw/main/assignment.pdf?token=PRIVATE',REPO],['gitlab',REPO+'/-/raw/main/assignment.pdf#fragment',REPO],['gitlab',REPO+'/-/raw/main/%252e%252e/private/assignment.pdf',REPO],['sciebo','https://th-koeln.sciebo.de/remote.php/dav/files/user/Private/assignment.docx',SCIEBO],['sciebo','https://th-koeln.sciebo.de/s/another_share/download?path=%2FCourse&files=assignment.docx',SHARE],['sciebo','https://th-koeln.sciebo.de/s/synthetic_share/download?path=%2FCourseExtra&files=assignment.xlsx',SHARE],['sciebo','https://th-koeln.sciebo.de/s/synthetic_share/download?path=%2FCourse&files=passwords.pptx',SHARE],['sciebo','https://th-koeln.sciebo.de/s/synthetic_share/download?path=%2FCourse&files=one.pdf,two.pdf',SHARE],['sciebo','https://th-koeln.sciebo.de/s/synthetic_share/download?path=%2FCourse&files=assignment.pdf&password=PRIVATE',SHARE]];
  for(const [service,url,scope]of files){assert.throws(()=>serviceFileURL(service,url,scope),url);assert.throws(()=>platformDocumentURL(service,url,scope),url);}
  for(const host of ['evil.test','127.0.0.1','git.coco.study.evil.test'])assert.throws(()=>serviceFileURL('gitlab',`https://${host}/course/robotics/-/raw/main/assignment.pdf`,REPO));
});

test('display hints come only from validated URL filenames and never assert a response MIME or guess an unnamed share download format',()=>{
  assert.deepEqual(serviceFileMetadata('gitlab',REPO+'/-/raw/main/assignment.DOCX',REPO),{fileName:'assignment.DOCX',type:'docx'});
  assert.deepEqual(serviceFileMetadata('sciebo','https://th-koeln.sciebo.de/s/synthetic_share/download?path=%2FCourse&files=Schedule%20final.xlsx',SHARE),{fileName:'Schedule final.xlsx',type:'xlsx'});
  assert.deepEqual(serviceFileMetadata('gitlab',REPO+'/-/raw/main/README.md',REPO),{fileName:'README.md',type:'text'});
  const share=SHARE.split('?')[0];assert.deepEqual(serviceFileMetadata('sciebo',share+'/download',share),{fileName:'',type:'unknown'});assert.throws(()=>serviceFileMetadata('gitlab',REPO+'/-/raw/main/secrets.docx',REPO));
  assert.equal(serviceFileMetadata('gitlab',REPO+'/-/raw/main/assignment.pdf',REPO).contentType,undefined);
});

test('document DOM discovery returns only safe observed file URLs, bounded display metadata and no renderer asset download or file execution',async()=>{
  const urls=['pdf','docx','pptx','xlsx','md'].map(ext=>REPO+'/-/raw/main/assignment.'+ext),bad=[REPO+'/-/raw/main/passwords.docx',REPO+'/-/raw/main/legacy.doc',REPO+'/-/raw/main/macro.docm',REPO+'-other/-/raw/main/assignment.pdf','https://evil.test/assignment.pdf'];
  const script=serviceReadScript('gitlab',REPO),page=await vm.runInNewContext(script,documentFixture({url:REPO,links:[...urls,...bad].map(url=>link(url,'Synthetische Datei'))}));
  assert.deepEqual(Array.from(page.fileLinks,item=>item.url),urls);assert.deepEqual(Array.from(page.fileLinks,item=>item.type),['pdf','docx','pptx','xlsx','text']);assert.deepEqual(Array.from(page.fileLinks,item=>item.fileName),['assignment.pdf','assignment.docx','assignment.pptx','assignment.xlsx','assignment.md']);assert.ok(page.fileLinks.every(item=>item.fileName.length<=200));
  assert.doesNotMatch(script,/\bfetch\s*\(|XMLHttpRequest|document\.cookie|localStorage|sessionStorage|\.click\(/);assert.equal(page.fileLinks.some(item=>item.contentType),false);
  for(const url of urls)assert.throws(()=>serviceURL('gitlab',url,REPO),'file URL must remain outside browser navigation');
});

test('shared-folder document discovery preserves its offered filename but never offers same-host other-share or private-folder files',async()=>{
  const good='https://th-koeln.sciebo.de/index.php/s/synthetic_share/download?path=%2FCourse&files=assignment.pdf',bad=[good.replace('synthetic_share','another_share'),good.replace('%2FCourse','%2FPrivate'),good.replace('assignment.pdf','assignment.docm')];
  const page=await vm.runInNewContext(serviceReadScript('sciebo',SHARE),documentFixture({url:SHARE,links:[good,...bad].map(url=>link(url,'Assignment'))}));assert.deepEqual(Array.from(page.fileLinks,item=>item.url),[serviceFileURL('sciebo',good,SHARE)]);assert.equal(page.fileLinks[0].type,'pdf');assert.equal(page.fileLinks[0].fileName,'assignment.pdf');
});

test('large offered document lists retain the existing 50-file bound without synthesizing or fetching unobserved files',async()=>{
  const links=Array.from({length:80},(_,i)=>link(REPO+'/-/raw/main/assignment-'+i+'.pdf','Assignment '+i)),page=await vm.runInNewContext(serviceReadScript('gitlab',REPO),documentFixture({url:REPO,links}));assert.equal(page.fileLinks.length,50);assert.ok(page.fileLinks.every(item=>item.url.startsWith(REPO+'/-/raw/')));assert.equal(page.fileLinks.at(-1).fileName,'assignment-49.pdf');
});
