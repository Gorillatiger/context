import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpacesSearch, spacesSearchCourseURL } from '../connectors/spaces-search.mjs';

const ORIGIN = 'https://spaces.th-koeln.de', COURSE = ORIGIN + '/fixture-course/', API = COURSE + 'wp-json/';
const NONCE = 'synthetic_nonce_private_fixture';
const code = value => error => error.code === value;
const tick = () => new Promise(resolve => setImmediate(resolve));
function gate() { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; }
async function until(check) { for (let i = 0; i < 30 && !check(); i++) await tick(); assert.ok(check()); }
function index() {
  return { routes: Object.fromEntries(['/wp/v2/search', '/wp/v2/posts', '/wp/v2/posts/(?P<id>[\\d]+)', '/wp/v2/pages', '/wp/v2/pages/(?P<id>[\\d]+)']
    .map(route => [route, { methods: ['GET'] }])) };
}
const hit = (id = 7, subtype = 'post') => ({ id, type: 'post', subtype, title: '<b>Fixture &amp; title</b>', url: COURSE + 'entry-' + id + '/' });
const post = (id = 7, type = 'post', content = '<p>Readable &amp; safe.</p>') => ({
  id, type, status: 'publish', link: COURSE + 'entry-' + id + '/', title: { rendered: '<b>Fixture &amp; title</b>' },
  content: { rendered: content, protected: false }, author: 3, modified_gmt: '2026-10-14T12:00:00',
  _embedded: { author: [{ id: 3, name: 'Alex Beispiel', email: 'PRIVATE_EMAIL', capabilities: { PRIVATE_CAPABILITY: true } }] }
});
const html = (root = API, nonce = NONCE, link = root) => '<link rel="https://api.w.org/" href="' + link +
  '"><script id="wp-api-request-js-extra">var wpApiSettings = ' + JSON.stringify({ root, nonce }) + ';</script>';
const json = (value, total, pages) => Response.json(value, { headers: total === undefined ? {} : { 'X-WP-Total': String(total), 'X-WP-TotalPages': String(pages) } });
function fixture({ hook, now, authContext } = {}) {
  const calls = [], state = { markup: html(), routes: index(), hits: [hit(), hit(8, 'page')], total: 2, pages: 1, body: '<p>Readable &amp; safe.</p>' };
  const fetchImpl = async (value, options) => {
    const url = new URL(value); calls.push({ url: url.href, options });
    const supplied = await hook?.(url, options, state, calls);
    if (supplied !== undefined) return supplied;
    if (url.href === COURSE) return new Response(state.markup, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    if (url.href === API) return json(state.routes);
    if (url.pathname === new URL(API).pathname + 'wp/v2/search') return json(state.hits, state.total, state.pages);
    const match = url.pathname.match(/\/wp\/v2\/(posts|pages)\/(\d+)$/);
    if (match) return json(post(Number(match[2]), match[1] === 'posts' ? 'post' : 'page', state.body));
    throw new Error('Unexpected fixture request');
  };
  const engine = createSpacesSearch({ fetchImpl, ...(now ? { now } : {}), ...(authContext ? { authContext } : {}) });
  const search = (extra = {}, options) => engine.handle({ op: 'search', courseURL: COURSE, projectId: 'fixture', query: 'prototype', ...extra }, options);
  const read = (id, extra = {}, options) => engine.handle({ op: 'read', courseURL: COURSE, projectId: 'fixture', id, ...extra }, options);
  return { engine, search, read, calls, state, fetchImpl };
}

test('direct REST discovery and published search are GET-only and require no publishing capabilities or prior index', async () => {
  const f = fixture(), result = await f.search();
  assert.equal(result.scope, 'published');
  assert.equal(result.total, 2); assert.equal(result.totalPages, 1); assert.equal(result.hasMore, false);
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].title, 'Fixture & title');
  assert.match(result.items[0].id, /^b:spaces-rest:[a-f0-9]{64}$/);
  assert.equal(result.items[0].status, 'metadata'); assert.equal(result.items[0].text, ''); assert.equal(result.items[0].excerpt, '');
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls[2].options.headers['X-WP-Nonce'], NONCE);
  const url = new URL(f.calls[2].url);
  assert.equal(url.searchParams.get('type'), 'post'); assert.equal(url.searchParams.get('subtype'), 'post,page');
  assert.equal(url.searchParams.get('search'), 'prototype');
  assert.ok(f.calls.every(call => call.options.method === 'GET' && call.options.body === undefined && call.options.redirect === 'manual'));
  assert.doesNotMatch(JSON.stringify(result), /synthetic_nonce|PRIVATE_/);
});

