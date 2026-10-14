const encoder=new TextEncoder();
export function safeArchiveName(name) {
  const normalized=String(name).replace(/\\/g,'/');
  if(!normalized||normalized.startsWith('/')||(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(normalized))||normalized.split('/').some(p=>!p||p==='.'||p==='..')||/^[a-z]:/i.test(normalized))throw new Error('Ungültiger Dateiname im Abgabepaket.');
  return normalized;
}
export function hasCredentialMaterial(name,text='') {
  return /(^|\/)(\.env(?:\..*)?|id_rsa|id_ed25519|credentials|\.git)(\/|$)/i.test(name)||/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:glpat-|ghp_|github_pat_)[a-zA-Z0-9_]{16,}/.test(text);
}
export function crc32(bytes) {
  let crc=0xffffffff;
  for(const byte of bytes){crc^=byte;for(let k=0;k<8;k++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
  return (crc^0xffffffff)>>>0;
}
export function createZIP(files) {
  if(!files.length||files.length>100)throw new Error('Bitte zwischen 1 und 100 Dateien wählen.');
  const parts=[],directory=[];const seen=new Set();let offset=0,total=0;
  for(const f of files){
    const name=safeArchiveName(f.name);if(seen.has(name))throw new Error('Doppelter Dateiname: '+name);seen.add(name);
    const bytes=typeof f.content==='string'?encoder.encode(f.content):f.content;
    if(!(bytes instanceof Uint8Array))throw new Error('Ungültige Dateidaten.');
    total+=bytes.length;if(total>20000000)throw new Error('Das Abgabepaket darf höchstens 20 MB groß sein.');
    if(hasCredentialMaterial(name,typeof f.content==='string'?f.content:new TextDecoder().decode(bytes)))throw new Error('Mögliche Zugangsdaten in '+name+'. Datei zuerst prüfen.');
    const n=encoder.encode(name);if(n.length>65535)throw new Error('Dateiname zu lang.');const crc=crc32(bytes);const local=new Uint8Array(30+n.length);const l=new DataView(local.buffer);
    l.setUint32(0,0x04034b50,true);l.setUint16(4,20,true);l.setUint16(6,0x800,true);l.setUint32(14,crc,true);l.setUint32(18,bytes.length,true);l.setUint32(22,bytes.length,true);l.setUint16(26,n.length,true);local.set(n,30);
    const central=new Uint8Array(46+n.length);const c=new DataView(central.buffer);
    c.setUint32(0,0x02014b50,true);c.setUint16(4,20,true);c.setUint16(6,20,true);c.setUint16(8,0x800,true);c.setUint32(16,crc,true);c.setUint32(20,bytes.length,true);c.setUint32(24,bytes.length,true);c.setUint16(28,n.length,true);c.setUint32(42,offset,true);central.set(n,46);
    parts.push(local,bytes);directory.push(central);offset+=local.length+bytes.length;
  }
  const directorySize=directory.reduce((n,d)=>n+d.length,0);const end=new Uint8Array(22);const e=new DataView(end.buffer);
  e.setUint32(0,0x06054b50,true);e.setUint16(8,files.length,true);e.setUint16(10,files.length,true);e.setUint32(12,directorySize,true);e.setUint32(16,offset,true);
  return new Blob([...parts,...directory,end],{type:'application/zip'});
}
export function githubRepositoryURL(value) {
  const url=new URL(value);
  if(url.protocol!=='https:'||url.hostname!=='github.com'||url.username||url.password||url.search||url.hash||!/^\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+\/?$/.test(url.pathname))throw new Error('Bitte einen GitHub-Repository-Link wie https://github.com/team/projekt eingeben.');
  return url.origin+url.pathname.replace(/\/$/,'');
}
