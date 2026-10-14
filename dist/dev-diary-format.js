import {renderMarkdown} from './markdown.js';

// A tiny, diary-only extension: fixed disclosure tags, date-only summaries,
// no HTML attributes or arbitrary HTML. General Markdown still escapes HTML.
export function renderDevDiaryPost(content) {
  const lines=String(content).split('\n');let html='',buffer=[],inside=false;
  const flush=()=>{if(buffer.length){html+=renderMarkdown(buffer.join('\n'),[]);buffer=[];}};
  for(let i=0;i<lines.length;i++){
    if(!inside&&lines[i]==='<details>'&&/^<summary>\d{2}\.\d{2}\.\d{4}<\/summary>$/.test(lines[i+1]||'')&&lines.indexOf('</details>',i+2)>=0){
      flush();html+='<details class="dev-diary-day"><summary>'+lines[++i].slice(9,-10)+'</summary>';inside=true;
    }else if(inside&&lines[i]==='</details>'){flush();html+='</details>';inside=false;}
    else buffer.push(lines[i]);
  }
  flush();if(inside)html+='</details>';return html;
}
