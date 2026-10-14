import {miroBoardURL,boardFinding,mergeBoardFindings} from './board-index.js';
import {platformCatalog} from './source-catalog.js';

// The board open in the browser becomes readable only as a course source.
// An existing source in the chat's course wins; otherwise it is assigned to the
// chat's course, or to the only course. Nothing is guessed across courses.
export function planCurrentBoard(workspace,board,projectId=''){
  if(!board?.url)throw new Error('Im Context-Browser ist gerade kein Miro-Board geöffnet. Öffne das Board im Browser und frage erneut.');
  const url=miroBoardURL(board.url),courses=(workspace.projects||[]).filter(project=>!project.archived);
  const existing=platformCatalog(workspace).find(source=>source.service==='miro'&&source.url===url&&(!projectId||source.projectId===projectId));
  if(existing)return {sourceId:existing.id,projectId:existing.projectId,assigned:false};
  const target=projectId||(courses.length===1?courses[0].id:'');
  if(!target)throw new Error(courses.length?'Dieses Board ist noch keinem Kurs zugeordnet. Wähle oben im Assistenten den Kurs, zu dem es gehört, und frage erneut.':'Lege zuerst einen Kurs an. Danach kann der Assistent das Board als Kursquelle lesen.');
  const course=courses.find(project=>project.id===target);
  if(!course)throw new Error('Der gewählte Kurs ist nicht mehr verfügbar.');
  // While Miro loads, the tab is just called "Miro"; that is no board title.
  const title=String(board.title||'').trim(),named=title&&!/^miro$/i.test(title)?title.slice(0,200):'';
  const finding={...boardFinding({url,title:named,titleOrigin:'link'},{id:'browser:'+url,projectId:target,title:'Im Context-Browser geöffnet',kind:'browser'}),assignedProjectId:target};
  return {assigned:true,projectId:target,courseName:course.name,boardTitle:named||'Miro-Board',findingId:finding.id,boardFindings:mergeBoardFindings(workspace.boardFindings||[],[finding])};
}
