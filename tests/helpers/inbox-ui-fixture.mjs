import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {initialState,LINK_META,safeURL,notificationKey,notificationCourse,resolveNotificationCourse,courseMatches,taskNotifications} from '../../dist/core.js';
import {devDiaryReminderNotifications} from '../../dist/dev-diary-engine.js';
import {notificationGroup,notificationGroups,resolveNotificationGroup,notificationTime,compareNotificationTime,formatSnapshotTime} from '../../dist/inbox.js';
import {brandLogo} from '../../dist/brand-logos.js';

const source=readFileSync(new URL('../../dist/app.js',import.meta.url),'utf8');
const part=(start,end)=>{const offset=source.indexOf(start),finish=source.indexOf(end,offset);if(offset<0||finish<0)throw Error('Missing actual Inbox fixture source '+start);return source.slice(offset,finish);};
const decode=value=>String(value).replace(/&(amp|lt|gt|quot|#39);/g,(_,name)=>({amp:'&',lt:'<',gt:'>',quot:'"','#39':"'"})[name]);
const attrs=text=>Object.fromEntries([...text.matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s/>]+)))?/g)].map(m=>[m[1],decode(m[2]??m[3]??m[4]??'')]));
export const notice=(id,patch={})=>({id,source:'mattermost',title:'Synthetic notice '+id,summary:'Synthetic sender · course team',content:'A short already-delivered message excerpt for the synthetic course.',contentStatus:'excerpt',createdAt:'2026-10-13T12:00:00Z',revision:'1',url:'https://chat.coco.study/course/pl/'+id,groupUrl:'https://chat.coco.study/course/channels/prototyping',groupId:'course-channel',groupName:'Course team',projectId:'prototyping',...patch});

export function createInboxFixture({items=[notice('one'),notice('two',{source:'spaces',url:'https://spaces.th-koeln.de/prototyping-things-w26/synthetic/'}),notice('three',{source:'gitlab',projectId:'',url:'https://git.coco.study/synthetic/other'})],syncHTML=''}={}){
  const listeners=new Map(),effects=[];
  const state=initialState();state.tasks=[];state.devDiaries=[];state.notificationCourses={};
  const sandbox={state,view:'inbox',remoteItems:items,sourceStates:[{source:'spaces',status:'snapshot',complete:false,capturedAt:'2026-10-13T13:00:00Z',message:'Teilstand: nur bereits geladene Beiträge.'},{source:'mattermost',status:'connected',complete:false,message:'Teilstand: maximal 100 Textvorschauen.'},{source:'gitlab',status:'error',message:'Synthetic access error.'},{source:'webmail',status:'not_configured'}],
    inboxFilter:'all',inboxSource:'all',inboxGroup:'all',inboxLimit:50,feedBusy:false,feedCheckedAt:'2026-10-13T13:00:00Z',hasLocalConnector:true,
    LINK_META,safeURL,notificationKey,notificationCourse,resolveNotificationCourse,courseMatches,taskNotifications,devDiaryReminderNotifications,notificationGroup,notificationGroups,resolveNotificationGroup,notificationTime,compareNotificationTime,formatSnapshotTime,brandLogo,
    project:id=>state.projects.find(p=>p.id===id),meta:id=>LINK_META.find(p=>p.id===id),inboxSyncStatus:()=>syncHTML,
    inventoryView:{available:()=>false},nativeSpacesAvailable:()=>false,modal:{open:false},window:{contextTheme:{}},kiView:{isBusy:()=>false,scopeChanged(){}},
    document:{addEventListener:(name,handler)=>listeners.set(name,handler),body:{classList:{remove(){},toggle(){}}}},
    refreshFeed:()=>effects.push('refresh'),connectionHelp:id=>effects.push('connection:'+id),toggleDesktopNotifications:()=>effects.push('desktop'),previewNotification:item=>effects.push('preview:'+item.id),editTask:id=>effects.push('task:'+id),diaryView:{open:(...args)=>effects.push(['diary',...args])},activity:()=>{},save:()=>true,toast:()=>{},
  };
  const run=code=>vm.runInContext(code,sandbox);vm.createContext(sandbox);
  run(part('const esc =','\nconst uid')+part('const icon =','\nconst dateLabel')+part('function heading(','\nfunction renderToday()')+part('function inboxItems()','\nfunction previewNotification(')+part('function projectOptions(','\nfunction toolOptions('));
  sandbox.render=()=>{sandbox.html=run('renderInbox()');};sandbox.commit=()=>sandbox.render();
  run(part("document.addEventListener('click',e=>{","\ndocument.addEventListener('input',")+part("document.addEventListener('change',async e=>{","\ndocument.addEventListener('submit',"));
  const control=(predicate)=>{
    const found=[...sandbox.html.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)].map(m=>({...attrs(m[2]),tag:m[1]})).find(predicate);
    if(!found)throw Error('Missing actual rendered Inbox control');
    const dataset=Object.fromEntries(Object.entries(found).filter(([key])=>key.startsWith('data-')).map(([key,value])=>[key.slice(5).replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase()),value]));
    const node={id:found.id||'',dataset,value:found.value||'',disabled:'disabled' in found,attrs:found,matches:selector=>selector==='[data-notification-course]'?Object.hasOwn(found,'data-notification-course'):false,hasAttribute:name=>Object.hasOwn(found,name)};
    node.closest=selector=>selector==='[data-action],[data-view],[data-open]'&&(dataset.action||dataset.view||dataset.open)?node:selector==='a[href]'&&found.tag==='a'?node:null;
    return node;
  };
  sandbox.render();
  return {sandbox,state,effects,run,get html(){return sandbox.html;},render:sandbox.render,row:item=>{sandbox.item=item;return run('notificationRow(item)');},compact:item=>{sandbox.item=item;return run('notificationRow(item,true)');},control,
    click(action,id){const node=control(n=>n['data-action']===action&&(id===undefined||n['data-id']===id||n['data-value']===id));if(node.disabled)throw Error('Cannot click disabled fixture button');listeners.get('click')({target:node,preventDefault(){}});},
    async change(id,value){const node=control(n=>n.id===id);node.value=value;await listeners.get('change')({target:node});},
    async assign(id,value){const node=control(n=>n['data-notification-course']===id);node.value=value;await listeners.get('change')({target:node});},
  };
}
