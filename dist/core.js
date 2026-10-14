import {validateDevDiaries} from './dev-diary-engine.js';
import {validateBoardFindings} from './board-index.js';
import {validatePlatformFindings} from './platform-links.js';
import {initialCalendarSync,validateCalendarSync} from './calendar-sync.js';
import {validateCalendarEvents} from './calendar-engine.js';
import {resolveNotificationCourse} from './notification-routing.js';
export {resolveNotificationCourse} from './notification-routing.js';
export const STORAGE_KEY = 'coco-context-v1';
export const TOOL_META = [
  {id:'inventory',name:'Studio-Inventar',short:'IN',color:'blue',category:'Studio',description:'Geräte & Materialien ausleihen',url:'https://inventory.coco.study/',detail:'Das Inventar im Studio Code öffnen und die Ausleihe beim Anbieter verwalten.'},
  { id: 'spaces', name: 'TH-Spaces', short: 'SP', color: 'violet', category: 'Wissen', description: 'Kurse, Ankündigungen & Dokumentation', url: 'https://spaces.th-koeln.de/', detail: 'Direkter Einstieg in eure TH-Spaces. Inhalte werden dort mit deiner vorhandenen Anmeldung geöffnet.' },
  { id: 'mattermost', name: 'Mattermost', short: 'MM', color: 'blue', category: 'Kommunikation', description: 'Channels, Austausch & Teams', url: 'https://chat.coco.study/', detail: 'Euer Mattermost unter chat.coco.study. Projekt-Channels kannst du direkt einem Projekt zuordnen.' },
  { id: 'gitlab', name: 'GitLab', short: 'GL', color: 'peach', category: 'Code', description: 'Repositories, Issues & Abgaben', url: 'https://git.coco.study/', detail: 'Euer GitLab unter git.coco.study. Verknüpfe ein Repository oder Issue mit einem Projekt oder einer Aufgabe.' },
  { id: 'sciebo', name: 'Sciebo', short: 'SC', color: 'green', category: 'Dateien', description: 'Dateien, Ordner & geteilte Abgaben', url: 'https://th-koeln.sciebo.de/', detail: 'Der Sciebo-Dateispeicher der TH Köln. Ordner bleiben bei Sciebo; hier findest du den passenden Einstieg.' },
  { id: 'whatsapp', name: 'WhatsApp', short: 'WA', color: 'green', category: 'Kommunikation', description: 'Gruppen & kurze Absprachen', url: 'https://web.whatsapp.com/', detail: 'Öffnet WhatsApp Web. Gruppenlinks lassen sich einem Projekt zuordnen. Chat-Nachrichten werden nicht automatisch eingelesen.' },
  { id: 'signal', name: 'Signal', short: 'SI', color: 'blue', category: 'Kommunikation', description: 'Private Gruppen & Absprachen', url: 'https://signal.org/download/', detail: 'Signal nutzt eine Desktop-App. Hinterlege einen Signal-Gruppenlink für dein Projekt. Der Standardlink führt zur offiziellen Desktop-App.' },
  { id: 'miro', name: 'Miro', short: 'MI', color: 'yellow', category: 'Ideen', description: 'Boards, Skizzen & gemeinsame Ideen', url: 'https://miro.com/app/dashboard/', detail: 'Miro-Boards können wie Spaces und Repositories mit einem Projekt verknüpft werden.' },
  { id: 'zoom', name: 'Zoom', short: 'ZO', color: 'blue', category: 'Meetings', description: 'Meetings & gemeinsame Sessions', url: 'https://th-koeln.zoom-x.de/', detail: 'Der Zoom-Einstieg der TH Köln. Hinterlege den Meeting-Link direkt im jeweiligen Projekt.' },
  { id: 'webmail', name: 'TH-Webmail', short: 'EM', color: 'peach', category: 'E-Mail', description: 'Hochschul-Mails & wichtige Hinweise', url: 'https://webmail.th-koeln.de/', detail: 'Das Hochschul-Postfach der TH Köln. Der lokale Connector kann nach deiner Einrichtung ungelesene Mail-Kopfzeilen über verschlüsseltes IMAP abholen. Er verschickt keine Mails und lädt keine Anhänge.' }
];
export const LINK_META=[...TOOL_META,{id:'web',name:'Web / anderer Dienst',short:'LK',color:'blue',description:'Gespeicherter Weblink'}];

