import {deflateRawSync} from 'node:zlib';

export const documentMIMEs=Object.freeze({pdf:'application/pdf',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
const crcTable=Array.from({length:256},(_,n)=>{for(let bit=0;bit<8;bit++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
export function fixtureCRC(bytes){let crc=0xffffffff;for(const byte of bytes)crc=crcTable[(crc^byte)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;}

/** Deliberately independent tiny ZIP writer; all fixtures remain in memory. */
export function documentZip(entries,{comment='',disk=0}={}){
  const locals=[],central=[];let offset=0;
  for(const input of entries){
    const name=Buffer.from(input.name,'utf8'),localName=Buffer.from(input.localName??input.name,'utf8'),data=Buffer.from(input.data??'','utf8'),method=input.method??0,compressed=input.compressed??(method===8?deflateRawSync(data):data),crc=input.crc??fixtureCRC(data),flags=input.flags??0;
    const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(flags,6);local.writeUInt16LE(input.localMethod??method,8);local.writeUInt32LE(input.localCRC??crc,14);local.writeUInt32LE(compressed.length,18);local.writeUInt32LE(input.localSize??input.size??data.length,22);local.writeUInt16LE(localName.length,26);
    locals.push(local,localName,compressed);
    const record=Buffer.alloc(46);record.writeUInt32LE(0x02014b50);record.writeUInt16LE(20,4);record.writeUInt16LE(20,6);record.writeUInt16LE(flags,8);record.writeUInt16LE(method,10);record.writeUInt32LE(crc,16);record.writeUInt32LE(input.compressedSize??compressed.length,20);record.writeUInt32LE(input.size??data.length,24);record.writeUInt16LE(name.length,28);record.writeUInt16LE(input.disk??0,34);record.writeUInt32LE(input.externalAttributes??0,38);record.writeUInt32LE(offset,42);
    central.push(record,name);offset+=local.length+localName.length+compressed.length;
  }
  const directory=Buffer.concat(central),ending=Buffer.alloc(22),tail=Buffer.from(comment);ending.writeUInt32LE(0x06054b50);ending.writeUInt16LE(disk,4);ending.writeUInt16LE(disk,6);ending.writeUInt16LE(entries.length,8);ending.writeUInt16LE(entries.length,10);ending.writeUInt32LE(directory.length,12);ending.writeUInt32LE(offset,16);ending.writeUInt16LE(tail.length,20);
  return Buffer.concat([...locals,directory,ending,tail]);
}

const rootType={docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'};
export const documentRoots=Object.freeze({docx:'word/document.xml',pptx:'ppt/presentation.xml',xlsx:'xl/workbook.xml'});
export function typeXML(format){return `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/${documentRoots[format]}" ContentType="${rootType[format]}"/></Types>`;}
export function wordXML(text='Prüfe die Benutzeroberfläche.'){return `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`;}
export function officeEntries(format,{text='Prüfe die Benutzeroberfläche.',xml}={}){
  const basic=[{name:'[Content_Types].xml',data:typeXML(format)}];
  if(format==='docx')return [...basic,{name:'word/document.xml',data:xml??wordXML(text)}];
  if(format==='pptx')return [...basic,{name:'ppt/presentation.xml',data:'<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>'},{name:'ppt/_rels/presentation.xml.rels',data:'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>'},{name:'ppt/slides/slide1.xml',data:xml??`<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`}];
  if(format==='xlsx')return [...basic,{name:'xl/workbook.xml',data:'<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Woche 1" sheetId="1" r:id="rId1"/></sheets></workbook>'},{name:'xl/_rels/workbook.xml.rels',data:'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'},{name:'xl/worksheets/sheet1.xml',data:xml??`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${text}</t></is></c><c r="B1"><v>42</v></c></row></sheetData></worksheet>`}];
  throw new Error('Unknown synthetic document type.');
}
export const officeFixture=(format,options={})=>documentZip(officeEntries(format,options));
