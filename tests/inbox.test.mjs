import test from 'node:test';
import assert from 'node:assert/strict';
test('snapshot timestamps with missing or invalid provider dates render a safe label',async()=>{
  const {formatSnapshotTime}=await import('../dist/inbox.js');
  for(const value of [undefined,'','bad date'])assert.equal(formatSnapshotTime(value),'Zeitpunkt unbekannt');
  assert.match(formatSnapshotTime('2026-10-12T10:00:00Z'),/12/);
});
