// Age of a source relative to the current semester. Course platforms keep many
// outdated pages; the assistant must see how old evidence is instead of trusting
// whatever matched. Dates come from metadata, a dated URL or explicit dates and
// semesters in the text. Retrieval times (fetchedAt/checkedAt) are never content dates.
const MONTHS={januar:1,jan:1,january:1,februar:2,feb:2,february:2,märz:3,maerz:3,mär:3,mar:3,march:3,april:4,apr:4,mai:5,may:5,juni:6,jun:6,june:6,juli:7,jul:7,july:7,august:8,aug:8,september:9,sep:9,sept:9,oktober:10,okt:10,oct:10,october:10,november:11,nov:11,dezember:12,dez:12,dec:12,december:12};
const META=['postedAt','publishedAt','date','createdAt','updatedAt'];
const pad=n=>String(n).padStart(2,'0');
const iso=(y,m,d)=>{const date=new Date(Date.UTC(y,m-1,d,12));return date.getUTCFullYear()===y&&date.getUTCMonth()===m-1&&date.getUTCDate()===d?`${y}-${pad(m)}-${pad(d)}`:'';};
const parse=value=>{const m=/^(\d{4})-(\d{2})-(\d{2})/.exec(typeof value==='string'?value:'');return m?iso(Number(m[1]),Number(m[2]),Number(m[3])):'';};
// Summer semester April–September, winter semester October–March (index 2y / 2y+1).
const index=(y,m)=>m>=10?y*2+1:m>=4?y*2:(y-1)*2+1;
export function semesterLabel(idx){const y=Math.floor(idx/2);return idx%2?`WS ${y}/${pad((y+1)%100)}`:`SS ${y}`;}
const valid=value=>/^\d{4}-\d{2}-\d{2}$/.test(value||'')&&Number.isFinite(Date.parse(value+'T12:00:00Z'));
export function currentSemester(today){return valid(today)?semesterLabel(index(Number(today.slice(0,4)),Number(today.slice(5,7)))):'';}

function fromText(value,limit){
  const input=typeof value==='string'?value.slice(0,60000):'',found=[];
  const add=(idx,date,rank)=>{if(Number.isFinite(idx)&&idx>=2000*2&&idx<=limit)found.push({idx,date,rank});};
  for(const m of input.matchAll(/\b(\d{1,2})\.\s?(\d{1,2})\.\s?(20\d{2})\b/g)){const d=iso(Number(m[3]),Number(m[2]),Number(m[1]));if(d)add(index(Number(m[3]),Number(m[2])),d,3);}
  for(const m of input.matchAll(/\b(\d{1,2})\.?\s+([A-Za-zäöüÄÖÜ]{3,9})\.?,?\s+(20\d{2})\b/g)){const month=MONTHS[m[2].toLowerCase()];if(month){const d=iso(Number(m[3]),month,Number(m[1]));if(d)add(index(Number(m[3]),month),d,3);}}
  for(const m of input.matchAll(/\b([A-Za-zäöüÄÖÜ]{3,9})\s+(20\d{2})\b/g)){const month=MONTHS[m[1].toLowerCase()];if(month)add(index(Number(m[2]),month),`${m[2]}-${pad(month)}`,2);}
  for(const m of input.matchAll(/\b(?:WS|WiSe|W|Wintersemester)\s?(20\d{2})(?:\s?\/\s?(?:20)?\d{2})?\b/g))add(Number(m[1])*2+1,m[1],2);
  for(const m of input.matchAll(/\b(?:SS|SoSe|S|Sommersemester)\s?(20\d{2})\b/g))add(Number(m[1])*2,m[1],2);
  for(const m of input.matchAll(/(?<![\d./:-])(20\d{2})(?![\d./:-]|\s?(?:Zeichen|Wörter|px|€|%))/g))add(Number(m[1])*2,m[1],1);
  if(!found.length)return null;
  // Latest explicit mention; an exact date beats a bare year of the same semester.
  return found.sort((a,b)=>b.idx-a.idx||b.rank-a.rank)[0];
}

/** {date, sem, age, basis}: age is aktuell | älter | veraltet | unbekannt; basis names where the date came from. */
export function sourceAge(doc,today){
  if(!valid(today))return null;
  const nowIdx=index(Number(today.slice(0,4)),Number(today.slice(5,7))),limit=nowIdx+2;
  let date='',idx=NaN,basis='';
  for(const key of META){const value=parse(doc?.[key]);if(value){date=value;idx=index(Number(value.slice(0,4)),Number(value.slice(5,7)));basis='metadata';break;}}
  if(!basis){
    let url=null;try{url=new URL(String(doc?.url||''));}catch{}
    const m=url&&/\/(20\d{2})\/(\d{1,2})\/(?:(\d{1,2})\/)?/.exec(url.pathname);
    if(m&&Number(m[2])>=1&&Number(m[2])<=12){date=m[3]?iso(Number(m[1]),Number(m[2]),Number(m[3])):`${m[1]}-${pad(Number(m[2]))}`;if(date){idx=index(Number(m[1]),Number(m[2]));basis='url';}}
  }
  if(!basis){const found=fromText(`${doc?.title||''}\n${doc?.text||''}`,limit);if(found){date=found.date;idx=found.idx;basis='text';}}
  if(!basis||!Number.isFinite(idx))return {date:'',sem:'',age:'unbekannt',basis:''};
  const behind=nowIdx-idx;
  return {date,sem:semesterLabel(Math.min(idx,nowIdx+1)),age:behind<=0?'aktuell':behind===1?'älter':'veraltet',basis};
}
