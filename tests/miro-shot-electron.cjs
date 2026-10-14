/* Optional live check of board screenshots in real Electron.
 * Run npm run test:miro:shot [--out dir] [board url]. It reads a public Miro board
 * as visitor (network access, temporary profile), takes a screenshot of the whole
 * board and of one section, and checks that the pictures are real JPEGs that show
 * something. The pictures are written to --out (default: the OS temp directory).
 */
const {app,BrowserWindow}=require('electron');
const path=require('node:path'),os=require('node:os'),fs=require('node:fs'),crypto=require('node:crypto');
const {pathToFileURL}=require('node:url');
const outIndex=process.argv.indexOf('--out'),OUT=outIndex>=0?process.argv[outIndex+1]:os.tmpdir();
const given=process.argv.slice(2).find((value,index,all)=>/^https:\/\/miro\.com\//.test(value)&&all[index-1]!=='--out');
const BOARD=given||'https://miro.com/app/board/o9J_kuapqg4=/';
app.setPath('userData',path.join(os.tmpdir(),'context-miro-shot-'+crypto.randomUUID()));
app.setName('Context Miro · Screenshot Check');
app.on('window-all-closed',()=>{});

app.whenReady().then(async()=>{
  const load=file=>import(pathToFileURL(path.resolve(__dirname,file)).href);
  const {createMiroVisitorReader,miroOffscreenViews}=await load('../desktop/miro-visitor.mjs');
  const reader=createMiroVisitorReader({...miroOffscreenViews(BrowserWindow)});
  const report={electron:process.versions.electron,board:BOARD,checks:[],shots:[]};let failed=false;
  const check=(ok,label)=>{report.checks.push({ok:!!ok,label});if(!ok)failed=true;};
  try{
    const board=await reader({url:BOARD});
    const target=board.items.find(item=>item.type==='frame'&&item.text.length>20)||board.items[0];
    check(board.items.length>0,'the board was read ('+board.items.length+' sections)');
    for(const [name,itemId] of [['board',''],['section',target?.id||'']]){
      const started=Date.now(),shot=await reader.capture({url:BOARD,itemId});
      const bytes=Buffer.from(shot.data,'base64'),file=path.join(OUT,'miro-shot-'+name+'.jpg');fs.writeFileSync(file,bytes);
      const info=await app.whenReady().then(()=>require('electron').nativeImage.createFromBuffer(bytes));
      const size=info.getSize(),bitmap=info.resize({width:96}).toBitmap();let low=255,high=0;for(let i=0;i+3<bitmap.length;i+=4){const v=(bitmap[i]+bitmap[i+1]*2+bitmap[i+2])>>2;low=Math.min(low,v);high=Math.max(high,v);}
      report.shots.push({name,itemId,seconds:+((Date.now()-started)/1000).toFixed(1),bytes:bytes.length,width:shot.width,height:shot.height,settled:shot.settled,contrast:high-low,file});
      check(bytes[0]===0xff&&bytes[1]===0xd8&&size.width===shot.width&&size.height===shot.height,name+': real JPEG with the announced size');
      check(bytes.length>8000&&bytes.length<=480000,name+': plausible file size ('+bytes.length+' bytes)');
      check(high-low>=12,name+': the picture shows content (contrast '+(high-low)+')');
      check(shot.settled,name+': the picture was stable before it was taken');
    }
  }catch(error){failed=true;report.error=error.code||error.message;}
  console.log(JSON.stringify(report,null,2));
  reader.dispose();app.exit(failed?1:0);
}).catch(error=>{console.error(error);app.exit(1);});
