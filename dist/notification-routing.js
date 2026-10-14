// Deterministic provenance only. No titles, message bodies, network or account
// state participate in course routing; opaque provider IDs need an explicit
// persisted group mapping before they can become evidence.
const origins={spaces:'https://spaces.th-koeln.de',mattermost:'https://chat.coco.study',gitlab:'https://git.coco.study'};
const mailSources=new Set(['webmail','mail','gmail','outlook']);
const privateSegments=new Set(['user','users','auth','authentication','login','logout','signin','signout','oauth','oauth2','password','account','accounts','profile','settings','mail','webmail','messages','direct','dashboard']);
const result=(projectId='',reason='unassigned',manual=false,ambiguous=false)=>({projectId,reason,manual,ambiguous});

function routingURL(value){
 if(typeof value!=='string'||!value||value.length>2000||/[\s\x00-\x1f\x7f\\]/.test(value))return null;
 let url;try{url=new URL(value);}catch{return null;}
 if(url.protocol!=='https:'||url.username||url.password||url.port)return null;
 // Inspect before URL normalization, which would erase literal ../ segments.
 let path=value.replace(/^https:\/\/[^/?#]+/i,'').split(/[?#]/)[0]||'/';
 for(let round=0;round<8;round++){
  if(/[\\\x00-\x1f\x7f]/.test(path)||path.split('/').some(segment=>segment==='.'||segment==='..')||/%(?:2f|5c|00)/i.test(path))return null;
  if(!/%[a-f0-9]{2}/i.test(path))break;
  try{const next=decodeURIComponent(path);if(next===path)break;path=next;}catch{return null;}
  if(round===7&&/%[a-f0-9]{2}/i.test(path))return null;
 }
 if(path.split('/').some(segment=>privateSegments.has(segment.toLowerCase().replace(/\.php$/i,''))))return null;
 for(const [key,value] of url.searchParams){
  if(/token|secret|password|passwort|authorization|signature|^(?:api[_ -]?key|code)$/i.test(key))return null;
  if(/^(?:redirect(?:_uri)?|return_?url|url|next|continue)$/i.test(key))return null;
  if(/^(?:action|do|task|_task)$/i.test(key)&&/^(?:login|logout|delete|remove|send|mail|auth)$/i.test(value))return null;
 }
 const normalized=path.replace(/\/+$/,'')||'/';
 return {url,path:normalized};
}
function queryMatches(base,target){
 for(const key of new Set(base.searchParams.keys())){
  const expected=base.searchParams.getAll(key).sort(),actual=target.searchParams.getAll(key).sort();
  if(expected.length!==actual.length||expected.some((value,index)=>value!==actual[index]))return false;
 }
 return true;
}
function matchingProjects(target,projects,source){
 const matches=[];
 for(const project of projects)for(const link of Array.isArray(project.links)?project.links:[]){
  const base=routingURL(link?.url);if(!base||base.url.origin!==target.url.origin||base.path==='/')continue;
  // A Mattermost team or its channel directory does not identify one course.
  if(source==='mattermost'&&base.path.split('/').filter(Boolean).length<3)continue;
  if((target.path===base.path||target.path.startsWith(base.path+'/'))&&queryMatches(base.url,target.url))matches.push({project,length:base.path.length});
 }
 const longest=Math.max(0,...matches.map(match=>match.length));
 return [...new Map(matches.filter(match=>match.length===longest).map(match=>[match.project.id,match.project])).values()];
}

export function resolveNotificationCourse(item,state){
 if(!item||typeof item!=='object'||!state||typeof state!=='object')return result();
 const projects=(Array.isArray(state.projects)?state.projects:[]).filter(project=>project&&typeof project.id==='string');
 const find=id=>typeof id==='string'?projects.find(project=>project.id===id):undefined;
 const mappings=state.notificationCourses||{};
 if(typeof item.id==='string'&&Object.hasOwn(mappings,item.id)){
  const selected=mappings[item.id];if(selected==='')return result('','manual-unassigned',true);
  const project=find(selected);return project&&!project.archived?result(project.id,'manual',true):result('','manual-unavailable',true);
 }
 const explicit=find(item.projectId),course=find(item.courseId);
 if(explicit&&course&&explicit.id!==course.id)return result('',explicit.archived||course.archived?'archived':'ambiguous',false,true);
 if(explicit||course){const project=explicit||course;return project.archived?result('','archived'):result(project.id,explicit?'explicit-project':'explicit-course');}
 if(mailSources.has(item.source))return result();
 if(item.source&&item.source!=='context'&&!Object.hasOwn(origins,item.source))return result('','unsupported-source');
 if(item.source==='context')return result();
 const original=item.url?routingURL(item.url):null;
 if(item.url&&!original)return result('','unsafe-url');
 const group=item.groupUrl?routingURL(item.groupUrl):null;
 if(item.groupUrl&&!group)return result('','unsafe-group-url');
 const target=original||group;if(!target)return result();
 const source=item.source||Object.keys(origins).find(source=>origins[source]===target.url.origin);
 if(!source||origins[source]!==target.url.origin)return result('','unsafe-url');
 if(group&&(group.url.origin!==target.url.origin||group.url.origin!==origins[source]))return result('','unsafe-group-url');
 const direct=original?matchingProjects(original,projects,source):[],groupMatches=group?matchingProjects(group,projects,source):[];
 const candidates=[...new Map([...groupMatches,...direct].map(project=>[project.id,project])).values()];
 if(candidates.some(project=>project.archived))return result('','archived',false,candidates.length>1);
 if(candidates.length>1)return result('','ambiguous',false,true);
 return candidates.length?result(candidates[0].id,groupMatches.length?'group-url':'url-prefix'):result();
}
