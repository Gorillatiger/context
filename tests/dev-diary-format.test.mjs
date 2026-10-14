import test from 'node:test';
import assert from 'node:assert/strict';
import {renderDevDiaryPost} from '../dist/dev-diary-format.js';
import {renderMarkdown} from '../dist/markdown.js';

test('only fixed date disclosures render HTML; arbitrary tags, attributes, nesting and scripts stay inert',()=>{
 const markdown='# Diary\n\n<details>\n<summary>14.10.2026</summary>\n\n### Erkenntnisse\n\nSicher &lt;img src=x onerror=bad&gt;\n\n</details>\n';
 const html=renderDevDiaryPost(markdown);
 assert.match(html,/<details class="dev-diary-day"><summary>14\.10\.2026<\/summary>/);
 assert.match(html,/<h3>Erkenntnisse<\/h3>/);assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<img/);
 assert.doesNotMatch(renderMarkdown(markdown),/<details/,'the general Markdown renderer must keep escaping all HTML');
 for(const raw of ['<details onclick="bad()">\n<summary>14.10.2026</summary>\nA\n</details>','<details>\n<summary><img src=x></summary>\nA\n</details>','<details>\n<summary>14.10.2026</summary>\n<script>bad()</script>','<details>\n<summary>14.10.2026</summary>\n<details>\n<summary>15.10.2026</summary>\nX\n</details>\n</details>']){
  const rendered=renderDevDiaryPost(raw);assert.doesNotMatch(rendered,/<script|<img|<[^>]+\sonclick=|<summary><img/);
  assert((rendered.match(/<details class=/g)||[]).length<=1);
 }
});
