import { safeURL, requireText, validateState } from './core.js';
export const BUILTIN_PLUGINS=[
  {id:'obsidian',name:'Obsidian & Markdown',short:'MD',color:'violet',tag:'Notizen',description:'Notizen als .md-Dateien übernehmen. Dateinamen bleiben Notiztitel, damit deine Wiki-Links erhalten bleiben.',formats:'.md,.markdown,.txt',version:'1.0.1'},
  {id:'bookmarks',name:'Browser-Lesezeichen',short:'BM',color:'green',tag:'Links',description:'Lesezeichen aus Safari, Chrome, Brave oder Firefox als HTML-Export sammeln.',formats:'.html,.htm',version:'1.0.0'},
  {id:'projects',name:'GitHub & GitLab',short:'RE',color:'peach',tag:'Projekte',description:'Eine JSON-Projektliste aus der GitHub- oder GitLab-API als Projektkontexte übernehmen.',formats:'.json',version:'1.0.0'},
  {id:'context',name:'Context-Backup',short:'CX',color:'blue',tag:'Arbeitsbereich',description:'Ein bestehendes Context-Backup prüfen und in deinen Arbeitsbereich übernehmen.',formats:'.json',version:'1.0.0'}
];
const uuid=()=>crypto.randomUUID();
const decode=value=>value.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi,m=>{const names={'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'"};if(names[m.toLowerCase()])return names[m.toLowerCase()];const n=parseInt(m.slice(2,-1).replace(/^x/i,''),/^&#x/i.test(m)?16:10);return n>0&&n<=0x10ffff?String.fromCodePoint(n):'';});
const inferTool=url=>{const h=new URL(url).hostname;return h==='spaces.th-koeln.de'?'spaces':h==='chat.coco.study'?'mattermost':h==='git.coco.study'?'gitlab':h.endsWith('.sciebo.de')?'sciebo':h==='webmail.th-koeln.de'?'webmail':h==='miro.com'?'miro':'web';};
export function parseMarkdownFile(name,content) {
  if(content.length>50000)throw new Error('Eine Notiz darf höchstens 50.000 Zeichen enthalten.');
  const title=name.replace(/\.(md|markdown|txt)$/i,'');
  return {id:uuid(),title:requireText(title),content,projectId:'',updatedAt:new Date().toISOString()};
}
export function parseBookmarksHTML(html) {
  const items=[];let match;
  const pattern=/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi;
  while((match=pattern.exec(html))){if(items.length>=1000)throw new Error('Höchstens 1.000 Lesezeichen pro Import.');try{const url=safeURL(decode(match[1]));const title=decode(match[2].replace(/<[^>]*>/g,'')).trim()||new URL(url).hostname;items.push({id:uuid(),title:requireText(title),url,tool:inferTool(url),projectId:'',note:''});}catch{ /* Executable, local and credential-bearing links are excluded. */ }}
  if(!items.length)throw new Error('Keine geeigneten HTTPS-Lesezeichen gefunden.');
  return items;
}
export function parseProjectList(raw) {
  if(!Array.isArray(raw)||raw.length>300)throw new Error('Eine JSON-Liste mit höchstens 300 Projekten wird erwartet.');
  return raw.map(p=>{
    const url=safeURL(p.web_url||p.html_url);const host=new URL(url).hostname;
    if(!['git.coco.study','gitlab.com','github.com'].includes(host))throw new Error('Projektquelle muss GitHub oder GitLab sein.');
    const github=host==='github.com';
    return {id:uuid(),name:requireText(p.name||p.path),subtitle:requireText(p.path_with_namespace||p.full_name||p.name),color:github?'blue':'peach',archived:false,note:'',links:[{id:uuid(),title:github?'GitHub Repository':'GitLab Repository',tool:github?'web':'gitlab',url}]};
  });
}
export async function planImport(pluginId,files,current) {
  const plugin=BUILTIN_PLUGINS.find(p=>p.id===pluginId);if(!plugin)throw new Error('Unbekanntes Import-Plugin.');
  if(!files.length||files.length>100)throw new Error('Bitte zwischen 1 und 100 Dateien auswählen.');
  if(pluginId==='context'){if(files.length!==1)throw new Error('Bitte genau ein Backup auswählen.');if(files[0].size>8000000)throw new Error('Das Backup darf höchstens 8 MB groß sein.');return {replace:validateState(JSON.parse(await files[0].text()),{diaryImported:true}),pluginId};}
  if(files.reduce((s,f)=>s+f.size,0)>4000000)throw new Error('Der Import darf insgesamt höchstens 4 MB groß sein.');
  const notes=[],bookmarks=[],projects=[];
  for(const file of files){
    if(file.size>1000000)throw new Error('Einzeldateien dürfen höchstens 1 MB groß sein.');
    const text=await file.text();
    if(pluginId==='obsidian'){if(!/\.(md|markdown|txt)$/i.test(file.name))continue;notes.push(parseMarkdownFile(file.name,text));}
    if(pluginId==='bookmarks')bookmarks.push(...parseBookmarksHTML(text));
    if(pluginId==='projects')projects.push(...parseProjectList(JSON.parse(text)));
  }
  if(!notes.length&&!bookmarks.length&&!projects.length)throw new Error('Keine passenden Inhalte gefunden.');
  const existingLinks=new Set(current.bookmarks.map(b=>b.url));
  const uniqueLinks=bookmarks.filter(b=>{if(existingLinks.has(b.url))return false;existingLinks.add(b.url);return true;});
  const existingRepos=new Set(current.projects.flatMap(p=>p.links.map(l=>l.url)));
  const uniqueProjects=projects.filter(p=>{const url=p.links[0].url;if(existingRepos.has(url))return false;existingRepos.add(url);return true;});
  validateState({...current,notes:[...(current.notes||[]),...notes],bookmarks:[...current.bookmarks,...uniqueLinks],projects:[...current.projects,...uniqueProjects]});
  return {pluginId,notes,bookmarks:uniqueLinks,projects:uniqueProjects,skipped:bookmarks.length-uniqueLinks.length+projects.length-uniqueProjects.length};
}
export function applyImport(state,plan) {
  if(plan.replace)return plan.replace;
  return {...state,notes:[...(state.notes||[]),...plan.notes],bookmarks:[...state.bookmarks,...plan.bookmarks],projects:[...state.projects,...plan.projects]};
}
