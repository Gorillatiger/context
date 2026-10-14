// Test preload for tests/miro-shot-app-electron.cjs: the real renderer talks to the
// real native Miro/platform modules of the check's main process, nothing else.
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('contextDesktop',{
  browser:async()=>({}),
  service:message=>ipcRenderer.invoke('test:service',message),
  miro:message=>ipcRenderer.invoke('test:miro',message),
  onEvent:()=>()=>{},
});
