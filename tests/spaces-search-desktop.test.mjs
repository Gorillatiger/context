import test from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopSpacesSearch } from '../desktop/spaces-search.mjs';

test('native Spaces search uses only the existing provider fetch session and never enumerates or exports cookies', async () => {
  const courseURL = 'https://spaces.th-koeln.de/native-fixture/', apiRoot = courseURL + 'wp-json/';
  const nonce = 'native_fixture_private_nonce', calls = [];
  const electronResponse = response => { Object.defineProperty(response, 'url', { value: 'https://incorrect-electron-url.invalid/' }); return response; };
  const routes = Object.fromEntries(['/wp/v2/search', '/wp/v2/posts', '/wp/v2/posts/(?P<id>[\\d]+)', '/wp/v2/pages', '/wp/v2/pages/(?P<id>[\\d]+)']
    .map(route => [route, { methods: ['GET'] }]));
  const engine = createDesktopSpacesSearch({ providerSession: {
    cookies: { get() { throw new Error('Must never enumerate browser cookies'); } },
    async fetch(url, options) {
      calls.push({ url, options });
      if (url === courseURL) return electronResponse(new Response('<link rel="https://api.w.org/" href="' + apiRoot +
        '"><script id="wp-api-request-js-extra">var wpApiSettings = ' + JSON.stringify({ root: apiRoot, nonce }) +
        ';</script>', { headers: { 'content-type': 'text/html' } }));
      if (url === apiRoot) return electronResponse(Response.json({ routes }));
      if (new URL(url).pathname.endsWith('/posts/5')) return electronResponse(Response.json({
        id: 5, type: 'post', status: 'publish', link: courseURL + 'entry/', title: { rendered: 'Native fixture' },
        content: { rendered: '<p>Native readable text.</p>', protected: false }
      }));
      return electronResponse(Response.json([{ id: 5, title: 'Native fixture', type: 'post', subtype: 'post', url: courseURL + 'entry/' }],
        { headers: { 'X-WP-Total': '1', 'X-WP-TotalPages': '1' } }));
    }
  }, now: () => 0 });
  const result = await engine.handle({ op: 'search', courseURL, projectId: 'native-fixture', query: 'prototype' });
  assert.equal(result.items.length, 1);
  assert.equal(calls.length, 3);
  const read = await engine.handle({ op: 'read', courseURL, projectId: 'native-fixture', id: result.items[0].id });
  assert.equal(read.url, courseURL + 'entry/'); assert.equal(read.text, 'Native readable text.');
  assert.ok(calls.every(call => call.options.method === 'GET' && call.options.credentials === 'include' && call.options.redirect === 'manual' && call.options.bypassCustomProtocolHandlers === true));
  assert.equal(calls[0].options.headers['X-WP-Nonce'], undefined);
  assert.equal(calls[1].options.headers['X-WP-Nonce'], nonce);
  assert.doesNotMatch(JSON.stringify(result), /native_fixture_private_nonce|cookies/);
  engine.invalidate(); engine.dispose();
  await assert.rejects(engine.handle({ op: 'search', courseURL, projectId: '', query: 'test' }), error => error.code === 'DISPOSED');
});

test('native incorrect URL metadata does not bypass redirect, permission, MIME or response bounds checks', async () => {
  for (const [makeResponse, expected] of [
    [() => new Response('PRIVATE_BODY', { status: 302, headers: { location: 'https://outside.invalid/' } }), 'REDIRECT_BLOCKED'],
    [() => { const response = new Response('PRIVATE_BODY'); Object.defineProperty(response, 'redirected', { value: true }); return response; }, 'REDIRECT_BLOCKED'],
    [() => new Response('PRIVATE_BODY', { status: 401 }), 'LOGIN_REQUIRED'],
    [() => new Response('PRIVATE_BODY', { status: 403 }), 'LOGIN_REQUIRED'],
    [() => new Response('PRIVATE_BODY', { headers: { 'content-type': 'text/plain' } }), 'INVALID_RESPONSE'],
    [() => new Response('PRIVATE_BODY', { headers: { 'content-type': 'text/html', 'content-length': '1000001' } }), 'RESPONSE_LIMIT']
  ]) {
    let calls = 0;
    const engine = createDesktopSpacesSearch({ providerSession: { async fetch(url, options) {
      calls++; assert.equal(options.redirect, 'manual'); assert.equal(options.credentials, 'include');
      const response = makeResponse(); Object.defineProperty(response, 'url', { value: 'https://incorrect-electron-url.invalid/' });
      return response;
    } } });
    await assert.rejects(engine.handle({ op: 'search', courseURL: 'https://spaces.th-koeln.de/native-fixture/', projectId: 'fixture', query: 'prototype' }),
      error => error.code === expected && !error.message.includes('PRIVATE_BODY'));
    assert.equal(calls, 1); engine.dispose();
  }
});

test('native search rejects missing session transports without falling back to a global unauthenticated fetch', () => {
  assert.throws(() => createDesktopSpacesSearch({}), TypeError);
  assert.throws(() => createDesktopSpacesSearch({ providerSession: {} }), TypeError);
});
