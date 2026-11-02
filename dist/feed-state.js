import {parseNotificationItems,compareNotificationTime} from './inbox.js';

const services=['spaces','mattermost','gitlab','webmail','sciebo','miro','whatsapp','signal'];
const states=['connected','error','not_configured','snapshot','login_required','unsupported'];
const text=(value,max)=>typeof value==='string'?value.slice(0,max):'';
const date=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?value:'';

export function boundNotificationFeed(items,sources,limit=2200){
  if(items.length<=limit)return {items,sources};
  const sorted=[...items].sort(compareNotificationTime),selected=new Set();
  for(const source of sources)for(const item of sorted.filter(item=>item.source===source.source).slice(0,100))if(selected.size<limit)selected.add(item);
  for(const item of sorted){if(selected.size===limit)break;selected.add(item);}
  return {items:sorted.filter(item=>selected.has(item)),sources:sources.map(source=>{
    const missing=items.filter(item=>item.source===source.source&&!selected.has(item)).length;
    return missing?{...source,complete:false,warnings:[missing+' weitere Hinweise bleiben wegen des Gesamtlimits beim Anbieter verfügbar.',...(source.warnings||[])]}:source;
  })};
}

// Validate before changing the visible snapshot. Only failed sources keep their
// old rows; a disconnected account drops its former messages immediately.
export function parseFeedSnapshot(data,previous=[],previousSources=[]){
  if(!data||!Array.isArray(data.sources)||data.sources.length>8)throw Error('invalid_feed');
  const seen=new Set();
  const sources=data.sources.map(source=>{
    if(!source||!services.includes(source.source)||!states.includes(source.status)||seen.has(source.source))throw Error('invalid_feed');
    seen.add(source.source);
    return {source:source.source,status:source.status,message:text(source.message,2000),complete:source.complete===true,itemsAuthoritative:source.itemsAuthoritative===true,accountGeneration:/^[a-f0-9]{64}$/.test(source.accountGeneration||'')?source.accountGeneration:'',capturedAt:date(source.capturedAt),checkedAt:date(source.checkedAt),warnings:Array.isArray(source.warnings)?source.warnings.filter(w=>typeof w==='string').slice(0,20).map(w=>w.slice(0,500)):[]};
  });
  const parsed=parseNotificationItems(data.items),items=new Map();
  for(const item of parsed){
    const status=sources.find(s=>s.source===item.source)?.status;
    if(!['connected','snapshot','error'].includes(status))continue;
    if(items.has(item.id))throw Error('invalid_feed');
    items.set(item.id,item);
  }
  for(const item of previous){
    if(items.size>=2200)break;
    if(!items.has(item.id)&&sources.some(s=>s.source===item.source&&s.status==='error'&&!s.itemsAuthoritative&&(!s.accountGeneration||s.accountGeneration===previousSources.find(old=>old.source===s.source)?.accountGeneration)))items.set(item.id,item);
  }
  return {items:[...items.values()],sources,checkedAt:date(data.checkedAt)};
}
