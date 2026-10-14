// Recipient hints are deliberately scoped to one live mail account and kept in RAM.
export const MAIL_CONTACT_LIMITS = Object.freeze({ contacts: 500, suggestions: 8, headers: 200, people: 50, input: 16000, query: 200, name: 200 });
const unsafeText = /[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const atom = /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~.]+$/;
const addressKey = value => value.toLowerCase();
const own = (value, key) => {
  if (!value || typeof value !== 'object') return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch { return undefined; }
};

export function verifiedMailAddress(value) {
  if (typeof value !== 'string' || value.length > 254 || unsafeText.test(value)) return '';
  const address = value.trim();
  const parts = address.split('@');
  if (parts.length !== 2) return '';
  const [local, domain] = parts;
  if (!local || local.length > 64 || !atom.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return '';
  const labels = domain.split('.');
  if (labels.length < 2 || !/^[A-Za-z]{2,63}$/.test(labels.at(-1))) return '';
  if (labels.some(label => !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))) return '';
  return address;
}

function nameValue(value) {
  return typeof value === 'string' && value.length <= MAIL_CONTACT_LIMITS.name && !unsafeText.test(value)
    ? value.trim().replace(/ +/g, ' ') : '';
}

function ranges(value) {
  let quoted = false, angle = false, escaped = false, start = 0;
  const result = [];
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (escaped) { escaped = false; continue; }
    if (quoted && character === '\\') { escaped = true; continue; }
    if (character === '"') { quoted = !quoted; continue; }
    if (!quoted && character === '<') angle = true;
    else if (!quoted && character === '>') angle = false;
    else if (!quoted && !angle && (character === ',' || character === ';')) {
      result.push({ start, end: index }); start = index + 1;
    }
  }
  result.push({ start, end: value.length });
  return result;
}

