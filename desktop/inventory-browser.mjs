export const INVENTORY_URL='https://inventory.coco.study/';

// This is a page surface for a single, retained provider tab. It does not expose
// an arbitrary URL, a new remote preload or an inventory/loan automation API.
export function createInventoryBrowser({getTab,createTab,selectTab,navigateTab}){
 let tabId='',generation=0,attached=false,queue=Promise.resolve();
 const live=()=>{const tab=getTab(tabId);return tab&&!tab.view.webContents.isDestroyed()?tab:null;};
 function handle(message){
  if(!message||Array.isArray(message)||message.type!=='inventory'||!['attach','home','detach'].includes(message.action)||Object.keys(message).some(key=>!['type','action'].includes(key)))throw new Error('Ungültiger Inventar-Browserauftrag.');
  if(message.action==='detach'){generation++;attached=false;return Promise.resolve({tabId,detached:true});}
  const token=generation;
  const pending=queue.then(async()=>{
   if(token!==generation)return {tabId,detached:true};
   let tab=live(),created=false;
   if(!tab){tab=await createTab(INVENTORY_URL);tabId=String(tab.id);created=true;}
   if(token!==generation)return {tabId,detached:true};
   if(message.action==='home'&&!created)await navigateTab(tabId,INVENTORY_URL);
   if(token!==generation)return {tabId,detached:true};
   if(!live())throw new Error('Der Inventar-Tab wurde geschlossen. Bitte erneut öffnen.');
   try{await selectTab(tabId);}catch(error){attached=false;throw error;}
   if(token!==generation)return {tabId,detached:true};
   attached=true;return {tabId,surfaceToken:token};
  });
  queue=pending.catch(()=>{});return pending;
 }
 return Object.freeze({handle,owns:id=>String(id)===tabId&&!!live(),acceptsFrame:(message,active)=>attached&&message?.owner==='inventory'&&message.id===tabId&&active===tabId&&message.surfaceToken===generation&&!!live()});
}
