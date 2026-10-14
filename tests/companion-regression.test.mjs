import test from 'node:test';
import assert from 'node:assert/strict';
import {
  explicitDate, localFindings, matchingTask, mergeFindings,
  parseReview, partitionFindings, reviewPlan, reviewPrompt, urgency
} from '../dist/companion-engine.js';
import {cleanMemory, encryptMemory, decryptMemory} from '../dist/companion-memory.js';
import {buildKnowledge} from '../dist/knowledge.js';

const source = (overrides = {}) => ({
  id: 'u:studio', kind: 'updates', projectId: 'studio',
  title: 'Prototyping · Abgabe', status: 'full',
  url: 'https://spaces.th-koeln.de/studio/abgabe',
  text: 'Bitte den Prototyp vorbereiten und bis 16.10.2026 abgeben.',
  ...overrides
});
const workspace = (overrides = {}) => ({
  projects: [
    {id: 'studio', name: 'Prototyping', archived: false, links: [], note: ''},
    {id: 'public', name: 'How to Go Public', archived: false, links: [], note: ''}
  ], tasks: [], notes: [], notificationCourses: {}, ...overrides
});
const batch = (document = source()) => ({
  projectId: document.projectId,
  chunks: [{id: document.id + '@0', source: document, text: document.text, offset: 0}]
});
const report = (overrides = {}, document = source()) => JSON.stringify({findings: [{
  title: 'Prototyp für die Abgabe vorbereiten', sourceId: document.id + '@0',
  evidence: document.text, due: '2026-10-16', reason: 'Vorbereitung mit expliziter Abgabefrist.',
  ...overrides
}]});
const finding = (overrides = {}) => ({
  id: 'a'.repeat(64), title: 'Prototyp für die Abgabe vorbereiten',
  projectId: 'studio', sourceId: 'u:studio', source: source(),
  evidence: source().text, due: '2026-10-16', reason: 'Konkrete Kursabgabe.',
  method: 'ai', status: 'new', ...overrides
});

test('a repeated date in two supported formats is one deadline, with genuine leap-day validation', () => {
  assert.equal(explicitDate('Abgabe am 29.02.2028 (2028-02-29).'), '2028-02-29');
  assert.equal(explicitDate('Abgabe am 29.02.2027.'), '');
  assert.equal(explicitDate('Abgabe 31.04.2026 oder 2026-04-31.'), '');
  assert.equal(explicitDate('Beginn 12.10.2026; Abgabe 16.10.2026.'), '');
  assert.equal(explicitDate('Am 16.10. wird vorbereitet; morgen abgeben.'), '');
});

test('deadline urgency has a seven-calendar-day boundary across months and years', () => {
  assert.equal(urgency('2027-01-03', '2026-12-27'), 'soon');
  assert.equal(urgency('2027-01-04', '2026-12-27'), 'later');
  assert.equal(urgency('2026-12-26', '2026-12-27'), 'overdue');
  assert.equal(urgency('2026-12-27', '2026-12-27'), 'today');
});

test('AI cannot cite a quote elsewhere in the source that was outside its transmitted chunk', async () => {
  const document = source({text: 'Kursinformationen ohne Arbeitsauftrag.\n' + source().text});
  const transmitted = batch(document);
  transmitted.chunks[0].text = 'Kursinformationen ohne Arbeitsauftrag.';
  await assert.rejects(parseReview(report({evidence: source().text}, document), transmitted), /wörtlichen Quellenbeleg/);
});

test('AI quotation must preserve source wording, while a fenced valid JSON report remains supported', async () => {
  await assert.rejects(parseReview(report({evidence: source().text.replace('vorbereiten', 'erstellen')}), batch()), /wörtlichen Quellenbeleg/);
  const [valid] = await parseReview('```json\n' + report() + '\n```', batch());
  assert.equal(valid.evidence, source().text);
  assert.equal(valid.source.url, source().url);
  assert.equal(valid.projectId, 'studio');
});

test('one fabricated finding rejects a whole report rather than retaining a plausible first item', async () => {
  const value = JSON.parse(report());
  value.findings.push({...value.findings[0], sourceId: 'u:unseen@0'});
  await assert.rejects(parseReview(JSON.stringify(value), batch()), /wörtlichen Quellenbeleg/);
});

