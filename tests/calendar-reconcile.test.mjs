import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileCalendarEvents } from '../dist/calendar-refresh.js';
import { validateCalendarEvent } from '../dist/calendar-engine.js';

const event = (patch = {}) => validateCalendarEvent({
  id: 'google-primary-event1', title: 'Kursbesprechung', projectId: '',
  start: '2026-10-14T08:00:00Z', end: '2026-10-14T09:00:00Z', readonly: true,
  source: { kind: 'google', title: 'Kurskalender', url: 'https://calendar.google.com/calendar/event?eid=event1', externalId: 'event1' },
  ...patch,
});
const options = { projectIds: ['prototyping', 'go-public'] };
const deepFreeze = value => {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
};

test('a restart or a repeated read retains one stable provider event and reports no save', () => {
  const original = event(), previous = deepFreeze([original]);
  const first = reconcileCalendarEvents(previous, [event()], options);
  assert.deepEqual(first, { events: [original], added: 0, updated: 0, unchanged: 1, duplicates: 0, changed: false });
  const restarted = reconcileCalendarEvents(JSON.parse(JSON.stringify(first.events)), [event()], options);
  assert.deepEqual(restarted, first);
  assert.notEqual(first.events, previous);
  assert.notEqual(first.events[0], original);
});

test('remote changes update in place while preserving a local course assignment', () => {
  const previous = deepFreeze([event({ projectId: 'prototyping' })]);
  const fresh = event({ title: 'Neue Uhrzeit', start: '2026-10-14T10:00:00Z', end: '2026-10-14T11:00:00Z', projectId: 'go-public' });
  const result = reconcileCalendarEvents(previous, [fresh], options);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].projectId, 'prototyping');
  assert.equal(result.events[0].title, 'Neue Uhrzeit');
  assert.deepEqual([result.added, result.updated, result.unchanged, result.changed], [0, 1, 0, true]);
  assert.equal(previous[0].title, 'Kursbesprechung');
  assert.equal(reconcileCalendarEvents(result.events, [fresh], options).changed, false);
});

test('adding a new event preserves every unrelated and locally created event', () => {
  const local = event({ id: 'local-meeting', source: { kind: 'local', title: 'Eigener Termin' }, readonly: false });
  const previous = deepFreeze([local]);
  const result = reconcileCalendarEvents(previous, [event()], options);
  assert.deepEqual(result.events, [local, event()]);
  assert.deepEqual([result.added, result.updated, result.unchanged], [1, 0, 0]);
});

test('an empty or incomplete read never deletes previous provider events', () => {
  const previous = deepFreeze([event()]);
  const result = reconcileCalendarEvents(previous, [], options);
  assert.deepEqual(result.events, previous);
  assert.equal(result.changed, false);
  assert.deepEqual([result.added, result.updated, result.unchanged], [0, 0, 0]);
});

test('identical incoming page repetitions count once and require only one insertion', () => {
  const result = reconcileCalendarEvents([], [event(), event(), event()], options);
  assert.equal(result.events.length, 1);
  assert.deepEqual([result.added, result.updated, result.unchanged, result.duplicates], [1, 0, 0, 2]);
  const repeated = reconcileCalendarEvents(result.events, [event(), event()], options);
  assert.deepEqual([repeated.added, repeated.updated, repeated.unchanged, repeated.duplicates, repeated.changed], [0, 0, 1, 1, false]);
});

test('conflicting repetitions fail atomically even after another candidate addition', () => {
  const previous = deepFreeze([event({ id: 'untouched' })]), before = JSON.stringify(previous);
  const first = event({ id: 'new-a' });
  assert.throws(() => reconcileCalendarEvents(previous, [first, event(), event({ title: 'Contradiction' })], options), /Widersprüchliche/);
  assert.equal(JSON.stringify(previous), before);
});

test('dates and titles never deduplicate unrelated calendars or providers', () => {
  const sameTitleTime = [event(), event({ id: 'google-othercalendar-event1' }), event({ id: 'outlook-calendar-event1', source: { ...event().source, kind: 'outlook' } })];
  const result = reconcileCalendarEvents([], sameTitleTime, options);
  assert.equal(result.events.length, 3);
  assert.equal(result.added, 3);
  assert.equal(result.duplicates, 0);
});

test('a legacy ID cannot be guessed from a matching external ID, URL, title or time', () => {
  // Old source data has no calendar/account identity. Equal external IDs alone
  // cannot authorize merging two different provider-scoped local identities.
  const previous = [event({ id: 'legacy-google-event1', projectId: 'prototyping' })];
  const result = reconcileCalendarEvents(previous, [event()], options);
  assert.equal(result.events.length, 2);
  assert.equal(result.events[0].projectId, 'prototyping');
  assert.equal(result.events[1].projectId, '');
});

test('a provider ID collision cannot overwrite a local event or another provider', () => {
  for (const source of [{ kind: 'local' }, { kind: 'outlook', externalId: 'event1' }, { kind: 'google', externalId: 'different-event' }]) {
    const previous = deepFreeze([event({ source })]);
    assert.throws(() => reconcileCalendarEvents(previous, [event()], options), /anderen Quelle/);
    assert.deepEqual(previous[0].source.kind, source.kind);
  }
});

test('normalization makes equivalent ISO instants unchanged and handles fractional seconds', () => {
  const original = event({ start: '2026-10-25T02:30:12.123+02:00', end: '2026-10-25T02:30:12.456+01:00' });
  const fresh = { ...original, start: '2026-10-25T00:30:12.123Z', end: '2026-10-25T01:30:12.456Z' };
  const result = reconcileCalendarEvents([original], [fresh], options);
  assert.equal(result.changed, false);
  assert.equal(result.events[0].start, fresh.start);
  assert.equal(result.events[0].end, fresh.end);
});

test('invalid input, a foreign course and mixed local incoming sources cannot produce a partial result', () => {
  const previous = deepFreeze([event()]), before = JSON.stringify(previous);
  for (const incoming of [null, {}, false, [event({ id: 'added' }), { ...event(), end: 'bad' }], [event({ id: 'unknown-course', projectId: 'unknown' })], [event({ source: { kind: 'spaces' } })]]) {
    assert.throws(() => reconcileCalendarEvents(previous, incoming, options));
    assert.equal(JSON.stringify(previous), before);
  }
  assert.throws(() => reconcileCalendarEvents([event(), event()], [], options), /Doppelte/);
});

test('the 2000-event workspace bound is enforced before any calendar replacement', () => {
  const previous = Array.from({ length: 2000 }, (_, i) => event({ id: 'google-old-' + i }));
  deepFreeze(previous);
  assert.throws(() => reconcileCalendarEvents(previous, [event()], options), /höchstens 2000/);
  assert.equal(previous.length, 2000);
  assert.equal(reconcileCalendarEvents(previous, [], options).changed, false);
  assert.throws(() => reconcileCalendarEvents([], Array.from({ length: 2001 }, () => event()), options), /höchstens 2000/);
});

test('content, source evidence and all-day changes update once instead of appending', () => {
  const updated = event({ allDay: true, start: '2026-10-14', end: '2026-10-16', source: { ...event().source, title: 'Umbenannter Kalender', excerpt: 'Raum 12' } });
  const first = reconcileCalendarEvents([event()], [updated], options);
  assert.equal(first.updated, 1);
  assert.equal(first.events.length, 1);
  assert.equal(first.events[0].allDay, true);
  const second = reconcileCalendarEvents(first.events, [updated], options);
  assert.equal(second.unchanged, 1);
  assert.equal(second.changed, false);
});
