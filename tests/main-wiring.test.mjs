import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// node --check erkennt keine fehlenden Importe; dieser Test sichert die Kurssuche im Hauptprozess ab.
test('main process imports what the courses command uses',()=>{
  const main=readFileSync(new URL('../desktop/main.mjs',import.meta.url),'utf8');
  for(const name of ['courseMenuScript','cleanCourses','extractCourses','requestPaths'])assert.match(main,new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*'\\./course-menu\\.mjs'`),name);
});
