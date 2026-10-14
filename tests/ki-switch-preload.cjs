// Test preload for tests/ki-switch-electron.cjs: a connected OpenRouter stand-in so the composer is shown after the switch.
const {contextBridge}=require('electron');
const info={models:[{id:'router-model'}],storage:'session',provider:'OpenRouter'};
contextBridge.exposeInMainWorld('contextDesktop',{ai:async message=>{
  if(message.action==='usage')return {ok:false,error:'Kein Limit abrufbar.',code:'unsupported'};
  if(['models','status','connection'].includes(message.action))return {ok:true,value:message.action==='status'?{configured:true,storage:'session',provider:'OpenRouter'}:info};
  return {ok:false,error:'Nicht vorgesehen.',code:'unsupported'};
},onEvent:()=>()=>{}});