test('both discovery roots must agree exactly; script text is parsed as JSON without executing it', async () => {
  for (const markup of [
    html(ORIGIN + '/other/wp-json/'), html(API, NONCE, ORIGIN + '/other/wp-json/'),
    html() + '<link rel="https://api.w.org/" href="' + API + '">', '<p>No API discovery</p>',
    html().replace('var wpApiSettings = ', 'wpApiSettings = ')
  ]) {
    const f = fixture(); f.state.markup = markup;
    await assert.rejects(f.search(), code('UNSUPPORTED')); assert.equal(f.calls.length, 1);
  }
  const f = fixture(); f.state.markup += '<script>throw new Error("PRIVATE_EXECUTION");</script>';
  assert.equal((await f.search()).items.length, 2);
});

test('missing nonce and authenticated API denial fail closed without revealing HTML, nonce or provider errors', async () => {
  const missing = fixture(); missing.state.markup = html(API, '');
  await assert.rejects(missing.search(), code('LOGIN_REQUIRED'));
  const f = fixture({ hook: async url => url.href === API ? new Response('PRIVATE_BODY_' + NONCE, { status: 403 }) : undefined });
  await assert.rejects(f.search(), error => error.code === 'LOGIN_REQUIRED' && !error.message.includes(NONCE) && !error.message.includes('PRIVATE_BODY'));
  assert.equal(f.calls.length, 2);
  const thrown = fixture({ hook: async () => { throw new Error(NONCE); } });
  await assert.rejects(thrown.search(), error => error.code === 'NETWORK_ERROR' && !error.message.includes(NONCE));
});

test('course and request validation rejects arbitrary URLs, writable routes and unsupported fields before transport', async () => {
  for (const url of ['https://outside.invalid/course/', ORIGIN + '/', ORIGIN + '/course/?nonce=x', ORIGIN + '/wp-json/', ORIGIN + '/course%2fwp-admin/', 'http://spaces.th-koeln.de/course/', ORIGIN + '/course/child/', 'https://u:p@spaces.th-koeln.de/course/']) {
    assert.throws(() => spacesSearchCourseURL(url), code('BAD_SCOPE'));
  }
  assert.equal(spacesSearchCourseURL(ORIGIN + '/fixture-course'), COURSE);
  const f = fixture();
  for (const value of [
    { op: 'publish' }, { query: '' }, { query: 'a\nb' }, { page: 0 }, { page: 1.5 }, { perPage: 101 },
    { method: 'POST' }, { nonce: NONCE }, { url: ORIGIN + '/wp-admin/' }, { projectId: '../other' }
  ]) await assert.rejects(f.search(value));
  await assert.rejects(f.read(7), code('BAD_REQUEST'));
  assert.equal(f.calls.length, 0);
});

test('search requires declared read routes, without accepting absent methods or guessing a root', async () => {
  for (const route of ['/wp/v2/search', '/wp/v2/posts/(?P<id>[\\d]+)', '/wp/v2/pages']) {
    const f = fixture(); delete f.state.routes.routes[route];
    await assert.rejects(f.search(), code('UNSUPPORTED'));
    assert.equal(f.calls.length, 2);
  }
});

test('server pagination is confirmed and forwarded rather than reconstructed after missing or invalid headers', async () => {
  const f = fixture(); f.state.total = 5; f.state.pages = 3;
  const value = await f.search({ page: 2, perPage: 2 });
  assert.deepEqual([value.page, value.perPage, value.total, value.totalPages, value.hasMore], [2, 2, 5, 3, true]);
  assert.equal(new URL(f.calls.at(-1).url).searchParams.get('page'), '2');
  for (const reply of [json([hit()]), json([hit()], 1, 2), json([hit()], 0, 0), json([hit(), hit(8)], 1, 1)]) {
    const bad = fixture({ hook: async url => url.pathname.endsWith('/wp/v2/search') ? reply : undefined });
    await assert.rejects(bad.search(), code('INVALID_RESPONSE'));
  }
  const empty = fixture(); empty.state.hits = []; empty.state.total = 0; empty.state.pages = 0;
  assert.deepEqual((await empty.search()).items, []);
});

