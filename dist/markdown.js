import {sourceURL,sourceLabel} from './citations.js';
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const entities=value=>String(value).replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,(raw,key)=>{
  if(key[0]!=='#')return ({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:'\u00a0'})[key.toLowerCase()]||raw;
  const code=key[1].toLowerCase()==='x'?parseInt(key.slice(2),16):Number(key.slice(1));
  return code>0&&code<=0x10ffff&&!(code>=0xd800&&code<=0xdfff)?String.fromCodePoint(code):raw;
});
function inline(value,notes,sources,links=true) {
  // Render tokens separately: generated attributes and code never enter another replacement pass.
  const tokens=/`([^`]+)`|\[\[([^\]]+)\]\]|\[((?:[^\[\]]|\[[^\]]*\])+)\]\((https:\/\/[^\s)]+)\)|\[((?:[pntubc]|photo|live|crawl|miro|service):[^\]\s]{1,158})\]|\*\*([^*]+)\*\*|(?<!\*)\*([^*]+)\*(?!\*)/g;
  let html='',offset=0;
  for(const match of String(value).matchAll(tokens)){
    html+=escape(entities(value.slice(offset,match.index)));offset=match.index+match[0].length;
    const [,code,wiki,label,url,id,bold,italic]=match;
    if(code!==undefined){html+='<code>'+escape(code)+'</code>';continue;}
    if(wiki!==undefined){
      const [title,name]=wiki.split('|'),note=notes.find(n=>n.title.toLowerCase()===entities(title).toLowerCase());
      html+=note&&links?`<button class="wiki-link" data-action="note" data-id="${escape(note.id)}">${escape(entities(name||title))}</button>`:`<span class="wiki-missing">${escape(entities(name||title))}</span>`;continue;
    }
    if(url!==undefined){const href=sourceURL({url:entities(url)}),text=inline(label,notes,undefined,false);html+=href&&links?`<a href="${escape(href)}" target="_blank" rel="noopener noreferrer">${text}</a>`:text;continue;}
    if(id!==undefined){
      if(!sources||!links){html+=escape(match[0]);continue;}
      const source=sources.get(id);
      if(!source){html+='<span class="ki-citation-missing">(Quelle nicht verfügbar)</span>';continue;}
      const href=sourceURL(source),text=escape(sourceLabel(source));
      html+=href?`<a class="ki-citation" href="${escape(href)}" target="_blank" rel="noopener noreferrer" title="Originalquelle öffnen">${text}&nbsp;<span aria-hidden="true">↗</span></a>`:`<button class="ki-citation" data-ki-action="source" data-id="${escape(source.id)}" title="Quelle im Arbeitsbereich ansehen">${text}</button>`;continue;
    }
    html+=bold!==undefined?'<strong>'+inline(bold,notes,sources,links)+'</strong>':'<em>'+inline(italic,notes,sources,links)+'</em>';
  }
  return html+escape(entities(value.slice(offset)));
}
export function renderMarkdown(content,notes=[],{sources}={}) {
  const known=sources?new Map(sources.map(d=>[d.id,d])):undefined;
  const lines=String(content).split('\n');let code=false;let frontmatter=false;let list=false;let html='';
  for(let i=0;i<lines.length;i++){
    const line=lines[i];
    if(i===0&&line.trim()==='---'){frontmatter=true;html+='<pre class="frontmatter"><code>---\n';continue;}
    if(frontmatter){html+=escape(line)+'\n';if(line.trim()==='---'){html+='</code></pre>';frontmatter=false;}continue;}
    if(line.startsWith('```')){if(list){html+='</ul>';list=false;}html+=code?'</code></pre>':'<pre><code>';code=!code;continue;}
    if(code){html+=escape(line)+'\n';continue;}
    const bullet=line.match(/^\s*[-*]\s+(.+)/);
    if(bullet){if(!list){html+='<ul>';list=true;}html+='<li>'+inline(bullet[1],notes,known)+'</li>';continue;}
    if(list){html+='</ul>';list=false;}
    const heading=line.match(/^(#{1,6})\s+(.+)/);
    if(heading){html+=`<h${heading[1].length}>${inline(heading[2],notes,known)}</h${heading[1].length}>`;continue;}
    if(line.startsWith('> ')){html+='<blockquote>'+inline(line.slice(2),notes,known)+'</blockquote>';continue;}
    if(/^\s*---\s*$/.test(line)){html+='<hr>';continue;}
    html+=line.trim()?'<p>'+inline(line,notes,known)+'</p>':'<div class="md-space"></div>';
  }
  if(code||frontmatter)html+='</code></pre>';if(list)html+='</ul>';
  return html||'<p class="md-placeholder">Deine Vorschau erscheint hier.</p>';
}