export function initialState() {
  return {
    version: 1,
    profile: { name: '', semester: 'Wintersemester 2026/27' },
    tools: TOOL_META.map(t => ({ id: t.id, url: t.url, pinned: ['spaces', 'mattermost', 'gitlab', 'sciebo', 'inventory'].includes(t.id) })),
    projects: [
      { id: 'prototyping', name: 'Prototyping Things', subtitle: 'Wintersemester 2026/27', color: 'violet', archived: false, links: [{ id: 'pt-space', title: 'Kurs-Space', tool: 'spaces', url: 'https://spaces.th-koeln.de/prototyping-things-w26/' }], note: '' },
      { id: 'go-public', name: 'How to Go Public', subtitle: 'C&R · Projekt & Community', color: 'peach', archived: false, links: [{ id: 'gp-channel', title: 'Projekt-Channel', tool: 'mattermost', url: 'https://chat.coco.study/students/channels/cr---how-to-go-public' }], note: '' }
    ],
    tasks: [], bookmarks: [], boardFindings: [], platformFindings: [], activity: [], notes: [], devDiaries: [], calendarEvents: [], calendarSync:initialCalendarSync(), inboxRead: [], activeCourse:'', notificationCourses:{}, notificationSettings: { desktop:false }
  };
}

export function safeURL(value) {
  const url = new URL(String(value).trim());
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Bitte einen HTTPS-Link ohne Zugangsdaten eingeben.');
  return url.href;
}
export function cleanText(value, max = 200) {
  if (typeof value !== 'string') throw new Error('Ungültiger Text.');
  const result = value.trim();
  if (result.length > max) throw new Error('Der Text ist zu lang.');
  return result;
}
export function requireText(value, max = 200) {
  const text = cleanText(value, max);
  if (!text) throw new Error('Bitte alle erforderlichen Felder ausfüllen.');
  return text;
}
export function validateDate(value) {
  if (!value) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value + 'T12:00:00Z')) || new Date(value + 'T12:00:00Z').toISOString().slice(0,10) !== value) throw new Error('Ungültiges Datum.');
  return value;
}
export function preserveMarkdown(value) {if(typeof value!=='string'||value.length>50000)throw new Error('Ungültiger Markdown-Text.');return value;}
export function validateState(raw, {diaryImported=false} = {}) {
  if (!raw || raw.version !== 1 || !Array.isArray(raw.tools) || !Array.isArray(raw.projects) || !Array.isArray(raw.tasks) || !Array.isArray(raw.bookmarks)) throw new Error('Das ist kein gültiges Context-Backup.');
  const id = value => { const text = requireText(value, 80); if (!/^[a-zA-Z0-9_-]+$/.test(text)) throw new Error('Ungültige ID.'); return text; };
  const tool = value => { if (!TOOL_META.some(t => t.id === value)) throw new Error('Unbekanntes Tool.'); return value; };
  const color = value => ['violet','peach','green','blue','yellow'].includes(value) ? value : 'violet';
  const unique = (items, limit) => { if (items.length > limit || new Set(items.map(i => i.id)).size !== items.length) throw new Error('Zu viele oder doppelte Einträge.'); return items; };
  const link = l => { if(!LINK_META.some(t=>t.id===l.tool))throw new Error('Unbekannte Link-Quelle.');return { id:id(l.id), title:requireText(l.title), tool:l.tool, url:safeURL(l.url) }; };
  const migratedTools = [...raw.tools];
  for(const m of TOOL_META) if(!migratedTools.some(t=>t.id===m.id)) migratedTools.push({id:m.id,url:m.url,pinned:m.id==='inventory'});
  const tools = unique(migratedTools.map(t => ({ id:tool(t.id), url:safeURL(t.url), pinned:!!t.pinned })), TOOL_META.length);
  if (tools.length !== TOOL_META.length) throw new Error('Im Backup fehlen Tools.');
  const projects = unique(raw.projects.map(p => ({ id:id(p.id), name:requireText(p.name), subtitle:cleanText(p.subtitle || ''), color:color(p.color), archived:!!p.archived, links:unique((p.links || []).map(link),40), note:cleanText(p.note || '',10000) })), 300);
  const projectId = value => { if (!value) return ''; if (!projects.some(p => p.id === value)) throw new Error('Ein verknüpftes Projekt fehlt.'); return value; };
  const tasks = unique(raw.tasks.map(t => ({ id:id(t.id), title:requireText(t.title), projectId:projectId(t.projectId), status:['todo','doing','done'].includes(t.status) ? t.status : 'todo', due:validateDate(t.due), url:t.url ? safeURL(t.url) : '', createdAt:cleanText(t.createdAt || '',80) })), 2000);
  const bookmarks = unique(raw.bookmarks.map(b => ({ ...link(b), projectId:projectId(b.projectId), note:cleanText(b.note || '',1000) })),2000);
  const notes=unique((raw.notes||[]).map(n=>({id:id(n.id),title:requireText(n.title),content:preserveMarkdown(n.content||''),projectId:projectId(n.projectId),updatedAt:cleanText(n.updatedAt||'',80)})),200);
  const calendarEvents=validateCalendarEvents(raw.calendarEvents===undefined?[]:raw.calendarEvents,{projectIds:projects.map(p=>p.id)});
  const notificationCourses={};
  const mappings=Object.entries(raw.notificationCourses||{});
  if(mappings.length>2000)throw new Error('Zu viele Kurszuordnungen.');
  for(const [key,value] of mappings){if(!/^[-a-zA-Z0-9_]{1,150}$/.test(key))throw new Error('Ungültige Hinweis-ID.');notificationCourses[key]=projectId(value);}
  return { version:1, profile:{ name:cleanText(raw.profile?.name || '',80), semester:cleanText(raw.profile?.semester || '',100) }, tools, projects, tasks, bookmarks, boardFindings:validateBoardFindings(raw.boardFindings||[],projects.map(p=>p.id)), platformFindings:validatePlatformFindings(raw.platformFindings===undefined?[]:raw.platformFindings), activity:[], notes, devDiaries:validateDevDiaries(raw.devDiaries===undefined?[]:raw.devDiaries,projects,{imported:diaryImported}), calendarEvents, calendarSync:validateCalendarSync(raw.calendarSync), inboxRead:(Array.isArray(raw.inboxRead)?raw.inboxRead:[]).filter(i=>typeof i==='string'&&i.length<=200).slice(0,2000), activeCourse:projectId(raw.activeCourse), notificationCourses, notificationSettings:{desktop:raw.notificationSettings?.desktop===true} };
}
export function searchState(state, query) {
  const words = String(query).toLocaleLowerCase('de').trim().split(/\s+/).filter(Boolean);
  const entries = [
    ...state.tools.map(t => { const m=TOOL_META.find(m => m.id===t.id); return { type:'tool', id:t.id, title:m.name, description:m.description, url:t.url }; }),
    ...state.projects.filter(p => !p.archived).map(p => ({ type:'project', id:p.id, title:p.name, description:p.subtitle+' '+p.note })),
    ...state.projects.filter(p=>!p.archived).flatMap(p => p.links.map(l => ({ type:'link', id:l.id, title:l.title, description:p.name+' '+l.tool, url:l.url }))),
    ...state.tasks.map(t => ({ type:'task', id:t.id, title:t.title, description:state.projects.find(p=>p.id===t.projectId)?.name || 'Persönliche Aufgabe' })),
    ...(state.notes||[]).map(n=>({type:'note',id:n.id,title:n.title,description:n.content})),
    ...(state.devDiaries||[]).filter(d=>!d.archived).map(d=>({type:'diary',id:d.id,title:d.title,description:d.courseName+' '+d.startDate+' '+d.endDate})),
    ...(state.calendarEvents||[]).filter(e=>!state.projects.find(p=>p.id===e.projectId)?.archived).map(e=>({type:'calendar',id:e.id,title:e.title,description:e.start+' '+(state.projects.find(p=>p.id===e.projectId)?.name||'Persönlich')})),
    ...(state.boardFindings||[]).map(b=>({type:'board',id:b.id,title:b.customTitle||b.title,description:b.postedBy+' '+b.sourceTitle+' '+(state.projects.find(p=>p.id===b.projectId)?.name||''),url:b.url})),
    ...state.bookmarks.map(b => ({ type:'bookmark', id:b.id, title:b.title, description:b.note+' '+b.tool, url:b.url }))
  ];
  return entries.filter(e => words.every(w => (e.title+' '+e.description+' '+(e.url||'')).toLocaleLowerCase('de').includes(w))).slice(0,40);
}
export function dateKey(date=new Date()) { return new Intl.DateTimeFormat('sv-SE',{ timeZone:'Europe/Berlin',year:'numeric',month:'2-digit',day:'2-digit' }).format(date); }
export function taskCounts(state) { const today=dateKey(); return { open:state.tasks.filter(t=>t.status!=='done').length, done:state.tasks.filter(t=>t.status==='done').length, due:state.tasks.filter(t=>t.status!=='done'&&t.due&&t.due<=today).length }; }

export function notificationKey(item) { return item.id + ':' + (item.revision || '1'); }
export function taskNotifications(state) {
  const today=dateKey();
  return state.tasks.filter(t=>t.status!=='done'&&t.due&&t.due<=today).map(t=>({id:'task_'+t.id,revision:t.due,source:'context',title:t.title,summary:t.due<today?'Die Aufgabe ist überfällig.':'Die Aufgabe ist heute fällig.',url:t.url,createdAt:t.due+'T09:00:00+02:00',taskId:t.id,projectId:t.projectId}));
}
export function courseMatches(projectId,selected=''){return !selected||projectId===selected;}
export function notificationCourse(item,state){
  return resolveNotificationCourse(item,state).projectId;
}
