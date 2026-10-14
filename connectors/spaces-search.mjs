import { createHash } from 'node:crypto';
import { normalizePlatformURL } from '../dist/source-catalog.js';

const ORIGIN = 'https://spaces.th-koeln.de';
const MAX_BYTES = 1_000_000, MAX_GRANTS = 200, GRANT_AGE = 600_000;
const AUTH_AGE = 60_000, MAX_TEXT = 64_000, MAX_CONCURRENT = 4;
const messages = {
  BAD_REQUEST: 'Ungültiger Auftrag für die Spaces-Suche.',
  BAD_SCOPE: 'Wähle einen gültigen Spaces-Kurs.',
  BUSY: 'Zu viele gleichzeitige Spaces-Suchanfragen. Bitte kurz warten.',
  ABORTED: 'Spaces-Suche abgebrochen.',
  DISPOSED: 'Die Spaces-Suche wurde beendet.',
  TIMEOUT: 'Die Spaces-Suche hat zu lange gebraucht.',
  NETWORK_ERROR: 'Spaces konnte nicht sicher erreicht werden.',
  LOGIN_REQUIRED: 'Melde dich bei Spaces an und prüfe deine Kursberechtigung.',
  UNSUPPORTED: 'Die lesende WordPress-Schnittstelle dieses Kurses wurde nicht bestätigt.',
  INVALID_RESPONSE: 'Spaces hat keine gültige Suchantwort geliefert.',
  RESPONSE_LIMIT: 'Die Spaces-Antwort ist zu groß.',
  REDIRECT_BLOCKED: 'Die Spaces-Suche hat eine gesperrte Weiterleitung erkannt.',
  NOT_OFFERED: 'Dieser Spaces-Treffer ist nicht mehr im gewählten Kurs freigegeben. Suche erneut.',
  CONTENT_UNAVAILABLE: 'Der Inhalt dieses Spaces-Beitrags ist geschützt oder nicht lesbar.',
  CONTENT_CHANGED: 'Der Spaces-Beitrag wurde geändert. Lies ihn erneut ab dem Anfang.'
};
export class SpacesSearchError extends Error {
  constructor(code) {
    const key = Object.hasOwn(messages, code) ? code : 'NETWORK_ERROR';
    super(messages[key]); this.name = key === 'ABORTED' ? 'AbortError' : 'SpacesSearchError'; this.code = key;
  }
}
const failure = code => new SpacesSearchError(code);
const hash = value => createHash('sha256').update(value).digest('hex');
const integer = value => Number.isSafeInteger(value) && value > 0;
const plainRecord = value => value && typeof value === 'object' && !Array.isArray(value);

