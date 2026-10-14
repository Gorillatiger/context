import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createKIClient } from '../connectors/ki.mjs';
import { createLocalAIClient } from '../desktop/local-ai.mjs';
import { createDesktopAI } from '../desktop/ai.mjs';
import { createRequestHandler } from '../server.mjs';
import { aiRequest } from '../dist/ai-client.js';

const KEY = 'synthetic-usage-key';
const KEY_URL = 'https://openrouter.ai/api/v1/key';
const INPUT = { model: 'fixture-model', messages: [{ role: 'user', content: 'Synthetic question' }] };
const auth = async () => ({ key: KEY, storage: 'session' });
const metadata = remaining => ({ data: { is_free_tier: false, limit: 10, limit_remaining: remaining, limit_reset: null } });
const modelResponse = () => Response.json({ data: [{ id: INPUT.model }] });
const completion = () => Response.json({ choices: [{ message: { content: 'Fixture answer' } }] });
const hasCode = code => error => error.code === code;
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function until(predicate, message) {
  for (let i = 0; i < 30 && !predicate(); i++) await tick();
  assert.ok(predicate(), message);
}
function replaceGlobal(t, name, value) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  });
}
function cloud(options = {}) {
  return createKIClient({ provider: 'openrouter', getKey: auth, ...options });
}

test('usage is a fixed authenticated GET with bounded sanitized metadata and genuine zero values', async () => {
  const calls = [];
  const client = cloud({ now: () => 0, fetcher: async (url, options) => {
    calls.push({ url, options });
    return Response.json({ data: {
      ...metadata(0).data, usage: 0,
      label: 'PRIVATE_FIXTURE_LABEL', hash: 'PRIVATE_FIXTURE_HASH', key: KEY,
      rate_limit: { requests: 999, interval: '1s' },
      free_model_daily_requests: { used: 50, limit: 50, remaining: 0 }
    } });
  } });
  const value = await client.usage();
  assert.deepEqual(value.keyBudget, { limit: 10, remaining: 0, resetInterval: null });
  assert.deepEqual(value.spend, { total: 0 });
  assert.deepEqual(value.freeRequests, { used: 50, limit: 50, remaining: 0 });
  assert.equal(value.checkedAt, '1970-01-01T00:00:00.000Z');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, KEY_URL);
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer ' + KEY);
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.body, undefined);
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE_FIXTURE|synthetic-usage-key|rate_limit/);
});

test('null key caps and missing provider values remain different from zero or unlimited credit', async () => {
  for (const [data, expected] of [
    [{ limit: null, limit_remaining: null }, 'unset'],
    [{ label: 'PRIVATE_ONLY', rate_limit: { requests: 100 } }, 'unknown']
  ]) {
    const value = await cloud({ fetcher: async () => Response.json({ data }) }).usage();
    assert.equal(value.status, expected === 'unset' ? 'available' : 'unknown');
    assert.equal(value.keyLimitUnset === true, expected === 'unset');
    assert.equal(Object.hasOwn(value, 'keyBudget'), false);
    assert.equal(Object.hasOwn(value, 'unlimited'), false);
    assert.equal(Object.hasOwn(value, 'balance'), false);
    assert.doesNotMatch(JSON.stringify(value), /PRIVATE_ONLY|rate_limit/);
  }
});

test('usage single-flight shares one fetch while the thirty-second cache returns independent copies', async () => {
  let now = 0, calls = 0;
  const gate = deferred();
  const client = cloud({ now: () => now, fetcher: async () => {
    calls++;
    if (calls === 1) await gate.promise;
    return Response.json(metadata(4));
  } });
  const a = client.usage(), b = client.usage();
  await until(() => calls === 1, 'shared provider request starts once');
  gate.resolve();
  const [first, second] = await Promise.all([a, b]);
  first.keyBudget.remaining = 999;
  assert.equal(second.keyBudget.remaining, 4);
  now = 29999;
  assert.equal((await client.usage()).keyBudget.remaining, 4);
  assert.equal(calls, 1);
  now = 30000;
  await client.usage();
  assert.equal(calls, 2, 'exact TTL boundary refreshes');
  now = 29999;
  await client.usage();
  assert.equal(calls, 3, 'clock rollback cannot prolong an old cache');
});