test('malformed search hits and foreign-course permalinks cannot mint grants', async () => {
  for (const change of [
    { id: -1 }, { type: 'user' }, { subtype: 'attachment' }, { url: ORIGIN + '/other-course/post/' },
    { url: 'https://outside.invalid/post/' }, { url: COURSE + 'wp-admin/' }, { url: COURSE + '%6dembers/person/' },
    { url: COURSE + '%2570rofile/person/' }, { url: COURSE + 'post/?token=' + NONCE }
  ]) {
    const f = fixture(); f.state.hits = [{ ...hit(), ...change }]; f.state.total = 1;
    await assert.rejects(f.search(), code('INVALID_RESPONSE'));
    await assert.rejects(f.read('b:spaces-rest:' + 'a'.repeat(64)), code('NOT_OFFERED'));
  }
});

test('a read needs the exact offered source and course/project scope; IDs are stable across repeated searches', async () => {
  const f = fixture(), first = await f.search(), repeated = await f.search();
  assert.deepEqual(first.items.map(i => i.id), repeated.items.map(i => i.id));
  const before = f.calls.length;
  await assert.rejects(f.read(first.items[0].id, { projectId: 'other' }), code('NOT_OFFERED'));
  await assert.rejects(f.read(first.items[0].id, { courseURL: ORIGIN + '/other-course/' }), code('NOT_OFFERED'));
  await assert.rejects(f.read('b:spaces-rest:' + 'f'.repeat(64)), code('NOT_OFFERED'));
  assert.equal(f.calls.length, before);
  await f.search({ projectId: 'other' });
  assert.equal((await f.read(first.items[0].id, { projectId: 'other' })).projectId, 'other');
  assert.equal((await f.read(first.items[0].id)).projectId, 'fixture');
});

test('post and page reads sanitize HTML and expose only a matching observed author name', async () => {
  const f = fixture(), found = await f.search();
  f.state.body = '<p>Visible &amp; text</p><!--PRIVATE_COMMENT--><script>PRIVATE_SCRIPT</script><style>PRIVATE_STYLE</style><img src="https://outside.invalid/tracker" onerror="PRIVATE_HANDLER">';
  const document = await f.read(found.items[0].id);
  assert.equal(document.text, 'Visible & text'); assert.equal(document.status, 'full');
  assert.equal(document.authorName, 'Alex Beispiel');
  assert.match(document.revision, /^[a-f0-9]{64}$/);
  assert.equal(document.nextOffset, null); assert.equal(document.hasMore, false);
  assert.doesNotMatch(JSON.stringify(document), /PRIVATE_|synthetic_nonce|tracker|capabilities|email/);
  const request = new URL(f.calls.at(-1).url);
  assert.match(request.pathname, /\/wp\/v2\/posts\/7$/);
  assert.equal(request.searchParams.get('context'), 'view'); assert.equal(request.searchParams.get('_embed'), 'author');
  await f.read(found.items[1].id);
  assert.match(new URL(f.calls.at(-1).url).pathname, /\/wp\/v2\/pages\/8$/);
});

test('author mismatches, wrong posts and password-protected contents cannot become a readable complete source', async () => {
  for (const variant of ['author', 'wrong-id', 'protected', 'foreign-link', 'different-offered-link']) {
    const f = fixture({ hook: async url => {
      if (!/\/posts\/7$/.test(url.pathname)) return;
      const raw = post();
      if (variant === 'author') raw._embedded.author[0].id = 99;
      if (variant === 'wrong-id') raw.id = 8;
      if (variant === 'protected') raw.content.protected = true;
      if (variant === 'foreign-link') raw.link = ORIGIN + '/another/post/';
      if (variant === 'different-offered-link') raw.link = COURSE + 'another-entry/';
      return json(raw);
    } });
    const found = await f.search();
    if (variant === 'author') assert.equal(Object.hasOwn(await f.read(found.items[0].id), 'authorName'), false);
    else await assert.rejects(f.read(found.items[0].id), code(variant === 'protected' ? 'CONTENT_UNAVAILABLE' : 'INVALID_RESPONSE'));
  }
});

