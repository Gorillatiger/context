export const DIARY_IMAGE_LIMIT=8*1024*1024;
export const DIARY_MEDIA_PER_DAY=8;
export const DIARY_MEDIA_PER_RUN=40;
export const DIARY_MEDIA_TYPES=Object.freeze(['image/jpeg','image/png','image/gif','image/webp']);
export function diaryImageBytes(value){
 const bytes=value instanceof ArrayBuffer?new Uint8Array(value):ArrayBuffer.isView(value)?new Uint8Array(value.buffer,value.byteOffset,value.byteLength):null;
 if(!bytes||bytes.length<16||bytes.length>DIARY_IMAGE_LIMIT)throw new Error('Wähle ein Foto oder GIF mit höchstens 8 MiB.');
 return bytes;
}
export function inspectDiaryImage(value){
 const b=diaryImageBytes(value),ascii=(offset,n)=>String.fromCharCode(...b.slice(offset,offset+n));let mime='',width=0,height=0;
 const be=(n)=>new DataView(b.buffer,b.byteOffset,b.byteLength).getUint32(n);
 if(b.length>=24&&ascii(0,8)==='\x89PNG\r\n\x1a\n'&&ascii(12,4)==='IHDR'){mime='image/png';width=be(16);height=be(20);}
 else if(['GIF87a','GIF89a'].includes(ascii(0,6))){mime='image/gif';width=b[6]|b[7]<<8;height=b[8]|b[9]<<8;}
 else if(ascii(0,4)==='RIFF'&&ascii(8,4)==='WEBP'){
  mime='image/webp';const chunk=ascii(12,4);
  if(chunk==='VP8X'&&b.length>=30){width=1+(b[24]|b[25]<<8|b[26]<<16);height=1+(b[27]|b[28]<<8|b[29]<<16);}
  else if(chunk==='VP8L'&&b.length>=25&&b[20]===47){width=1+(b[21]|(b[22]&63)<<8);height=1+((b[22]>>6)|b[23]<<2|(b[24]&15)<<10);}
  else if(chunk==='VP8 '&&b.length>=30&&b[23]===157&&b[24]===1&&b[25]===42){width=(b[26]|b[27]<<8)&16383;height=(b[28]|b[29]<<8)&16383;}
 }
 else if(b[0]===255&&b[1]===216){
  mime='image/jpeg';for(let i=2;i+8<b.length;){if(b[i++]!==255)break;while(b[i]===255)i++;const marker=b[i++];if(marker===217||marker===218)break;if(marker===1||marker>=208&&marker<=215)continue;const length=(b[i]<<8)|b[i+1];if(length<2||i+length>b.length)break;if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)){height=(b[i+3]<<8)|b[i+4];width=(b[i+5]<<8)|b[i+6];break;}i+=length;}
 }
 if(!mime||!width||!height||width>16384||height>16384||width*height>40_000_000)throw new Error('Diese Bilddatei wird nicht unterstützt. Nutze JPG, PNG, WebP oder GIF mit höchstens 40 Megapixeln.');
 return {mime,size:b.length,width,height};
}
export function validateDiaryAttachment(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['id','name','mime','size','caption'].includes(k))||typeof value.id!=='string'||!/^[a-f0-9]{64}$/.test(value.id)||!DIARY_MEDIA_TYPES.includes(value.mime)||!Number.isSafeInteger(value.size)||value.size<16||value.size>DIARY_IMAGE_LIMIT||typeof value.name!=='string'||value.name.length>120||/[\x00-\x1f\x7f/\\]/.test(value.name)||typeof (value.caption??'')!=='string'||(value.caption||'').length>240||/[\x00-\x1f\x7f]/.test(value.caption||''))throw new Error('Ungültiger Diary-Bildanhang.');
 return {id:value.id,name:value.name,mime:value.mime,size:value.size,caption:value.caption||''};
}
export function diaryMediaIds(content){return [...new Set([...String(content).matchAll(/^!\[[^\]\n]*\]\(diary-media:([a-f0-9]{64})\)$/gm)].map(m=>m[1]))];}
