import {createHash} from 'node:crypto';
import {MailError, validateDraft} from './mail.mjs';

// OAuth credentials remain inside Nango. This adapter only accepts its injected,
// capability-checked proxy. Provider responses are never rendered or evaluated.
// https://learn.microsoft.com/graph/api/user-list-messages
// https://learn.microsoft.com/graph/api/user-sendmail
// https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages
// https://developers.google.com/workspace/gmail/api/guides/sending
const PAGE = 40, MAX_MESSAGE = 12 * 1024 * 1024, MAX_ATTACHMENT = 8 * 1024 * 1024;
const MAX_PARTS = 200, MAX_TEXT = 200000, MAX_JSON = 20 * 1024 * 1024;
const addressPattern = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const validAddress = value => typeof value === 'string' && value.length <= 254 && addressPattern.test(value);
const clean = (value, max = MAX_TEXT) => typeof value === 'string' ? value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').slice(0, max) : '';
const line = (value, max = 1000) => clean(value, max).replace(/[\r\n\t]/g, ' ').trim();
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const id = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_~+./=-]{1,2048}$/.test(value) || value.split('/').some(part => part === '.' || part === '..')) throw fail('invalid_request');
  return value;
};
const segment = value => encodeURIComponent(id(value));
function fail(code, status) {
  const error = new MailError(code);
  const messages = {
    not_configured: 'Verbinde zuerst das ausgewählte Cloud-Mailkonto.',
    auth_failed: 'Die Cloud-Anmeldung ist abgelaufen. Verbinde das Konto erneut.',
    connection_failed: 'Der Cloud-Mailanbieter ist gerade nicht erreichbar.',
    mailbox_changed: 'Das ausgewählte Cloud-Konto hat sich geändert. Aktualisiere die Mailansicht.',
    message_too_large: 'Diese Nachricht ist größer als 12 MB. Öffne sie beim Mailanbieter.',
    send_failed: 'Der Mailanbieter hat die Nachricht abgelehnt. Sie wurde nicht angenommen.',
    delivery_unknown: 'Der Versandstatus ist unklar. Prüfe den Gesendet-Ordner beim Mailanbieter, bevor du erneut sendest.',
    cancelled: 'Die Cloud-Mailverbindung wurde geändert oder getrennt.',
    permission_denied: 'Die benötigten Mailrechte sind für diese Verbindung nicht freigegeben.',
    invalid_response: 'Der Mailanbieter hat keine gültige Antwort geliefert.',
  };
  if (messages[code]) error.message = messages[code];
  if (['permission_denied', 'invalid_response'].includes(code)) { error.code = code; error.status = code === 'permission_denied' ? 403 : 502; }
  if (status) error.status = status;
  return error;
}
function safeError(error, action = 'read') {
  if (error instanceof MailError) return error;
  const status = Number(error?.status);
  if (action === 'send') return fail([400,401,403,404,413,422,429].includes(status) ? 'send_failed' : 'delivery_unknown');
  if (status === 401 || ['auth_failed', 'reconnect_required'].includes(error?.code)) return fail('auth_failed');
  if (status === 403 || ['permission_denied', 'capability_denied', 'capability_required'].includes(error?.code)) return fail('permission_denied');
  if (status === 404) return fail('message_unavailable');
  if (status === 429) return fail('busy');
  if (error?.code === 'cancelled' || error?.name === 'AbortError') return fail('cancelled');
  return fail('connection_failed');
}
function iso(value) {
  if (typeof value !== 'string' || value.length > 200) return '';
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : '';
}
function filename(value) {
  return line(value, 2000).split(/[\\/]/).at(-1)?.slice(0, 180) || 'Anhang';
}
function base64(value, limit, url = false) {
  if (typeof value !== 'string') throw fail('invalid_response');
  if (value.length > Math.ceil(limit / 3) * 4 + 4) throw fail(limit === MAX_ATTACHMENT ? 'attachment_too_large' : 'message_too_large');
  if (!(url ? /^[A-Za-z0-9_-]*={0,2}$/ : /^[A-Za-z0-9+/]*={0,2}$/).test(value)) throw fail('invalid_response');
  const unpadded = value.replace(/=+$/, '');
  if (unpadded.length % 4 === 1) throw fail('invalid_response');
  const bytes = Buffer.from(value, url ? 'base64url' : 'base64');
  if (bytes.length > limit) throw fail(limit === MAX_ATTACHMENT ? 'attachment_too_large' : 'message_too_large');
  if (bytes.toString(url ? 'base64url' : 'base64').replace(/=+$/, '') !== unpadded) throw fail('invalid_response');
  return bytes;
}
function decode(bytes, charset = 'utf-8') {
  const label = typeof charset === 'string' && /^[A-Za-z0-9._-]{1,60}$/.test(charset) ? charset : 'utf-8';
  try { return new TextDecoder(label).decode(bytes); } catch { return bytes.toString('utf8'); }
}
function decodeWords(value) {
  return line(value, 65536).replace(/(=\?[^? ]{1,60}\?[bq]\?[^?]*\?=)\s+(?==\?)/gi, '$1').replace(/=\?([^? ]{1,60})\?([bq])\?([^?]{0,4096})\?=/gi, (word, charset, encoding, body) => {
    try {
      const bytes = encoding.toLowerCase() === 'b' ? base64(body, 4096) : Buffer.from(body.replace(/_/g, ' ').replace(/=([0-9a-f]{2})/gi, (_, code) => String.fromCharCode(parseInt(code, 16))), 'latin1');
      return decode(bytes, charset);
    } catch { return word; }
  });
}
function headers(payload) {
  const result = new Map(); let size = 0;
  if (!Array.isArray(payload?.headers) || payload.headers.length > 1000) throw fail('invalid_response');
  for (const field of payload.headers) {
    if (typeof field?.name !== 'string' || typeof field.value !== 'string') continue;
    size += field.name.length + field.value.length;
    if (size > 65536) throw fail('message_too_large');
    const name = field.name.toLowerCase();
    if (!result.has(name)) result.set(name, field.value);
  }
  return result;
}
function people(value) {
  // Split address lists only outside quoted names, comments and angle brackets.
  // Decode encoded words *after* parsing: encoded display-name commas/addresses
  // must never become additional reply recipients.
  const source = line(value, 65536); const parts = []; let part = '', quote = false, angle = 0, comment = 0, escaped = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (source.startsWith('=?', index)) { const word = source.slice(index, index + 4240).match(/^=\?[^? ]{1,60}\?[bq]\?[^?]{0,4096}\?=/i)?.[0]; if (word) {part += word; index += word.length - 1; continue;} }
    if (escaped) { part += char; escaped = false; continue; }
    if (char === '\\' && quote) { part += char; escaped = true; continue; }
    if (char === '"' && !comment) quote = !quote;
    if (!quote) { if (char === '(') comment++; if (char === ')' && comment) comment--; if (!comment && char === '<') angle++; if (!comment && char === '>' && angle) angle--; }
    if (char === ',' && !quote && !angle && !comment) { parts.push(part); part = ''; } else part += char;
  }
  parts.push(part);
  return parts.slice(0, 50).flatMap(part => {
    const open = part.lastIndexOf('<'), close = open >= 0 ? part.indexOf('>', open + 1) : -1;
    let name = '', candidate = '';
    if (open >= 0) {
      if (close < 0) return [];
      const tail = part.slice(close + 1).trim();
      if (tail && !(tail.startsWith('(') && tail.endsWith(')'))) return [];
      name = part.slice(0, open).trim().replace(/^"|"$/g, '').replace(/\\(["\\])/g, '$1');
      candidate = part.slice(open + 1, close);
    } else {
      let depth = 0;
      for (const char of part) {if (char === '(') depth++; else if (char === ')') depth = Math.max(0, depth - 1); else if (!depth) candidate += char;}
      candidate = candidate.replace(/^[^:]+:\s*/, '').replace(/;\s*$/, '');
    }
    const address = candidate.trim();
    if (!validAddress(address)) return [];
    return [{name:line(decodeWords(name), 200), address}];
  });
}
function graphPeople(value) {
  return (Array.isArray(value) ? value : value ? [value] : []).slice(0, 50).flatMap(person => {
    const address = typeof person?.emailAddress?.address === 'string' ? person.emailAddress.address.trim() : '';
    return validAddress(address) ? [{name: line(person.emailAddress.name, 200), address}] : [];
  });
}
function graphEnvelope(message) {
  const from = graphPeople(message.from || message.sender);
  return {subject: line(message.subject, 1000) || '(Kein Betreff)', sender: from.map(p => p.name ? `${p.name} <${p.address}>` : p.address).join(', '), from,
    to: graphPeople(message.toRecipients), cc: graphPeople(message.ccRecipients), replyTo: graphPeople(message.replyTo), date: iso(message.receivedDateTime || message.sentDateTime), messageId: line(message.internetMessageId, 500)};
}
function gmailEnvelope(message) {
  const fields = headers(message.payload), from = people(fields.get('from'));
  const milliseconds = typeof message.internalDate === 'string' && /^\d{1,16}$/.test(message.internalDate) ? Number(message.internalDate) : NaN;
  const date = Number.isFinite(milliseconds) && milliseconds <= 8640000000000000 ? new Date(milliseconds).toISOString() : iso(fields.get('date'));
  return {subject: line(decodeWords(fields.get('subject')), 1000) || '(Kein Betreff)', sender: line(decodeWords(fields.get('from')), 1000), from,
    to: people(fields.get('to')), cc: people(fields.get('cc')), replyTo: people(fields.get('reply-to')), date, messageId: line(fields.get('message-id'), 500)};
}
const entities = {amp:'&', lt:'<', gt:'>', quot:'"', apos:"'", nbsp:' ', hellip:'…', ndash:'–', mdash:'—', copy:'©', reg:'®', trade:'™', euro:'€'};
function unescapeHTML(value) {
  return value.replace(/&(#x[0-9a-f]{1,8}|#\d{1,8}|[a-z]{2,12});/gi, (original, name) => {
    if (name[0] !== '#') return entities[name.toLowerCase()] ?? original;
    const point = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : '�';
  });
}
function htmlText(value) {
  // A bounded text tokenizer, not a DOM. Attributes/URLs are deliberately ignored.
  const blocked = new Map(), parts = []; let cursor = 0, blockedCount = 0;
  const hidden = new Set(['script','style','head','iframe','object','svg','template','noscript']);
  const blocks = new Set(['p','div','br','li','tr','h1','h2','h3','h4','h5','h6','blockquote','hr','table']);
  while (cursor < value.length) {
    const start = value.indexOf('<', cursor);
    if (start < 0) { if (!blockedCount) parts.push(unescapeHTML(value.slice(cursor))); break; }
    if (!blockedCount) parts.push(unescapeHTML(value.slice(cursor, start)));
    if (value.startsWith('<!--', start)) { const end = value.indexOf('-->', start + 4); cursor = end < 0 ? value.length : end + 3; continue; }
    let end = start + 1, quote = '';
    for (; end < value.length && end - start <= 4096; end++) {
      const char = value[end];
      if (quote) { if (char === quote) quote = ''; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
    }
    // Consume malformed/overlong tags once; retrying at each '<' would make a
    // crafted 12-MB mail quadratic. Hidden-tag counters also have fixed size.
    if (value[end] !== '>') { cursor = end; continue; }
    const tag = value.slice(start + 1, end).match(/^\s*(\/?)\s*([a-z][a-z0-9:-]*)\b/i);
    cursor = end + 1;
    if (!tag) continue;
    const name = tag[2].toLowerCase(), closing = !!tag[1];
    if (hidden.has(name)) {
      if (closing) { const count = blocked.get(name) || 0; if (count) {blocked.set(name, count - 1); blockedCount--;} }
      else if (!/\/\s*$/.test(value.slice(start + 1, end))) {blocked.set(name, (blocked.get(name) || 0) + 1); blockedCount++;}
    }
    if (!blockedCount && blocks.has(name)) parts.push('\n');
  }
  return clean(parts.join(''), MAX_MESSAGE).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
function mime(draft, address, requestId) {
  const encoded = value => {
    const words = []; let chunk = '';
    for (const char of value) { if (Buffer.byteLength(chunk + char) > 42) { words.push(chunk); chunk = ''; } chunk += char; }
    if (chunk) words.push(chunk);
    return words.map(word => `=?UTF-8?B?${Buffer.from(word).toString('base64')}?=`).join('\r\n ');
  };
  const wrap = value => value.match(/.{1,76}/g)?.join('\r\n') || '';
  const encodedFilename = value => {
    const encoded = encodeURIComponent(value).replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase());
    if (encoded.length <= 60) return `filename*=UTF-8''${encoded}`;
    return encoded.match(/(?:%[A-F0-9]{2}|[^%]){1,20}/g).map((part, index) => `filename*${index}*=${index === 0 ? "UTF-8''" : ''}${part}`).join(';\r\n ');
  };
  const boundary = 'context-' + hash(requestId).slice(0, 40), messageId = `<context-${requestId}@${address.split('@')[1]}>`;
  const head = [`From: ${address}`, `To: ${draft.to.join(',\r\n ')}`, ...(draft.cc.length ? [`Cc: ${draft.cc.join(',\r\n ')}`] : []), ...(draft.bcc.length ? [`Bcc: ${draft.bcc.join(',\r\n ')}`] : []), `Subject: ${encoded(draft.subject)}`, `Date: ${new Date().toUTCString()}`, `Message-ID: ${messageId}`, 'MIME-Version: 1.0', ...(draft.inReplyTo ? [`In-Reply-To: ${draft.inReplyTo}`, `References: ${draft.inReplyTo}`] : [])];
  const textPart = ['Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', wrap(Buffer.from(draft.text.replace(/\r?\n/g, '\r\n')).toString('base64'))].join('\r\n');
  if (!draft.attachments.length) return {content: [...head, textPart].join('\r\n'), messageId};
  const parts = draft.attachments.map(file => `--${boundary}\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="attachment.bin"; ${encodedFilename(file.name)}\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap(file.data)}`);
  return {content: [...head, `Content-Type: multipart/mixed; boundary="${boundary}"`, '', `--${boundary}\r\n${textPart}`, ...parts, `--${boundary}--`, ''].join('\r\n'), messageId};
}

export function createNangoMailClient({nango, service} = {}) {
  if (!['outlook', 'gmail'].includes(service) || typeof nango?.status !== 'function' || typeof nango?.proxy !== 'function') throw fail('invalid_request');
  const root = service === 'outlook' ? '/v1.0/me' : '/gmail/v1/users/me';
  let binding = null, epoch = 0, statusVersion = 0, profileVersion = 0, observedAccount = null;
  const active = new Set(), pages = new Map(), sent = new Map();
  function invalidate() { epoch++; profileVersion++; observedAccount = null; pages.clear(); for (const controller of active) controller.abort(); }
  async function current() {
    const version = ++statusVersion;
    let raw; try { raw = await nango.status(service); } catch (error) { throw safeError(error); }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw fail('invalid_response');
    const connected = raw.connected === true, connectionId = typeof raw.connectionId === 'string' ? raw.connectionId : '', integrationId = typeof raw.integrationId === 'string' ? raw.integrationId : '', revision = raw.revision;
    if (typeof revision !== 'string' || !/^\d{1,20}:\d{1,20}$/.test(revision) || connectionId.length > 512 || integrationId.length > 200 || /[\x00-\x20\x7f]/.test(connectionId + integrationId) || connected && (!connectionId || !integrationId)) throw fail('invalid_response');
    const capabilities = Object.fromEntries(['mailRead','mailSend','mailModify'].map(key => [key, raw.capabilities?.[key] === true]));
    const next = {connected, connectionId, integrationId, revision, capabilities};
    next.key = JSON.stringify([service, connected, integrationId, connectionId, revision, capabilities]);
    next.uidValidity = connected ? hash(JSON.stringify([service, integrationId, connectionId, revision])) : '';
    if (version !== statusVersion) { if (!binding || binding.key !== next.key) throw fail('cancelled'); return binding; }
    if (binding && binding.key !== next.key) invalidate();
    binding = next; return next;
  }
  function access(value, capability) {
    if (!value.connected) throw fail('not_configured');
    if (capability && !value.capabilities[capability]) throw fail('permission_denied');
    return value;
  }
  function target(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.uidValidity !== 'string' || !/^[a-f0-9]{64}$/.test(data.uidValidity)) throw fail('invalid_request');
    return {folder:id(data.folder), uid:id(data.uid), uidValidity:data.uidValidity};
  }
  async function run(capability, action, fn, selected) {
    const live = access(await current(), capability);
    if (active.size >= 3) throw fail('busy');
    const controller = new AbortController(), context = {binding:live, controller, epoch, signal:AbortSignal.any([controller.signal, AbortSignal.timeout(45000)]), action, dispatched:false};
    active.add(controller);
    try {
      context.account = await getProfile(context);
      if (selected && selected.uidValidity !== context.account.key) throw fail('mailbox_changed');
      const value = await fn(context), accountAfter = await getProfile(context), after = await current();
      if (accountAfter.key !== context.account.key || after.key !== live.key || context.epoch !== epoch) throw fail(context.dispatched ? 'delivery_unknown' : 'cancelled');
      return value;
    }
    catch (error) {
      if (context.epoch !== epoch || context.signal.aborted) throw fail(context.dispatched ? 'delivery_unknown' : 'cancelled');
      // Even a failed *status* read after POST may hide an accepted delivery.
      if (context.dispatched && action === 'send') throw error?.code === 'send_failed' ? error : fail('delivery_unknown');
      throw safeError(error);
    }
    finally { active.delete(controller); }
  }
  async function proxy(context, request) {
    const live = access(await current(), request.method === 'GET' ? 'mailRead' : context.action === 'send' ? 'mailSend' : 'mailModify');
    if (live.key !== context.binding.key || context.epoch !== epoch || context.signal.aborted) throw fail(context.action === 'send' ? 'delivery_unknown' : 'cancelled');
    let response;
    const isSend = context.action === 'send' && request.method === 'POST';
    if (isSend) context.dispatched = true;
    try { response = await nango.proxy(service, {...request, identity:{integrationId:context.binding.integrationId, connectionId:context.binding.connectionId, revision:context.binding.revision, capabilities:context.binding.capabilities}, headers:{Accept:'application/json', ...(service === 'outlook' ? {Prefer:'outlook.body-content-type="text", IdType="ImmutableId"'} : {}), ...request.headers}}, context.signal); }
    catch (error) { throw safeError(error, isSend ? 'send' : 'read'); }
    const after = await current();
    if (after.key !== context.binding.key || context.epoch !== epoch || context.signal.aborted) throw fail(context.action === 'send' ? 'delivery_unknown' : 'cancelled');
    if (!response || !Number.isInteger(response.status)) throw fail(isSend ? 'delivery_unknown' : 'invalid_response');
    if (response.status < 200 || response.status >= 300) {
      // A definite provider rejection is distinct from a lost/ambiguous response.
      if (isSend) throw fail([400,401,403,404,413,422,429].includes(response.status) ? 'send_failed' : 'delivery_unknown');
      throw safeError({status:response.status});
    }
    if (isSend && service === 'outlook') { if (response.status !== 202) throw fail('delivery_unknown'); return {accepted:true}; }
    if (!response.data || typeof response.data !== 'object' || Array.isArray(response.data)) throw fail(isSend ? 'delivery_unknown' : 'invalid_response');
    let size; try { size = Buffer.byteLength(JSON.stringify(response.data)); } catch { throw fail('invalid_response'); }
    if (size > MAX_JSON) throw fail('message_too_large');
    return response.data;
  }
  function continuation(value, expectedPath) {
    if (!value) return null;
    if (typeof value !== 'string' || value.length > 8192) throw fail('invalid_response');
    let parsed; try { parsed = new URL(value); } catch { throw fail('invalid_response'); }
    const samePath = () => { try { const actual = parsed.pathname.split('/'), expected = expectedPath.split('/'); return actual.length === expected.length && actual.every((part, index) => decodeURIComponent(part) === decodeURIComponent(expected[index])); } catch { return false; } };
    if (parsed.origin !== 'https://graph.microsoft.com' || parsed.username || parsed.password || parsed.hash || !samePath()) throw fail('invalid_response');
    const params = Object.fromEntries(parsed.searchParams);
    if (Object.keys(params).some(key => !['$top','$skip','$skiptoken','$select','$filter','$orderby','$count','$search'].includes(key))) throw fail('invalid_response');
    return {method:'GET', path:expectedPath, params};
  }
  async function collection(context, request, max = 1000, truncate = false) {
    const items = []; let next = request, count = 0;
    while (next) {
      if (++count > 100) throw fail('invalid_response');
      const response = await proxy(context, next);
      if (!Array.isArray(response.value)) throw fail('invalid_response');
      if (items.length + response.value.length > max) { if (!truncate) throw fail('invalid_response'); items.push(...response.value.slice(0, max - items.length)); items.limited = true; return items; }
      items.push(...response.value); next = continuation(response['@odata.nextLink'], request.path);
      if (truncate && next && items.length === max) { items.limited = true; return items; }
    }
    return items;
  }
  async function getProfile(context) {
    const version = ++profileVersion;
    const response = await proxy(context, {method:'GET', path:service === 'outlook' ? root : root + '/profile', ...(service === 'outlook' ? {params:{$select:'id,mail,userPrincipalName,displayName'}} : {})});
    const rawAddress = service === 'outlook' ? response.mail || response.userPrincipalName : response.emailAddress;
    const address = typeof rawAddress === 'string' ? rawAddress.trim() : '';
    if (!validAddress(address)) throw fail('invalid_response');
    const accountID = service === 'outlook' ? id(response.id) : 'gmail:' + address.toLowerCase();
    const value = {id:accountID, address, total:integer(response.messagesTotal), key:hash(JSON.stringify([context.binding.uidValidity, accountID, address.toLowerCase()]))};
    // Never accept a late profile A after a newer profile B was observed. A
    // dashboard-side OAuth replacement can retain the same Nango connection ID.
    if (version !== profileVersion && (!observedAccount || observedAccount.key !== value.key)) throw fail('cancelled');
    if (observedAccount && observedAccount.key !== value.key) {
      epoch++; pages.clear();
      for (const controller of active) if (controller !== context.controller) controller.abort();
      context.epoch = epoch;
    }
    observedAccount = value;
    return value;
  }
  async function status() {
    const live = await current();
    const shape = (selected, account) => ({configured:selected.connected && selected.capabilities.mailRead, connected:selected.connected, address:account?.address || '', smtpReady:!!account && selected.capabilities.mailSend, storage:selected.connected ? 'nango' : '', backend:'nango', service, capabilities:selected.capabilities, revision:selected.revision, uidValidity:account?.key || '', accountKey:account?.key || ''});
    const value = shape(live);
    if (!value.configured) return value;
    return run('mailRead', 'read', context => shape(context.binding, context.account));
  }
  async function folders() {
    return run('mailRead', 'read', async context => {
      if (service === 'gmail') {
        const response = await proxy(context, {method:'GET', path:root + '/labels'});
        if (!Array.isArray(response.labels) || response.labels.length > 1000) throw fail('invalid_response');
        const kinds = {INBOX:'inbox', SENT:'sent', DRAFT:'drafts', TRASH:'trash', SPAM:'junk'};
        const excluded = new Set(['UNREAD','STARRED','IMPORTANT','CHAT','CATEGORY_PERSONAL','CATEGORY_SOCIAL','CATEGORY_PROMOTIONS','CATEGORY_UPDATES','CATEGORY_FORUMS']);
        return {folders:response.labels.filter(folder => !excluded.has(folder.id)).map(folder => ({id:id(folder.id), label:line(folder.name, 300) || folder.id, kind:kinds[folder.id] || 'folder'})).sort((a,b) => (a.kind === 'inbox' ? -1 : b.kind === 'inbox' ? 1 : 0))};
      }
      const known = new Map();
      for (const [alias, kind] of [['inbox','inbox'],['sentitems','sent'],['drafts','drafts'],['deleteditems','trash'],['junkemail','junk']]) {
        try { const folder = await proxy(context, {method:'GET', path:root + '/mailFolders/' + alias, params:{$select:'id'}}); known.set(id(folder.id), kind); }
        catch (error) { if (error.code !== 'message_unavailable') throw error; }
      }
      const result = [], seen = new Set(), queue = [{path:root + '/mailFolders', parent:''}];
      while (queue.length) {
        const item = queue.shift(), rows = await collection(context, {method:'GET', path:item.path, params:{$top:100, $select:'id,displayName,childFolderCount'}}, 1000 - result.length);
        for (const folder of rows) {
          const folderId = id(folder.id); if (seen.has(folderId)) continue; seen.add(folderId);
          const label = [item.parent, line(folder.displayName, 300) || 'Ordner'].filter(Boolean).join(' / ').slice(0, 600);
          result.push({id:folderId, label, kind:known.get(folderId) || 'folder'});
          if (integer(folder.childFolderCount)) queue.push({path:root + '/mailFolders/' + segment(folderId) + '/childFolders', parent:label});
        }
        if (queue.length > 1000 || result.length > 1000) throw fail('invalid_response');
      }
      return {folders:result.sort((a,b) => (a.kind === 'inbox' ? -1 : b.kind === 'inbox' ? 1 : 0))};
    });
  }
  function listInput(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data) || !Number.isSafeInteger(data.offset ?? 0) || (data.offset ?? 0) < 0 || (data.offset ?? 0) > 10000000 || typeof (data.query ?? '') !== 'string' || (data.query ?? '').length > 200 || /[\x00-\x1f\x7f]/.test(data.query ?? '') || data.unread !== undefined && typeof data.unread !== 'boolean') throw fail('invalid_request');
    return {folder:id(data.folder), offset:data.offset ?? 0, query:data.query ?? '', unread:!!data.unread};
  }
  async function list(data) {
    const selected = listInput(data);
    return run('mailRead', 'read', async context => {
      const key = JSON.stringify([selected.folder, selected.query, selected.unread]);
      let markers = pages.get(key);
      if (selected.offset === 0) { if (pages.size >= 50) pages.delete(pages.keys().next().value); markers = new Map(); pages.set(key, markers); }
      else if (!markers?.has(selected.offset)) throw fail('invalid_request');
      if (service === 'outlook') {
        const path = root + '/mailFolders/' + segment(selected.folder) + '/messages';
        const params = {$top:PAGE, $select:'id,subject,from,toRecipients,ccRecipients,replyTo,receivedDateTime,sentDateTime,internetMessageId,isRead', $count:'true'};
        if (selected.query) params.$search = JSON.stringify(selected.query);
        else params.$orderby = 'receivedDateTime desc';
        if (selected.unread) params.$filter = selected.query ? 'isRead eq false' : 'receivedDateTime ge 0001-01-01T00:00:00Z and isRead eq false';
        const response = await proxy(context, selected.offset ? markers.get(selected.offset) : {method:'GET', path, params});
        if (!Array.isArray(response.value) || response.value.length > PAGE) throw fail('invalid_response');
        const items = response.value.map(message => ({uid:id(message.id), unread:message.isRead !== true, size:integer(message.size), ...graphEnvelope(message)}));
        const next = continuation(response['@odata.nextLink'], path), nextOffset = next ? selected.offset + PAGE : null;
        if (next) markers.set(nextOffset, next);
        const matched = Number.isSafeInteger(response['@odata.count']) ? integer(response['@odata.count']) : selected.offset + items.length + (next ? 1 : 0);
        return {folder:selected.folder, uidValidity:context.account.key, items, total:matched, matched, offset:selected.offset, nextOffset, estimated:response['@odata.count'] === undefined};
      }
      const q = [selected.query ? JSON.stringify(selected.query) : '', selected.unread ? 'is:unread' : ''].filter(Boolean).join(' ');
      const response = await proxy(context, {method:'GET', path:root + '/messages', params:{maxResults:PAGE, labelIds:[selected.folder], includeSpamTrash:['SPAM','TRASH'].includes(selected.folder), ...(q ? {q} : {}), ...(selected.offset ? {pageToken:markers.get(selected.offset)} : {})}});
      if (response.messages !== undefined && (!Array.isArray(response.messages) || response.messages.length > PAGE)) throw fail('invalid_response');
      const items = [];
      const messages = response.messages || [];
      // Nango verifies each proxy request remotely. Serial metadata reads can
      // exceed the operation deadline even when every provider request succeeds.
      // Four reads per batch keep latency bounded and preserve provider order.
      for (let start = 0; start < messages.length; start += 4) {
        const batch = await Promise.allSettled(messages.slice(start, start + 4).map(async item => {
          const uid = id(item.id), message = await proxy(context, {method:'GET', path:root + '/messages/' + segment(uid), params:{format:'metadata', metadataHeaders:['Subject','From','To','Cc','Reply-To','Date','Message-ID']}});
          if (id(message.id) !== uid || !Array.isArray(message.labelIds)) throw fail('invalid_response');
          if (!message.labelIds.includes(selected.folder)) return null; // A move during pagination must not enter the wrong folder.
          return {uid, unread:message.labelIds.includes('UNREAD'), size:integer(message.sizeEstimate), ...gmailEnvelope(message)};
        }));
        const failed = batch.find(result => result.status === 'rejected');
        if (failed) throw failed.reason;
        for (const result of batch) if (result.value) items.push(result.value);
      }
      const next = response.nextPageToken === undefined ? null : response.nextPageToken;
      if (next !== null && (typeof next !== 'string' || !next || next.length > 8192 || /[\x00-\x20\x7f]/.test(next))) throw fail('invalid_response');
      const nextOffset = next ? selected.offset + PAGE : null;
      if (next) markers.set(nextOffset, next);
      const matched = Math.max(integer(response.resultSizeEstimate), selected.offset + items.length);
      return {folder:selected.folder, uidValidity:context.account.key, items, total:matched, matched, offset:selected.offset, nextOffset, estimated:true};
    });
  }
  function messagePath(selected) { return service === 'outlook' ? root + '/mailFolders/' + segment(selected.folder) + '/messages/' + segment(selected.uid) : root + '/messages/' + segment(selected.uid); }
  async function gmailFull(context, selected) {
    const response = await proxy(context, {method:'GET', path:messagePath(selected), params:{format:'full'}});
    if (id(response.id) !== selected.uid || !Array.isArray(response.labelIds) || !response.labelIds.includes(selected.folder)) throw fail('message_unavailable');
    if (integer(response.sizeEstimate) > MAX_MESSAGE) throw fail('message_too_large');
    return response;
  }
  async function parseGmail(context, selected, response, requestedPart = '') {
    let count = 0, limited = false, consumed = 0; const attachments = [], downloadParts = new Map();
    async function readable(part, path, depth) {
      if (++count > MAX_PARTS || depth > 20) { limited = true; return {text:'', html:false}; }
      if (!part || typeof part !== 'object') throw fail('invalid_response');
      const type = line(part.mimeType, 100).toLowerCase(), fields = headers({...part, headers:part.headers ?? []});
      const attached = !!part.filename || /^attachment\b/i.test(fields.get('content-disposition') || '') || type === 'message/rfc822';
      const body = part.body ?? {}, partId = body.attachmentId ? id(body.attachmentId) : 'inline:' + path;
      if (attached) {
        if (body.attachmentId || typeof body.data === 'string') {
          const metadata = {part:partId, name:filename(decodeWords(part.filename || 'Anhang')), size:integer(body.size), type:type || 'application/octet-stream'};
          attachments.push(metadata); downloadParts.set(partId, {metadata, body});
        } else limited = true;
        return {text:'', html:false};
      }
      if (Array.isArray(part.parts)) {
        const sections = [];
        for (let index = 0; index < part.parts.length; index++) { if (count >= MAX_PARTS) { limited = true; break; } sections.push(await readable(part.parts[index], path + '.' + index, depth + 1)); }
        const useful = sections.filter(result => result.text.trim());
        if (type === 'multipart/alternative') return useful.find(result => !result.html) || useful[0] || {text:'', html:false};
        return {text:useful.map(result => result.text).join('\n\n'), html:useful.some(result => result.html)};
      }
      if (!['text/plain','text/html'].includes(type) || requestedPart) return {text:'', html:false};
      let encoded = body.data;
      if (encoded === undefined && body.attachmentId) { const external = await proxy(context, {method:'GET', path:messagePath(selected) + '/attachments/' + segment(body.attachmentId)}); if (integer(external.size) > MAX_MESSAGE) throw fail('message_too_large'); encoded = external.data; }
      if (encoded === undefined) return {text:'', html:false};
      const bytes = base64(encoded, MAX_MESSAGE, true); consumed += bytes.length;
      if (consumed > MAX_MESSAGE) throw fail('message_too_large');
      const charset = fields.get('content-type')?.match(/charset\s*=\s*["']?([A-Za-z0-9._-]+)/i)?.[1] || 'utf-8';
      const decoded = decode(bytes, charset);
      return {text:type === 'text/html' ? htmlText(decoded) : clean(decoded, MAX_MESSAGE), html:type === 'text/html'};
    }
    const result = await readable(response.payload, '0', 0);
    if (requestedPart) {
      const file = downloadParts.get(requestedPart); if (!file) throw fail('message_unavailable');
      if (file.metadata.size > MAX_ATTACHMENT) throw fail('attachment_too_large');
      let body = file.body;
      if (body.data === undefined) body = await proxy(context, {method:'GET', path:messagePath(selected) + '/attachments/' + segment(body.attachmentId)});
      if (integer(body.size) > MAX_ATTACHMENT) throw fail('attachment_too_large');
      return {name:file.metadata.name, data:base64(body.data, MAX_ATTACHMENT, true).toString('base64')};
    }
    return {...gmailEnvelope(response), text:result.text.slice(0, MAX_TEXT), convertedHTML:result.html, truncated:result.text.length > MAX_TEXT, partsLimited:limited, attachments};
  }
  async function message(data) {
    const selected = target(data);
    return run('mailRead', 'read', async context => {
      if (service === 'gmail') return {uid:selected.uid, uidValidity:context.account.key, ...await parseGmail(context, selected, await gmailFull(context, selected))};
      const response = await proxy(context, {method:'GET', path:messagePath(selected), params:{$select:'id,subject,from,toRecipients,ccRecipients,replyTo,receivedDateTime,sentDateTime,internetMessageId,body,hasAttachments'}});
      if (id(response.id) !== selected.uid || typeof response.body?.content !== 'string') throw fail('invalid_response');
      if (Buffer.byteLength(response.body.content) > MAX_MESSAGE) throw fail('message_too_large');
      const convertedHTML = response.body.contentType?.toLowerCase() === 'html', text = convertedHTML ? htmlText(response.body.content) : clean(response.body.content, MAX_MESSAGE);
      // hasAttachments excludes inline-only files in Graph, so enumerate metadata.
      const rows = await collection(context, {method:'GET', path:messagePath(selected) + '/attachments', params:{$select:'id,name,size,contentType,isInline', $top:100}}, MAX_PARTS, true);
      const attachments = rows.filter(file => file['@odata.type'] === '#microsoft.graph.fileAttachment').map(file => ({part:id(file.id), name:filename(file.name), size:integer(file.size), type:line(file.contentType, 100) || 'application/octet-stream'}));
      return {uid:selected.uid, uidValidity:context.account.key, ...graphEnvelope(response), text:text.slice(0, MAX_TEXT), convertedHTML, truncated:text.length > MAX_TEXT, partsLimited:!!rows.limited || rows.length !== attachments.length, attachments};
    }, selected);
  }
  async function attachment(data) {
    const selected = target(data);
    if (typeof data.part !== 'string' || !/^(?:[A-Za-z0-9_~+./=-]{1,2048}|inline:\d+(?:\.\d+){0,20})$/.test(data.part)) throw fail('invalid_request');
    return run('mailRead', 'read', async context => {
      if (service === 'gmail') return parseGmail(context, selected, await gmailFull(context, selected), data.part);
      const file = await proxy(context, {method:'GET', path:messagePath(selected) + '/attachments/' + segment(data.part)});
      if (file['@odata.type'] !== '#microsoft.graph.fileAttachment' || id(file.id) !== data.part) throw fail('message_unavailable');
      if (integer(file.size) > MAX_ATTACHMENT) throw fail('attachment_too_large');
      return {name:filename(file.name), data:base64(file.contentBytes, MAX_ATTACHMENT).toString('base64')};
    }, selected);
  }
  async function flag(data) {
    const selected = target(data); if (typeof data.unread !== 'boolean') throw fail('invalid_request');
    return run('mailModify', 'flag', async context => {
      if (service === 'outlook') await proxy(context, {method:'PATCH', path:messagePath(selected), body:{isRead:!data.unread}});
      else {
        // Check current folder membership before the explicit mutation.
        const message = await proxy(context, {method:'GET', path:messagePath(selected), params:{format:'minimal'}});
        if (id(message.id) !== selected.uid || !Array.isArray(message.labelIds) || !message.labelIds.includes(selected.folder)) throw fail('message_unavailable');
        await proxy(context, {method:'POST', path:messagePath(selected) + '/modify', body:data.unread ? {addLabelIds:['UNREAD'], removeLabelIds:[]} : {addLabelIds:[], removeLabelIds:['UNREAD']}});
      }
      return {unread:data.unread};
    }, selected);
  }
  async function send(data) {
    if (!data || typeof data.requestId !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(data.requestId) || typeof data.accountKey !== 'string' || !/^[a-f0-9]{64}$/.test(data.accountKey)) throw fail('invalid_request');
    const draft = validateDraft(data.draft), digest = hash(JSON.stringify([data.accountKey, draft])), previous = sent.get(data.requestId);
    if (previous) { if (previous.digest !== digest) throw fail('invalid_request'); return previous.result; }
    if (sent.size >= 100) throw fail('busy');
    const result = run('mailSend', 'send', async context => {
      const account = await getProfile(context);
      if (account.key !== data.accountKey || account.key !== context.account.key) throw fail('mailbox_changed');
      const serialized = mime(draft, account.address, data.requestId);
      let request;
      if (service === 'gmail') request = {method:'POST', path:root + '/messages/send', body:{raw:Buffer.from(serialized.content).toString('base64url')}};
      else {
        if (draft.attachments.some(file => Buffer.from(file.data, 'base64').length >= 3 * 1024 * 1024)) throw fail('attachment_too_large');
        if (draft.inReplyTo) request = {method:'POST', path:root + '/sendMail', headers:{'Content-Type':'text/plain'}, body:Buffer.from(serialized.content).toString('base64')};
        else request = {method:'POST', path:root + '/sendMail', body:{message:{subject:draft.subject, body:{contentType:'Text', content:draft.text}, toRecipients:draft.to.map(address => ({emailAddress:{address}})), ccRecipients:draft.cc.map(address => ({emailAddress:{address}})), bccRecipients:draft.bcc.map(address => ({emailAddress:{address}})), ...(draft.attachments.length ? {attachments:draft.attachments.map(file => ({'@odata.type':'#microsoft.graph.fileAttachment', name:file.name, contentType:'application/octet-stream', contentBytes:file.data}))} : {})}, saveToSentItems:true}};
        if (Buffer.byteLength(typeof request.body === 'string' ? request.body : JSON.stringify(request.body)) >= 4 * 1024 * 1024) throw fail('attachment_too_large');
      }
      const response = await proxy(context, request);
      if (service === 'gmail' && (typeof response.id !== 'string' || !/^[A-Za-z0-9_~+./=-]{1,2048}$/.test(response.id))) throw fail('delivery_unknown');
      return {accepted:draft.to.length + draft.cc.length + draft.bcc.length, providerAccepted:true, refused:[], sentCopySaved:service === 'gmail' && Array.isArray(response.labelIds) && response.labelIds.includes('SENT'), sentCopyRequested:true, messageId:serialized.messageId, providerMessageId:service === 'gmail' ? response.id : '', deliveryConfirmed:false};
    });
    // Reserve before any asynchronous permission/profile lookup. Every outcome,
    // including an unknown send, retains its ID and cannot trigger an auto retry.
    sent.set(data.requestId, {digest, result}); result.catch(() => {}); return result;
  }
  async function disconnect() {
    invalidate(); binding = null;
    if (typeof nango.disconnect !== 'function') throw fail('invalid_request');
    try { await nango.disconnect(service); } catch (error) { throw safeError(error); }
    return status();
  }
  return {status, folders, list, message, attachment, flag, send, disconnect,
    configure(data) { if (!data || data.disconnect !== true || Object.keys(data).some(key => key !== 'disconnect')) throw fail('invalid_request'); return disconnect(); }};
}