test('original REST anchors expose observed platform targets even when their text only says hier', async () => {
  const targets = [
    ['miro', 'https://miro.com/app/board/FixtureBoard1=/'],
    ['gitlab', 'https://git.coco.study/fixture/repository/-/issues/42'],
    ['sciebo', 'https://th-koeln.sciebo.de/s/FixtureShare1'],
    ['mattermost', 'https://chat.coco.study/fixture/channels/general']
  ];
  const f = fixture({ hook: async (url, options, state) => {
    if (!/\/posts\/7$/.test(url.pathname)) return;
    const raw = post(7, 'post', state.body); raw.date_gmt = '2026-10-14T09:08:07';
    return json(raw);
  } });
  f.state.body = targets.map(([, url], i) => '<a class="resource" href="' + url + '"><strong>hier ' + i + '</strong></a>').join(' ');
  const offered = await f.search(), read = await f.read(offered.items[0].id);
  assert.equal(read.platformLinks.length, 4); assert.equal(read.platformLinksMore, false);
  assert.doesNotMatch(read.text, /https:/);
  assert.equal(read.contentRevision, read.revision);
  assert.equal(read.date, '2026-10-14T09:08:07.000Z'); assert.equal(read.postedAt, read.date);
  assert.equal(read.updatedAt, '2026-10-14T12:00:00.000Z');
  for (const [i, link] of read.platformLinks.entries()) {
    assert.equal(link.service, targets[i][0]); assert.equal(link.url, targets[i][1]);
    assert.equal(link.title, 'hier ' + i); assert.equal(link.sourceURL, offered.items[0].url);
    assert.equal(link.sourceTitle, 'Fixture & title'); assert.equal(link.postedBy, 'Alex Beispiel');
    assert.equal(link.postedAt, read.date);
  }
  assert.doesNotMatch(JSON.stringify(read), /PRIVATE_EMAIL|PRIVATE_CAPABILITY/);
});

test('platform link evidence excludes scripts, inert contents, fake attributes and unquoted or duplicate hrefs', async () => {
  const target = 'https://miro.com/app/board/FixtureBoard1=/', anchor = '<a href="' + target + '">inert</a>';
  const f = fixture(), found = await f.search();
  f.state.body = '<!--' + anchor + '--><script>' + anchor + '</script><style>' + anchor + '</style>' +
    '<textarea>' + anchor + '</textarea><noscript>' + anchor + '</noscript><iframe>' + anchor + '</iframe>' +
    '<template><template>' + anchor + '</template>' + anchor + '</template>' +
    '<div title="<a href=\'' + target + '\'>fake</a>">plain</div>' +
    '<![CDATA[' + anchor + ']]><?fixture ' + anchor + '?>' +
    '<a data-description=\' href="' + target + '"\'>fake attribute</a>' +
    '<a href=' + target + '>unquoted</a><a href="' + target + '" href="' + target + '">duplicate</a>' +
    '<a title="greater > and <a text" href=\'' + target + '\'>real</a>';
  const read = await f.read(found.items[0].id);
  assert.equal(read.platformLinksMore, false);
  assert.deepEqual(read.platformLinks.map(link => [link.url, link.title]), [[target, 'real']]);
});

test('platform links reject credential and nonce URLs before canonicalization, including encoded host and auth tricks', async () => {
  const target = 'https://miro.com/app/board/FixtureBoard1=/', encodedNonce = [...NONCE].map(c => '%' + c.charCodeAt(0).toString(16)).join('');
  const bad = [
    'javascript:alert(1)', 'http://miro.com/app/board/FixtureBoard1=/',
    'https://user:password@miro.com/app/board/FixtureBoard1=/',
    'https://miro.com.outside.invalid/app/board/FixtureBoard1=/',
    'https://%6diro.com/app/board/FixtureBoard1=/', 'https://miro%2ecom/app/board/FixtureBoard1=/',
    target + '?nonce=' + NONCE, target + '?harmless=' + encodedNonce,
    target + '?%2574oken=PRIVATE_AUTH', target + '#access_token=PRIVATE_AUTH',
    target + '?auth=PRIVATE_AUTH', target + '?key=PRIVATE_AUTH', target + '#jwt=PRIVATE_AUTH',
    'https://git.coco.study/fixture/repository/-/settings',
    'https://th-koeln.sciebo.de/index.php/s/FixtureShare1/download',
    'https://chat.coco.study/fixture/channels/general?token=PRIVATE_AUTH'
  ];
  const f = fixture(), found = await f.search();
  f.state.body = bad.map(url => '<a href="' + url.replaceAll('&', '&amp;') + '">hier</a>').join('') +
    '<a href="https://miro.com/app/board/FixtureBoard1%3D/?share_link_id=fixture">belegt</a>';
  const read = await f.read(found.items[0].id);
  assert.deepEqual(read.platformLinks.map(link => [link.service, link.url, link.title]), [['miro', target, 'belegt']]);
  assert.doesNotMatch(JSON.stringify(read.platformLinks), /PRIVATE_AUTH|synthetic_nonce|%2574oken/);
});

