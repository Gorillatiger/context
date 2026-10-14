import {safeSpacesURL} from '../dist/agent-browser.js';
import {normalizePlatformURL} from '../dist/source-catalog.js';
import {redactKnowledge} from '../dist/knowledge.js';

const text=value=>redactKnowledge(typeof value==='string'?value:'').replace(/<[^>]*>/g,'').slice(0,200);
const stamp=value=>typeof value==='string'&&value.length<=80&&/^\d{4}-\d{2}-\d{2}T/.test(value)&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():'';
export function readerPlatformLinks(page){
  if(page?.loginRequired||page?.permissionRequired||page?.accessDenied||page?.navigationBlocked)return [];
  const sourceURL=safeSpacesURL(page.url),seen=new Set();
  return (Array.isArray(page.platformLinks)?page.platformLinks:[]).slice(0,100).flatMap(link=>{
    try{
      if(!link||safeSpacesURL(link.sourceURL)!==sourceURL)return [];
      const url=normalizePlatformURL(link.service,link.url),key=link.service+'\n'+url;
      if(seen.has(key))return [];seen.add(key);
      return [{service:link.service,url,title:text(link.title),sourceURL,sourceTitle:text(link.sourceTitle||page.title),postedBy:text(link.postedBy),postedAt:stamp(link.postedAt)}];
    }catch{return [];}
  });
}
