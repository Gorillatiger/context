import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState,validateState,searchState } from '../dist/core.js';
import { planImport,parseBookmarksHTML,parseProjectList,applyImport } from '../dist/importers.js';
import { renderMarkdown } from '../dist/markdown.js';
import { createZIP,crc32,safeArchiveName,hasCredentialMaterial,githubRepositoryURL } from '../dist/zip.js';
const file=(name,text)=>({name,size:Buffer.byteLength(text),text:async()=>text});
test('Markdown imports preserve whitespace, support search and round-trip in backups',async()=>{
  const content='# Meine Idee\n\n  eingerückt\n\n';const current=initialState();const plan=await planImport('obsidian',[file('Idee.md',content)],current);
  assert.equal(current.notes.length,0);assert.equal(plan.notes[0].title,'Idee');const next=validateState(applyImport(current,plan));assert.equal(next.notes[0].content,content);assert.equal(searchState(next,'eingerückt')[0].type,'note');
});
test('Obsidian imports preserve filename-based wiki links when headings have different names',async()=>{
  const plan=await planImport('obsidian',[file('Erste.md','# Andere Überschrift\n\n[[Zweite|Weiter]]'),file('Zweite.md','# Noch eine Überschrift\n\n[[Erste]]')],initialState());
  const next=validateState(applyImport(initialState(),plan));
  assert.ok(renderMarkdown(next.notes[0].content,next.notes).includes('data-id="'+next.notes[1].id+'"'));
  assert.ok(renderMarkdown(next.notes[1].content,next.notes).includes('data-id="'+next.notes[0].id+'"'));
  assert.ok(renderMarkdown(next.notes[0].content,next.notes).includes('>Weiter</button>'));
  assert.equal(next.notes[0].content,'# Andere Überschrift\n\n[[Zweite|Weiter]]');
});
test('bookmark import excludes executable/local URLs, deduplicates and uses generic source for GitHub',async()=>{
  const html='<A HREF="javascript:alert(1)">bad</A><A HREF="file:///private">local</A><A HREF="https://github.com/team/repo">Repo</A><A HREF="https://github.com/team/repo">Repo</A>';
  const list=parseBookmarksHTML(html);assert.equal(list.length,2);assert.equal(list[0].tool,'web');const plan=await planImport('bookmarks',[file('Bookmarks.html',html)],initialState());assert.equal(plan.bookmarks.length,1);assert.equal(plan.skipped,1);
});
test('plugin import is bounded and transactional; unknown executables and invalid backups are rejected',async()=>{
  const current=initialState();await assert.rejects(()=>planImport('remote-script',[],current));await assert.rejects(()=>planImport('obsidian',[file('ok.md','# ok'),file('bad.md','x'.repeat(50001))],current));assert.equal(current.notes.length,0);
  await assert.rejects(()=>planImport('context',[file('backup.json','{}')],current));await assert.rejects(()=>planImport('bookmarks',[{name:'big.html',size:5000000}],current));
});
test('project imports preserve repository destinations and skip existing repositories',async()=>{
  const data=[{name:'repo',full_name:'team/repo',html_url:'https://github.com/team/repo'}];const plan=await planImport('projects',[file('repos.json',JSON.stringify(data))],initialState());assert.equal(plan.projects[0].links[0].tool,'web');assert.equal(plan.projects[0].links[0].url,data[0].html_url);const repeat=await planImport('projects',[file('repos.json',JSON.stringify(data))],applyImport(initialState(),plan));assert.equal(repeat.projects.length,0);assert.equal(repeat.skipped,1);assert.throws(()=>parseProjectList([{name:'bad',html_url:'https://evil.example/p'}]));
});
test('Markdown renderer escapes raw HTML, blocks unsafe links and renders only known wiki IDs',()=>{
  const notes=[{id:'note-1',title:'Andere'}];const html=renderMarkdown('# Hallo\n<img src=x onerror=alert(1)>\n[bad](javascript:alert(1))\n[[Andere]]\n[[Unbekannt]]\n```\n<script>evil</script>\n```',notes);
  assert.ok(!html.includes('<img'));assert.ok(!html.includes('<script>'));assert.ok(!html.includes('href="javascript:'));assert.ok(html.includes('data-id="note-1"'));assert.ok(html.includes('wiki-missing'));assert.ok(html.includes('<h1>Hallo</h1>'));assert.ok(html.includes('&lt;script&gt;'));
});
test('ZIP rejects path traversal, duplicate names, secrets in bytes and oversized payloads',()=>{
  for(const name of ['../secret','/secret','C:\\secret','a/../b','a//b'])assert.throws(()=>safeArchiveName(name));
  assert.throws(()=>createZIP([{name:'a.txt',content:'x'},{name:'a.txt',content:'y'}]));assert.throws(()=>createZIP([{name:'.env',content:'x'}]));assert.throws(()=>createZIP([{name:'src.txt',content:new TextEncoder().encode('glpat-'+'a'.repeat(30))}]));assert.ok(hasCredentialMaterial('key.txt','-----BEGIN PRIVATE KEY-----'));
  assert.throws(()=>createZIP([{name:'x',content:new Uint8Array(20000001)}]));
});
test('ZIP output contains valid records and standard CRC-32; GitHub targets are restricted',async()=>{
  const blob=createZIP([{name:'grüße.md',content:'# Hallo\n'}]);const bytes=new Uint8Array(await blob.arrayBuffer());const v=new DataView(bytes.buffer);assert.equal(v.getUint32(0,true),0x04034b50);assert.equal(v.getUint16(6,true),0x800);assert.equal(v.getUint32(bytes.length-22,true),0x06054b50);assert.equal(crc32(new TextEncoder().encode('123456789')),0xcbf43926);
  assert.equal(githubRepositoryURL('https://github.com/team/repo/'),'https://github.com/team/repo');for(const url of ['https://evil.example/team/repo','https://github.com/team/repo?token=x','https://u:p@github.com/team/repo','https://github.com/team/repo/pulls'])assert.throws(()=>githubRepositoryURL(url));
});
