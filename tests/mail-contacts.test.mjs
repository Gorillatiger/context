import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createMailContacts, mailHeaderPeople, verifiedMailAddress, activeRecipientToken, replaceRecipientToken, MAIL_CONTACT_LIMITS } from '../dist/mail-contacts.js';

const account = 'th:synthetic-live-generation';
const header = (address, name = '') => ({ from: [{ address, name }] });
const fixture = options => { const contacts = createMailContacts(options); contacts.setAccount(account); return contacts; };
const hints = (contacts, value = '', extra = {}) => contacts.suggest({ value, cursor: value.length, ...extra });

test('verified addresses are complete bounded mailboxes, never invented from a local part', () => {
  for (const address of ['alex.beispiel@example.org', 'first+course@example.org', "o'hara@example.co.uk", 'A.Z@example.TEST']) assert.equal(verifiedMailAddress(address), address);
  for (const address of ['alex.beispiel', 'Alex Beispiel', 'mailto:alex@example.org', 'Alex <alex@example.org>', 'x@example..org', '.x@example.org', 'x.@example.org', 'x..y@example.org', 'x@-example.org', 'x@example-.org', 'x@'+ 'a'.repeat(64)+'.org', 'x@example.1', 'x@example', 'x@@example.org', 'ä@example.org', 'x@exämple.org', 'x@example.org\r\nBcc: y@example.org', 'x@example.org\0', 'x@example.org\u202e', 'a'.repeat(65)+'@example.org', 'a'.repeat(255)]) assert.equal(verifiedMailAddress(address), '', address);
  assert.equal(verifiedMailAddress(' alex@example.org '), 'alex@example.org');
  assert.equal(verifiedMailAddress(null), '');
});

test('canonical loaded people and complete quoted raw headers preserve names and verified addresses', () => {
  assert.deepEqual(mailHeaderPeople([{ name: ' Alex  Müller ', address: ' alex@example.org ' }]), [{ name: 'Alex Müller', address: 'alex@example.org' }]);
  assert.deepEqual(mailHeaderPeople('"Beispiel, Alex" <alex@example.org>; Birgit Müller <birgit@example.org>, other@example.org'), [
    { name: 'Beispiel, Alex', address: 'alex@example.org' }, { name: 'Birgit Müller', address: 'birgit@example.org' }, { name: '', address: 'other@example.org' }
  ]);
  assert.deepEqual(mailHeaderPeople('"Alex \\"A\\"" <alex@example.org>'), [{ name: 'Alex "A"', address: 'alex@example.org' }]);
});

test('injected, damaged, oversized and partial headers cannot add an address', () => {
  for (const source of ['Alex Beispiel', 'alex.beispiel', 'User <alex@example.org> suffix', '"Unclosed <alex@example.org>', 'User <alex@example.org\r\nBcc: evil@example.org>', 'alex@example.org\n', 'A'.repeat(201)+' <alex@example.org>', 'x'.repeat(16001)]) assert.deepEqual(mailHeaderPeople(source), [], source.slice(0, 100));
  assert.deepEqual(mailHeaderPeople([{ name: 'Name\nBcc:', address: 'alex@example.org' }, { address: 'alex@example.org\r' }, { name: 'x'.repeat(201), address: 'alex@example.org' }]), []);
  assert.deepEqual(mailHeaderPeople([{ name: '\u202eSpoof', address: 'alex@example.org' }]), []);
  assert.deepEqual(mailHeaderPeople([{ name: 'Name\u0085Other', address: 'alex@example.org' }, { name: 'Name\u2028Other', address: 'alex@example.org' }]), []);
});

