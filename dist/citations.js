const labels={spaces:'TH-Spaces',mattermost:'Mattermost',gitlab:'GitLab',miro:'Miro',sciebo:'Sciebo'};
export function sourceURL(source){
  if(typeof source?.url!=='string'||source.url.length>2000||/[\u0000-\u0020\u007f]/.test(source.url))return '';
  try{const url=new URL(source.url);return url.protocol==='https:'&&!url.username&&!url.password?url.href:'';}catch{return '';}
}
export function sourceLabel(source){
  const kind=source.kind==='browser'?'TH-Spaces':labels[source.source]||({notes:'Notiz',tasks:'Aufgabe',projects:'Projekt',bookmarks:'Ablage-Link',updates:'Mitteilung',calendar:'Kalendertermin',photo:'Terminplan-Foto',miro:'Miro'})[source.kind]||'Quelle';
  return kind+' · '+String(source.title||'Ohne Titel').slice(0,200);
}
// Leave code, frontmatter, wiki links and existing Markdown links untouched.
function mapCitations(content,replace){
  let code=false,frontmatter=false;
  return String(content).split('\n').map((line,index)=>{
    if(index===0&&line.trim()==='---'){frontmatter=true;return line;}
    if(frontmatter){if(line.trim()==='---')frontmatter=false;return line;}
    if(line.startsWith('```')){code=!code;return line;}
    if(code)return line;
    return line.replace(/`[^`]+`|\[\[[^\]]+\]\]|\[(?:[^\[\]]|\[[^\]]*\])+\]\([^\s)]+\)|\[((?:[pntubc]|photo|live|crawl|miro|service):[^\]\s]{1,158})\]/g,(token,id)=>id?replace(id):token);
  }).join('\n');
}
export function citationIds(content){const ids=new Set();mapCitations(content,id=>{ids.add(id);return '';});return [...ids];}
const markdownLabel=source=>sourceLabel(source).replace(/[\[\]\\`*]/g,'');
export function sourceMarkdown(source){
  const url=sourceURL(source),label=markdownLabel(source);
  return url?`[${label}](${url.replace(/\(/g,'%28').replace(/\)/g,'%29')})`:label;
}
export function citationsToMarkdown(content,sources=[]){
  const known=new Map(sources.map(d=>[d.id,d]));
  return mapCitations(content,id=>known.has(id)?sourceMarkdown(known.get(id)):'(Quelle nicht verfügbar)');
}