test('platform metadata deduplicates canonical targets, caps at thirty and reports incomplete scans', async () => {
  const target = i => 'https://miro.com/app/board/FixtureBoard' + i + '=/';
  const anchor = i => '<a href="' + target(i) + '">Board ' + i + '</a>';
  const f = fixture(), found = await f.search();
  f.state.body = Array.from({ length: 30 }, (_, i) => anchor(i) + anchor(i)).join('');
  let read = await f.read(found.items[0].id);
  assert.equal(read.platformLinks.length, 30); assert.equal(read.platformLinksMore, false);
  f.state.body += anchor(30); read = await f.read(found.items[0].id);
  assert.equal(read.platformLinks.length, 30); assert.equal(read.platformLinksMore, true);
  assert.equal(read.platformLinks.at(-1).url, target(29));
  f.state.body = '<span></span>'.repeat(2600) + anchor(0); read = await f.read(found.items[0].id);
  assert.equal(read.platformLinks.length, 0); assert.equal(read.platformLinksMore, true);
  f.state.body = '<a title="' + 'x'.repeat(5000) + '" href="' + target(0) + '">long</a>';
  read = await f.read(found.items[0].id);
  assert.equal(read.platformLinks.length, 0); assert.equal(read.platformLinksMore, true);
});

test('UTC date metadata is backed by valid GMT fields and never inferred from local dates or the current time', async () => {
  const target = 'https://miro.com/app/board/FixtureBoard1=/';
  for (const value of [undefined, '', '0000-00-00T00:00:00', '2026-02-30T12:00:00', '2026-10-14', '2026-10-14T24:00:00', '2026-10-14T12:00:00+02:00']) {
    const f = fixture({ hook: async url => {
      if (!/\/posts\/7$/.test(url.pathname)) return;
      const raw = post(7, 'post', '<a href="' + target + '">hier</a>');
      raw.date_gmt = value; raw.modified_gmt = value; raw.date = '2026-10-14T12:00:00';
      raw._embedded.author[0].id = 99;
      return json(raw);
    } });
    const found = await f.search(), read = await f.read(found.items[0].id);
    assert.equal(read.date, ''); assert.equal(read.postedAt, ''); assert.equal(read.updatedAt, '');
    assert.equal(read.postedBy, ''); assert.equal(Object.hasOwn(read, 'authorName'), false);
    assert.equal(read.platformLinks[0].postedBy, ''); assert.equal(read.platformLinks[0].postedAt, '');
  }
});

test('all chunks retain the same original HTML link evidence and revisions also bind provenance metadata', async () => {
  let author = 'Alex Beispiel';
  const f = fixture({ hook: async (url, options, state) => {
    if (!/\/posts\/7$/.test(url.pathname)) return;
    const raw = post(7, 'post', state.body); raw._embedded.author[0].name = author;
    raw.date_gmt = '2026-10-14T09:08:07.12Z'; return json(raw);
  } });
  f.state.body = 'x'.repeat(5000) + '<a href="https://miro.com/app/board/FixtureBoard1=/">hier</a>';
  const found = await f.search(), first = await f.read(found.items[0].id);
  assert.equal(first.platformLinks.length, 1); assert.equal(first.date, '2026-10-14T09:08:07.120Z');
  const next = await f.read(found.items[0].id, { offset: 4000, expectedRevision: first.revision });
  assert.deepEqual(next.platformLinks, first.platformLinks); assert.equal(next.contentRevision, first.contentRevision);
  author = 'Sam Beispiel';
  await assert.rejects(f.read(found.items[0].id, { offset: 4000, expectedRevision: first.revision }), code('CONTENT_CHANGED'));
});

