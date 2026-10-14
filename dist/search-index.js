// Local retrieval only. Callers provide bounded, already redacted documents.
// This module reads no workspace, account, storage, browser or network state.
export const SEARCH_LIMITS=Object.freeze({documents:20000,characters:40000000,text:70000,title:300,terms:250000,bytes:268435456,query:500,queryTerms:24,results:50,excerpt:3000,expansions:24,fuzzyScans:1200});
const routes=new Set(['project','task','note','diary','calendar','board','link','tool','update','source','chat','mail']);
const stops=new Set('der die das den dem des ein eine einen einer eines und oder ist sind was wie zu im in mit von fur bitte mir mein meine projekt kurs kannst mache machen ich du es auf aus am als zum zur um uber auch an bei nach vor'.split(' '));
const words=/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu;
export const normalizeSearch=value=>String(value??'').normalize('NFKD').replace(/\p{M}/gu,'').replace(/[ßẞ]/g,'ss').toLocaleLowerCase('de');
const clock=()=>globalThis.performance?.now?.()??Date.now();
const snapshotReaders=new WeakMap();
// Worker persistence receives only the documents actually accepted by this
// index, never the caller's discarded fields or omitted input documents.
export const searchIndexDocuments=index=>snapshotReaders.get(index)?.()||[];
const abort=()=>new DOMException('Suche abgebrochen.','AbortError');
const clamp=(value,min,max,fallback)=>Number.isFinite(value)?Math.max(min,Math.min(max,Math.floor(value))):fallback;
const cleanString=(value,max)=>typeof value==='string'?value.slice(0,max):'';
const originalSlice=(value,max)=>value.slice(0,max>0&&max<value.length&&/[\uDC00-\uDFFF]/.test(value[max])?max-1:max);
const fields={projectId:160,source:160,url:2000,targetId:200,kind:80,status:80,type:80,updatedAt:80,due:80,taskStatus:80};

export function cleanSearchDocument(value,textLimit=SEARCH_LIMITS.text){
  if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.id!=='string'||!value.id||value.id.length>200||/[\x00-\x1f\x7f]/.test(value.id)||typeof value.kind!=='string'||!value.kind||value.kind.length>80||typeof value.title!=='string'||typeof value.text!=='string')return null;
  const document={id:value.id,kind:value.kind,title:originalSlice(value.title,SEARCH_LIMITS.title),text:originalSlice(value.text,textLimit)};
  for(const [key,max] of Object.entries(fields))if(typeof value[key]==='string')document[key]=cleanString(value[key],max);
  if(value.route&&routes.has(value.route.type)&&typeof value.route.id==='string'&&value.route.id&&value.route.id.length<=200&&!/[\x00-\x1f\x7f]/.test(value.route.id))document.route={type:value.route.type,id:value.route.id};
  if(Number.isSafeInteger(value.offset)&&value.offset>=0)document.offset=value.offset;
  return document;
}

function tokenize(value){
  const result=[];words.lastIndex=0;
  for(const match of value.matchAll(words)){const term=normalizeSearch(match[0]);if(term.length&&term.length<=80)result.push({term,start:match.index,end:match.index+match[0].length});}
  return result;
}
function sameDocument(a,b){const keys=Object.keys(a);return keys.length===Object.keys(b).length&&keys.every(key=>key==='route'?a.route.type===b.route?.type&&a.route.id===b.route?.id:a[key]===b[key]);}
const phraseText=tokens=>' '+tokens.map(token=>token.term).join(' ')+' ';
function distance(a,b,max){
  if(Math.abs(a.length-b.length)>max)return max+1;
  let before,previous=Array.from({length:b.length+1},(_,i)=>i);
  for(let i=1;i<=a.length;i++){
    const row=[i];let minimum=i;
    for(let j=1;j<=b.length;j++){
      let value=Math.min(row[j-1]+1,previous[j]+1,previous[j-1]+(a[i-1]===b[j-1]?0:1));
      if(before&&i>1&&j>1&&a[i-1]===b[j-2]&&a[i-2]===b[j-1])value=Math.min(value,before[j-2]+1);
      row.push(value);minimum=Math.min(minimum,value);
    }
    if(minimum>max)return max+1;before=previous;previous=row;
  }
  return previous[b.length];
}
const lowerBound=(array,value)=>{let lo=0,hi=array.length;while(lo<hi){const mid=(lo+hi)>>>1;if(array[mid]<value)lo=mid+1;else hi=mid;}return lo;};

