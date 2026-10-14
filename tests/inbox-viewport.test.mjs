import test from 'node:test';import assert from 'node:assert/strict';
import {captureInboxViewport,restoreInboxViewport} from '../dist/inbox-viewport.js';
function fixture(key='course|all|all|all'){
  const focus=[],details=[{dataset:{inboxDetail:'sources'},open:true},{dataset:{inboxDetail:'assign:one'},open:true}],select={id:'',tagName:'SELECT',getAttribute:()=> 'one',focus:options=>focus.push(options)},container={dataset:{inboxScope:key},querySelectorAll:query=>query.startsWith('details')?details:[select],contains:node=>node===select};
  return {details,focus,select,document:{activeElement:select,scrollingElement:{scrollTop:800},querySelector:()=>container}};
}
test('passive refresh preserves open source/assignment controls, focus and reading position',()=>{
  const before=fixture(),after=fixture();after.details.forEach(detail=>detail.open=false);after.document.scrollingElement.scrollTop=0;
  restoreInboxViewport(captureInboxViewport(before.document),after.document);assert.ok(after.details.every(detail=>detail.open));assert.deepEqual(after.focus,[{preventScroll:true}]);assert.equal(after.document.scrollingElement.scrollTop,800);
});
test('course/filter changes do not inherit another Inbox reading state',()=>{
  const before=fixture(),after=fixture('other|new|all|all');after.details.forEach(detail=>detail.open=false);after.document.scrollingElement.scrollTop=0;
  restoreInboxViewport(captureInboxViewport(before.document),after.document);assert.ok(after.details.every(detail=>!detail.open));assert.deepEqual(after.focus,[]);assert.equal(after.document.scrollingElement.scrollTop,0);
});
test('removed rows and disabled controls are not focused; missing Inbox is harmless',()=>{
  const before=fixture(),after=fixture();after.select.disabled=true;
  restoreInboxViewport(captureInboxViewport(before.document),after.document);assert.deepEqual(after.focus,[]);
  assert.equal(captureInboxViewport({querySelector:()=>null}),null);assert.doesNotThrow(()=>restoreInboxViewport(null,after.document));
});