test('aborting one single-flight participant cannot cancel the other participant or cache its mutation', async () => {
  const gate = deferred(), calls = [];
  const client = cloud({ fetcher: async (url, options) => {
    calls.push({ url, options });
    await gate.promise;
    return Response.json(metadata(6));
  } });
  const firstAbort = new AbortController(), secondAbort = new AbortController();
  const first = client.usage(firstAbort.signal), second = client.usage(secondAbort.signal);
  const cancelled = assert.rejects(first, hasCode('cancelled'));
  await until(() => calls.length === 1, 'shared fetch starts');
  firstAbort.abort();
  await cancelled;
  assert.equal(calls[0].options.signal.aborted, false, 'remaining participant owns the fetch');
  gate.resolve();
  const value = await second;
  value.keyBudget.remaining = -900;
  assert.equal((await client.usage()).keyBudget.remaining, 6);
  assert.equal(calls.length, 1);
});

test('completed usage caches remain credential-bound when environment keys change within the TTL', async () => {
  let key = 'synthetic-A';
  const calls = [];
  const client = cloud({ now: () => 0, getKey: async () => ({ key, storage: 'session' }), fetcher: async (_url, options) => {
    calls.push(options.headers.Authorization);
    return Response.json(metadata(options.headers.Authorization === 'Bearer synthetic-A' ? 6 : 1));
  } });
  assert.equal((await client.usage()).keyBudget.remaining, 6);
  await client.usage();
  assert.equal(calls.length, 1);
  key = 'synthetic-B';
  assert.equal((await client.usage()).keyBudget.remaining, 1);
  key = 'synthetic-A';
  assert.equal((await client.usage()).keyBudget.remaining, 6);
  assert.deepEqual(calls, ['Bearer synthetic-A', 'Bearer synthetic-B', 'Bearer synthetic-A']);
});

test('aborting every participant cancels the provider request and late output cannot seed the retry cache', async () => {
  const old = deferred(), calls = [];
  const client = cloud({ fetcher: async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) { await old.promise; return Response.json(metadata(9)); }
    return Response.json(metadata(2));
  } });
  const a = new AbortController(), b = new AbortController();
  const first = client.usage(a.signal), second = client.usage(b.signal);
  const rejected = Promise.all([assert.rejects(first, hasCode('cancelled')), assert.rejects(second, hasCode('cancelled'))]);
  await until(() => calls.length === 1, 'initial fetch starts');
  a.abort(); b.abort();
  await rejected;
  assert.equal(calls[0].options.signal.aborted, true);
  assert.equal((await client.usage()).keyBudget.remaining, 2);
  old.resolve();
  await tick();
  assert.equal((await client.usage()).keyBudget.remaining, 2);
  assert.equal(calls.length, 2);
});

test('key changes A to B to A reject old pending generations even if their fetch adapters ignore abort', async () => {
  let key = 'synthetic-A';
  const calls = [];
  const client = cloud({ getKey: async () => ({ key, storage: 'session' }), fetcher: async (url, options) => {
    const gate = deferred(); calls.push({ url, options, gate }); return gate.promise;
  } });
  const first = client.usage(), firstRejected = assert.rejects(first, hasCode('usage_changed'));
  await until(() => calls.length === 1, 'first A starts');
  key = 'synthetic-B';
  const second = client.usage(), secondRejected = assert.rejects(second, hasCode('usage_changed'));
  await until(() => calls.length === 2, 'B starts');
  key = 'synthetic-A';
  const current = client.usage();
  await until(() => calls.length === 3, 'current A starts');
  assert.equal(calls[0].options.signal.aborted, true);
  assert.equal(calls[1].options.signal.aborted, true);
  calls[2].gate.resolve(Response.json(metadata(3)));
  assert.equal((await current).keyBudget.remaining, 3);
  calls[0].gate.resolve(Response.json(metadata(9)));
  calls[1].gate.resolve(Response.json(metadata(8)));
  await Promise.all([firstRejected, secondRejected]);
  assert.equal((await client.usage()).keyBudget.remaining, 3);
  assert.equal(calls.length, 3);
});