test('header projection reads only explicitly allowed own data fields and never Bcc or a body', () => {
  const contacts = fixture();
  const message = { from: [{ address: 'from@example.org', name: 'From' }], to: [{ address: 'to@example.org' }], cc: [{ address: 'cc@example.org' }], replyTo: [{ address: 'reply@example.org' }] };
  for (const key of ['bcc', 'text', 'body', 'password', 'attachments', 'sender']) Object.defineProperty(message, key, { get() { throw new Error('Private field accessed: '+key); } });
  assert.equal(contacts.ingest(message), 4);
  assert.deepEqual(new Set(hints(contacts).map(contact => contact.address)), new Set(['from@example.org', 'to@example.org', 'cc@example.org', 'reply@example.org']));
  const getterPerson = Object.defineProperty({}, 'address', { get() { throw new Error('Getter accessed'); } });
  assert.equal(contacts.ingest({ from: [getterPerson] }), 0);
  assert.equal(contacts.ingest(Object.create({ from: [{ address: 'prototype@example.org' }] })), 0);
});

test('sender fallback requires a complete address and is ignored when From already identifies the sender', () => {
  const contacts = fixture();
  contacts.ingest([{ sender: 'Name only' }, { sender: 'alex.beispiel' }, { sender: 'User <real@example.org>' }, { from: [{ address: 'actual@example.org' }], sender: 'wrong@example.org' }]);
  assert.deepEqual(new Set(hints(contacts).map(contact => contact.address)), new Set(['real@example.org', 'actual@example.org']));
});

test('no account means no learned contacts; changing or disconnecting clears all suggestions', () => {
  const contacts = createMailContacts();
  assert.equal(contacts.ingest(header('alex@example.org')), 0);
  assert.equal(contacts.learnSent({ to: ['alex@example.org'] }), 0);
  assert.deepEqual(hints(contacts), []);
  contacts.setAccount(account); contacts.ingest(header('alex@example.org'));
  assert.equal(contacts.setAccount(account), false); assert.equal(contacts.size(), 1);
  assert.equal(contacts.setAccount('gmail:new-generation'), true); assert.equal(contacts.size(), 0);
  contacts.ingest(header('other@example.org')); contacts.setAccount(''); assert.equal(contacts.size(), 0);
  contacts.setAccount(account); contacts.ingest(header('alex@example.org')); contacts.setAccount('  '); assert.equal(contacts.size(), 0);
  contacts.setAccount(account); contacts.ingest(header('alex@example.org')); contacts.setAccount('invalid\nkey'); assert.equal(contacts.size(), 0);
  contacts.setAccount(account); contacts.ingest(header('alex@example.org')); contacts.reset(); assert.equal(contacts.size(), 0);
});

test('case-insensitive deduplication preserves a verified address and fills a later known name', () => {
  const contacts = fixture();
  contacts.ingest([header('Alex@example.org'), header('alex@EXAMPLE.ORG', 'Alex Beispiel'), header('alex@example.org')]);
  assert.equal(contacts.size(), 1);
  assert.deepEqual(hints(contacts, 'alex'), [{ address: 'Alex@example.org', name: 'Alex Beispiel' }]);
});

test('typing a known local part finds a verified full address without guessing its domain', () => {
  const contacts = fixture(); contacts.ingest(header('alex.beispiel@actual.example.org', 'Alex Beispiel'));
  assert.deepEqual(hints(contacts, 'alex.beispiel'), [{ address: 'alex.beispiel@actual.example.org', name: 'Alex Beispiel' }]);
  assert.deepEqual(hints(contacts, 'unseen.teacher'), []);
});

test('German names support umlauts, decomposed accents, ae/oe/ue spellings and case-insensitive name starts', () => {
  const contacts = fixture(); contacts.ingest([header('birgit@example.org', 'Birgit Müller'), header('joerg@example.org', 'Jörg Weiß'), header('alex@example.org', 'A\u0308nne Groß')]);
  for (const query of ['Müll', 'mull', 'Mueller']) assert.equal(hints(contacts, query)[0]?.address, 'birgit@example.org', query);
  for (const query of ['JÖRG', 'Joerg', 'Weiss']) assert.equal(hints(contacts, query)[0]?.address, 'joerg@example.org', query);
  for (const query of ['Anne', 'Änne', 'Gross']) assert.equal(hints(contacts, query)[0]?.address, 'alex@example.org', query);
});

