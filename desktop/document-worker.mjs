// Isolated, memory-only OOXML reader. No extraction, filesystem reads, network,
// shell, formula evaluation, macros or relationship traversal outside the ZIP.
import {inflateRawSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';

export const DOCUMENT_WORKER_LIMITS = Object.freeze({inputBytes:8*1024*1024,expandedBytes:32*1024*1024,entryBytes:2*1024*1024,entries:512,ratio:100,text:60000,xmlTokens:100000,xmlDepth:128,units:100,cells:50000});
const L=DOCUMENT_WORKER_LIMITS;
const types={docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'};
export class DocumentFailure extends Error {constructor(code){super(code);this.name='DocumentFailure';this.code=code;}}
const fail=code=>{throw new DocumentFailure(code);};
const crcTable=Uint32Array.from({length:256},(_,index)=>{let crc=index;for(let bit=0;bit<8;bit++)crc=crc&1?0xedb88320^(crc>>>1):crc>>>1;return crc>>>0;});
export function documentCRC32(bytes){let crc=0xffffffff;for(const byte of bytes)crc=crcTable[(crc^byte)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;}
const utf8=bytes=>{try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{fail('invalidXML');}};
function entryName(bytes){const name=utf8(bytes),parts=name.split('/');if(parts.at(-1)==='')parts.pop();if(!name||name.length>240||/[\\\x00-\x1f\x7f]/.test(name)||name.startsWith('/')||name.includes(':')||parts.some(part=>part==='..'||part==='.'||!part))fail('unsafeArchive');return name;}
function extras(bytes){let pos=0;while(pos<bytes.length){if(pos+4>bytes.length)fail('invalidArchive');const id=bytes.readUInt16LE(pos),length=bytes.readUInt16LE(pos+2);pos+=4;if(pos+length>bytes.length||id===1)fail('unsupportedArchive');pos+=length;}}
function unzip(bytes){
  if(!Buffer.isBuffer(bytes)||bytes.length<22||bytes.length>L.inputBytes)fail('inputLimit');
  if(bytes.readUInt32LE(0)!==0x04034b50)fail('invalidArchive');
  let eocd=-1;for(let pos=bytes.length-22;pos>=Math.max(0,bytes.length-65557);pos--)if(bytes.readUInt32LE(pos)===0x06054b50&&pos+22+bytes.readUInt16LE(pos+20)===bytes.length){eocd=pos;break;}
  if(eocd<0||bytes.readUInt16LE(eocd+4)||bytes.readUInt16LE(eocd+6))fail('unsupportedArchive');
  const count=bytes.readUInt16LE(eocd+10),size=bytes.readUInt32LE(eocd+12),start=bytes.readUInt32LE(eocd+16);
  if(!count||count>L.entries||count!==bytes.readUInt16LE(eocd+8)||start+size!==eocd)fail('archiveLimit');
  const entries=new Map(),ranges=[];let pos=start,total=0;
  for(let index=0;index<count;index++){
    if(pos+46>eocd||bytes.readUInt32LE(pos)!==0x02014b50)fail('invalidArchive');
    const needed=bytes.readUInt16LE(pos+6),flags=bytes.readUInt16LE(pos+8),method=bytes.readUInt16LE(pos+10),crc=bytes.readUInt32LE(pos+16),compressed=bytes.readUInt32LE(pos+20),expanded=bytes.readUInt32LE(pos+24),nameLength=bytes.readUInt16LE(pos+28),extraLength=bytes.readUInt16LE(pos+30),commentLength=bytes.readUInt16LE(pos+32),disk=bytes.readUInt16LE(pos+34),offset=bytes.readUInt32LE(pos+42);
    const end=pos+46+nameLength+extraLength+commentLength;
    if(end>eocd||needed>20||disk||flags&~0x080e||![0,8].includes(method)||[expanded,compressed,offset].includes(0xffffffff))fail('unsupportedArchive');
    if(expanded>L.entryBytes||(expanded>0&&(!compressed||expanded>Math.max(1,compressed)*L.ratio))||(total+=expanded)>L.expandedBytes)fail('archiveLimit');
    const name=entryName(bytes.subarray(pos+46,pos+46+nameLength));extras(bytes.subarray(pos+46+nameLength,pos+46+nameLength+extraLength));
    if(entries.has(name)||/(?:^|\/)(?:vbaProject\.bin|vbaData\.xml|macros?)(?:\/|$)/i.test(name)||/\.bin$/i.test(name)&&/vba/i.test(name))fail('unsafeArchive');
    if(offset+30>start||bytes.readUInt32LE(offset)!==0x04034b50||bytes.readUInt16LE(offset+6)!==flags||bytes.readUInt16LE(offset+8)!==method)fail('invalidArchive');
    const localName=bytes.readUInt16LE(offset+26),localExtra=bytes.readUInt16LE(offset+28),dataStart=offset+30+localName+localExtra,dataEnd=dataStart+compressed;
    if(dataEnd>start||localName!==nameLength||!bytes.subarray(offset+30,offset+30+localName).equals(bytes.subarray(pos+46,pos+46+nameLength)))fail('invalidArchive');
    extras(bytes.subarray(offset+30+localName,dataStart));
    if(!(flags&8)&&(bytes.readUInt32LE(offset+14)!==crc||bytes.readUInt32LE(offset+18)!==compressed||bytes.readUInt32LE(offset+22)!==expanded))fail('invalidArchive');
    let rangeEnd=dataEnd;
    if(flags&8){let descriptor=dataEnd;if(descriptor+4<=start&&bytes.readUInt32LE(descriptor)===0x08074b50)descriptor+=4;if(descriptor+12>start||bytes.readUInt32LE(descriptor)!==crc||bytes.readUInt32LE(descriptor+4)!==compressed||bytes.readUInt32LE(descriptor+8)!==expanded)fail('invalidArchive');rangeEnd=descriptor+12;}
    ranges.push([offset,rangeEnd]);
    let value;try{if(method===0)value=Buffer.from(bytes.subarray(dataStart,dataEnd));else{const inflated=inflateRawSync(bytes.subarray(dataStart,dataEnd),{maxOutputLength:L.entryBytes,info:true});if(inflated.engine.bytesWritten!==compressed)fail('invalidArchive');value=inflated.buffer;}}catch{fail('invalidArchive');}
    if(value.length!==expanded||documentCRC32(value)!==crc)fail('invalidArchive');
    entries.set(name,value);pos=end;
  }
  if(pos!==eocd)fail('invalidArchive');ranges.sort((a,b)=>a[0]-b[0]);if(ranges[0][0]!==0||ranges.some((range,index)=>index&&range[0]<ranges[index-1][1]))fail('invalidArchive');
  return entries;
}
function entityText(value){return value.replace(/&([^;\s<&]{1,32});/g,(_,entity)=>{if(Object.hasOwn({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"},entity))return {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"}[entity];let code;if(/^#\d{1,7}$/.test(entity))code=Number(entity.slice(1));else if(/^#x[0-9a-f]{1,6}$/i.test(entity))code=parseInt(entity.slice(2),16);else fail('unsafeXML');if(!Number.isSafeInteger(code)||code>0x10ffff||code>=0xd800&&code<=0xdfff||code<32&&![9,10,13].includes(code)||code===127)fail('unsafeXML');return String.fromCodePoint(code);});}
function decodeEntities(value){if(/&(?!(?:amp|lt|gt|quot|apos|#\d{1,7}|#x[\da-f]{1,6});)/i.test(value))fail('unsafeXML');return entityText(value);}
export function walkDocumentXML(bytes,handlers={}){
  const xml=utf8(bytes).replace(/^\uFEFF/,'');
  if(xml.length>L.entryBytes||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(xml)||/<!\s*(?:DOCTYPE|ENTITY)/i.test(xml))fail('unsafeXML');
  let pos=0,tokens=0,root=false,closed=false;const stack=[];
  const namePattern=/^[A-Za-z_][A-Za-z0-9_.:-]*/;
  while(pos<xml.length){
    if(++tokens>L.xmlTokens)fail('xmlLimit');
    if(xml[pos]!=='<'){const end=xml.indexOf('<',pos),raw=xml.slice(pos,end<0?xml.length:end);if(!stack.length&&raw.trim())fail('invalidXML');if(stack.length)handlers.text?.(decodeEntities(raw),stack);pos=end<0?xml.length:end;continue;}
    if(xml.startsWith('<!--',pos)){const end=xml.indexOf('-->',pos+4);if(end<0||xml.slice(pos+4,end).includes('--'))fail('invalidXML');pos=end+3;continue;}
    if(xml.startsWith('<![CDATA[',pos)){const end=xml.indexOf(']]>',pos+9);if(end<0||!stack.length)fail('invalidXML');handlers.text?.(xml.slice(pos+9,end),stack);pos=end+3;continue;}
    if(xml.startsWith('<?',pos)){const end=xml.indexOf('?>',pos+2);const declaration=xml.slice(pos,end+2);if(end<0||root||pos!==0||!/^<\?xml\s+[^<>]*\?>$/.test(declaration)||/encoding\s*=\s*['"](?!UTF-8['"])[^'"]+/i.test(declaration))fail('unsafeXML');pos=end+2;continue;}
    if(xml.startsWith('</',pos)){const match=namePattern.exec(xml.slice(pos+2));if(!match)fail('invalidXML');const end=pos+2+match[0].length,finish=/^\s*>/.exec(xml.slice(end));if(!finish||stack.pop()!==match[0])fail('invalidXML');handlers.close?.(match[0],stack);if(!stack.length)closed=true;pos=end+finish[0].length;continue;}
    if(xml.startsWith('<!',pos))fail('unsafeXML');
    const match=namePattern.exec(xml.slice(pos+1));if(!match||closed)fail('invalidXML');const name=match[0],attrs=Object.create(null);let cursor=pos+1+name.length,attributeCount=0,selfClosing=false;
    while(cursor<xml.length){const space=/^\s*/.exec(xml.slice(cursor))[0];cursor+=space.length;if(xml.startsWith('/>',cursor)){selfClosing=true;cursor+=2;break;}if(xml[cursor]==='>'){cursor++;break;}if(!space||++attributeCount>128)fail('xmlLimit');const attribute=namePattern.exec(xml.slice(cursor));if(!attribute||Object.hasOwn(attrs,attribute[0]))fail('invalidXML');cursor+=attribute[0].length;const equal=/^\s*=\s*(['"])/.exec(xml.slice(cursor));if(!equal)fail('invalidXML');cursor+=equal[0].length;const end=xml.indexOf(equal[1],cursor);if(end<0||end-cursor>16384||xml.slice(cursor,end).includes('<'))fail('xmlLimit');attrs[attribute[0]]=decodeEntities(xml.slice(cursor,end));cursor=end+1;}
    if(cursor>xml.length||xml[cursor-1]!=='>')fail('invalidXML');
    if(!root)root=true;if(stack.length>=L.xmlDepth)fail('xmlLimit');stack.push(name);handlers.open?.(name,attrs,stack);if(selfClosing){stack.pop();handlers.close?.(name,stack);if(!stack.length)closed=true;}pos=cursor;
  }
  if(!root||stack.length||!closed)fail('invalidXML');
}
const local=name=>name.split(':').at(-1);
function rootNamespace(bytes,expectedName,namespaces){walkDocumentXML(bytes,{open(name,attrs,stack){if(stack.length!==1)return;const prefix=name.includes(':')?name.split(':')[0]:'';if(local(name)!==expectedName||!namespaces.includes(attrs[prefix?'xmlns:'+prefix:'xmlns']))fail('invalidOffice');}});}
function sink(){let text='',truncated=false;return {add(value){const cleaned=String(value).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,'');const remaining=L.text-text.length;if(cleaned.length>remaining)truncated=true;if(remaining>0)text+=cleaned.slice(0,remaining);},get text(){return text.replace(/[ \t]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim();},get truncated(){return truncated;}};}
function packageRelationships(bytes){rootNamespace(bytes,'Relationships',['http://schemas.openxmlformats.org/package/2006/relationships']);const rels=new Map(),seen=new Set();let external=false;walkDocumentXML(bytes,{open(name,attrs){if(local(name)!=='Relationship')return;if(!attrs.Id||seen.has(attrs.Id)||!attrs.Target||attrs.Target.length>1024)fail('invalidXML');seen.add(attrs.Id);if(attrs.TargetMode==='External'){external=true;return;}if(attrs.TargetMode&&attrs.TargetMode!=='Internal')fail('unsafeXML');if(/^[a-z][a-z0-9+.-]*:|[\\\x00-\x1f]/i.test(attrs.Target))fail('unsafeXML');rels.set(attrs.Id,attrs.Target);}});return {rels,external};}
function resolvePart(base,target){const parts=base.split('/').slice(0,-1);if(target.startsWith('/'))parts.length=0;for(const part of target.split('/')){if(!part||part==='.')continue;if(part==='..'){if(!parts.length)fail('unsafeArchive');parts.pop();}else parts.push(part);}return parts.join('/');}
function wordText(bytes,out){walkDocumentXML(bytes,{open(name){if(['tab','br','cr'].includes(local(name)))out.add(local(name)==='tab'?'\t':'\n');},text(value,stack){if(local(stack.at(-1))==='t'&&!stack.some(name=>local(name)==='del'))out.add(value);},close(name){if(['p','tr'].includes(local(name)))out.add('\n');else if(local(name)==='tc')out.add('\t');}});}
function slideText(bytes,out){walkDocumentXML(bytes,{text(value,stack){if(local(stack.at(-1))==='t')out.add(value);},close(name){if(local(name)==='p')out.add('\n');}});}
export function parseOfficeDocument(bytes,format){
  if(!Object.hasOwn(types,format))fail('unsupportedType');const entries=unzip(bytes),out=sink(),warnings=['Nur vorhandener Dokumenttext: Bilder, Diagramme und Layout werden nicht interpretiert.'];let external=false;
  // Validate every XML part, not just the text parts. ZIP size/CRC was already
  // checked for every entry, including media or unselected relationships.
  for(const [name,value] of entries)if(/\.(?:xml|rels)$/i.test(name)){if(/\.rels$/i.test(name))external=packageRelationships(value).external||external;else walkDocumentXML(value);}
  const mainPart={docx:'word/document.xml',pptx:'ppt/presentation.xml',xlsx:'xl/workbook.xml'}[format],rootName={docx:'document',pptx:'presentation',xlsx:'workbook'}[format];
  if(!entries.has('[Content_Types].xml')||!entries.has(mainPart))fail('invalidOffice');rootNamespace(entries.get('[Content_Types].xml'),'Types',['http://schemas.openxmlformats.org/package/2006/content-types']);let mainType=false;const overrides=new Set();walkDocumentXML(entries.get('[Content_Types].xml'),{open(name,attrs){if(/macroEnabled|vbaProject/i.test(attrs.ContentType||''))fail('unsafeArchive');if(local(name)==='Override'){if(overrides.has(attrs.PartName))fail('invalidOffice');overrides.add(attrs.PartName);if(attrs.PartName==='/'+mainPart&&attrs.ContentType===types[format])mainType=true;}}});if(!mainType)fail('invalidOffice');
  const family={docx:'wordprocessingml',pptx:'presentationml',xlsx:'spreadsheetml'}[format];rootNamespace(entries.get(mainPart),rootName,[`http://schemas.openxmlformats.org/${family}/2006/main`,`http://purl.oclc.org/ooxml/${family}/main`]);
  if(external)warnings.push('Externe Verknüpfungen wurden ignoriert; keine externen Inhalte wurden geladen.');
  let unitsTotal=0,unitsRead=0;
  if(format==='docx'){
    if(!entries.has('word/document.xml'))fail('invalidOffice');const names=['word/document.xml',...[...entries.keys()].filter(name=>/^word\/(?:header\d+|footer\d+|footnotes|endnotes)\.xml$/.test(name)).sort()];unitsTotal=names.length;
    for(const name of names.slice(0,L.units)){if(out.truncated)break;wordText(entries.get(name),out);out.add('\n');unitsRead++;}
  }else if(format==='pptx'){
    const main=entries.get('ppt/presentation.xml'),rels=entries.get('ppt/_rels/presentation.xml.rels');if(!main||!rels)fail('invalidOffice');const relationships=packageRelationships(rels).rels,names=[];
    walkDocumentXML(main,{open(name,attrs){if(local(name)==='sldId'){const target=relationships.get(attrs['r:id']);if(!target)fail('invalidOffice');const path=resolvePart('ppt/presentation.xml',target);if(!/^ppt\/slides\/slide\d+\.xml$/.test(path)||!entries.has(path)||names.includes(path))fail('invalidOffice');names.push(path);}}});unitsTotal=names.length;
    for(const name of names.slice(0,L.units)){if(out.truncated)break;out.add(`\nFolie ${unitsRead+1}\n`);slideText(entries.get(name),out);unitsRead++;}
    if([...entries.keys()].some(name=>/^ppt\/notesSlides\//.test(name)))warnings.push('Sprechernotizen wurden nicht gelesen.');
  }else{
    const main=entries.get('xl/workbook.xml'),rels=entries.get('xl/_rels/workbook.xml.rels');if(!main||!rels)fail('invalidOffice');const relationships=packageRelationships(rels).rels,sheets=[],strings=[];let string='',inShared=false;
    if(entries.has('xl/sharedStrings.xml'))walkDocumentXML(entries.get('xl/sharedStrings.xml'),{open(name){if(local(name)==='si'){string='';inShared=true;}},text(value,stack){if(inShared&&local(stack.at(-1))==='t'&&!stack.some(name=>local(name)==='rPh')){string+=value;if(string.length>20000)fail('xmlLimit');}},close(name){if(local(name)==='si'){if(strings.length>=L.cells)fail('xmlLimit');strings.push(string);inShared=false;}}});
    walkDocumentXML(main,{open(name,attrs){if(local(name)==='sheet'){const target=relationships.get(attrs['r:id']);if(!target)fail('invalidOffice');const path=resolvePart('xl/workbook.xml',target);if(!/^xl\/worksheets\/sheet\d+\.xml$/.test(path)||!entries.has(path)||sheets.some(sheet=>sheet.path===path))fail('invalidOffice');sheets.push({name:attrs.name||`Tabelle ${sheets.length+1}`,path});}}});unitsTotal=sheets.length;let cells=0,formula=false;
    for(const sheet of sheets.slice(0,L.units)){if(out.truncated)break;out.add(`\n${sheet.name}\n`);let cellType='',value='',insideCell=false;
      walkDocumentXML(entries.get(sheet.path),{open(name,attrs){if(local(name)==='c'){if(++cells>L.cells)fail('xmlLimit');cellType=attrs.t||'';value='';insideCell=true;}if(local(name)==='f')formula=true;},text(text,stack){if(insideCell&&['v','t'].includes(local(stack.at(-1)))){value+=text;if(value.length>20000)fail('xmlLimit');}},close(name){if(local(name)==='c'){if(cellType==='s'){if(!/^\d{1,6}$/.test(value)||Number(value)>=strings.length)fail('invalidOffice');value=strings[Number(value)];}out.add(value+'\t');insideCell=false;}else if(local(name)==='row')out.add('\n');}});unitsRead++;
    }
    warnings.push('Zellwerte werden ohne Zahlen-/Datumsformatierung gelesen.');if(formula)warnings.push('Formeln wurden nicht ausgeführt; nur vorhandene gespeicherte Ergebnisse wurden gelesen.');
  }
  if(!unitsTotal)fail('invalidOffice');if(out.truncated||unitsRead<unitsTotal)warnings.unshift('Das Dokument wurde durch die Text-/Abschnittsgrenze nur teilweise gelesen.');
  return {status:out.text?'ok':'empty',text:out.text,coverage:'partial',warnings,metadata:{format,engine:'OOXML local',unitsRead,unitsTotal,ocrUnits:0,truncated:out.truncated||unitsRead<unitsTotal}};
}
async function main(){let chunks=[],size=0;try{if(process.argv.length!==3||!Object.hasOwn(types,process.argv[2]))fail('unsupportedType');for await(const chunk of process.stdin){size+=chunk.length;if(size>L.inputBytes)fail('inputLimit');chunks.push(chunk);}const bytes=Buffer.concat(chunks);chunks.forEach(chunk=>chunk.fill(0));chunks=[];let value;try{value=parseOfficeDocument(bytes,process.argv[2]);}finally{bytes.fill(0);}process.stdout.write(JSON.stringify({ok:true,value}));}catch(error){chunks.forEach(chunk=>chunk.fill(0));process.stdout.write(JSON.stringify({ok:false,code:error instanceof DocumentFailure?error.code:'readFailed'}));process.exitCode=1;}}
if(process.argv[1]===fileURLToPath(import.meta.url))await main();