export function spacesSearchCourseURL(value) {
  if (typeof value !== 'string' || value.length > 300 || /[\x00-\x20\\]/.test(value)) throw failure('BAD_SCOPE');
  let url; try { url = new URL(value); } catch { throw failure('BAD_SCOPE'); }
  const slug = url.pathname.match(/^\/([a-z0-9][a-z0-9-]{0,100})\/?$/)?.[1];
  if (url.origin !== ORIGIN || url.username || url.password || url.search || url.hash || !slug ||
      /^(?:wp-json|wp-admin|wp-login|login|logout|public|home|app|hilfe|users?|members?|profiles?)$/.test(slug)) throw failure('BAD_SCOPE');
  return ORIGIN + '/' + slug + '/';
}
function htmlEntities(value) {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, value) => {
      if (value[0] !== '#') return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[value.toLowerCase()] || entity;
      const point = value[1].toLowerCase() === 'x' ? parseInt(value.slice(2), 16) : Number(value.slice(1));
      return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : '';
    });
}
export function plainSpacesHTML(value) {
  if (typeof value !== 'string') return '';
  return htmlEntities(value.replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '')
    .replace(/<br\b[^>]*>|<\/(?:p|h[1-6]|li|blockquote|pre|div|ul|ol|section|article)\s*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '• ').replace(/<[^>]*>/g, ''))
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n').trim();
}
function attributes(text) {
  const result = {};
  for (const match of text.matchAll(/\s([\w:-]+)\s*=\s*(["'])([\s\S]*?)\2/g)) {
    result[match[1].toLowerCase()] = match[3].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  }
  return result;
}
function assignedSettings(script) {
  const match = /(?:\b(?:var|let|const)\s+|\bwindow\.)wpApiSettings\s*=\s*/.exec(script);
  if (!match) throw failure('UNSUPPORTED');
  const start = match.index + match[0].length;
  if (script[start] !== '{') throw failure('UNSUPPORTED');
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; i < Math.min(script.length, start + 20000); i++) {
    const c = script[i];
    if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; continue; }
    if (c === '"') quoted = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try { return JSON.parse(script.slice(start, i + 1)); } catch { throw failure('UNSUPPORTED'); }
    }
  }
  throw failure('UNSUPPORTED');
}
function discover(html, courseURL) {
  const links = [...html.matchAll(/<link\b[^>]*>/gi)].map(m => attributes(m[0]))
    .filter(a => a.rel === 'https://api.w.org/' || a.rel === 'https://api.w.org');
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
    .filter(m => attributes('<script ' + m[1]).id === 'wp-api-request-js-extra');
  if (links.length !== 1 || scripts.length !== 1) throw failure('UNSUPPORTED');
  const settings = assignedSettings(scripts[0][2]), apiRoot = courseURL + 'wp-json/';
  if (links[0].href !== apiRoot || settings?.root !== apiRoot) throw failure('UNSUPPORTED');
  if (typeof settings.nonce !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(settings.nonce)) throw failure('LOGIN_REQUIRED');
  return { apiRoot, nonce: settings.nonce };
}
function routeMethods(route) {
  return new Set([route?.methods, ...(route?.endpoints || []).map(e => e.methods)].flatMap(value =>
    Array.isArray(value) ? value : typeof value === 'string' ? value.split(',').map(v => v.trim()) :
      plainRecord(value) ? Object.keys(value).filter(key => value[key] === true) : []));
}
function verifyRoutes(index) {
  if (!plainRecord(index?.routes)) throw failure('UNSUPPORTED');
  for (const route of [
    '/wp/v2/search', '/wp/v2/posts', '/wp/v2/posts/(?P<id>[\\d]+)',
    '/wp/v2/pages', '/wp/v2/pages/(?P<id>[\\d]+)'
  ]) if (!routeMethods(index.routes[route]).has('GET')) throw failure('UNSUPPORTED');
}
function postURL(value, courseURL, id) {
  let url; try { url = new URL(value); } catch { throw failure('INVALID_RESPONSE'); }
  const prefix = new URL(courseURL).pathname;
  let pathname = url.pathname;
  try { for (let i = 0; i < 3 && pathname.includes('%'); i++) pathname = decodeURIComponent(pathname); }
  catch { throw failure('INVALID_RESPONSE'); }
  if (typeof value !== 'string' || value.length > 2000 || /[\x00-\x20\\]/.test(value) ||
      url.origin !== ORIGIN || url.username || url.password || !pathname.startsWith(prefix) ||
      /[%\\\x00-\x20]/.test(pathname) || /(?:^|\/)\.{1,2}(?:\/|$)/.test(pathname) ||
      /%(?:2f|5c|2e|00)/i.test(url.pathname) ||
      /\/(?:wp-admin|wp-json|wp-login\.php|logout|users?|members?|profiles?)(?:\/|$)/i.test(pathname)) throw failure('INVALID_RESPONSE');
  for (const [key, value] of url.searchParams) {
    if (!['p', 'page_id'].includes(key) || value !== String(id)) throw failure('INVALID_RESPONSE');
  }
  url.hash = ''; return url.href;
}
function cleanMessage(message) {
  const allowed = { search: ['op', 'courseURL', 'projectId', 'query', 'page', 'perPage'], read: ['op', 'courseURL', 'projectId', 'id', 'offset', 'expectedRevision'] };
  if (!plainRecord(message) || !Object.hasOwn(allowed, message.op) || Object.keys(message).some(k => !allowed[message.op].includes(k))) throw failure('BAD_REQUEST');
  const courseURL = spacesSearchCourseURL(message.courseURL);
  if (typeof message.projectId !== 'string' || !/^[A-Za-z0-9_-]{0,80}$/.test(message.projectId)) throw failure('BAD_SCOPE');
  if (message.op === 'search') {
    const query = typeof message.query === 'string' ? message.query.trim() : '';
    const page = message.page ?? 1, perPage = message.perPage ?? 20;
    if (!query || query.length > 300 || /[\x00-\x1f\x7f]/.test(query) || !integer(page) || page > 10000 || !integer(perPage) || perPage > 100) throw failure('BAD_REQUEST');
    return { op: 'search', courseURL, projectId: message.projectId, query, page, perPage };
  }
  const offset = message.offset ?? 0;
  if (!/^b:spaces-rest:[a-f0-9]{64}$/.test(message.id || '') || !Number.isSafeInteger(offset) || offset < 0 || offset > 60000 ||
      message.expectedRevision !== undefined && !/^[a-f0-9]{64}$/.test(message.expectedRevision)) throw failure('BAD_REQUEST');
  return { ...message, courseURL, offset };
}
function checkedHeader(headers, name) {
  const value = headers?.get(name);
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,8})$/.test(value)) throw failure('INVALID_RESPONSE');
  return Number(value);
}
function privateText(value, context) {
  const text = plainSpacesHTML(value);
  return context.nonce ? text.split(context.nonce).join('[Authentifizierung entfernt]') : text;
}
function gmtTimestamp(value) {
  if (typeof value !== 'string') return '';
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z?$/.exec(value);
  if (!match || match[1].startsWith('0000-')) return '';
  const iso = match[1] + '.' + (match[2] || '').padEnd(3, '0') + 'Z', time = Date.parse(iso);
  return Number.isFinite(time) && new Date(time).toISOString() === iso ? iso : '';
}
function quotedHref(opening) {
  const pattern = /\s+([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gy;
  let cursor = 2, href, count = 0;
  while (cursor < opening.length - 1) {
    if (/^\s*$/.test(opening.slice(cursor, -1))) break;
    pattern.lastIndex = cursor;
    const match = pattern.exec(opening);
    if (!match || ++count > 128) return;
    if (match[1].toLowerCase() === 'href') {
      if (href !== undefined || match[2] === undefined && match[3] === undefined) return;
      href = match[2] ?? match[3];
    }
    cursor = pattern.lastIndex;
  }
  return href;
}
function platformTarget(value, context) {
  const href = htmlEntities(value);
  if (href.length > 2500 || /[\x00-\x20\x7f\\]/.test(href)) return;
  const authority = /^https:\/\/([^/?#]+)/i.exec(href)?.[1].toLowerCase();
  const service = { 'miro.com': 'miro', 'www.miro.com': 'miro', 'git.coco.study': 'gitlab',
    'th-koeln.sciebo.de': 'sciebo', 'chat.coco.study': 'mattermost' }[authority];
  if (!service) return;
  // Check before canonicalization: Miro drops query/fragment fields, which must
  // never conceal an authentication value supplied by the original HTML.
  let decoded = href;
  for (let i = 0; i < 8; i++) {
    if (context.nonce && decoded.includes(context.nonce) || /(?:^|[?&#])[^=&#]*(?:nonce|token|secret|credential|authorization|password|passcode|session|signature|key|jwt|bearer|auth)[^=&#]*=/i.test(decoded)) return;
    let next; try { next = decodeURIComponent(decoded); } catch { return; }
    if (next === decoded) break;
    if (i === 7) return;
    decoded = next;
  }
  try { return { service, url: normalizePlatformURL(service, href) }; } catch {}
}
function observedPlatformLinks(html, context, metadata) {
  const links = [], seen = new Set(), tags = /<!--|<!|<\?|<\/?[a-z][a-z0-9:-]*(?=[\s/>])/gi;
  let inspected = 0, templateDepth = 0, platformLinksMore = false, match;
  while ((match = tags.exec(html))) {
    if (++inspected > 5000) { platformLinksMore = true; break; }
    const start = match.index;
    if (match[0] === '<!--') {
      const end = html.indexOf('-->', tags.lastIndex); if (end < 0) break;
      tags.lastIndex = end + 3; continue;
    }
    if (match[0] === '<!' || match[0] === '<?') {
      const end = html.indexOf('>', tags.lastIndex); if (end < 0) break;
      tags.lastIndex = end + 1; continue;
    }
    const tail = /^(?:[^"'<>]|"[^"]*"|'[^']*')*>/.exec(html.slice(tags.lastIndex, start + 4096));
    if (!tail) { platformLinksMore = true; break; }
    const end = tags.lastIndex + tail[0].length, opening = html.slice(start, end);
    tags.lastIndex = end;
    const name = match[0].replace(/^<\/?/, '').toLowerCase(), closing = match[0][1] === '/';
    if (name === 'template') {
      templateDepth = closing ? Math.max(0, templateDepth - 1) : templateDepth + 1;
      if (templateDepth > 128) { platformLinksMore = true; break; }
      continue;
    }
    if (!closing && /^(?:script|style|noscript|textarea|title|xmp|iframe|noembed)$/.test(name)) {
      const close = new RegExp('</' + name + '\\s*>', 'gi'); close.lastIndex = end;
      if (!close.exec(html)) break;
      tags.lastIndex = close.lastIndex; continue;
    }
    if (!closing && name === 'plaintext') break;
    if (templateDepth || closing || name !== 'a') continue;
    const href = quotedHref(opening), target = href === undefined ? undefined : platformTarget(href, context);
    if (!target || seen.has(target.service + '|' + target.url)) continue;
    seen.add(target.service + '|' + target.url);
    if (links.length === 30) { platformLinksMore = true; break; }
    const body = html.slice(end, end + 8192), close = /<\/a\s*>/i.exec(body), nested = /<a(?=[\s>])/i.exec(body);
    const label = close && (!nested || close.index < nested.index) ? body.slice(0, close.index) : '';
    links.push({ ...target, title: privateText(label, context).slice(0, 200), ...metadata });
  }
  return { platformLinks: links, platformLinksMore };
}
function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(failure(signal.reason?.name === 'TimeoutError' ? 'TIMEOUT' : 'ABORTED'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(failure(signal.reason?.name === 'TimeoutError' ? 'TIMEOUT' : 'ABORTED'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
function cancelBody(response) { try { void response?.body?.cancel().catch(() => {}); } catch {} }

/** Private server/native service. Its transport owns authentication; IPC never receives a nonce. */
export function createSpacesSearch({ fetchImpl, authContext, now = Date.now } = {}) {
  if (typeof fetchImpl !== 'function' || authContext !== undefined && typeof authContext !== 'function' || typeof now !== 'function') throw new TypeError('Invalid Spaces search transport.');
  const grants = new Map(), contexts = new Map(), operations = new Set();
  let generation = 0, disposed = false;
  function invalidate() {
    generation++; grants.clear(); contexts.clear();
    for (const operation of operations) operation.controller.abort();
  }
  function revokeCourse(courseURL) {
    contexts.delete(courseURL);
    for (const [key, grant] of grants) if (grant.courseURL === courseURL) grants.delete(key);
    for (const operation of operations) if (operation.courseURL === courseURL) operation.controller.abort();
  }
  function dispose() { if (!disposed) { disposed = true; invalidate(); } }
  function assertActive(operation) {
    if (disposed) throw failure('DISPOSED');
    if (operation.generation !== generation || operation.signal.aborted) throw failure(operation.signal.reason?.name === 'TimeoutError' ? 'TIMEOUT' : 'ABORTED');
  }
  function prune() {
    const time = now();
    for (const [key, grant] of grants) if (time < grant.at || time - grant.at >= GRANT_AGE) grants.delete(key);
  }
  async function fetchText(url, context, operation, json = false) {
    assertActive(operation);
    const timeout = AbortSignal.timeout(15000), signal = AbortSignal.any([operation.signal, timeout]);
    let response, reader;
    try {
      const pending = Promise.resolve().then(() => {
        assertActive(operation);
        if (signal.aborted) throw failure(timeout.aborted ? 'TIMEOUT' : 'ABORTED');
        return fetchImpl(url, {
          method: 'GET', credentials: 'omit', redirect: 'manual', cache: 'no-store', signal,
          headers: { Accept: json ? 'application/json' : 'text/html', ...(context?.nonce ? { 'X-WP-Nonce': context.nonce } : {}) }
        });
      });
      pending.then(value => { if (signal.aborted) cancelBody(value); }, () => {});
      response = await abortable(pending, signal); assertActive(operation);
      if (response.status >= 300 && response.status < 400 || response.redirected || response.url && response.url !== url) throw failure('REDIRECT_BLOCKED');
      if (response.status === 401 || response.status === 403) throw failure('LOGIN_REQUIRED');
      if (!response.ok) throw failure('NETWORK_ERROR');
      const mime = response.headers?.get('content-type') || '';
      if (json ? !/^application\/(?:json|[a-z0-9!#$&^_.+-]+\+json)\s*(?:;|$)/i.test(mime) : !/^text\/html\s*(?:;|$)/i.test(mime)) throw failure('INVALID_RESPONSE');
      const declared = response.headers?.get('content-length');
      if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BYTES)) throw failure('RESPONSE_LIMIT');
      reader = response.body?.getReader();
      if (!reader) throw failure('INVALID_RESPONSE');
      let size = 0; const chunks = [];
      while (true) {
        const { done, value } = await abortable(reader.read(), signal);
        assertActive(operation); if (done) break;
        size += value.byteLength; if (size > MAX_BYTES) throw failure('RESPONSE_LIMIT');
        chunks.push(Buffer.from(value));
      }
      const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
      return { text, headers: response.headers };
    } catch (cause) {
      try { if (reader) void reader.cancel().catch(() => {}); else cancelBody(response); } catch {}
      if (cause instanceof SpacesSearchError) throw cause;
      if (signal.aborted) throw failure(timeout.aborted ? 'TIMEOUT' : 'ABORTED');
      throw failure('NETWORK_ERROR');
    } finally { try { reader?.releaseLock(); } catch {} }
  }
  async function jsonRequest(context, route, params, operation) {
    const url = new URL(context.apiRoot + route);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    const response = await fetchText(url.href, context, operation, true);
    let value; try { value = JSON.parse(response.text); } catch { throw failure('INVALID_RESPONSE'); }
    return { value, headers: response.headers };
  }
  async function contextFor(courseURL, operation) {
    const cached = contexts.get(courseURL), time = now();
    if (cached && time >= cached.at && time - cached.at < AUTH_AGE) return cached.context;
    let context;
    if (authContext) {
      let provided;
      const authSignal = AbortSignal.any([operation.signal, AbortSignal.timeout(15000)]);
      try { provided = await abortable(Promise.resolve().then(() => {
        assertActive(operation);
        if (authSignal.aborted) throw failure(authSignal.reason?.name === 'TimeoutError' ? 'TIMEOUT' : 'ABORTED');
        return authContext({ courseURL, signal: authSignal });
      }), authSignal); }
      catch (cause) { if (cause instanceof SpacesSearchError) throw cause; if (operation.signal.aborted) throw failure('ABORTED'); throw failure('LOGIN_REQUIRED'); }
      if (!plainRecord(provided) || provided.apiRoot !== courseURL + 'wp-json/' || provided.nonce !== undefined &&
          (typeof provided.nonce !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(provided.nonce))) throw failure('UNSUPPORTED');
      context = { apiRoot: provided.apiRoot, ...(provided.nonce ? { nonce: provided.nonce } : {}) };
    } else {
      const page = await fetchText(courseURL, undefined, operation);
      context = discover(page.text, courseURL);
    }
    const index = await fetchText(context.apiRoot, context, operation, true);
    let parsed; try { parsed = JSON.parse(index.text); } catch { throw failure('INVALID_RESPONSE'); }
    verifyRoutes(parsed); assertActive(operation);
    for (const [key, value] of contexts) if (now() < value.at || now() - value.at >= AUTH_AGE) contexts.delete(key);
    contexts.delete(courseURL); contexts.set(courseURL, { at: now(), context });
    while (contexts.size > MAX_GRANTS) contexts.delete(contexts.keys().next().value);
    return context;
  }
  async function search(message, operation) {
    const context = await contextFor(message.courseURL, operation);
    const response = await jsonRequest(context, 'wp/v2/search', {
      search: message.query, type: 'post', subtype: 'post,page', page: message.page, per_page: message.perPage,
      _fields: 'id,title,url,type,subtype'
    }, operation);
    const total = checkedHeader(response.headers, 'x-wp-total'), totalPages = checkedHeader(response.headers, 'x-wp-totalpages');
    if (!Array.isArray(response.value) || response.value.length > message.perPage ||
        totalPages !== Math.ceil(total / message.perPage) || total > 0 && message.page > totalPages ||
        response.value.length > total || total === 0 && response.value.length) throw failure('INVALID_RESPONSE');
    const pending = response.value.map(raw => {
      if (!plainRecord(raw) || !integer(raw.id) || raw.type !== 'post' || !['post', 'page'].includes(raw.subtype) || typeof raw.title !== 'string' || raw.title.length > MAX_BYTES) throw failure('INVALID_RESPONSE');
      const url = postURL(raw.url, message.courseURL, raw.id);
      if (context.nonce && decodeURIComponent(url).includes(context.nonce)) throw failure('INVALID_RESPONSE');
      const id = 'b:spaces-rest:' + hash(JSON.stringify([context.apiRoot, raw.subtype, raw.id]));
      return { id, wpId: raw.id, subtype: raw.subtype, kind: 'browser', source: 'spaces',
        title: privateText(raw.title, context).slice(0, 200), url, projectId: message.projectId, courseURL: message.courseURL,
        status: 'metadata', excerpt: '', text: '' };
    });
    if (new Set(pending.map(item => item.id)).size !== pending.length) throw failure('INVALID_RESPONSE');
    assertActive(operation); prune();
    for (const item of pending) {
      const key = item.id + '|' + message.projectId;
      grants.delete(key); grants.set(key, { ...item, at: now(), generation });
      while (grants.size > MAX_GRANTS) grants.delete(grants.keys().next().value);
    }
    return { items: pending, page: message.page, perPage: message.perPage, total, totalPages,
      hasMore: message.page < totalPages, scope: 'published', courseURL: message.courseURL, projectId: message.projectId };
  }
  async function read(message, operation) {
    prune();
    const grant = grants.get(message.id + '|' + message.projectId);
    if (!grant || grant.courseURL !== message.courseURL || grant.generation !== generation) throw failure('NOT_OFFERED');
    const context = await contextFor(message.courseURL, operation);
    const response = await jsonRequest(context, 'wp/v2/' + (grant.subtype === 'post' ? 'posts/' : 'pages/') + grant.wpId, {
      context: 'view', _embed: 'author', _fields: 'id,type,status,link,title,content,author,date_gmt,modified_gmt,_links,_embedded'
    }, operation);
    const raw = response.value;
    if (!plainRecord(raw) || raw.id !== grant.wpId || raw.type !== grant.subtype || typeof raw.title?.rendered !== 'string' ||
        typeof raw.content?.rendered !== 'string') throw failure('INVALID_RESPONSE');
    if (raw.status !== 'publish' || raw.content.protected === true) throw failure('CONTENT_UNAVAILABLE');
    const url = postURL(raw.link, message.courseURL, raw.id);
    if (url !== grant.url || context.nonce && decodeURIComponent(url).includes(context.nonce)) throw failure('INVALID_RESPONSE');
    const title = privateText(raw.title.rendered, context).slice(0, 200), whole = privateText(raw.content.rendered, context);
    const author = Array.isArray(raw._embedded?.author) ? raw._embedded.author.find(value => integer(value?.id) && value.id === raw.author && typeof value.name === 'string') : undefined;
    const postedBy = author ? privateText(author.name, context).slice(0, 160) : '';
    const postedAt = gmtTimestamp(raw.date_gmt), updatedAt = gmtTimestamp(raw.modified_gmt);
    const revision = hash(JSON.stringify([context.apiRoot, raw.type, raw.id, url, title, raw.content.rendered, postedBy, postedAt, updatedAt]));
    if (message.expectedRevision && message.expectedRevision !== revision) throw failure('CONTENT_CHANGED');
    const text = whole.slice(0, MAX_TEXT);
    if (message.offset > text.length) throw failure('BAD_REQUEST');
    const chunk = text.slice(message.offset, message.offset + 4000), next = message.offset + chunk.length;
    const hasMore = next < text.length && next <= 60000;
    const platform = observedPlatformLinks(raw.content.rendered, context, { sourceURL: url, sourceTitle: title, postedBy, postedAt });
    assertActive(operation); prune();
    const currentGrant = grants.get(message.id + '|' + message.projectId);
    if (!currentGrant || currentGrant.courseURL !== message.courseURL || currentGrant.generation !== generation || currentGrant.url !== url) throw failure('NOT_OFFERED');
    return { id: grant.id, kind: 'browser', source: 'spaces', projectId: message.projectId, courseURL: message.courseURL,
      title, url, text: chunk, offset: message.offset, nextOffset: hasMore ? next : null, hasMore, revision, contentRevision: revision,
      ...platform, postedBy, postedAt, date: postedAt, updatedAt,
      status: message.offset > 0 || next < whole.length ? 'excerpt' : 'full', contentTruncated: whole.length > MAX_TEXT,
      ...(author ? { authorName: postedBy } : {}) };
  }
  async function handle(value, { signal } = {}) {
    if (disposed) throw failure('DISPOSED');
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw failure('BAD_REQUEST');
    if (signal?.aborted) throw failure('ABORTED');
    const message = cleanMessage(value);
    if (operations.size >= MAX_CONCURRENT) throw failure('BUSY');
    const controller = new AbortController(), operation = {
      controller, generation, courseURL: message.courseURL,
      signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    };
    operations.add(operation);
    try { return await (message.op === 'search' ? search(message, operation) : read(message, operation)); }
    catch (cause) {
      if (cause instanceof SpacesSearchError) { if (cause.code === 'LOGIN_REQUIRED') revokeCourse(message.courseURL); throw cause; }
      if (operation.signal.aborted || generation !== operation.generation) throw failure('ABORTED');
      throw failure('NETWORK_ERROR');
    } finally { operations.delete(operation); }
  }
  return { handle, invalidate, dispose };
}