test('exact local part outranks a name prefix and substring, regardless of recency', () => {
  const contacts = fixture();
  contacts.ingest([header('alex@example.org', 'Actual'), header('other@example.org', 'Alex Lehrerin'), header('last@example.org', 'Susalex')]);
  assert.deepEqual(hints(contacts, 'alex').map(person => person.address), ['alex@example.org', 'other@example.org', 'last@example.org']);
});

test('name token prefixes match a surname and still outrank general substring matches', () => {
  const contacts = fixture(); contacts.ingest([header('first@example.org', 'Alex Beispiel'), header('second@example.org', 'Notabeispiel')]);
  assert.deepEqual(hints(contacts, 'beis').map(person => person.address), ['first@example.org', 'second@example.org']);
});

test('suggestions exclude selected addresses across all recipient fields', () => {
  const contacts = fixture(); contacts.ingest([header('one@example.org', 'CoCo One'), header('two@example.org', 'CoCo Two'), header('three@example.org', 'CoCo Three'), header('four@example.org', 'CoCo Four')]);
  assert.deepEqual(hints(contacts, 'one@example.org; co', { field: 'to', fields: { to: 'old', cc: 'TWO@EXAMPLE.ORG', bcc: 'three@example.org' } }), [{ address: 'four@example.org', name: 'CoCo Four' }]);
  assert.deepEqual(hints(contacts, 'co', { field: 'cc', fields: { to: 'one@example.org', bcc: 'two@example.org, three@example.org' } }), [{ address: 'four@example.org', name: 'CoCo Four' }]);
});

test('later draft recipients beyond the send limit are also excluded, rather than suggested twice', () => {
  const contacts = fixture(); contacts.ingest(header('last@example.org', 'Last'));
  const selected = Array.from({ length: 55 }, (_, index) => 'recipient'+index+'@example.org').join(', ') + ', last@example.org';
  assert.deepEqual(hints(contacts, 'last', { fields: { cc: selected } }), []);
});

test('successful manual To/Cc usage learns bounded addresses, skips refusals, and never reads Bcc', () => {
  const contacts = fixture();
  const draft = { to: ['success@example.org', 'REFUSED@example.org', 'partial.name'], cc: ['cc@example.org'] };
  Object.defineProperty(draft, 'bcc', { get() { throw new Error('Bcc learning is forbidden'); } });
  assert.equal(contacts.learnSent(draft, { refused: ['refused@EXAMPLE.ORG'] }), 2);
  assert.deepEqual(new Set(hints(contacts).map(person => person.address)), new Set(['success@example.org', 'cc@example.org']));
});

test('manual usage wins ties and remains bounded when loaded mail headers fill the cache', () => {
  const contacts = fixture({ limit: 3 });
  contacts.learnSent({ to: ['known@example.org'] });
  contacts.ingest([header('one@example.org'), header('two@example.org'), header('three@example.org'), header('four@example.org')]);
  assert.equal(contacts.size(), 3);
  assert.deepEqual(hints(contacts).map(person => person.address), ['known@example.org', 'four@example.org', 'three@example.org']);
  contacts.learnSent({ to: ['second@example.org', 'third@example.org', 'fourth@example.org'] });
  assert.equal(contacts.size(), 3);
});

test('hard cache, ingestion and suggestion limits prevent unbounded memory or result lists', () => {
  const contacts = fixture({ limit: 50000 });
  for (let page = 0; page < 4; page++) contacts.ingest(Array.from({ length: 200 }, (_, index) => header('user'+(page*200+index)+'@example.org')));
  assert.equal(contacts.size(), MAIL_CONTACT_LIMITS.contacts);
  assert.equal(hints(contacts, '', { limit: 100 }).length, 8);
  assert.equal(hints(contacts, '', { limit: 2 }).length, 2);
  const limited = fixture(); limited.ingest(Array.from({ length: 201 }, (_, index) => header('bounded'+index+'@example.org')));
  assert.equal(limited.size(), 200);
  assert.equal(mailHeaderPeople(Array.from({ length: 51 }, (_, index) => ({ address: 'person'+index+'@example.org' }))).length, 50);
  assert.deepEqual(hints(contacts, 'x'.repeat(201)), []);
  assert.deepEqual(hints(contacts, 'x'.repeat(16001)), []);
});

