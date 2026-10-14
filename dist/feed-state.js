import {parseNotificationItems} from './inbox.js';

const services=['spaces','mattermost','gitlab','webmail'];
const states=['connected','error','not_configured','snapshot','login_required'];
const text=(value,max)=>typeof value==='string'?value.slice(0,max):'';
const date=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?value:'';

// Validate before changing the visible snapshot. Only failed sources keep their
// old rows; a disconnected account drops its former messages immediately.
export function parseFeedSnapshot(data,previous=[]){
  if(!data||!Array.isArray(data.sources)||data.sources.length>8)throw Error('invalid_feed');
  const seen=new Set();
  const sources=data.sources.map(source=>{
    if(!source||!services.includes(source.source)||!states.includes(source.status)||seen.has(source.source))throw Error('invalid_feed');
    seen.add(source.source);
    return {source:source.source,status:source.status,message:text(source.message,2000),complete:source.complete===true,capturedAt:date(source.capturedAt),checkedAt:date(source.checkedAt),warnings:Array.isArray(source.warnings)?source.warnings.filter(w=>typeof w==='string').slice(0,20).map(w=>w.slice(0,500)):[]};
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
    if(!items.has(item.id)&&sources.some(s=>s.source===item.source&&s.status==='error'))items.set(item.id,item);
  }
  return {items:[...items.values()],sources,checkedAt:date(data.checkedAt)};
}