test('successful reconnects invalidate an A cache across A to B to A while failed reconnects retain the old account', async () => {
  const old = deferred();
  let holdOld = true, keyCalls = 0;
  const client = cloud({ getKey: async () => ({ key: 'synthetic-A', storage: 'session' }), fetcher: async (url, options) => {
    if (url.endsWith('/models')) return modelResponse();
    keyCalls++;
    const key = options.headers.Authorization.slice(7);
    if (key === 'synthetic-bad') return new Response('PRIVATE_ERROR', { status: 401 });
    if (holdOld && key === 'synthetic-A') { holdOld = false; return old.promise; }
    return Response.json(metadata(key === 'synthetic-B' ? 7 : 2));
  } });
  const first = client.usage(), rejected = assert.rejects(first, hasCode('usage_changed'));
  await until(() => keyCalls === 1, 'old A usage starts');
  await client.configure({ key: 'synthetic-B' });
  await client.configure({ key: 'synthetic-A' });
  old.resolve(Response.json(metadata(9)));
  await rejected;
  assert.equal((await client.usage()).keyBudget.remaining, 2);
  const beforeFailure = keyCalls;
  await assert.rejects(client.configure({ key: 'synthetic-bad' }), hasCode('access_denied'));
  assert.equal((await client.usage()).keyBudget.remaining, 2);
  assert.equal(keyCalls, beforeFailure + 1, 'failed reconnect cannot invalidate valid cached account data');
});

test('abort during credential lookup cannot return an available cached quota or a KI:connect unknown result', async () => {
  for (const provider of ['openrouter', 'kiconnect']) {
    let hold = false, calls = 0;
    const gate = deferred();
    const client = createKIClient({ provider, getKey: async () => {
      if (hold) await gate.promise;
      return { key: KEY, storage: 'session' };
    }, fetcher: async () => { calls++; return Response.json(metadata(4)); } });
    await client.usage();
    hold = true;
    const controller = new AbortController(), pending = client.usage(controller.signal);
    const rejected = assert.rejects(pending, hasCode('cancelled'));
    controller.abort(); gate.resolve();
    await rejected;
    assert.equal(calls, provider === 'openrouter' ? 1 : 0);
  }
});

test('missing credentials, malformed signals and pre-abort cannot contact a cloud API', async () => {
  let calls = 0;
  const client = cloud({ getKey: async () => null, fetcher: async () => { calls++; throw new Error('forbidden'); } });
  await assert.rejects(client.usage(), hasCode('not_configured'));
  await assert.rejects(client.usage({}), hasCode('invalid_request'));
  await assert.rejects(client.usage(AbortSignal.abort()), hasCode('cancelled'));
  assert.equal(calls, 0);
});

test('KI:connect reports unknown quota without probing an unverified provider endpoint', async () => {
  let calls = 0;
  const client = createKIClient({ getKey: auth, now: () => 0, fetcher: async () => { calls++; throw new Error('forbidden'); } });
  assert.deepEqual(await client.usage(), { provider: 'kiconnect', status: 'unknown', checkedAt: '1970-01-01T00:00:00.000Z', reason: 'not_exposed' });
  assert.equal(calls, 0);
});

test('usage remains available while a chat is active and does not consume the chat request rate', async () => {
  let now = 0, chats = 0, keys = 0;
  const heldChat = deferred();
  const client = cloud({ now: () => now, fetcher: async url => {
    if (url.endsWith('/models')) return modelResponse();
    if (url === KEY_URL) { keys++; return Response.json(metadata(4)); }
    chats++;
    if (chats === 1) await heldChat.promise;
    return completion();
  } });
  const first = client.complete(INPUT);
  await until(() => chats === 1, 'chat starts');
  assert.equal((await client.usage()).keyBudget.remaining, 4, 'read-only quota fetch is independent of active chat');
  heldChat.resolve(); await first;
  for (let i = 1; i < 10; i++) {
    await client.usage();
    await client.complete(INPUT);
  }
  assert.equal(chats, 10);
  assert.equal(keys, 10, 'chat completion invalidates the previous usage cache');
  await client.usage();
  await assert.rejects(client.complete(INPUT), hasCode('local_limit'));
  now = 60001;
  await client.complete(INPUT);
  assert.equal(chats, 11);
});