test('active token tracks a cursor in the middle instead of replacing the last recipient', () => {
  const value = 'first@example.org, ale ; last@example.org';
  const cursor = value.indexOf('ale') + 2;
  assert.deepEqual(activeRecipientToken(value, cursor), { start: 18, end: 23, text: ' ale ', query: 'ale' });
  const replaced = replaceRecipientToken(value, cursor, 'alex@example.org');
  assert.deepEqual(replaced, { value: 'first@example.org, alex@example.org ; last@example.org', selectionStart: 35, selectionEnd: 35 });
});

test('token replacement preserves every other recipient, separators and surrounding spaces', () => {
  const value = 'one@example.org;  an  , three@example.org';
  const replaced = replaceRecipientToken(value, value.indexOf('an') + 1, 'alex@example.org');
  assert.equal(replaced.value, 'one@example.org;  alex@example.org  , three@example.org');
  assert.equal(replaced.value.slice(0, replaced.selectionStart), 'one@example.org;  alex@example.org');
  assert.deepEqual(replaceRecipientToken('', 0, 'alex@example.org'), { value: 'alex@example.org', selectionStart: 16, selectionEnd: 16 });
  assert.equal(replaceRecipientToken('one@example.org; ', 17, 'two@example.org').value, 'one@example.org; two@example.org');
});

test('quoted commas do not split a complete display-name token', () => {
  const value = 'one@example.org; "Beispiel, Alex" <alex@example.org>; last@example.org';
  const cursor = value.indexOf('Beispiel') + 2;
  assert.equal(activeRecipientToken(value, cursor).query, '"Beispiel, Alex" <alex@example.org>');
  assert.equal(replaceRecipientToken(value, cursor, 'other@example.org').value, 'one@example.org; other@example.org; last@example.org');
});

test('cross-token selections, invalid cursor positions and injected replacements fail closed', () => {
  const value = 'one@example.org; two';
  assert.equal(activeRecipientToken(value, 2, value.length), null);
  for (const cursor of [-1, value.length+1, 2.5, NaN]) assert.equal(activeRecipientToken(value, cursor), null);
  for (const address of ['alex.beispiel', 'x@example.org\nBcc: bad@example.org', 'X <x@example.org>']) assert.equal(replaceRecipientToken(value, value.length, address), null);
  assert.equal(activeRecipientToken('alex\n', 4), null);
  assert.equal(activeRecipientToken('x'.repeat(201), 100), null);
});

test('suggestion query follows the active cursor token and refuses invalid exclusion fields', () => {
  const contacts = fixture(); contacts.ingest([header('alex@example.org', 'Alex'), header('last@example.org', 'Last')]);
  const value = 'ale; las';
  assert.deepEqual(hints(contacts, value, { cursor: 2 }), [{ address: 'alex@example.org', name: 'Alex' }]);
  assert.deepEqual(hints(contacts, 'ale', { fields: { cc: 'x@example.org\n' } }), []);
  assert.deepEqual(hints(contacts, 'ale', { field: 'subject' }), []);
  assert.deepEqual(contacts.suggest({ value: null }), []);
  assert.deepEqual(contacts.suggest({ value: 123 }), []);
});

test('contact outputs are detached data, so consumer mutation cannot poison later suggestions', () => {
  const contacts = fixture(); contacts.ingest(header('alex@example.org', 'Alex'));
  const first = hints(contacts, 'ale'); first[0].address = 'attacker@example.org'; first[0].name = 'Other'; first.push({ address: 'extra@example.org' });
  assert.deepEqual(hints(contacts, 'ale'), [{ address: 'alex@example.org', name: 'Alex' }]);
});

test('engine has no persistence, network, credentials, body parsing, or cloud contact dependency', async () => {
  const source = await readFile(new URL('../dist/mail-contacts.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\b(?:fetch|localStorage|sessionStorage|indexedDB|XMLHttpRequest|navigator|window|document)\b/);
  assert.doesNotMatch(source, /from ['"]|import\s*\(/);
});
