import {buildKnowledge,DEFAULT_KNOWLEDGE,redactKnowledge} from './knowledge.js';
import {TOOL_META,notificationCourse} from './core.js';
import {boardKnowledgeKey} from './board-index.js';
import {sourceURL} from './citations.js';

const string=value=>typeof value==='string'?value:'';
const MAX_DOCUMENTS=20000,CHUNK=60000,OVERLAP=200;
// Routing targets deliberately stay in the UI process: opaque mail identities,
// folder fences and complete chat records never enter the worker's metadata.
export function buildSearchDocuments({workspace,updates=[],browserSources=[],platformSources=[],chatRecords=[],mailSources=[],sourceStates=[]}) {
  const documents=[],targets=new Map(),warnings=[],projects=new Map((workspace.projects||[]).map(p=>[p.id,p]));
  let omitted=0,chatSourcesLimited=0;
  const allowed=id=>!id||projects.has(id)&&!projects.get(id).archived;
  const safeLink=value=>sourceURL({url:redactKnowledge(string(value))});
  function add(input,target) {
    const text=redactKnowledge(string(input.text)),title=redactKnowledge(string(input.title)).slice(0,300);
    // Chunk unusually long already-read sources without losing their tail.
    // The overlap preserves words/phrases at a chunk boundary.
    const chunks=Math.max(1,Math.ceil(Math.max(0,text.length-OVERLAP)/(CHUNK-OVERLAP)));
    for(let part=0;part<chunks;part++){
      if(documents.length>=MAX_DOCUMENTS){omitted++;continue;}
      const start=part*(CHUNK-OVERLAP),id=part?input.id+':part'+part:input.id;
      const doc={...input,id,title:chunks>1?title+` · Abschnitt ${part+1}`:title,text:text.slice(start,start+CHUNK),offset:start,
        ...(input.url?{url:safeLink(input.url)}:{}),route:{type:target.type,id:target.id}};
      documents.push(doc);targets.set(id,{...target,document:doc});
    }
  }
  const boardIds=new Map((workspace.boardFindings||[]).map(b=>['p:'+boardKnowledgeKey(b.id),b]));
  const linkIds=new Map((workspace.bookmarks||[]).map(b=>['p:bookmark:'+b.id,b]));
  const knowledge=buildKnowledge(workspace,updates,{enabled:DEFAULT_KNOWLEDGE,browserSources,platformSources,maxDocuments:MAX_DOCUMENTS});
  for(const item of knowledge){
    if(item.id.startsWith('n:diary:'))continue; // Dedicated human diary routes below.
    let kind=item.kind,source=item.source||'context',target;
    const board=boardIds.get(item.id),bookmark=linkIds.get(item.id);
    if(board){kind='boards';source='miro';target={type:'board',id:board.id,sourceURL:safeLink(board.sourceURL)};}
    else if(bookmark){source=bookmark.tool||'context';target={type:'link',id:bookmark.id};}
    else if(kind==='projects')target={type:'project',id:item.targetId};
    else if(kind==='notes')target={type:'note',id:item.targetId};
    else if(kind==='tasks')target={type:'task',id:item.targetId};
    else if(kind==='calendar')target={type:'calendar',id:item.targetId};
    else if(kind==='updates')target={type:'update',id:item.targetId};
    else if(['miro','service'].includes(kind)){source=item.service||item.source;target={type:'source',id:item.id};}
    else {source='spaces';target={type:'source',id:item.id};}
    add({...item,kind,source,...(board?{url:board.url}:{})},target);
  }
  if(knowledge.length>=MAX_DOCUMENTS)warnings.push('Die Projektquellen erreichen die Dokumentgrenze; weitere Inhalte können fehlen.');
  for(const project of workspace.projects||[]){
    if(project.archived)continue;
    for(const link of project.links||[])add({id:'link:'+project.id+':'+link.id,kind:'links',title:link.title,text:[project.name,link.title,link.tool,link.url].join('\n'),url:link.url,projectId:project.id,source:link.tool,status:'metadata'}, {type:'link',id:link.id});
  }
  for(const tool of workspace.tools||[]){
    const meta=TOOL_META.find(t=>t.id===tool.id);if(!meta)continue;
    add({id:'tool:'+tool.id,kind:'tools',title:meta.name,text:[meta.name,meta.description,tool.url].join('\n'),url:tool.url,projectId:'',source:tool.id,status:'metadata'}, {type:'tool',id:tool.id});
  }
  for(const diary of workspace.devDiaries||[]){
    if(diary.archived||!allowed(diary.projectId))continue;
    add({id:'diary:'+diary.id,kind:'diaries',title:diary.title,text:[diary.courseName,diary.startDate,diary.endDate].join('\n'),projectId:diary.projectId,source:'context',status:'metadata',updatedAt:diary.updatedAt,url:diary.remote?.url||diary.courseUrl},{type:'diary',id:diary.id});
    for(const entry of diary.entries||[]){
      if(!['done','learned','problems','next'].some(field=>string(entry[field]).trim()))continue;
      add({id:'diary:'+diary.id+':'+entry.date,kind:'diaries',title:diary.title+' · '+entry.date,text:[diary.courseName,entry.date,'Gemacht: '+string(entry.done),'Gelernt: '+string(entry.learned),'Probleme: '+string(entry.problems),'Nächster Schritt: '+string(entry.next)].join('\n'),projectId:diary.projectId,source:'context',status:'full',updatedAt:entry.updatedAt,url:diary.remote?.url||diary.courseUrl},{type:'diary',id:diary.id,date:entry.date});
    }
  }
  // Only confirmed archive rows supplied by createKIView.searchRecords().
  // Drafts, active speech sessions and failed archive writes are absent.
  for(const chat of chatRecords){
    if(!allowed(chat.scope))continue;
    for(const [index,message] of (chat.messages||[]).entries()){
      const sources=new Map([...(message.citations||[]),...(message.sources||[]),...(message.steps||[]).flatMap(step=>step.sources||[])].filter(s=>s?.id).map(s=>[s.id,s]));
      const parts=[message.role==='user'?'Nutzer':'Assistent',string(message.content)];let sourceCharacters=0;
      for(const source of sources.values()){
        const remaining=60000-sourceCharacters;
        if(remaining<=0){chatSourcesLimited++;break;}
        const excerpt=string(source.text).slice(0,remaining);sourceCharacters+=excerpt.length;
        if(excerpt.length<string(source.text).length)chatSourcesLimited++;
        parts.push('Quelle: '+string(source.title),safeLink(source.url)||'',excerpt);
      }
      parts.push(...(message.steps||[]).map(step=>['Arbeitsschritt',step.label,step.detail].filter(Boolean).join(': ')));
      const identity=boardKnowledgeKey(chat.id+':'+(message.id||index));
      add({id:'chat:'+identity,kind:'chats',title:chat.title||chat.projectName||'Gespeicherter Chat',text:parts.join('\n'),projectId:chat.scope||'',source:'assistant',status:'excerpt',updatedAt:chat.updatedAt}, {type:'chat',id:chat.id,messageId:message.id,index});
    }
  }
  const loadedMail=new Set();
  for(const mail of mailSources){
    if(!mail?.target||typeof mail.identity!=='string')continue;
    const identity=boardKnowledgeKey(mail.identity),source=mail.service==='th'?'webmail':mail.service;
    loadedMail.add(JSON.stringify([source,mail.target.folder,mail.target.uidValidity,mail.target.uid]));
    add({id:'mail:'+identity,kind:'mail',title:mail.title,text:mail.text,projectId:'',source,status:mail.status,updatedAt:mail.updatedAt}, {type:'mail',id:identity,mailTarget:mail.target});
  }
  for(const item of updates){
    if(item.source!=='webmail'||!item.mailTarget)continue;
    const key=JSON.stringify(['webmail',item.mailTarget.folder,item.mailTarget.uidValidity,item.mailTarget.uid]);if(loadedMail.has(key))continue;
    let projectId='';try{projectId=notificationCourse(item,workspace);}catch{continue;}if(!allowed(projectId))continue;
    add({id:'mail-header:'+item.id,kind:'mail',title:item.title,text:item.summary||'',projectId,source:'webmail',status:'metadata',updatedAt:item.createdAt||''}, {type:'mail',id:item.id,mailTarget:{service:'th',...item.mailTarget}});
  }
  if(omitted)warnings.push(`${omitted} weitere Suchabschnitte liegen außerhalb der Grenze von ${MAX_DOCUMENTS} Inhalten.`);
  if(chatSourcesLimited)warnings.push('Sehr große gespeicherte Chatquellen sind in der Suche nur als Auszug enthalten.');
  warnings.push('Externe Dateien und ungelesene Spaces-Unterseiten werden erst nach dem Import oder Einlesen durchsuchbar.');
  warnings.push('Mail enthält nur bereits geladene Kopfzeilen und geöffnete Texte. WhatsApp und Signal werden nicht automatisch eingelesen.');
  warnings.push('Gespeicherte Chats und Mail sind für deine Suche verfügbar; sie werden dadurch nicht automatisch KI-Wissen.');
  for(const source of sourceStates)if(['error','login_required','not_configured'].includes(source.status))warnings.push(`${source.source}: ${source.status==='error'?'Abruf fehlgeschlagen; vorhandener Stand kann veraltet sein':source.status==='login_required'?'Anmeldung erforderlich':'nicht verbunden'}.`);
  return {documents,targets,warnings,complete:false};
}