test('external and invalidation cancellation use AbortError while preserving the stable ABORTED code', async () => {
  const f = fixture(), cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(f.search({}, { signal: cancelled.signal }), error => error.name === 'AbortError' && error.code === 'ABORTED');
  const held = gate(); let started = false;
  const waiting = fixture({ hook: async url => { if (url.href === COURSE) { started = true; await held.promise; } } });
  const pending = waiting.search(), rejected = assert.rejects(pending, error => error.name === 'AbortError' && error.code === 'ABORTED');
  await until(() => started); waiting.engine.invalidate(); await rejected; held.release();
});

test('a new search cannot rebind a pending read to a different currently offered permalink', async () => {
  const held = gate(); let started = false;
  const f = fixture({ hook: async url => { if (/\/posts\/7$/.test(url.pathname)) { started = true; await held.promise; } } });
  const found = await f.search(), pending = f.read(found.items[0].id);
  const rejected = assert.rejects(pending, code('NOT_OFFERED'));
  await until(() => started);
  f.state.hits[0].url = COURSE + 'renamed-entry/';
  await f.search(); held.release(); await rejected;
});

test('published search grants cannot read a post that becomes private, draft or otherwise unpublished', async () => {
  for (const status of ['private', 'draft', 'pending', 'future', 'trash', undefined]) {
    let currentStatus = 'publish';
    const f = fixture({ hook: async url => {
      if (!/\/posts\/7$/.test(url.pathname)) return;
      const raw = post(); raw.status = currentStatus; return json(raw);
    } });
    const found = await f.search(), first = await f.read(found.items[0].id);
    const request = new URL(f.calls.at(-1).url);
    assert.ok(request.searchParams.get('_fields').split(',').includes('status'));
    assert.equal(first.status, 'full'); currentStatus = status;
    await assert.rejects(f.read(found.items[0].id, { expectedRevision: first.revision }), code('CONTENT_UNAVAILABLE'));
  }
});

test('immediate cancellation does not start a pending transport or trusted authentication callback', async () => {
  const direct = fixture(), pending = direct.search(); direct.engine.invalidate();
  await assert.rejects(pending, error => error.code === 'ABORTED' && error.name === 'AbortError');
  await tick(); assert.equal(direct.calls.length, 0);
  let authCalls = 0;
  const delegated = fixture({ authContext: async () => { authCalls++; return { apiRoot: API }; } });
  const pendingAuth = delegated.search(); delegated.engine.invalidate();
  await assert.rejects(pendingAuth, error => error.code === 'ABORTED' && error.name === 'AbortError');
  await tick(); assert.equal(authCalls, 0); assert.equal(delegated.calls.length, 0);
});

test('non-native transports still reject mismatched response URLs and followed redirect metadata', async () => {
  for (const changed of [{ url: 'https://outside.invalid/private/' }, { redirected: true }]) {
    const f = fixture({ hook: async () => {
      const response = new Response(html(), { headers: { 'content-type': 'text/html' } });
      for (const [key, value] of Object.entries(changed)) Object.defineProperty(response, key, { value });
      return response;
    } });
    await assert.rejects(f.search(), code('REDIRECT_BLOCKED'));
    assert.equal(f.calls.length, 1);
  }
});

test('four-thousand-character chunks and expected revisions prevent mixing changed content', async () => {
  const f = fixture(), found = await f.search(); f.state.body = 'a'.repeat(5000);
  const first = await f.read(found.items[0].id);
  assert.equal(first.text.length, 4000); assert.equal(first.nextOffset, 4000); assert.equal(first.hasMore, true); assert.equal(first.status, 'excerpt');
  const tail = await f.read(found.items[0].id, { offset: first.nextOffset, expectedRevision: first.revision });
  assert.equal(tail.text.length, 1000); assert.equal(tail.hasMore, false); assert.equal(tail.status, 'excerpt');
  f.state.body = 'b'.repeat(5000);
  await assert.rejects(f.read(found.items[0].id, { offset: 4000, expectedRevision: first.revision }), code('CONTENT_CHANGED'));
  assert.notEqual((await f.read(found.items[0].id)).revision, first.revision);
  f.state.body = 'z'.repeat(70000);
  const capped = await f.read(found.items[0].id, { offset: 60000 });
  assert.equal(capped.text.length, 4000); assert.equal(capped.hasMore, false); assert.equal(capped.nextOffset, null);
  assert.equal(capped.contentTruncated, true); assert.equal(capped.status, 'excerpt');
  await assert.rejects(f.read(found.items[0].id, { offset: 60001 }), code('BAD_REQUEST'));
});