function personToken(value) {
  const token = value.trim();
  const direct = verifiedMailAddress(token);
  if (direct) return { address: direct, name: '' };
  const match = token.match(/^([^<>]*)<([^<>]+)>$/);
  if (!match) return null;
  const address = verifiedMailAddress(match[2]);
  let name = match[1].trim();
  if (name.startsWith('"')) {
    if (!/^"(?:[^"\\]|\\["\\])*"$/.test(name)) return null;
    name = name.slice(1, -1).replace(/\\(["\\])/g, '$1');
  } else if (/["\\,;]/.test(name)) return null;
  if (!address || name.length > MAIL_CONTACT_LIMITS.name || unsafeText.test(name)) return null;
  return { address, name: nameValue(name) };
}

// This is a conservative parser, not an RFC header repairer: only complete,
// validated mailboxes are accepted. A name or partial local-part is never an address.
export function mailHeaderPeople(value) {
  if (typeof value === 'string') {
    if (value.length > MAIL_CONTACT_LIMITS.input || unsafeText.test(value)) return [];
    return ranges(value).slice(0, MAIL_CONTACT_LIMITS.people)
      .map(range => personToken(value.slice(range.start, range.end))).filter(Boolean);
  }
  if (!Array.isArray(value)) return [];
  const result = [];
  for (let index = 0; index < Math.min(value.length, MAIL_CONTACT_LIMITS.people); index++) {
    const person = own(value, String(index));
    if (typeof person === 'string') {
      const parsed = person.length <= 1024 && !unsafeText.test(person) ? personToken(person) : null;
      if (parsed) result.push(parsed);
      continue;
    }
    const address = verifiedMailAddress(own(person, 'address'));
    const rawName = own(person, 'name');
    if (address && (rawName === undefined || typeof rawName === 'string' && rawName.length <= MAIL_CONTACT_LIMITS.name && !unsafeText.test(rawName))) {
      result.push({ address, name: nameValue(rawName) });
    }
  }
  return result;
}

export function activeRecipientToken(value, cursor, selectionEnd = cursor) {
  if (typeof value !== 'string' || value.length > MAIL_CONTACT_LIMITS.input || unsafeText.test(value)) return null;
  if (!Number.isInteger(cursor) || !Number.isInteger(selectionEnd) || cursor < 0 || selectionEnd < cursor || selectionEnd > value.length) return null;
  const range = ranges(value).find(item => cursor >= item.start && cursor <= item.end);
  if (!range || selectionEnd > range.end) return null;
  const text = value.slice(range.start, range.end);
  const query = text.trim();
  if (query.length > MAIL_CONTACT_LIMITS.query) return null;
  return { ...range, text, query };
}

export function replaceRecipientToken(value, cursor, address, selectionEnd = cursor) {
  const verified = verifiedMailAddress(address);
  const token = activeRecipientToken(value, cursor, selectionEnd);
  if (!verified || !token) return null;
  const leading = token.text.match(/^ */)[0];
  const trailing = token.text.trim() ? token.text.match(/ *$/)[0] : '';
  const replacement = leading + verified + trailing;
  const caret = token.start + leading.length + verified.length;
  return { value: value.slice(0, token.start) + replacement + value.slice(token.end), selectionStart: caret, selectionEnd: caret };
}

function fold(value) {
  return value.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/ß/g, 'ss').replace(/\s+/g, ' ').trim();
}
function variants(value) {
  const german = value.toLowerCase().replace(/[äöü]/g, character => ({ ä: 'ae', ö: 'oe', ü: 'ue' })[character]);
  return [...new Set([fold(value), fold(german)])];
}
function matchRank(contact, query) {
  if (!query) return 1;
  const queries = variants(query);
  let best = 0;
  for (const needle of queries) {
    for (const address of variants(contact.address)) {
      const local = address.split('@')[0];
      if (address === needle) best = Math.max(best, 10000);
      else if (local === needle) best = Math.max(best, 9000);
      else if (address.startsWith(needle)) best = Math.max(best, 7000);
      else if (address.includes(needle)) best = Math.max(best, 4000);
    }
    for (const name of variants(contact.name)) {
      if (!name) continue;
      if (name === needle) best = Math.max(best, 8000);
      else if (name.startsWith(needle)) best = Math.max(best, 6500);
      else if (name.split(/[\s,.-]+/).some(part => part.startsWith(needle))) best = Math.max(best, 6000);
      else if (name.includes(needle)) best = Math.max(best, 3500);
    }
  }
  return best;
}

export function createMailContacts({ limit = MAIL_CONTACT_LIMITS.contacts } = {}) {
  const cap = Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAIL_CONTACT_LIMITS.contacts) : MAIL_CONTACT_LIMITS.contacts;
  let account = '', sequence = 0;
  const contacts = new Map();
  const clear = () => { contacts.clear(); sequence = 0; };
  function add(person, learned = false) {
    const key = addressKey(person.address);
    const old = contacts.get(key);
    contacts.delete(key);
    contacts.set(key, { address: old?.address || person.address, name: person.name || old?.name || '', learned: learned || old?.learned === true, seen: ++sequence });
    while (contacts.size > cap) {
      const expendable = [...contacts].find(([, candidate]) => !candidate.learned)?.[0] || contacts.keys().next().value;
      contacts.delete(expendable);
    }
  }
  function setAccount(key) {
    const next = typeof key === 'string' && key.length <= 512 && !unsafeText.test(key) ? key.trim() : '';
    const changed = next !== account;
    if (changed || !next) clear();
    account = next;
    return changed;
  }
  function ingest(messages) {
    if (!account) return 0;
    const input = Array.isArray(messages) ? messages : [messages];
    let added = 0;
    for (let index = 0; index < Math.min(input.length, MAIL_CONTACT_LIMITS.headers); index++) {
      const message = own(input, String(index));
      if (!message || typeof message !== 'object') continue;
      const from = mailHeaderPeople(own(message, 'from'));
      const people = [...from, ...mailHeaderPeople(own(message, 'to')), ...mailHeaderPeople(own(message, 'cc')), ...mailHeaderPeople(own(message, 'replyTo'))];
      if (!from.length) people.push(...mailHeaderPeople(own(message, 'sender')));
      for (const person of people) { add(person); added++; }
    }
    return added;
  }
  function learnSent(draft, { refused = [] } = {}) {
    if (!account || !draft || typeof draft !== 'object') return 0;
    const rejected = new Set(mailHeaderPeople(refused).map(person => addressKey(person.address)));
    let added = 0;
    // Bcc is never accessed or retained, including after successful delivery.
    for (const field of ['to', 'cc']) {
      for (const person of mailHeaderPeople(own(draft, field))) {
        if (!rejected.has(addressKey(person.address))) { add(person, true); added++; }
      }
    }
    return added;
  }
  function suggest({ value = '', cursor = typeof value === 'string' ? value.length : 0, selectionEnd = cursor, field = 'to', fields = {}, limit: maximum = MAIL_CONTACT_LIMITS.suggestions } = {}) {
    if (!account || !['to', 'cc', 'bcc'].includes(field)) return [];
    const token = activeRecipientToken(value, cursor, selectionEnd);
    if (!token) return [];
    const excluded = new Set();
    for (const name of ['to', 'cc', 'bcc']) {
      const recipients = name === field ? value : own(fields, name) ?? '';
      if (typeof recipients !== 'string' || recipients.length > MAIL_CONTACT_LIMITS.input || unsafeText.test(recipients)) return [];
      // The draft may temporarily exceed the send limit. Still exclude every
      // complete address, rather than accidentally suggesting a later duplicate.
      for (const range of ranges(recipients)) {
        const person = personToken(recipients.slice(range.start, range.end));
        if (person) excluded.add(addressKey(person.address));
      }
    }
    const count = Number.isInteger(maximum) && maximum > 0 ? Math.min(maximum, MAIL_CONTACT_LIMITS.suggestions) : MAIL_CONTACT_LIMITS.suggestions;
    return [...contacts.values()].map(contact => ({ contact, rank: matchRank(contact, token.query) }))
      .filter(item => item.rank && !excluded.has(addressKey(item.contact.address)))
      .sort((left, right) => right.rank - left.rank || Number(right.contact.learned) - Number(left.contact.learned) || right.contact.seen - left.contact.seen || left.contact.address.localeCompare(right.contact.address))
      .slice(0, count).map(({ contact }) => ({ address: contact.address, name: contact.name }));
  }
  return Object.freeze({ setAccount, ingest, learnSent, suggest, reset: () => { account = ''; clear(); }, size: () => contacts.size });
}
