import {normalizePlatformURL,platformDocumentURL,platformSourceId} from './source-catalog.js';

const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const text=(value,max=200)=>typeof value==='string'?value.trim().slice(0,max).replace(/[\uD800-\uDBFF]$/,''):'';
const names={gitlab:'GitLab',sciebo:'Sciebo'};
const documentIcon='<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 3h9l5 5v13H5Z"/><path d="M14 3v5h5M9 12h6m-6 4h6"/></svg>';
const readIcon='<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14m-6-6 6 6-6 6"/></svg>';
function offeredFiles(source,files){
  try{
    if(!source||!Object.hasOwn(names,source.service)||source.id!==platformSourceId(source)||!Array.isArray(files))return [];
    const scope=normalizePlatformURL(source.service,source.url),rows=[],seen=new Set();
    for(const file of files.slice(0,50))try{
      if(!file||Array.isArray(file)||file.sourceId!==undefined&&file.sourceId!==source.id||file.projectId!==undefined&&file.projectId!==source.projectId||file.service!==undefined&&file.service!==source.service)continue;
      const url=platformDocumentURL(source.service,file.url,scope);
      // platformDocumentURL also accepts normal source pages for Knowledge.
      // This view is only for links from the separate observed-file policy.
      let page=false;try{normalizePlatformURL(source.service,url,scope);page=true;}catch{}if(page||seen.has(url))continue;
      const parsed=new URL(url),candidate=parsed.searchParams.get('files')||parsed.pathname.split('/').at(-1)||'';let filename='';try{filename=decodeURIComponent(candidate);}catch{}
      const extension=/\.(pdf|docx|pptx|xlsx|md|markdown|txt|json)$/i.exec(filename)?.[1]?.toLowerCase()||'';
      const format=extension?['md','markdown','txt','json'].includes(extension)?'Text':extension.toUpperCase():'Datei';
      const title=text(file.title)||text(file.fileName)||text(filename&&extension?filename:'')||'Material';
      seen.add(url);rows.push({url,title,format});
    }catch{}
    return rows;
  }catch{return [];}
}

/** Present observed local metadata only. No fetch, IPC or storage side effects. */
export function renderSourceFiles(source,{files=[],busy=false,expanded=false}={}){
  const rows=offeredFiles(source,files);if(!rows.length)return '';
  const origin=text(source.title)||names[source.service],label='Materialien aus '+origin;
  return `<details class="source-files"${expanded?' open':''}><summary data-platform="materials" data-source="${escape(source.id)}">${documentIcon}<span>Materialien <span class="source-files-count">(${rows.length})</span></span></summary><div class="source-files-scroll"><ul class="source-files-list" aria-label="${escape(label)}">${rows.map(file=>`<li>${documentIcon}<div class="source-files-name"><strong>${escape(file.title)}</strong><small>${escape(file.format)}</small></div><button type="button" class="source-files-read" data-platform="read-file" data-source="${escape(source.id)}" data-file="${escape(file.url)}" aria-label="${escape(file.title+' lesen · '+origin)}" title="${escape(file.format+' lesen: '+file.title+' · '+origin)}" ${busy?'disabled aria-busy="true"':''}>${readIcon}</button></li>`).join('')}</ul></div></details>`;
}