test('key metadata payloads enforce their smaller byte bound and never expose malformed provider bodies', async () => {
  for (const [makeResponse, code] of [
    [() => Response.json({ data: { secret: 'PRIVATE_BODY'.repeat(7000) } }), 'response_limit'],
    [() => new Response('PRIVATE_BODY', { headers: { 'content-type': 'text/plain' } }), 'invalid_response'],
    [() => new Response('{PRIVATE_BODY', { headers: { 'content-type': 'application/json' } }), 'connection_failed'],
    [() => new Response('PRIVATE_BODY', { status: 401 }), 'access_denied'],
    [() => new Response('PRIVATE_BODY', { status: 429 }), 'provider_limit']
  ]) {
    const client = cloud({ fetcher: async () => makeResponse() });
    await assert.rejects(client.usage(), error => error.code === code && !error.message.includes('PRIVATE_BODY'));
  }
});

test('redirected or foreign-url key responses are rejected even when an adapter ignores redirect:error', async () => {
  for (const properties of [{ redirected: true }, { url: 'https://outside.invalid/key' }]) {
    const calls = [];
    const client = cloud({ fetcher: async (url, options) => {
      calls.push({ url, options });
      const response = Response.json(metadata(4));
      for (const [key, value] of Object.entries(properties)) Object.defineProperty(response, key, { value });
      return response;
    } });
    await assert.rejects(client.usage(), hasCode('redirect_blocked'));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, KEY_URL);
    assert.equal(calls[0].options.redirect, 'error');
  }
});

test('local quota is not applicable, uses no network after configuration, and never leaks the local credential', async () => {
  let calls = 0;
  const local = createLocalAIClient({ now: () => 0, fetcher: async () => { calls++; return modelResponse(); } });
  await assert.rejects(local.usage(), hasCode('not_configured'));
  assert.equal(calls, 0);
  await local.configure({ port: 1234, key: 'PRIVATE_LOCAL_KEY' });
  const before = calls;
  assert.deepEqual(await local.usage(), { provider: 'local', status: 'not_applicable', checkedAt: '1970-01-01T00:00:00.000Z' });
  await assert.rejects(local.usage(AbortSignal.abort()), hasCode('cancelled'));
  await assert.rejects(local.usage({}), hasCode('invalid_request'));
  assert.equal(calls, before);
});

test('native local usage selects only the local client even when local configuration is missing', async () => {
  let cloudCalls = 0, localCalls = 0;
  const local = createLocalAIClient({ fetcher: async () => { localCalls++; return modelResponse(); } });
  const bridge = createDesktopAI({ usage: async () => { cloudCalls++; return { provider: 'openrouter', status: 'available' }; } }, local);
  await assert.rejects(bridge({ action: 'usage', provider: 'local', id: crypto.randomUUID() }), hasCode('not_configured'));
  assert.equal(cloudCalls, 0);
  assert.equal(localCalls, 0);
  await local.configure({ port: 1234 });
  const before = localCalls;
  assert.equal((await bridge({ action: 'usage', provider: 'local', id: crypto.randomUUID() })).status, 'not_applicable');
  assert.equal(localCalls, before);
  assert.equal(cloudCalls, 0);
});

test('usage IPC requires a UUID, rejects every supplied body, and cancelling a participant preserves a shared fetch', async () => {
  const gate = deferred(), calls = [];
  const client = cloud({ fetcher: async (url, options) => { calls.push({ url, options }); await gate.promise; return Response.json(metadata(4)); } });
  const bridge = createDesktopAI(client), firstID = crypto.randomUUID(), secondID = crypto.randomUUID();
  for (const message of [
    { action: 'usage' }, { action: 'usage', id: 'bad' },
    ...[null, false, '', {}, []].map(body => ({ action: 'usage', id: firstID, body })),
    { action: 'usage', id: firstID, url: 'https://outside.invalid/' },
    { action: 'usage', id: firstID, provider: 'kiconnect' }
  ]) await assert.rejects(bridge(message), hasCode('invalid_request'));
  assert.equal(calls.length, 0);
  const first = bridge({ action: 'usage', id: firstID }), second = bridge({ action: 'usage', id: secondID });
  const rejected = assert.rejects(first, hasCode('cancelled'));
  await until(() => calls.length === 1, 'shared native quota fetch starts');
  await assert.rejects(bridge({ action: 'usage', id: secondID }), hasCode('invalid_request'));
  await bridge({ action: 'cancel', id: firstID, provider: 'openrouter' });
  await rejected;
  assert.equal(calls[0].options.signal.aborted, false);
  gate.resolve();
  assert.equal((await second).keyBudget.remaining, 4);
  assert.equal((await bridge({ action: 'usage', id: secondID })).keyBudget.remaining, 4, 'settled native UUID is reusable');
});

