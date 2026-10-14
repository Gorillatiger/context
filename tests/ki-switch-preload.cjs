// Test preload for tests/ki-switch-electron.cjs and tests/ki-effort-electron.cjs: a connected OpenRouter stand-in so the composer is shown after the switch.
const {contextBridge}=require('electron');
const info={models:[{id:'router-model'}],storage:'session',provider:'OpenRouter'};
contextBridge.exposeInMainWorld('contextDesktop',{ai:async message=>{
  if(message.action==='usage')return {ok:false,error:'Kein Limit abrufbar.',code:'unsupported'};
  if(['models','status','connection'].includes(message.action))return {ok:true,value:message.action==='status'?{configured:true,storage:'session',provider:'OpenRouter'}:info};
  if(message.action==='chat'){const last=message.body?.messages?.at(-1)?.content||'';const asked=last.split('AKTUELLER NUTZERAUFTRAG:\n').pop().slice(0,120);return {ok:true,value:{content:JSON.stringify({type:'answer',text:'OpenRouter-Antwort auf: '+asked,citations:[]}),model:'router-model',totalTokens:5}};}
  return {ok:false,error:'Nicht vorgesehen.',code:'unsupported'};
},onEvent:()=>()=>{}});
