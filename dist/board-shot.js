// Screenshots of board areas shown under assistant answers. The picture is
// evidence for the person, never input for the model: it is not part of the
// sources, the history or any request. Stored only in the encrypted local chat.
export const SHOT_LIMITS=Object.freeze({data:660000,perMessage:3,perChat:7000000,notes:3});
const text=(value,max)=>typeof value==='string'?value.replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,max):'';
const BASE64=/^[A-Za-z0-9+/]+={0,2}$/;

/** Normalized shot record, or a thrown error. data may be '' once the picture was evicted from the archive. */
export function cleanBoardShot(value){
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Ungültiger Screenshot.');
  let url;try{url=new URL(value.url);}catch{throw new Error('Ungültiger Screenshot-Link.');}
  if(url.protocol!=='https:'||!['miro.com','www.miro.com'].includes(url.hostname)||url.username||url.password||url.port||!/^\/app\/board\/[^/]+\/?$/.test(url.pathname))throw new Error('Ungültiger Screenshot-Link.');
  const data=typeof value.data==='string'?value.data:'';
  if(data&&(data.length>SHOT_LIMITS.data||!BASE64.test(data)||!data.startsWith('/9j/')))throw new Error('Ungültiges Screenshot-Bild.');
  if(value.mime!=='image/jpeg'||!Number.isSafeInteger(value.width)||!Number.isSafeInteger(value.height)||value.width<64||value.height<64||value.width>1280||value.width*value.height>4000000)throw new Error('Ungültige Screenshot-Größe.');
  const id=text(value.id,160);if(!/^[-\w]{1,160}$/.test(id))throw new Error('Ungültige Screenshot-Kennung.');
  const capturedAt=text(value.capturedAt,40);if(!Number.isFinite(Date.parse(capturedAt)))throw new Error('Ungültiger Aufnahmezeitpunkt.');
  return {id,title:text(value.title,200),boardTitle:text(value.boardTitle,200),url:url.href,mime:'image/jpeg',data,width:value.width,height:value.height,capturedAt,settled:value.settled===true};
}
/** Keeps the newest pictures within the chat budget; older ones keep their record but lose the pixels. */
export function limitShotBudget(messages,budget=SHOT_LIMITS.perChat){
  let used=0;
  for(const message of [...messages].reverse())for(const shot of [...(message.shots||[])].reverse()){
    if(!shot.data)continue;
    if(used+shot.data.length>budget)shot.data='';else used+=shot.data.length;
  }
  return messages;
}