test('usage IPC cancellation stays provider-scoped even with identical request IDs', async () => {
  const signals = {}, gates = { cloud: deferred(), local: deferred() }, id = crypto.randomUUID();
  const waiting = label => ({ usage: async signal => { signals[label] = signal; await gates[label].promise; return { provider: label }; } });
  const bridge = createDesktopAI(waiting('cloud'), waiting('local'));
  const cloudRead = bridge({ action: 'usage', id, provider: 'openrouter' });
  const localRead = bridge({ action: 'usage', id, provider: 'local' });
  await bridge({ action: 'cancel', id, provider: 'local' });
  assert.equal(signals.local.aborted, true);
  assert.equal(signals.cloud.aborted, false);
  gates.local.resolve(); gates.cloud.resolve();
  await Promise.all([localRead, cloudRead]);
});

test('frontend native usage forwards a matching cancellation ID and discards late quota output', async t => {
  const calls = [], gate = deferred(), controller = new AbortController();
  let fetches = 0;
  replaceGlobal(t, 'fetch', async () => { fetches++; throw new Error('no cloud fallback'); });
  replaceGlobal(t, 'window', { contextDesktop: { ai: async message => {
    calls.push(message);
    return message.action === 'cancel' ? { ok: true } : gate.promise;
  } } });
  const pending = aiRequest('openrouter', 'usage', { signal: controller.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  assert.match(calls[0].id, /^[a-f0-9-]{36}$/i);
  assert.equal(calls[0].body, undefined);
  controller.abort();
  gate.resolve({ ok: true, value: { provider: 'openrouter', status: 'available' } });
  await rejected;
  assert.deepEqual(calls[1], { action: 'cancel', id: calls[0].id, provider: 'openrouter' });
  assert.equal(fetches, 0);
});

test('frontend usage uses the fixed HTTP GET and fails closed for local, invalid or body-bearing requests', async t => {
  const calls = [];
  replaceGlobal(t, 'window', {});
  replaceGlobal(t, 'fetch', async (url, options) => { calls.push({ url, options }); return Response.json({ provider: 'openrouter', status: 'unknown' }); });
  await aiRequest('openrouter', 'usage');
  assert.equal(calls[0].url, '/api/ai/usage?provider=openrouter');
  assert.equal(calls[0].options.body, undefined);
  assert.equal(calls[0].options.credentials, 'same-origin');
  for (const body of [null, false, '', {}, []]) await assert.rejects(aiRequest('openrouter', 'usage', { body }));
  for (const provider of ['local', 'evil', '__proto__']) await assert.rejects(aiRequest(provider, 'usage'));
  await assert.rejects(aiRequest('openrouter', 'usage', { signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.equal(calls.length, 1);
});

class FakeResponse extends EventEmitter {
  status = 0; headers = {}; body = ''; writableEnded = false; destroyed = false;
  writeHead(status, headers = {}) { this.status = status; this.headers = headers; }
  end(body = '') { this.body = String(body); this.writableEnded = true; }
}
function requestMessage(url, { method = 'GET', headers = {}, body } = {}) {
  return {
    url, method, headers: { host: '127.0.0.1:4346', ...headers },
    async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)); }
  };
}
async function httpFixture(ki, router) {
  const handler = createRequestHandler(() => 4346, async () => ({ items: [], sources: [] }), ki, undefined, router);
  const request = async (url, options) => { const res = new FakeResponse(); await handler(requestMessage(url, options), res); return res; };
  const cookie = (await request('/')).headers['Set-Cookie'].split(';')[0];
  return { handler, request, cookie };
}

test('real HTTP handler rejects hostile usage reads and wrong methods before invoking either provider', async () => {
  const calls = [];
  const client = provider => ({ usage: async signal => { assert.ok(signal instanceof AbortSignal); calls.push(provider); return { provider, status: 'unknown' }; } });
  const f = await httpFixture(client('kiconnect'), client('openrouter'));
  for (const [options, status] of [
    [{ headers: {} }, 403],
    [{ headers: { cookie: 'wrong' } }, 403],
    [{ headers: { cookie: f.cookie, host: 'outside.invalid:4346' } }, 403],
    [{ headers: { cookie: f.cookie, origin: 'https://outside.invalid' } }, 403],
    [{ headers: { cookie: f.cookie, 'sec-fetch-site': 'cross-site' } }, 403],
    [{ headers: { cookie: f.cookie, 'content-length': '1' }, body: {} }, 400],
    [{ headers: { cookie: f.cookie, 'transfer-encoding': 'chunked' }, body: {} }, 400],
    [{ method: 'POST', headers: { cookie: f.cookie }, body: { key: 'PRIVATE_INJECTED' } }, 405],
    [{ method: 'PUT', headers: { cookie: f.cookie } }, 405],
    [{ method: 'HEAD', headers: { cookie: f.cookie } }, 405]
  ]) assert.equal((await f.request('/api/ai/usage?provider=openrouter', options)).status, status);
  for (const provider of ['unknown', 'local', '__proto__']) {
    assert.equal((await f.request('/api/ai/usage?provider=' + provider, { headers: { cookie: f.cookie } })).status, 400);
  }
  for (const path of [
    '/api/ai/usage?provider=openrouter&url=https://outside.invalid',
    '/api/ai/usage?provider=openrouter&key=PRIVATE_INJECTED',
    '/api/ai/usage?provider=openrouter&provider=kiconnect'
  ]) assert.equal((await f.request(path, { headers: { cookie: f.cookie } })).status, 400);
  assert.equal(calls.length, 0);
  const reply = await f.request('/api/ai/usage?provider=openrouter', { headers: { cookie: f.cookie } });
  assert.equal(reply.status, 200);
  assert.equal(reply.headers['Cache-Control'], 'private, no-store');
  assert.deepEqual(JSON.parse(reply.body), { provider: 'openrouter', status: 'unknown' });
  assert.deepEqual(calls, ['openrouter'], 'only the validated provider reaches its usage capability');
  assert.equal((await f.request('/api/ai/usage', { headers: { cookie: f.cookie } })).status, 200);
  assert.deepEqual(calls, ['openrouter', 'kiconnect']);
});

test('real HTTP usage handler masks internal failures and disconnect cancels its actual connector participant', async () => {
  const errorClient = { usage: async () => { throw new Error('PRIVATE_INTERNAL_FAILURE'); } };
  const bad = await httpFixture(errorClient, errorClient);
  const failed = await bad.request('/api/ai/usage?provider=openrouter', { headers: { cookie: bad.cookie } });
  assert.equal(failed.status, 502);
  assert.doesNotMatch(failed.body, /PRIVATE_INTERNAL_FAILURE/);

  const gate = deferred(), calls = [];
  const router = cloud({ fetcher: async (url, options) => { calls.push({ url, options }); await gate.promise; return Response.json(metadata(4)); } });
  const f = await httpFixture({ usage: async () => ({ provider: 'kiconnect', status: 'unknown' }) }, router);
  const response = new FakeResponse();
  const pending = f.handler(requestMessage('/api/ai/usage?provider=openrouter', { headers: { cookie: f.cookie } }), response);
  await until(() => calls.length === 1, 'HTTP usage connector request starts');
  response.destroyed = true;
  response.emit('close');
  await pending;
  assert.equal(calls[0].options.signal.aborted, true);
  assert.equal(response.status, 0, 'disconnected response receives no late quota data');
  assert.equal(response.listenerCount('close'), 0);
  gate.resolve(); await tick();
});