test('quoted relative or ambiguous dates cannot justify an invented AI deadline', async () => {
  for (const text of [
    'Bitte den Prototyp morgen zur Abgabe vorbereiten.',
    'Bitte den Prototyp am 16.10. für die Abgabe vorbereiten.',
    'Bitte am 12.10.2026 anfangen und am 16.10.2026 abgeben.'
  ]) {
    const document = source({text});
    await assert.rejects(parseReview(report({evidence: text}, document), batch(document)), /Frist.*nicht.*belegt/);
    const [valid] = await parseReview(report({evidence: text, due: ''}, document), batch(document));
    assert.equal(valid.due, '');
  }
});

test('a model cannot inject task state, action parameters, course or URLs through a review finding', async () => {
  for (const injected of [
    {status: 'done'}, {projectId: 'public'}, {url: 'https://example.org/'},
    {tool: 'send_mail'}, {args: {recipient: 'somebody@example.org'}}
  ]) {
    await assert.rejects(parseReview(report(injected), batch()), /Ungültiger Aufgabenhinweis/);
  }
});

test('checkbox tasks already checked off are not resurrected as new obligations', async () => {
  const documents = [
    source({id: 'n:finished', kind: 'notes', text: '[x] Prototyp für die Abgabe vorbereiten'}),
    source({id: 'n:open', kind: 'notes', text: '[ ] Dokumentation für die Abgabe vorbereiten'})
  ];
  const found = await localFindings(documents);
  assert.deepEqual(found.map(f => f.sourceId), ['n:open']);
});

test('new source text can enrich a dismissed or completed hint without undoing the user decision', () => {
  for (const status of ['dismissed', 'done', 'accepted']) {
    const previous = finding({status, taskId: 't:user'});
    const refreshed = finding({id: 'b'.repeat(64), evidence: 'Bitte den Prototyp vorbereiten', due: '', reason: 'Aktualisierte Quelleneinordnung.'});
    const merged = mergeFindings([previous], [refreshed], workspace());
    assert.equal(merged.length, 1);
    assert.equal(merged[0].status, status);
    assert.equal(merged[0].taskId, 't:user');
    assert.equal(merged[0].id, previous.id);
    assert.equal(merged[0].reason, refreshed.reason);
  }
});

test('a shorter AI quote without a date retains the grounded deadline, evidence and user decision', async () => {
  const [grounded] = await parseReview(report(), batch());
  const shorterEvidence = 'Bitte den Prototyp vorbereiten';
  for (const status of ['dismissed', 'done', 'accepted']) {
    for (const latestSource of [source(), source({text: shorterEvidence, status: 'excerpt'})]) {
      const [shorter] = await parseReview(report({evidence: shorterEvidence, due: ''}, latestSource), batch(latestSource));
      const previous = {...grounded, status, taskId: 't:confirmed'};
      const [merged] = mergeFindings([previous], [shorter], workspace());
      assert.equal(merged.status, status);
      assert.equal(merged.taskId, 't:confirmed');
      assert.equal(merged.due, '2026-10-16');
      assert.equal(merged.evidence, grounded.evidence);
      assert.ok(merged.source.text.includes(merged.evidence), 'The retained deadline must remain traceable in its retained source');
      assert.equal(merged.changed === true, false);
    }
  }
});

test('an explicitly changed date reopens a settled hint while retaining its accepted task identity', async () => {
  const [grounded] = await parseReview(report(), batch());
  const revisedSource = source({text: 'Bitte den Prototyp vorbereiten und bis 23.10.2026 abgeben.'});
  const [revised] = await parseReview(report({due: '2026-10-23'}, revisedSource), batch(revisedSource));
  const w = workspace({tasks: [{id: 't:confirmed', title: grounded.title, projectId: 'studio', due: '2026-10-16', status: 'done'}]});
  for (const status of ['dismissed', 'done', 'accepted']) {
    const originalId = grounded.id;
    const merged = mergeFindings([{...grounded, status, taskId: 't:confirmed'}], [revised], w);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].id, originalId);
    assert.equal(merged[0].status, 'new');
    assert.equal(merged[0].changed, true);
    assert.equal(merged[0].taskId, 't:confirmed');
    assert.equal(merged[0].due, '2026-10-23');
    assert.equal(merged[0].evidence, revisedSource.text);
    assert.equal(w.tasks[0].due, '2026-10-16', 'A changed source must not silently modify a confirmed task');
    assert.equal(w.tasks[0].status, 'done');
  }
});

