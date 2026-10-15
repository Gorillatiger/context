// The assistant reads WhatsApp only through the CoCo-Fokus: chats the person selected AND released for
// the assistant, in the WhatsApp Web tab of the Context browser. The native side verifies every request again.
const bridge=()=>typeof window!=='undefined'&&typeof window.contextDesktop?.chatFilter==='function'?window.contextDesktop.chatFilter:null;
const unwrap=reply=>{if(reply?.ok===false||reply?.error)throw Object.assign(new Error(reply.error||'WhatsApp konnte nicht gelesen werden.'),{code:reply.code});return reply?.ok===true?reply.value:reply;};

/** {available, chats:[{id,title}]}: tools are offered only with a released selection in an open WhatsApp tab. */
export async function whatsappStatus(){
  const call=bridge();if(!call)return {available:false,chats:[]};
  try{const value=unwrap(await call({op:'status'}));
    return {available:value?.supported===true&&value?.assistant===true&&Array.isArray(value.selected)&&value.selected.length>0,chats:(value?.selected||[]).slice(0,100).map(row=>({id:String(row.id),title:String(row.title)}))};}
  catch{return {available:false,chats:[]};}
}
export async function readWhatsappChat(id){
  const call=bridge();if(!call)throw new Error('WhatsApp-Zugriff braucht die Context-Desktop-App.');
  const value=unwrap(await call({op:'read',id}));
  if(!value?.read)throw new Error('Der Chat konnte nicht gelesen werden.');
  return value.read;
}
