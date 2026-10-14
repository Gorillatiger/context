/* Optional check of the encrypted AI key store with the real OS keychain (Electron safeStorage).
 * Run npm run test:keys:electron. Synthetic key, temporary profile; the keychain entry it creates
 * ("Context AI Key Check Safe Storage") can be deleted afterwards in Keychain Access.
 */
const {app,safeStorage}=require('electron');
const path=require('node:path'),os=require('node:os'),fs=require('node:fs/promises'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const userData=path.join(os.tmpdir(),'context-ai-keys-electron-'+crypto.randomUUID());
app.setPath('userData',userData);app.setName('Context AI Key Check');
app.whenReady().then(async()=>{
  const {createDesktopKeyStore}=await import(pathToFileURL(path.resolve(__dirname,'../desktop/key-store.mjs')).href);
  const KEY='sk-or-live-check-'+crypto.randomBytes(12).toString('hex'),directory=path.join(userData,'ai'),report={electron:process.versions.electron,platform:process.platform};
  report.encryptionAvailable=await safeStorage.isAsyncEncryptionAvailable?.();
  const store=createDesktopKeyStore({directory,crypto:safeStorage}),or=store.forProvider('openrouter');
  report.saved=await or.save(KEY);
  const file=path.join(directory,'ai-keys.enc'),disk=await fs.readFile(file).catch(()=>Buffer.alloc(0));
  report.fileBytes=disk.length;report.plaintextOnDisk=disk.includes(KEY);report.mode=((await fs.stat(file).catch(()=>({mode:0}))).mode&0o777).toString(8);
  report.restoredByNewStore=(await createDesktopKeyStore({directory,crypto:safeStorage}).forProvider('openrouter').load())===KEY;
  await or.clear();report.removedAfterForget=await fs.stat(file).then(()=>false,()=>true);
  console.log(JSON.stringify(report,null,2));
  const ok=report.encryptionAvailable&&report.saved&&!report.plaintextOnDisk&&report.mode==='600'&&report.restoredByNewStore&&report.removedAfterForget;
  await fs.rm(userData,{recursive:true,force:true});app.exit(ok?0:1);
}).catch(error=>{console.error(error);app.exit(1);});