test('private auth nonce cannot escape through titles, readable content or embedded author metadata', async () => {
  const f = fixture({ hook: async url => {
    if (/\/posts\/7$/.test(url.pathname)) {
      const raw = post(7, 'post', 'Text ' + NONCE);
      raw.title.rendered = NONCE; raw._embedded.author[0].name = NONCE;
      return json(raw);
    }
  } });
  f.state.hits[0].title = NONCE;
  const found = await f.search(), document = await f.read(found.items[0].id);
  assert.doesNotMatch(JSON.stringify([found, document]), /synthetic_nonce_private_fixture/);
});

test('grants expire after ten minutes, fail on clock rollback, and keep only two hundred offered scopes', async () => {
  let now = 0;
  const f = fixture({ now: () => now }), first = await f.search();
  now = 600000;
  const before = f.calls.length;
  await assert.rejects(f.read(first.items[0].id), code('NOT_OFFERED')); assert.equal(f.calls.length, before);
  now = 700000; const fresh = await f.search(); now = 699999;
  await assert.rejects(f.read(fresh.items[0].id), code('NOT_OFFERED'));

  const many = fixture({ now: () => 0, hook: async url => {
    if (!url.pathname.endsWith('/wp/v2/search')) return;
    const page = Number(url.searchParams.get('page'));
    return json(Array.from({ length: 20 }, (_, i) => hit((page - 1) * 20 + i + 1)), 220, 11);
  } });
  const old = await many.search(), recent = [];
  for (let page = 2; page <= 11; page++) recent.push(await many.search({ page }));
  await assert.rejects(many.read(old.items[0].id), code('NOT_OFFERED'));
  assert.equal((await many.read(recent.at(-1).items[0].id)).status, 'full');
});

test('invalidating during a pending read aborts and prevents late results or reuse of old grants', async () => {
  const held = gate(); let waiting = false;
  const f = fixture({ hook: async url => { if (/\/posts\/7$/.test(url.pathname)) { waiting = true; await held.promise; } } });
  const found = await f.search(), read = f.read(found.items[0].id), rejected = assert.rejects(read, code('ABORTED'));
  await until(() => waiting); f.engine.invalidate(); await rejected;
  held.release(); await tick();
  await assert.rejects(f.read(found.items[0].id), code('NOT_OFFERED'));
  f.engine.dispose(); await assert.rejects(f.search(), code('DISPOSED'));
});

test('a denied course revokes its own grants without cancelling an unrelated parallel course search', async () => {
  const held = gate(), good = ORIGIN + '/allowed-course/', bad = ORIGIN + '/denied-course/';
  let waiting = false;
  const engine = createSpacesSearch({
    authContext: async ({ courseURL }) => ({ apiRoot: courseURL + 'wp-json/' }),
    fetchImpl: async value => {
      const url = new URL(value);
      if (url.href === bad + 'wp-json/') return new Response('PRIVATE_FORBIDDEN', { status: 403 });
      if (url.href === good + 'wp-json/') { waiting = true; await held.promise; return json(index()); }
      return json([{ ...hit(), url: good + 'entry/' }], 1, 1);
    }
  });
  const goodSearch = engine.handle({ op: 'search', courseURL: good, projectId: 'good', query: 'prototype' });
  await until(() => waiting);
  await assert.rejects(engine.handle({ op: 'search', courseURL: bad, projectId: 'bad', query: 'prototype' }), code('LOGIN_REQUIRED'));
  held.release();
  const result = await goodSearch;
  assert.equal(result.items.length, 1); assert.equal(result.courseURL, good);
});

test('an API authentication failure revokes old read grants and forces fresh discovery on the next search', async () => {
  let deny = false;
  const f = fixture({ hook: async url => deny && /\/posts\/7$/.test(url.pathname) ? new Response('PRIVATE_BODY', { status: 401 }) : undefined });
  const offered = await f.search(); deny = true;
  await assert.rejects(f.read(offered.items[0].id), code('LOGIN_REQUIRED'));
  const before = f.calls.length;
  await assert.rejects(f.read(offered.items[0].id), code('NOT_OFFERED'));
  assert.equal(f.calls.length, before);
  deny = false;
  await f.search();
  assert.equal(f.calls.slice(before).filter(call => call.url === COURSE).length, 1);
});

