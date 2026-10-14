import {notificationCourse} from './core.js';
import {miroBoardURL} from './board-index.js';

const viewNames={boards:'Miro-Boards',inventory:'Studio-Inventar',today:'Heute',browser:'Browser',calendar:'Kalender',companion:'Studienbegleiter',inbox:'Mitteilungen',projects:'Projekte',tasks:'Aufgaben',notes:'Notizen',links:'Ablage',mail:'TH-Mail',ai:'Hochschul-KI',imports:'Importieren',plugins:'Plugins',submissions:'Abgaben',tools:'Tools',settings:'Einstellungen'};

// Only saved project data and page metadata. Never scrape form fields or mail bodies.
export function resolveAgentContext(workspace,updates,{view='today',projectId,noteId,taskId,notificationId,browser}={}){
  let scope=projectId;
  if(scope===undefined&&noteId)scope=workspace.notes.find(n=>n.id===noteId)?.projectId;
  if(scope===undefined&&taskId)scope=workspace.tasks.find(t=>t.id===taskId)?.projectId;
  if(scope===undefined&&notificationId){const n=updates.find(n=>n.id===notificationId);if(n)scope=notificationCourse(n,workspace);}
  if(scope===undefined)scope=workspace.activeCourse||'';
  const project=workspace.projects.find(p=>p.id===scope);
  if(scope&&!project)scope=workspace.activeCourse||'';
  const name=workspace.projects.find(p=>p.id===scope)?.name||'Alle Projekte';
  const browserCurrent=(browser?.visible===true||view==='browser'&&browser?.current===true)&&browser?.readable===true;
  const label=projectId!==undefined?'Projekt · '+name:viewNames[view]||'Arbeitsbereich';
  // A Miro board in the active, shown browser tab. Only the normalized URL and tab title travel.
  let currentBoard=null;
  if((browser?.visible===true||view==='browser'&&browser?.current===true)&&browser?.miroBoard)try{currentBoard={url:miroBoardURL(browser.miroBoard.url),title:String(browser.miroBoard.title||'').replace(/[\u0000-\u001f\u007f]/g,'').trim().replace(/^miro$/i,'').slice(0,200)||'Miro-Board'};}catch{}
  return {projectId:scope,projectName:name,label:currentBoard?'Miro-Board · '+currentBoard.title.slice(0,60):label,browserCurrent,...(currentBoard?{currentBoard}:{})};
}
