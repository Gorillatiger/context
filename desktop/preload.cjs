const {contextBridge,ipcRenderer}=require('electron');
// No raw IPC/event object is exposed, and remote pages never receive this preload.
contextBridge.exposeInMainWorld('contextDesktop',Object.freeze({
  boardScan:true,
  boardScanVersion:2,
  inventoryBrowser:true,
  browser:message=>ipcRenderer.invoke('context:browser',message),
  space:message=>ipcRenderer.invoke('context:space',message),
  agent:message=>ipcRenderer.invoke('context:agent',message),
  ai:message=>ipcRenderer.invoke('context:ai',message),
  calendar:message=>ipcRenderer.invoke('context:calendar',message),
  nango:message=>ipcRenderer.invoke('context:nango',message),
  nangoMail:message=>ipcRenderer.invoke('context:nango-mail',message),
 service:message=>ipcRenderer.invoke('context:service',message),
 miro:message=>ipcRenderer.invoke('context:miro',message),
  ocr:message=>ipcRenderer.invoke('context:ocr',message),
  speech:message=>ipcRenderer.invoke('context:speech',message),
  theme:message=>ipcRenderer.invoke('context:theme',message),
  chatFilter:message=>ipcRenderer.invoke('context:chat-filter',message),
  devDiary:message=>ipcRenderer.invoke('context:dev-diary',message),
  diaryReminders:message=>ipcRenderer.invoke('context:diary-reminders',message),
  onEvent:callback=>{if(typeof callback!=='function')return;const handler=(_event,payload)=>callback(payload);ipcRenderer.on('context:event',handler);return ()=>ipcRenderer.removeListener('context:event',handler);}
}));