test('the same normalized obligation is suppressed by a completed task only within its own course', () => {
  const record = finding({title: 'Übung: Prototyp abgeben!'});
  const w = workspace({tasks: [{id: 't:done', projectId: 'studio', title: 'UBUNG prototyp abgeben', status: 'done'}]});
  assert.equal(matchingTask(w, record)?.id, 't:done');
  assert.equal(mergeFindings([], [record], w).length, 0);
  const otherCourse = {...record, id: 'c'.repeat(64), projectId: 'public'};
  assert.equal(matchingTask(w, otherCourse), undefined);
  assert.equal(mergeFindings([], [otherCourse], w).length, 1);
});

test('a renamed confirmed task is still associated by ID, with that association limited to its course', () => {
  const renamed = {id: 't:confirmed', title: 'Endgültiges Kursprojekt einreichen', projectId: 'studio', status: 'done'};
  const titleMatch = {id: 't:other', title: finding().title, projectId: 'studio', status: 'todo'};
  const w = workspace({tasks: [titleMatch, renamed]});
  const original = finding({taskId: 't:confirmed'});
  assert.equal(matchingTask(w, original), renamed, 'A persisted task ID takes precedence over another task with the old title');
  assert.equal(mergeFindings([], [original], w).length, 0);
  assert.equal(matchingTask(w, {...original, projectId: 'public'}), undefined, 'A task ID is not authority to cross the course boundary');
  const foreignOnly = workspace({tasks: [{...renamed, projectId: 'public'}]});
  assert.equal(matchingTask(foreignOnly, original), undefined);
  assert.equal(mergeFindings([], [original], foreignOnly).length, 1);
});

const completedHistory = () => Array.from({length: 150}, (_, index) => {
  const sourceId = 'u:completed-' + index;
  const text = `Bitte Prototyp ${index} vorbereiten und bis 16.10.2026 abgeben.`;
  return finding({id: index.toString(16).padStart(64, '0'), title: `Prototyp ${index} vorbereiten`,
    sourceId, source: source({id: sourceId, text}), evidence: text,
    status: 'done', taskId: 't:completed-' + index, stale: false, changed: false});
});

test('150 completed hints make room for a new obligation without dropping their evidence or decisions', () => {
  const settled = completedHistory();
  const snapshot = structuredClone(settled);
  const incoming = finding({id: 'f'.repeat(64), sourceId: 'u:new-obligation',
    source: source({id: 'u:new-obligation'}), title: 'Neue Dokumentation für die Abgabe vorbereiten'});
  const merged = mergeFindings(settled, [incoming], workspace(), 1650);
  const partition = partitionFindings(merged, workspace());
  assert.equal(partition.findings.length, 150);
  assert.equal(partition.archived.length, 1);
  assert.ok(partition.findings.some(f => f.id === incoming.id && f.status === 'new'));
  const restoredHistory = [...partition.archived, ...partition.findings].filter(f => f.id !== incoming.id)
    .sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(restoredHistory, snapshot);
  assert.deepEqual(settled, snapshot, 'Partitioning and merging must not mutate the callers history');
  assert.equal(new Set([...partition.archived, ...partition.findings].map(f => f.id)).size, 151);
});

test('a changed deadline revives an archived hint even when its confirmed task is done and renamed', () => {
  const settled = completedHistory();
  const incoming = finding({id: 'f'.repeat(64), sourceId: 'u:new-obligation',
    source: source({id: 'u:new-obligation'}), title: 'Neue Dokumentation vorbereiten'});
  const initial = partitionFindings(mergeFindings(settled, [incoming], workspace(), 1650), workspace());
  const archived = initial.archived[0];
  const confirmed = {id: archived.taskId, projectId: archived.projectId,
    title: 'Vom Nutzer umbenanntes endgültiges Projekt', due: '2026-10-16', status: 'done'};
  const w = workspace({tasks: [confirmed]});
  const changedText = 'Bitte Prototyp 0 vorbereiten und bis 23.10.2026 abgeben.';
  const update = {...archived, due: '2026-10-23', evidence: changedText,
    source: {...archived.source, text: changedText}, status: 'new'};
  const revised = partitionFindings(mergeFindings([...initial.archived, ...initial.findings], [update], w, 1650), w);
  const reopened = revised.findings.find(f => f.id === archived.id);
  assert.ok(reopened, 'Changed archived obligations must reappear among the active findings');
  assert.equal(reopened.status, 'new');
  assert.equal(reopened.changed, true);
  assert.equal(reopened.due, '2026-10-23');
  assert.equal(reopened.evidence, changedText);
  assert.equal(reopened.taskId, confirmed.id);
  assert.equal(matchingTask(w, reopened), confirmed);
  assert.ok(!revised.archived.some(f => f.id === reopened.id));
  assert.equal([...revised.archived, ...revised.findings].length, 151);
  assert.equal(confirmed.due, '2026-10-16');
  assert.equal(confirmed.status, 'done');
});

