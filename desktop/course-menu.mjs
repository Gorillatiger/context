import {safeSpacesURL} from '../dist/agent-browser.js';

// Läuft im Spaces-Seitenkontext: findet das Menü „Meine Spaces" und liest nur dessen Kurskarten.
// Es werden nur der Spaces-Menüknopf und keine Formulare/Links angeklickt; es wird nichts abgeschickt.
export async function readCourseMenu(win=globalThis,wait=ms=>new Promise(r=>setTimeout(r,ms))){
  const doc=win.document,origin=win.location.origin;
  if(win.location.hostname!=='spaces.th-koeln.de'||doc.querySelector('input[type=password]')||/login|auth|password/i.test(win.location.pathname))return {loginRequired:true,courses:[]};
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
  let found=collect();
  if(!found.length){
    const opener=[...doc.querySelectorAll('header a,header button,nav a,nav button,[role=menubar] *')].find(el=>text(el)==='Spaces');
    if(opener){opener.dispatchEvent(new win.MouseEvent('mouseover',{bubbles:true}));opener.click();await wait(1800);found=collect();}
  }
  return {loginRequired:false,courses:found};
}

export const courseMenuScript=`(${readCourseMenu.toString()})()`;

export function cleanCourses(value){
  const out=new Map();
  for(const c of Array.isArray(value)?value.slice(0,200):[]){
    try{
      const url=new URL(safeSpacesURL(String(c?.url||''))),parts=url.pathname.split('/').filter(Boolean);
      if(parts.length!==1||url.search)continue;
      const href=`${url.origin}/${parts[0]}/`;
      if(!out.has(href))out.set(href,{url:href,title:String(c?.title||'').replace(/[\u0000-\u001f\u007f]+/g,' ').replace(/\s+/g,' ').trim().slice(0,200)});
    }catch{}
  }
  return [...out.values()].slice(0,60);
}
