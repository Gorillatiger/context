const error=(code,message)=>Object.assign(new Error(message),{code});
function attrs(text){const result={};for(const match of text.matchAll(/\s([\w:-]+)\s*=\s*(["'])([\s\S]*?)\2/g))result[match[1].toLowerCase()]=match[3].replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'");return result;}
function assignedJSON(script,name){
 const match=new RegExp('(?:\\b(?:var|let|const)\\s+|\\bwindow\\.)'+name+'\\s*=\\s*').exec(script);if(!match)return null;
 let start=match.index+match[0].length,depth=0,string=false,escape=false;
 if(script[start]!=='{')return null;
 for(let index=start;index<Math.min(script.length,start+20000);index++){
  const char=script[index];if(string){if(escape)escape=false;else if(char==='\\')escape=true;else if(char==='"')string=false;continue;}
  if(char==='"')string=true;else if(char==='{')depth++;else if(char==='}'&&!--depth)return JSON.parse(script.slice(start,index+1));
 }
 return null;
}
// Private authentication context: never return this object through IPC, store it,
// include it in an Error, or log it. Both independent roots must agree.
export function authenticationContext(html,courseURL,{admin=false}={}){
 const links=[...html.matchAll(/<link\b[^>]*>/gi)].map(match=>attrs(match[0])).filter(link=>link.rel==='https://api.w.org/'||link.rel==='https://api.w.org');
 const scripts=[...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)].filter(match=>attrs('<script '+match[1]).id==='wp-api-request-js-extra');
 if((admin?links.length>1:links.length!==1)||scripts.length!==1)throw error('UNVERIFIED_SPACES_API','Die WordPress-Schnittstelle dieses Kurses wurde noch nicht sicher erkannt.');
 let settings;try{settings=assignedJSON(scripts[0][2],'wpApiSettings');}catch{}
 const expected=courseURL+'wp-json/';
 if((links.length&&links[0].href!==expected)||settings?.root!==expected)throw error('UNVERIFIED_SPACES_API','Die Spaces-Schnittstelle gehört nicht eindeutig zum gewählten Kurs.');
 if(typeof settings.nonce!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(settings.nonce))throw error('LOGIN_REQUIRED','Melde dich im Context-Browser bei Spaces an.');
 return {courseURL,apiRoot:expected,nonce:settings.nonce};
}