test('clean memory and authenticated encryption retain archived sources, task identity and settled states', async () => {
  const history = completedHistory().slice(0, 3).map((f, index) => ({...f,
    status: ['done', 'dismissed', 'accepted'][index], stale: index === 1, changed: index === 2,
    source: {...f.source, offset: 40 + index, cookie: 'NO_STORE_ARCHIVE_COOKIE'},
    apiKey: 'NO_STORE_ARCHIVE_KEY'}));
  const memory = cleanMemory({findings: [finding()], archived: history,
    settings: {automaticAI: false, autoProvider: 'openrouter'}});
  const key = await crypto.subtle.generateKey({name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt']);
  const decrypted = await decryptMemory(await encryptMemory(memory, key), key);
  assert.deepEqual(decrypted, memory);
  assert.equal(decrypted.archived.length, 3);
  assert.deepEqual(decrypted.archived.map(f => f.status), ['done', 'dismissed', 'accepted']);
  assert.deepEqual(decrypted.archived.map(f => f.taskId), history.map(f => f.taskId));
  assert.deepEqual(decrypted.archived.map(f => [f.evidence, f.due, f.source.url, f.source.offset]),
    history.map(f => [f.evidence, f.due, f.source.url, f.source.offset]));
  assert.equal(decrypted.archived[1].stale, true);
  assert.equal(decrypted.archived[2].changed, true);
  assert.equal(decrypted.settings.autoProvider, 'openrouter');
  assert.equal(decrypted.settings.automaticAI, false);
  assert.ok(!JSON.stringify(decrypted).includes('NO_STORE_ARCHIVE_'));
  assert.throws(() => cleanMemory({archived: [{...history[0], due: '2026-02-30'}]}), /Ungültiges Datum/);
});

test('a changed URL or reassigned course invalidates an earlier source review', async () => {
  const original = await reviewPlan([source()]);
  const reviewed = Object.fromEntries(original.batches.flatMap(b => b.chunks.map(c => [c.key, c.version])));
  assert.equal((await reviewPlan([source()], reviewed)).totalChunks, 0);
  assert.equal((await reviewPlan([source({url: 'https://spaces.th-koeln.de/studio/revised'})], reviewed)).totalChunks, 1);
  const reassigned = await reviewPlan([source({projectId: 'public'})], reviewed);
  assert.equal(reassigned.totalChunks, 1);
  assert.equal(reassigned.batches[0].projectId, 'public');
});

test('partial review resumes the remaining chunks without combining courses or losing text', async () => {
  const documents = [source({text: 'A'.repeat(6500)}), source({id: 'u:public', projectId: 'public', text: 'B'.repeat(1601)})];
  const original = await reviewPlan(documents);
  assert.equal(original.totalChunks, 7);
  assert.ok(original.batches.every(b => b.chunks.length <= 4 && b.chunks.every(c => c.source.projectId === b.projectId)));
  for (const document of documents) {
    const chunks = original.batches.flatMap(b => b.chunks).filter(c => c.source.id === document.id).sort((a, b) => a.offset - b.offset);
    assert.equal(chunks.map(c => c.text).join(''), document.text);
  }
  const first = original.batches[0];
  const reviewed = Object.fromEntries(first.chunks.map(c => [c.key, c.version]));
  const resumed = await reviewPlan(documents, reviewed);
  assert.equal(resumed.totalChunks, 3);
  assert.ok(resumed.batches.flatMap(b => b.chunks).every(c => !Object.hasOwn(reviewed, c.key)));
});

test('archiving a course excludes its project, notes and updates from the companion input', async () => {
  const archived = {id: 'past', name: 'Alter Kurs', archived: true, links: [], note: 'Bitte einen alten Prototyp vorbereiten.'};
  const w = workspace({
    projects: [...workspace().projects, archived],
    notes: [{id: 'old-note', projectId: 'past', title: 'Alte Vorbereitung', content: 'Bitte die alte Abgabe vorbereiten.'},
      {id: 'current-note', projectId: 'studio', title: 'Aktuelle Vorbereitung', content: 'Bitte den neuen Prototyp vorbereiten.'}]
  });
  const updates = [{id: 'old-update', source: 'spaces', projectId: 'past', title: 'Alte Abgabe',
    summary: 'Abgabe 16.10.2026', content: 'Bitte die alte Abgabe vorbereiten.', contentStatus: 'full',
    url: 'https://spaces.th-koeln.de/past/abgabe'}];
  const documents = buildKnowledge(w, updates);
  assert.ok(documents.some(d => d.projectId === 'studio'));
  assert.ok(documents.every(d => d.projectId !== 'past'), 'Archived-course sources must not reach unattended checks');
  assert.ok((await localFindings(documents)).every(f => f.projectId !== 'past'));
  assert.ok((await reviewPlan(documents)).batches.every(b => b.projectId !== 'past'));
});

test('review prompts limit existing-task context to its course and redact secrets from user instructions', () => {
  const w = workspace({tasks: [
    {title: 'Prototyp abgeben', projectId: 'studio', status: 'done', due: '2026-10-16'},
    {title: 'Öffentliche Veranstaltung planen', projectId: 'public', status: 'todo', due: ''}
  ]});
  const prompt = reviewPrompt(batch(), w, '2026-10-12', 'Abgaben prüfen.\nAPI-Key: TEST_PRIVATE_DO_NOT_TRANSMIT');
  assert.match(prompt, /Prototyp abgeben/);
  assert.ok(!prompt.includes('Öffentliche Veranstaltung planen'));
  assert.ok(!prompt.includes('TEST_PRIVATE_DO_NOT_TRANSMIT'));
  assert.match(prompt, /untrusted_data/);
  assert.match(prompt, /Keine Werkzeuge ausführen/);
});

test('memory survives provider changes with each old audit step and user decision intact', async () => {
  const memory = cleanMemory({findings: [finding({status: 'dismissed'})],
    log: [
      {id: 'new', at: '2026-10-12T11:00:00Z', label: 'Neue Prüfung', detail: 'Quelle geprüft', status: 'done', provider: 'openrouter', model: 'example/new-model', tokens: 90, apiKey: 'NO_STORE_NEW_KEY'},
      {id: 'old', at: '2026-10-12T10:00:00Z', label: 'Frühere Prüfung', detail: 'Quelle geprüft', status: 'done', provider: 'kiconnect', model: 'example/old-model', tokens: 70, apiKey: 'NO_STORE_OLD_KEY'}
    ], apiKey: 'NO_STORE_ROOT_KEY', settings: {automaticAI: false, provider: 'openrouter', key: 'NO_STORE_SETTINGS_KEY'}});
  const key = await crypto.subtle.generateKey({name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt']);
  const loaded = await decryptMemory(await encryptMemory(memory, key), key);
  assert.equal(loaded.findings[0].status, 'dismissed');
  assert.deepEqual(loaded.log.map(r => [r.provider, r.model, r.tokens]), [
    ['openrouter', 'example/new-model', 90], ['kiconnect', 'example/old-model', 70]
  ]);
  assert.equal(loaded.settings.automaticAI, false);
  assert.ok(!JSON.stringify(loaded).includes('NO_STORE_'));
});

test('an archive from another encryption key or a modified nonce cannot be loaded as trusted memory', async () => {
  const makeKey = () => crypto.subtle.generateKey({name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt']);
  const key = await makeKey(), otherKey = await makeKey();
  const encrypted = await encryptMemory(cleanMemory({findings: [finding()]}), key);
  await assert.rejects(decryptMemory(encrypted, otherKey));
  const alteredNonce = new Uint8Array(encrypted.iv);
  alteredNonce[0] ^= 1;
  await assert.rejects(decryptMemory({...encrypted, iv: alteredNonce}, key));
});
