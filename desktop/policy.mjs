import {isIP} from 'node:net';
export const HUB='http://127.0.0.1:4318';
export function publicHost(host){host=host.toLowerCase().replace(/^\[|\]$/g,'');if(host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local')||host.endsWith('.internal')||!host.includes('.'))return false;
 if(isIP(host)===6)return false;
 if(isIP(host)===4){const [a,b]=host.split('.').map(Number);return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&b===168||a===100&&b>=64&&b<=127);}
 return /^[a-z0-9.-]+$/.test(host);
}
export function browserURL(value){if(typeof value!=='string'||value.length>4000||/[\x00-\x20]/.test(value))throw new Error('Bitte eine gültige HTTPS-Adresse eingeben.');const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.port&&u.port!=='443'||!publicHost(u.hostname))throw new Error('Der Browser öffnet öffentliche HTTPS-Seiten. Lokale Adressen und andere Protokolle sind gesperrt.');return u.href;}
export function requestURL(value){try{const u=new URL(value);if(['data:','blob:'].includes(u.protocol))return true;if(u.protocol==='wss:'){u.protocol='https:';return !!browserURL(u.href);}return !!browserURL(value);}catch{return false;}}
export function hubURL(value){try{return new URL(value).origin===HUB;}catch{return false;}}
export function displayURL(value){try{const u=new URL(browserURL(value));u.search='';u.hash='';return u.href;}catch{return '';}}
export function frameBounds(message,width,height){if(message?.visible!==true)return null;const r=message.rect,c=message.clip||{x:0,y:0,width,height};if(!r||![r.x,r.y,r.width,r.height,c.x,c.y,c.width,c.height].every(Number.isFinite))return null;const x=Math.ceil(Math.max(0,r.x,c.x)),y=Math.ceil(Math.max(0,r.y,c.y)),right=Math.floor(Math.min(width,r.x+r.width,c.x+c.width)),bottom=Math.floor(Math.min(height,r.y+r.height,c.y+c.height));return right>x&&bottom>y?{x,y,width:right-x,height:bottom-y}:null;}