export function createSearchIndex(){
  const records=new Map(),inverted=new Map(),projects=new Map(),kinds=new Map(),sources=new Map();
  let characters=0,postings=0,estimatedBytes=0,revision=0,omitted=0,truncated=0,vocabulary=null,lengths=null;
  let lastDiff={added:0,updated:0,removed:0,unchanged:0},lastSearch={mode:'empty',candidates:0,totalMatches:0,offset:0,returned:0,omittedCandidates:0,expansionTruncated:false,queryTruncated:false};
  const categoryAdd=(map,key,id)=>{if(!map.has(key))map.set(key,new Set());map.get(key).add(id);};
  const categoryRemove=(map,key,id)=>{const set=map.get(key);set?.delete(id);if(set&&!set.size)map.delete(key);};
  const statistics=()=>({documents:records.size,indexedCharacters:characters,terms:inverted.size,postings,estimatedBytes,omitted,truncated,revision,lastDiff:{...lastDiff},lastSearch:{...lastSearch}});
  function remove(id){
    const record=records.get(id);if(!record)return;
    for(const term of record.tokens.keys()){const posting=inverted.get(term);posting.delete(id);postings--;if(!posting.size)inverted.delete(term);}
    categoryRemove(projects,record.doc.projectId||'',id);categoryRemove(kinds,record.doc.kind,id);categoryRemove(sources,record.doc.source||'',id);
    characters-=record.doc.text.length;estimatedBytes-=record.bytes;records.delete(id);vocabulary=lengths=null;
  }
  function prepare(doc,originalLength,indexTruncated,order){
    const titleTokens=tokenize(doc.title),bodyTokens=tokenize(doc.text),tokens=new Map();
    for(const [which,items] of [['t',titleTokens],['b',bodyTokens]])for(const token of items){
      if(token.term.length<2)continue;
      if(!tokens.has(token.term))tokens.set(token.term,{t:0,b:0});tokens.get(token.term)[which]++;
    }
    const bodyPhrase=phraseText(bodyTokens),titlePhrase=phraseText(titleTokens);
    const metadata=Object.values(doc).reduce((sum,value)=>sum+(typeof value==='string'?value.length:0),0)+(doc.route?doc.route.type.length+doc.route.id.length:0);
    const bytes=(metadata+bodyPhrase.length+titlePhrase.length)*2+tokens.size*104+512;
    return {doc,tokens,length:Math.max(1,bodyTokens.length),bodyPhrase,titlePhrase,bytes,originalLength,indexTruncated,order};
  }
  function add(record){
    const id=record.doc.id;
    for(const [term,frequency] of record.tokens){if(!inverted.has(term))inverted.set(term,new Map());inverted.get(term).set(id,frequency);postings++;}
    records.set(id,record);characters+=record.doc.text.length;estimatedBytes+=record.bytes;
    categoryAdd(projects,record.doc.projectId||'',id);categoryAdd(kinds,record.doc.kind,id);categoryAdd(sources,record.doc.source||'',id);vocabulary=lengths=null;
  }
  function replace(documents){
    if(!Array.isArray(documents))throw new TypeError('Der Suchindex benötigt eine Dokumentliste.');
    const next=new Map();let used=0,invalid=0,cut=0,order=0;
    for(let position=0;position<Math.min(documents.length,SEARCH_LIMITS.documents*2);position++){
      const value=documents[position];
      if(next.size>=SEARCH_LIMITS.documents){invalid++;continue;}
      const doc=cleanSearchDocument(value,Math.min(SEARCH_LIMITS.text,Math.max(0,SEARCH_LIMITS.characters-used)));
      if(!doc||next.has(doc.id)){invalid++;continue;}
      const originalLength=Number.isSafeInteger(value.originalLength)&&value.originalLength>=value.text.length&&value.originalLength<=100000000?value.originalLength:value.text.length,indexTruncated=value.indexTruncated===true||doc.text.length<originalLength||doc.title.length<value.title.length;
      next.set(doc.id,{doc,originalLength,indexTruncated,order:order++});used+=doc.text.length;
    }
    invalid+=Math.max(0,documents.length-SEARCH_LIMITS.documents*2);
    const diff={added:0,updated:0,removed:0,unchanged:0};
    for(const id of records.keys())if(!next.has(id)){remove(id);diff.removed++;}
    for(const [id,value] of next){
      const previous=records.get(id);
      if(previous&&previous.originalLength===value.originalLength&&previous.indexTruncated===value.indexTruncated&&sameDocument(previous.doc,value.doc)){previous.order=value.order;diff.unchanged++;if(previous.indexTruncated)cut++;continue;}
      const candidate=prepare(value.doc,value.originalLength,value.indexTruncated,value.order);
      const newTerms=[...candidate.tokens.keys()].filter(term=>!inverted.has(term)).length;
      const leavingTerms=previous?[...previous.tokens.keys()].filter(term=>!candidate.tokens.has(term)&&inverted.get(term).size===1).length:0;
      if(estimatedBytes-(previous?.bytes||0)+candidate.bytes>SEARCH_LIMITS.bytes||inverted.size-leavingTerms+newTerms>SEARCH_LIMITS.terms){if(previous){remove(id);diff.removed++;}invalid++;continue;}
      if(previous){remove(id);diff.updated++;}else diff.added++;
      add(candidate);if(candidate.indexTruncated)cut++;
    }
    omitted=invalid;truncated=cut;lastDiff=diff;if(diff.added||diff.updated||diff.removed)revision++;return statistics();
  }
  function eligible(options){
    const sets=[];
    if(options.projectId){if(typeof options.projectId!=='string'||options.projectId.length>160)throw new TypeError('Ungültiger Suchkurs.');sets.push(projects.get(options.projectId)||new Set());}
    for(const [name,map] of [['kinds',kinds],['sources',sources]])if(options[name]!==undefined){
      if(!Array.isArray(options[name])||options[name].length>80||options[name].some(value=>typeof value!=='string'||value.length>160))throw new TypeError('Ungültiger Suchfilter.');
      const union=new Set();for(const value of new Set(options[name]))for(const id of map.get(value)||[])union.add(id);sets.push(union);
    }
    if(!sets.length)return new Set(records.keys());sets.sort((a,b)=>a.size-b.size);return new Set([...sets[0]].filter(id=>sets.every(set=>set.has(id))));
  }
  function search(query,options={}){
    const began=clock();
    if(typeof query!=='string')throw new TypeError('Die Suchanfrage muss Text sein.');
    if(!options||typeof options!=='object')throw new TypeError('Ungültige Suchoptionen.');
    const check=()=>{if(options.signal?.aborted)throw abort();};check();
    const scope=eligible(options),limit=clamp(options.limit,1,SEARCH_LIMITS.results,8),offset=clamp(options.offset,0,SEARCH_LIMITS.documents,0),excerptLength=clamp(options.excerptLength,40,SEARCH_LIMITS.excerpt,1000);
    const originalQuery=query;query=query.slice(0,SEARCH_LIMITS.query);
    const rawTokens=tokenize(query),allTerms=[...new Set(rawTokens.filter(t=>t.term.length>=2).map(t=>t.term))],queryTerms=allTerms.filter(term=>!stops.has(term)).slice(0,SEARCH_LIMITS.queryTerms);
    let groups=[],expansionTruncated=false,phraseQueries=[...query.matchAll(/"([^"]+)"/g)].map(match=>phraseText(tokenize(match[1]))).filter(value=>value.trim());
    if(!phraseQueries.length&&rawTokens.length>1)phraseQueries=[phraseText(rawTokens)];
    const frequency=new Map(),df=term=>{if(frequency.has(term))return frequency.get(term);let count=0;for(const id of inverted.get(term)?.keys()||[])if(scope.has(id))count++;frequency.set(term,count);return count;};
    const termsSorted=()=>vocabulary||(vocabulary=[...inverted.keys()].sort());
    for(let i=0;i<queryTerms.length;i++){
      check();const word=queryTerms[i],variants=new Map();if(df(word))variants.set(word,1);
      if(!variants.size||i===queryTerms.length-1){
        const list=termsSorted(),start=lowerBound(list,word);let seen=0;
        for(let j=start;j<list.length&&list[j].startsWith(word);j++){
          if(++seen>2048||variants.size>=SEARCH_LIMITS.expansions){expansionTruncated=true;break;}
          if(df(list[j]))variants.set(list[j],list[j]===word?1:.8);
        }
      }
      if(!variants.size&&word.length>=4&&word.length<=64){
        if(!lengths){lengths=new Map();for(const term of inverted.keys()){if(!lengths.has(term.length))lengths.set(term.length,[]);lengths.get(term.length).push(term);}for(const bucket of lengths.values())bucket.sort((a,b)=>inverted.get(b).size-inverted.get(a).size||(a<b?-1:1));}
        const max=word.length>=8?2:1;let seen=0;
        fuzzy:for(let size=word.length-max;size<=word.length+max;size++)for(const term of lengths.get(size)||[]){
          if(++seen>SEARCH_LIMITS.fuzzyScans||variants.size>=SEARCH_LIMITS.expansions){expansionTruncated=true;break fuzzy;}
          if(!(seen%64))check();if(df(term)&&distance(word,term,max)<=max)variants.set(term,.55);
          if(variants.size>=SEARCH_LIMITS.expansions){expansionTruncated=true;break fuzzy;}
        }
      }
      groups.push(variants);
    }
    const candidateIds=new Set();for(const variants of groups)for(const term of variants.keys())for(const id of inverted.get(term).keys())if(scope.has(id))candidateIds.add(id);
    let mode=queryTerms.length?'and':'empty';
    if(!queryTerms.length&&query.trim()&&!allTerms.length)mode='none';
    let candidates=mode==='empty'?[...scope]:[...candidateIds];
    if(groups.length){const and=candidates.filter(id=>groups.every(group=>[...group.keys()].some(term=>inverted.get(term).has(id))));if(and.length)candidates=and;else mode='or';}
    check();
    const average=scope.size?[...scope].reduce((sum,id)=>sum+records.get(id).length,0)/scope.size:1;
    const score=[];let phraseFound=false;
    for(const id of candidates){
      if(!(score.length%128))check();const record=records.get(id);let value=0;
      for(const variants of groups){let best=0;for(const [term,weight] of variants){const hit=inverted.get(term).get(id);if(!hit)continue;const idf=Math.log(1+(scope.size-df(term)+.5)/(df(term)+.5)),body=hit.b?hit.b*2.2/(hit.b+1.2*(.25+.75*record.length/average)):0,title=hit.t?6*hit.t*2.2/(hit.t+1.2):0;best=Math.max(best,(body+title)*idf*weight);}value+=best;}
      const phrase=phraseQueries.length>0&&phraseQueries.every(q=>record.titlePhrase.includes(q)||record.bodyPhrase.includes(q));
      if(phrase){value+=5+(phraseQueries.some(q=>record.titlePhrase.includes(q))?8:0);phraseFound=true;}
      score.push({record,score:value,phrase});
    }
    if(query.includes('"')&&phraseFound){mode='phrase';for(let i=score.length-1;i>=0;i--)if(!score[i].phrase)score.splice(i,1);}
    score.sort((a,b)=>b.score-a.score||(mode==='empty'?a.record.order-b.record.order:0)||(a.record.doc.id<b.record.doc.id?-1:1));
    const matched=new Set(groups.flatMap(group=>[...group.keys()]));
    const results=score.slice(offset,offset+limit).map(({record,score})=>{
      check();const bodyTokens=tokenize(record.doc.text),hits=bodyTokens.filter(token=>matched.has(token.term));
      let hit=hits[0]?.start||0;
      for(const phrase of phraseQueries)if(record.bodyPhrase.includes(phrase)){
        const sequence=phrase.trim().split(' '),position=bodyTokens.findIndex((token,i)=>token.term===sequence[0]&&sequence.every((term,j)=>bodyTokens[i+j]?.term===term));
        if(position>=0){hit=bodyTokens[position].start;break;}
      }
      let start=Math.max(0,hit-Math.min(120,Math.floor(excerptLength/4)));
      // UTF-16 offsets remain exact; never cut between surrogate halves.
      if(start&&/[\uDC00-\uDFFF]/.test(record.doc.text[start]))start--;
      let end=Math.min(record.doc.text.length,start+excerptLength);if(end<record.doc.text.length&&/[\uDC00-\uDFFF]/.test(record.doc.text[end]))end--;
      return {...record.doc,...(record.doc.route?{route:{...record.doc.route}}:{}),score,text:record.doc.text.slice(start,end),excerptOffset:start,truncated:record.indexTruncated||start>0||end<record.originalLength,matchedRanges:hits.filter(h=>h.end>start&&h.start<end).slice(0,80).map(({start,end})=>({start,end}))};
    });
    lastSearch={mode,candidates:candidates.length,totalMatches:score.length,offset,returned:results.length,omittedCandidates:0,expansionTruncated,queryTruncated:originalQuery.length>query.length||allTerms.length>SEARCH_LIMITS.queryTerms,unmatchedTerms:groups.filter(group=>!group.size).length,milliseconds:clock()-began};
    return results;
  }
  function clear(){records.clear();inverted.clear();projects.clear();kinds.clear();sources.clear();characters=postings=estimatedBytes=omitted=truncated=0;vocabulary=lengths=null;revision++;lastDiff={added:0,updated:0,removed:0,unchanged:0};lastSearch={mode:'empty',candidates:0,totalMatches:0,offset:0,returned:0,omittedCandidates:0,expansionTruncated:false,queryTruncated:false};return statistics();}
  const index={replace,search,stats:statistics,clear};
  snapshotReaders.set(index,()=>[...records.values()].sort((a,b)=>a.order-b.order).map(record=>({...record.doc,...(record.doc.route?{route:{...record.doc.route}}:{}),originalLength:record.originalLength,indexTruncated:record.indexTruncated})));
  return index;
}
