import {safeSpacesURL} from '../dist/agent-browser.js';

// Läuft im Spaces-Seitenkontext (Hauptwelt). Liest nur: hört beim Öffnen des Menüs „Meine Spaces" auf die
// gleichartigen Antworten des Spaces-Backends mit und liest die Kurskarten. Es wird nichts abgeschickt.
export async function readCourseMenu(win=globalThis,wait=ms=>new Promise(r=>setTimeout(r,ms))){
  const doc=win.document,origin=win.location.origin;
  if(win.location.hostname!=='spaces.th-koeln.de'||doc.querySelector('input[type=password]')||/login|auth|password/i.test(win.location.pathname))return {loginRequired:true,courses:[],captured:[]};
  const captured=[],keep=(url,body)=>{try{const u=new URL(url,win.location.href);if(u.origin===origin&&captured.length<40&&typeof body==='string'&&body.length)captured.push({path:u.pathname,body:body.slice(0,400000)});}catch{}};
  const nativeFetch=win.fetch,OpenXHR=win.XMLHttpRequest?.prototype?.open;
  if(typeof nativeFetch==='function')win.fetch=function(...args){const result=nativeFetch.apply(this,args);try{const url=typeof args[0]==='string'?args[0]:args[0]?.url;Promise.resolve(result).then(r=>r.clone().text().then(t=>keep(url,t))).catch(()=>{});}catch{}return result;};
  if(OpenXHR)win.XMLHttpRequest.prototype.open=function(method,url,...rest){try{this.addEventListener('load',()=>{try{if(this.responseType===''||this.responseType==='text')keep(url,this.responseText);}catch{}});}catch{}return OpenXHR.call(this,method,url,...rest);};
  const text=el=>String(el?.textContent||'').replace(/\s+/g,' ').trim();
  const single=a=>{try{const u=new URL(a.getAttribute('href'),win.location.href);const p=u.pathname.split('/').filter(Boolean);return u.origin===origin&&p.length===1&&!u.search?u.href:'';}catch{return '';}};
  const container=()=>{
    const marker=[...doc.querySelectorAll('a,button,li,span,div,h2,h3')].find(el=>text(el)==='Meine Spaces'&&el.children.length===0);
    for(let el=marker?.parentElement,depth=0;el&&depth<8;el=el.parentElement,depth++)if([...el.querySelectorAll('a[href]')].filter(single).length>=2)return el;
    return null;
  };
  const collect=()=>{
    const root=container();if(!root)return [];
    return [...root.querySelectorAll('a[href]')].flatMap(a=>{
      const url=single(a);if(!url)return [];
      const lines=String(a.innerText??a.textContent??'').split('\n').map(s=>s.replace(/\s+/g,' ').trim()).filter(Boolean);
      const title=(a.getAttribute('aria-label')||a.getAttribute('title')||lines.sort((x,y)=>y.length-x.length)[0]||'').slice(0,200);
      return [{title,url}];
    });
  };
  try{
    let found=collect();
    if(!found.length){
      const opener=[...doc.querySelectorAll('header a,header button,nav a,nav button,[role=menubar] *')].find(el=>text(el)==='Spaces');
      if(opener){opener.dispatchEvent(new win.MouseEvent('mouseover',{bubbles:true}));opener.click();await wait(3000);found=collect();}
    }
    return {loginRequired:false,courses:found,captured};
  }finally{
    if(typeof nativeFetch==='function')win.fetch=nativeFetch;
    if(OpenXHR)win.XMLHttpRequest.prototype.open=OpenXHR;
  }
}

export const courseMenuScript=`(${readCourseMenu.toString()})()`;

const plain=v=>String(v??'').replace(/<[^>]*>/g,' ').replace(/&amp;/g,'&').replace(/&#0?38;/g,'&').replace(/&quot;/g,'"').replace(/&#0?39;|&apos;/g,"'").replace(/&nbsp;/g,' ').replace(/[\u0000-\u001f\u007f]+/g,' ').replace(/\s+/g,' ').trim();
const first=(o,keys)=>{for(const k of keys){const v=o?.[k];if(typeof v==='string'&&v.trim())return v;if(v&&typeof v==='object'&&typeof v.rendered==='string'&&v.rendered.trim())return v.rendered;}return '';};

// Schemaunabhängig: sucht in JSON- und HTML-Antworten nach Objekten/Links, die auf einen Spaces-Kursraum zeigen.
export function extractCourses(captured){
  const found=[];
  const add=(url,title)=>{if(found.length<400&&typeof url==='string')found.push({url,title:plain(title)});};
  const walk=(node,depth=0)=>{
    if(!node||depth>8||found.length>=400)return;
    if(Array.isArray(node)){for(const x of node.slice(0,500))walk(x,depth+1);return;}
    if(typeof node!=='object')return;
    const url=first(node,['link','url','permalink','href','site_url','siteurl','path','home']);
    if(url)add(url.startsWith('/')?'https://spaces.th-koeln.de'+url:url,first(node,['title','name','blogname','label','text','post_title']));
    for(const v of Object.values(node))if(v&&typeof v==='object')walk(v,depth+1);
  };
  for(const item of Array.isArray(captured)?captured.slice(0,40):[]){
    const body=String(item?.body||'');
    let data=null;try{data=JSON.parse(body);}catch{}
    if(data)walk(data);
    const html=data&&typeof data==='object'?Object.values(data).filter(v=>typeof v==='string'&&v.includes('<a')).join('\n'):body;
    for(const m of html.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)){if(found.length>=400)break;add(m[1].startsWith('/')?'https://spaces.th-koeln.de'+m[1]:m[1],m[2]);}
  }
  return found;
}

export function cleanCourses(value){
  const out=new Map();
  for(const c of Array.isArray(value)?value.slice(0,600):[]){
    try{
      const url=new URL(safeSpacesURL(String(c?.url||''))),parts=url.pathname.split('/').filter(Boolean);
      if(parts.length!==1||url.search)continue;
      const href=`${url.origin}/${parts[0]}/`,title=plain(c?.title).slice(0,200);
      if(!out.has(href)||!out.get(href).title&&title)out.set(href,{url:href,title});
    }catch{}
  }
  return [...out.values()].slice(0,60);
}

export const requestPaths=captured=>[...new Set((Array.isArray(captured)?captured:[]).map(c=>String(c?.path||'').slice(0,120)).filter(Boolean))].slice(0,20);
