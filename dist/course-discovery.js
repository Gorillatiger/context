import {safeSpacesURL} from './agent-browser.js';

const ENTRY='https://spaces.th-koeln.de/';
const generic=/^(?:wp|blog|feed|members?|users?|profiles?|people|groups?|community|search|sitemap|impressum|datenschutz|hilfe|help|login|logout|register|wp-admin|wp-json|wp-content|wp-login\.php|tag|category|author|page|attachment)$/i;

// A course root is exactly one path segment below spaces.th-koeln.de, e.g. /prototyping-things-w26/.
export function courseRootURL(value){
  try{
    const url=new URL(safeSpacesURL(value));
    const parts=url.pathname.split('/').filter(Boolean);
    if(parts.length<1||generic.test(parts[0])||/^\d{4}$/.test(parts[0])||url.search)return '';
    return `${url.origin}/${parts[0]}/`;
  }catch{return '';}
}

export const knownCourseRoots=projects=>{
  const roots=new Set();
  for(const p of projects||[])for(const l of p?.links||[]){const r=l?.tool==='spaces'?courseRootURL(l.url):'';if(r)roots.add(r);}
  return roots;
};

// Reads only the Spaces start page (read-only, background tab) and returns course roots that no project links yet.
export async function discoverNewCourses({projects,request,signal}){
  if(typeof request!=='function')throw new Error('Spaces-Browserwerkzeuge sind nicht verfügbar.');
  const known=knownCourseRoots(projects);
  await request({command:'start',url:ENTRY,background:true,scan:true},{signal});
  const page=await request({command:'courses',background:true,scan:true},{signal});
  if(page?.loginRequired)return {status:'login_required',courses:[],checked:0};
  if(!Array.isArray(page?.courses))return {status:'update_required',courses:[],checked:0};
  const found=new Map();
  for(const l of page.courses){
    const url=courseRootURL(l?.url);
    if(!url||known.has(url)||found.has(url))continue;
    const title=typeof l.title==='string'?l.title.replace(/\s+/g,' ').trim().slice(0,160):'';
    found.set(url,{url,title:title||decodeURIComponent(new URL(url).pathname.replaceAll('/','')).replace(/[-_]+/g,' ')});
  }
  return {status:'ok',courses:[...found.values()].slice(0,30),checked:page.courses.length,requests:Array.isArray(page.requests)?page.requests.filter(r=>typeof r==='string').slice(0,20):[]};
}