test('external cancellation interrupts stalled response streams and frees bounded concurrent operations', async () => {
  let streaming = false, cancelled = false;
  const f = fixture({ hook: async url => url.pathname.endsWith('/wp/v2/search') ? new Response(new ReadableStream({
    start(controller) { streaming = true; controller.enqueue(new TextEncoder().encode('[')); },
    cancel() { cancelled = true; }
  }), { headers: { 'content-type': 'application/json' } }) : undefined });
  const abort = new AbortController(), pending = f.search({}, { signal: abort.signal }), rejected = assert.rejects(pending, code('ABORTED'));
  await until(() => streaming); abort.abort(); await rejected; await tick(); assert.equal(cancelled, true);

  const held = gate(), controllers = Array.from({ length: 4 }, () => new AbortController());
  const busy = fixture({ hook: async url => { if (url.href === COURSE) await held.promise; } });
  const pendingReads = controllers.map(controller => busy.search({}, { signal: controller.signal }));
  const rejectedReads = pendingReads.map(value => assert.rejects(value, code('ABORTED')));
  await until(() => busy.calls.length === 4);
  await assert.rejects(busy.search(), code('BUSY'));
  controllers.forEach(controller => controller.abort()); await Promise.all(rejectedReads);
  held.release(); await tick();
  assert.equal((await busy.search()).items.length, 2);
});

test('redirects, malformed MIME and one-megabyte responses are blocked without exposing private response bodies', async () => {
  for (const [reply, expected] of [
    [() => new Response('PRIVATE_BODY', { status: 302, headers: { location: 'https://outside.invalid/' } }), 'REDIRECT_BLOCKED'],
    [() => new Response('PRIVATE_BODY', { headers: { 'content-type': 'text/plain' } }), 'INVALID_RESPONSE'],
    [() => new Response('x'.repeat(1000001), { headers: { 'content-type': 'text/html' } }), 'RESPONSE_LIMIT'],
    [() => new Response('PRIVATE_BODY', { headers: { 'content-type': 'text/html', 'content-length': '1000001' } }), 'RESPONSE_LIMIT']
  ]) {
    const f = fixture({ hook: async () => reply() });
    await assert.rejects(f.search(), error => error.code === expected && !error.message.includes('PRIVATE_BODY'));
    assert.equal(f.calls.length, 1);
  }
});

test('both a stalled fetch and a stalled trusted auth adapter receive a fifteen-second bounded timeout', async t => {
  const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout'), actual = AbortSignal.timeout.bind(AbortSignal), requested = [];
  Object.defineProperty(AbortSignal, 'timeout', { configurable: true, writable: true, value: milliseconds => {
    requested.push(milliseconds); return actual(20);
  } });
  const keepAlive = setTimeout(() => {}, 200);
  t.after(() => { Object.defineProperty(AbortSignal, 'timeout', descriptor); clearTimeout(keepAlive); });
  const fetchGate = gate(), f = fixture({ hook: async () => { await fetchGate.promise; } });
  await assert.rejects(f.search(), code('TIMEOUT'));
  fetchGate.release(); await tick();
  const authGate = gate(), auth = fixture({ authContext: async () => { await authGate.promise; return { apiRoot: API }; } });
  await assert.rejects(auth.search(), code('TIMEOUT'));
  authGate.release(); await tick();
  assert.ok(requested.length >= 2);
  assert.ok(requested.every(milliseconds => milliseconds === 15000));
  assert.equal(auth.calls.length, 0);
});

test('a trusted future server authentication adapter can own bearer authentication without renderer cookie transfer', async () => {
  let authCalls = 0;
  const f = fixture({ authContext: async ({ courseURL, signal }) => {
    authCalls++; assert.equal(courseURL, COURSE); assert.ok(signal instanceof AbortSignal);
    return { apiRoot: API };
  } });
  const found = await f.search();
  assert.equal(found.items.length, 2); assert.equal(authCalls, 1);
  assert.equal(f.calls.length, 2, 'injected trusted auth does not scrape HTML or transport browser cookies');
  assert.ok(f.calls.every(call => call.options.credentials === 'omit' && call.options.headers['X-WP-Nonce'] === undefined));
  const bad = fixture({ authContext: async () => ({ apiRoot: ORIGIN + '/other/wp-json/' }) });
  await assert.rejects(bad.search(), code('UNSUPPORTED')); assert.equal(bad.calls.length, 0);
});
