/* Optional real Electron check of the WhatsApp sweep and of reading a released chat (synthetic page only).
 * Run npm run test:whatsapp:electron. A fake web.whatsapp.com page (virtual chat list, header, messages)
 * is served from memory; no network, no live profile.
 */
const {app,BrowserWindow,session,protocol}=require('electron');
const path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {pathToFileURL}=require('node:url');
app.setPath('userData',path.join(os.tmpdir(),'context-whatsapp-read-'+crypto.randomUUID()));app.setName('Context WhatsApp Read Check');
app.commandLine.appendSwitch('host-resolver-rules','MAP * ~NOTFOUND');
app.on('window-all-closed',()=>{});
protocol.registerSchemesAsPrivileged([]);

const html=`<!doctype html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0}#pane-side{position:absolute;left:0;top:0;width:360px;height:500px;overflow:auto}.canvas{position:relative;height:6000px}.row{position:absolute;left:0;right:0;height:60px}#main{position:absolute;left:380px;top:0;width:500px}</style></head><body>
<div id="pane-side"><div class="canvas" role="grid"></div></div>
<div id="main"><header><span dir="auto" title=""></span></header><div id="messages"></div></div>
<script>
const pane=document.querySelector('#pane-side'),canvas=pane.firstElementChild,names={7:'Users & Situated Action',44:'Prototyping Things',88:'Go Public'};
const nameOf=i=>names[i]||'Chat '+String(i).padStart(3,'0');
const messages={'Users & Situated Action':[['09:12, 13.10.2026','Prof','Abgabe der README bis Freitag 18 Uhr'],['10:01, 14.10.2026','Pat','Fork ist angelegt']],'Prototyping Things':[['08:00, 01.10.2026','Dozent','Alte Info']]};
function show(title){document.querySelector('#main header span').setAttribute('title',title);document.querySelector('#messages').replaceChildren(...(messages[title]||[]).map(([when,who,text])=>{const outer=document.createElement('div');outer.className='copyable-text';outer.setAttribute('data-pre-plain-text','['+when+'] '+who+': ');const span=document.createElement('span');span.className='selectable-text';span.textContent=text;outer.append(span);return outer;}));}
let at=-1;function render(){const first=Math.floor(pane.scrollTop/60);if(first===at)return;at=first;canvas.replaceChildren();for(let i=first;i<Math.min(100,first+10);i++){const row=document.createElement('div');row.className='row';row.setAttribute('role','row');row.style.top=i*60+'px';const span=document.createElement('span');span.setAttribute('title',nameOf(i));span.setAttribute('dir','auto');span.textContent=nameOf(i);span.addEventListener('click',()=>show(nameOf(i)));row.append(span);canvas.append(row);}}
pane.addEventListener('scroll',()=>setTimeout(render,10));render();
</script></body></html>`;

app.whenReady().then(async()=>{
  const {chatFilterScript,namedChatId}=await import(pathToFileURL(path.resolve(__dirname,'../desktop/chat-filter.mjs')).href);
  const ses=session.fromPartition('whatsapp-read-check');
  ses.protocol.handle('https',request=>new URL(request.url).origin==='https://web.whatsapp.com'?new Response(html,{headers:{'content-type':'text/html'}}):new Response('',{status:404}));
  const win=new BrowserWindow({show:false,width:900,height:600,webPreferences:{offscreen:true,sandbox:true,contextIsolation:true,partition:undefined,session:ses}});
  const report={checks:[]};let failed=false;const check=(ok,label)=>{report.checks.push({ok:!!ok,label});if(!ok)failed=true;};
  try{
    await win.loadURL('https://web.whatsapp.com/');await new Promise(resolve=>setTimeout(resolve,500));
    const run=command=>win.webContents.executeJavaScriptInIsolatedWorld(1002,[{code:chatFilterScript(command)}]);
    const plain=await run({op:'discover'}),swept=await run({op:'discover',sweep:true});
    check(plain.chats.length<=12,'a normal discovery sees only the rendered window ('+plain.chats.length+')');
    check(swept.chats.length>=95&&swept.chats.some(c=>c.title==='Go Public'),'the sweep finds chats far down the virtual list ('+swept.chats.length+')');
    check(await win.webContents.executeJavaScript(`document.querySelector('#pane-side').scrollTop===0`),'the list is scrolled back to where it was');
    const target=swept.chats.find(c=>c.title==='Users & Situated Action'),lease='lease-1';
    const read=await run({op:'read',id:target.id,title:target.title,lease});
    check(read.opened&&read.verified&&read.title==='Users & Situated Action','the right chat was opened and verified');
    check(read.messages.length===2&&/README bis Freitag/.test(read.messages[0].text)&&/13\.10\.2026/.test(read.messages[0].meta),'the visible messages were read with their date');
    // The same id with another expected title must not read anything.
    const wrong=await run({op:'read',id:swept.chats.find(c=>c.title==='Prototyping Things').id,title:'Etwas anderes',lease:'lease-2'});
    check(wrong.opened&&wrong.verified===false&&wrong.messages.length===0,'a chat whose title differs from the selection is not read');
    const far=swept.chats.find(c=>c.title==='Go Public'),empty=await run({op:'read',id:far.id,title:far.title,lease:'lease-3'});
    check(empty.opened&&empty.verified&&empty.messages.length===0,'an empty chat yields no messages instead of an error');
  }catch(error){failed=true;report.error=String(error.message||error);}
  console.log(JSON.stringify(report,null,2));app.exit(failed?1:0);
}).catch(error=>{console.error(error);app.exit(1);});
