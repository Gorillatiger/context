import test from 'node:test';
import assert from 'node:assert/strict';
import {spaceBrowserURL} from '../dist/spaces.js';

test('Spaces browser entries stay within the HTTPS provider and read-only page routes',()=>{
  const project=url=>({links:[{tool:'spaces',url}]});
  assert.equal(spaceBrowserURL(project('https://spaces.th-koeln.de/prototyping-things-w202627/')),'https://spaces.th-koeln.de/prototyping-things-w202627/');
  assert.equal(spaceBrowserURL(project('https://spaces.th-koeln.de/course/index.php?page_id=123')),'https://spaces.th-koeln.de/course/index.php?page_id=123');
  for(const url of ['javascript:alert(1)','http://spaces.th-koeln.de/course/','https://spaces.th-koeln.de.evil.test/','https://evil.test/','https://u:p@spaces.th-koeln.de/','https://spaces.th-koeln.de:8443/','https://spaces.th-koeln.de/course/wp-admin/','https://spaces.th-koeln.de/wp-login.php','https://spaces.th-koeln.de/?action=logout','https://spaces.th-koeln.de/?redirect_to=https://evil.test'])assert.equal(spaceBrowserURL(project(url)),'');
  assert.equal(spaceBrowserURL({links:[{tool:'gitlab',url:'https://spaces.th-koeln.de/'}]}),'');
});
