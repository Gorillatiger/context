/* Optional live check of the Miro visitor reader in real Electron.
 * Run npm run test:miro:electron after npm ci. It opens public Miro boards
 * (network access) in a hidden view of a temporary profile; no live Context
 * profile, account or invitation token is used.
 * Arguments: board URLs; --expect-denied <url> for a board that must not be readable.
 */
const {app,BrowserWindow}=require('electron');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const {pathToFileURL}=require('node:url');

const args=process.argv.slice(2).filter(value=>!value.startsWith('--')&&value!==process.argv[1]);
const deniedIndex=process.argv.indexOf('--expect-denied'),denied=deniedIndex>=0?process.argv[deniedIndex+1]:'';
const boards=(args.filter(value=>value!==denied).length?args.filter(value=>value!==denied):['https://miro.com/app/board/o9J_kuapqg4=/','https://miro.com/app/board/o9J_kuTMbDA=/']).filter(value=>/^https:\/\/miro\.com\//.test(value));
app.setPath('userData',path.join(os.tmpdir(),'context-miro-electron-'+crypto.randomUUID()));
app.setName('Context Miro · Live Visitor Check');
// The reader closes its offscreen window after each board; the check itself has no other window.
app.on('window-all-closed',()=>{});

app.whenReady().then(async()=>{
  const load=file=>import(pathToFileURL(path.resolve(__dirname,file)).href);
  const {createMiroVisitorReader,miroOffscreenViews}=await load('../desktop/miro-visitor.mjs');
  const {fetchMiroOEmbed}=await load('../connectors/miro-visitor.mjs');
  // The exact production view factory of desktop/main.mjs.
  const reader=createMiroVisitorReader({...miroOffscreenViews(BrowserWindow)});
  const results=[];let failed=false;
  for(const url of boards){
    const started=Date.now();
    try{
      const meta=await fetchMiroOEmbed(url).catch(()=>({}));
      const value=await reader({url,meta:{title:meta.title||'',author:meta.author||''}});
      const ok=value.coverage.basis==='visitor-overview'&&value.documents.length>0&&value.documents.every(doc=>doc.url.startsWith(value.board.url+'?moveToWidget='));
      if(!ok)failed=true;
      results.push({url,ok,seconds:+((Date.now()-started)/1000).toFixed(1),title:value.board.title,owner:value.board.createdBy.name,documents:value.documents.length,unsupportedItems:value.coverage.unsupportedItems,firstTitles:value.documents.slice(0,5).map(doc=>doc.title)});
    }catch(error){failed=true;results.push({url,ok:false,seconds:+((Date.now()-started)/1000).toFixed(1),error:error.code||error.message});}
  }
  if(denied){
    try{await reader({url:denied});failed=true;results.push({url:denied,ok:false,error:'unexpectedly readable'});}
    catch(error){const ok=['no_access','login_required'].includes(error.code);if(!ok)failed=true;results.push({url:denied,ok,expectedDenied:true,error:error.code||error.message});}
  }
  console.log(JSON.stringify({electron:process.versions.electron,results},null,2));
  reader.dispose();app.exit(failed?1:0);
}).catch(error=>{console.error(error);app.exit(1);});
