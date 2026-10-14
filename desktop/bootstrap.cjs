const {mkdirSync,chmodSync}=require('node:fs');
const {app,dialog}=require('electron');
try{
 app.setName('Context Browser');
 const profile=require('node:path').join(app.getPath('appData'),'dev.hazylabs.context.workspace');
 mkdirSync(profile,{recursive:true,mode:0o700});chmodSync(profile,0o700);
 app.setPath('userData',profile);
 app.enableSandbox();
 app.whenReady().then(()=>app.setAccessibilitySupportEnabled(true));
 if(!app.requestSingleInstanceLock()){app.quit();}else{
  import('./main.mjs').catch(async()=>{await app.whenReady();dialog.showErrorBox('Context Browser konnte nicht starten','Der App-Start ist fehlgeschlagen. Bitte den Context-Server prüfen und die aktuelle App erneut öffnen.');app.quit();});
 }
}catch{app.exit(1);}
