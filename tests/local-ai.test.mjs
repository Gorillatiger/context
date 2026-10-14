import test from 'node:test';
import assert from 'node:assert/strict';
import { KIError } from '../connectors/ki.mjs';
import { createLocalAIClient } from '../desktop/local-ai.mjs';

const input = { model: 'local/model', messages: [{ role: 'user', content: 'Synthetic local question' }] };
const models = () => Response.json({ data: [{ id: 'local/model' }] });
const completion = () => Response.json({ choices: [{ message: { content: 'Local answer' }, finish_reason: 'stop' }], usage: { total_tokens: 42 } });
const fake = async url => url.endsWith('/models') ? models() : completion();
const hasCode = code => error => error instanceof KIError && error.code === code;
const turn = () => new Promise(resolve => setImmediate(resolve));

test('local AI starts disconnected at the default port and never probes without configure', async () => {
  let calls = 0;
  const client = createLocalAIClient({ fetcher: async () => { calls++; return models(); } });
  assert.deepEqual(await client.status(), { configured: false, storage: null, provider: 'Lokales Modell', port: 1234, local: true });
  await assert.rejects(client.models(), hasCode('not_configured'));
  await assert.rejects(client.complete(input), hasCode('not_configured'));
  assert.equal(calls, 0);
  const connected = await client.configure({});
  assert.equal(connected.port, 1234);
  assert.equal((await client.status()).configured, true);
  assert.equal(calls, 1);
});

test('only fixed loopback models and chat endpoints receive narrowly bounded OpenAI-compatible requests', async () => {
  const calls = [];
  const client = createLocalAIClient({ fetcher: async (url, options) => {
    calls.push({ url, options });
    return url.endsWith('/models')
      ? Response.json({ data: [{ id: 'local/model', name: 'private server name', secret: 'discarded' }] })
      : completion();
  } });
  const connected = await client.configure({ port: 11434, key: 'synthetic-local-secret' });
  assert.deepEqual(connected.models, [{ id: 'local/model' }]);
  assert.equal(connected.storage, 'session');
  const answer = await client.complete(input);
  assert.deepEqual(answer, { content: 'Local answer', model: 'local/model', finishReason: 'stop', totalTokens: 42 });
  assert.deepEqual(calls.map(call => call.url), ['http://127.0.0.1:11434/v1/models', 'http://127.0.0.1:11434/v1/chat/completions']);
  for (const { options } of calls) {
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.headers.Authorization, 'Bearer synthetic-local-secret');
    assert.equal(options.headers.Accept, 'application/json');
    assert.ok(options.signal instanceof AbortSignal);
  }
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.body, undefined);
  assert.equal(calls[1].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[1].options.body), { ...input, stream: false });
  assert.ok(!JSON.stringify([connected, answer, await client.status()]).includes('secret'));
  assert.ok(!JSON.stringify(connected).includes('private'));
});

test('invalid ports, arbitrary URLs and credential header injection never reach fetch', async () => {
  let calls = 0;
  const client = createLocalAIClient({ fetcher: async () => { calls++; return models(); } });
  for (const port of [0, 1023, 65536, 4318, 1234.5, '1234', NaN, Infinity, null, {}, '1234/v1/evil'])
    await assert.rejects(client.configure({ port }), hasCode('invalid_port'));
  for (const config of [null, [], { port: 1234, url: 'https://cloud.invalid/' }, { port: 1234, host: 'evil' }, { port: 1234, headers: {} }, { port: 1234, key: 7 }, { port: 1234, key: 'secret\r\nX-Other: injected' }, { port: 1234, key: '\0' }, { port: 1234, key: 'x'.repeat(4097) }])
    await assert.rejects(client.configure(config), error => error instanceof KIError && error.status === 400);
  assert.equal(calls, 0);
  await client.configure({ port: 1024 });
  await client.configure({ port: 65535 });
  assert.equal((await client.status()).port, 65535);
});

test('optional authentication remains in RAM and empty key removes the authorization header', async () => {
  const calls = [];
  const client = createLocalAIClient({ fetcher: async (url, options) => { calls.push(options.headers); return fake(url); } });
  await client.configure({ port: 1234, key: ' synthetic-key ' });
  assert.equal(calls[0].Authorization, 'Bearer synthetic-key');
  await client.configure({ port: 11434, key: '' });
  await client.complete(input);
  assert.equal(Object.hasOwn(calls[1], 'Authorization'), false);
  assert.equal(Object.hasOwn(calls[2], 'Authorization'), false);
  assert.equal((await client.status()).storage, null);
});

test('configure is atomic across connection, model catalog and optional key changes', async () => {
  const calls = [];
  const client = createLocalAIClient({ fetcher: async (url, options) => {
    calls.push({ url, options });
    if (url.includes(':11434/')) return new Response('private server key', { status: 401 });
    return fake(url);
  } });
  await client.configure({ port: 1234, key: 'old-synthetic-key' });
  await assert.rejects(client.configure({ port: 11434, key: 'failed-synthetic-key' }), hasCode('access_denied'));
  assert.equal((await client.status()).port, 1234);
  await client.complete(input);
  assert.equal(calls.at(-1).url, 'http://127.0.0.1:1234/v1/chat/completions');
  assert.equal(calls.at(-1).options.headers.Authorization, 'Bearer old-synthetic-key');
  const unconfigured = createLocalAIClient({ fetcher: async () => Response.json({ data: [] }) });
  await assert.rejects(unconfigured.configure({ port: 11434 }), hasCode('no_models'));
  assert.equal((await unconfigured.status()).configured, false);
  assert.equal((await unconfigured.status()).port, 1234);
});

test('model allowlist follows a successful reconfiguration and cannot be poisoned through returned arrays', async () => {
  const calls = [];
  const client = createLocalAIClient({ fetcher: async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/models')) return Response.json({ data: [{ id: url.includes(':11434/') ? 'new/model' : 'local/model' }] });
    return completion();
  } });
  const first = await client.configure({ port: 1234 });
  first.models[0].id = 'injected/model';
  await assert.rejects(client.complete({ ...input, model: 'injected/model' }), hasCode('unknown_model'));
  await client.complete(input);
  await client.configure({ port: 11434 });
  await assert.rejects(client.complete(input), hasCode('unknown_model'));
  await client.complete({ ...input, model: 'new/model' });
  assert.equal(JSON.parse(calls.at(-1).options.body).model, 'new/model');
});

test('model catalog refreshes after five minutes even while completions use the cached catalog', async () => {
  let time = 0;
  let available = 'local/model';
  let gets = 0;
  let posts = 0;
  const client = createLocalAIClient({ now: () => time, fetcher: async url => {
    if (url.endsWith('/models')) { gets++; return Response.json({ data: [{ id: available }] }); }
    posts++; return completion();
  } });
  await client.configure({ port: 1234 });
  time = 240_000;
  await client.complete(input);
  available = 'different/model';
  time = 300_000;
  await assert.rejects(client.complete(input), hasCode('unknown_model'));
  assert.equal(gets, 2);
  assert.equal(posts, 1);
});

test('malformed or oversized model catalogs and invalid identifiers cannot configure a connection', async () => {
  for (const [data, code] of [
    [{ data: [] }, 'no_models'],
    [{ data: [{}] }, 'no_models'],
    [{ data: [{ id: 'a'.repeat(161) }, { id: 'bad\nmodel' }] }, 'no_models'],
    [{ data: Array(201).fill({ id: 'local/model' }) }, 'invalid_models'],
    [{ data: {} }, 'invalid_models'],
    [[], 'invalid_response'],
    [null, 'invalid_response'],
  ]) {
    const client = createLocalAIClient({ fetcher: async () => Response.json(data) });
    await assert.rejects(client.configure({ port: 1234 }), hasCode(code));
    assert.equal((await client.status()).configured, false);
  }
  const client = createLocalAIClient({ fetcher: async () => Response.json({ data: [{ id: 'local/model' }, { id: 'local/model' }, null, { id: 'bad\n' }] }) });
  assert.deepEqual((await client.configure({ port: 1234 })).models, [{ id: 'local/model' }]);
});

test('provider and adapter errors never expose response bodies, keys, headers or a cloud fallback', async () => {
  for (const [status, code] of [[401, 'access_denied'], [403, 'access_denied'], [429, 'provider_limit'], [500, 'provider_error']]) {
    const calls = [];
    const client = createLocalAIClient({ fetcher: async url => {
      calls.push(url);
      return url.endsWith('/models') ? models() : new Response('synthetic-secret Authorization: Bearer synthetic-secret', { status });
    } });
    await client.configure({ port: 1234, key: 'synthetic-secret' });
    await assert.rejects(client.complete(input), error => {
      assert.equal(error.code, code);
      assert.ok(!String(error).includes('synthetic-secret'));
      assert.ok(!String(error).includes('Authorization'));
      return true;
    });
    assert.equal(calls.length, 2);
    assert.ok(calls.every(url => url.startsWith('http://127.0.0.1:1234/v1/')));
  }
  for (const thrown of [new Error('Authorization: Bearer synthetic-secret'), new KIError(500, 'unsafe', 'synthetic-secret')]) {
    const client = createLocalAIClient({ fetcher: async () => { throw thrown; } });
    await assert.rejects(client.configure({ port: 1234, key: 'synthetic-secret' }), error => error.code === 'connection_failed' && !String(error).includes('synthetic-secret'));
  }
});

test('redirects are disabled and attempted non-loopback response redirects fail closed', async () => {
  for (const response of [
    new Response('private', { status: 302, headers: { Location: 'https://cloud.invalid/' } }),
    Object.defineProperty(models(), 'redirected', { value: true }),
    Object.defineProperty(models(), 'url', { value: 'https://cloud.invalid/v1/models' }),
  ]) {
    let calls = 0;
    const client = createLocalAIClient({ fetcher: async (url, options) => {
      calls++;
      assert.equal(url, 'http://127.0.0.1:1234/v1/models');
      assert.equal(options.redirect, 'error');
      return response;
    } });
    await assert.rejects(client.configure({ port: 1234 }), hasCode('redirect_blocked'));
    assert.equal(calls, 1);
  }
});

test('JSON MIME, syntax, UTF-8 and response byte limits are enforced before model parsing', async () => {
  for (const [response, code] of [
    [new Response('{"data":[]}', { headers: { 'Content-Type': 'text/html' } }), 'invalid_response'],
    [new Response('private invalid JSON', { headers: { 'Content-Type': 'application/json' } }), 'invalid_response'],
    [new Response(new Uint8Array([123, 255, 125]), { headers: { 'Content-Type': 'application/json' } }), 'invalid_response'],
    [new Response('x'.repeat(1_000_001), { headers: { 'Content-Type': 'application/json' } }), 'response_limit'],
    [new Response('{}', { headers: { 'Content-Type': 'application/json', 'Content-Length': '1000001' } }), 'response_limit'],
  ]) {
    const client = createLocalAIClient({ fetcher: async () => response });
    await assert.rejects(client.configure({ port: 1234 }), error => error.code === code && !String(error).includes('private'));
    assert.equal((await client.status()).configured, false);
  }
});

test('chat validation and serialized request bounds reject extra capabilities before POST', async () => {
  const calls = [];
  const client = createLocalAIClient({ fetcher: async url => { calls.push(url); return fake(url); } });
  await client.configure({ port: 1234 });
  for (const body of [
    { ...input, tools: [] }, { ...input, url: 'https://cloud.invalid/' },
    { ...input, messages: [{ role: 'system', content: 'secret' }] },
    { ...input, messages: [{ role: 'user', content: 'x'.repeat(12001) }] },
    { ...input, messages: [{ role: 'user', content: 'u' }, { role: 'user', content: 'u' }] },
    { ...input, model: 'bad\nmodel' },
  ]) await assert.rejects(client.complete(body), error => error instanceof KIError && error.status === 400);
  const lengths = [12000, 50000, 12000, 14000, 12000];
  await assert.rejects(client.complete({ ...input, messages: lengths.map((length, index) => ({ role: index % 2 ? 'assistant' : 'user', content: '\0'.repeat(length) })) }), hasCode('request_limit'));
  assert.deepEqual(calls, ['http://127.0.0.1:1234/v1/models']);
});

test('completion content, finish reason and token metadata are bounded independently', async () => {
  for (const content of [null, '', ' ', 'x'.repeat(50001)]) {
    const client = createLocalAIClient({ fetcher: async url => url.endsWith('/models') ? models() : Response.json({ choices: [{ message: { content } }] }) });
    await client.configure({ port: 1234 });
    await assert.rejects(client.complete(input), hasCode('invalid_completion'));
  }
  const client = createLocalAIClient({ fetcher: async url => url.endsWith('/models') ? models() : Response.json({ model: 'untrusted/server/model', choices: [{ message: { content: 'Text only' }, finish_reason: 'x'.repeat(100) }], usage: { total_tokens: -1 } }) });
  await client.configure({ port: 1234 });
  const answer = await client.complete(input);
  assert.equal(answer.model, 'local/model');
  assert.equal(answer.finishReason.length, 30);
  assert.equal(Object.hasOwn(answer, 'totalTokens'), false);
});

test('busy state covers configure, model listing and completions; cancellation releases it', async () => {
  let pendingStarted;
  const started = new Promise(resolve => { pendingStarted = resolve; });
  let stall = true;
  const client = createLocalAIClient({ fetcher: async url => {
    if (url.endsWith('/models')) return models();
    if (stall) { pendingStarted(); return new Promise(() => {}); }
    return completion();
  } });
  await client.configure({ port: 1234 });
  const controller = new AbortController();
  const pending = client.complete(input, controller.signal);
  const rejected = assert.rejects(pending, hasCode('cancelled'));
  await started;
  await assert.rejects(client.models(), hasCode('busy'));
  await assert.rejects(client.configure({ port: 11434 }), hasCode('busy'));
  await assert.rejects(client.complete(input), hasCode('busy'));
  assert.equal((await client.status()).configured, true);
  controller.abort(new Error('synthetic-secret cancellation reason'));
  await rejected;
  stall = false;
  assert.equal((await client.complete(input)).content, 'Local answer');
});

test('pre-aborted requests do not fetch and aborted configure keeps the previously confirmed setup', async () => {
  let calls = 0;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const client = createLocalAIClient({ fetcher: async url => {
    calls++;
    if (url.includes(':11434/')) { entered(); return new Promise(() => {}); }
    return fake(url);
  } });
  await client.configure({ port: 1234 });
  const aborted = AbortSignal.abort(new Error('private abort reason'));
  for (const action of [() => client.models(aborted), () => client.complete(input, aborted), () => client.configure({ port: 11434 }, aborted)])
    await assert.rejects(action(), error => error.code === 'cancelled' && !String(error).includes('private'));
  assert.equal(calls, 1);
  const controller = new AbortController();
  const pending = client.configure({ port: 11434, key: 'failed-key' }, controller.signal);
  const rejected = assert.rejects(pending, hasCode('cancelled'));
  await started;
  assert.equal((await client.status()).port, 1234);
  controller.abort();
  await rejected;
  assert.equal((await client.status()).port, 1234);
  await client.complete(input);
});

test('cancellation interrupts a stalled response stream and cancels its body', async () => {
  let cancelled = false;
  let began;
  const started = new Promise(resolve => { began = resolve; });
  const client = createLocalAIClient({ fetcher: async url => {
    if (url.endsWith('/models')) return models();
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"choices":')); began(); },
      pull() { return new Promise(() => {}); },
      cancel() { cancelled = true; },
    }), { headers: { 'Content-Type': 'application/json' } });
  } });
  await client.configure({ port: 1234 });
  const controller = new AbortController();
  const pending = client.complete(input, controller.signal);
  const rejected = assert.rejects(pending, hasCode('cancelled'));
  await started;
  await turn();
  controller.abort();
  await rejected;
  assert.equal(cancelled, true);
});

test('late fetch responses are cancelled after caller abort rather than retained', async () => {
  let deliver;
  let began;
  const started = new Promise(resolve => { began = resolve; });
  const client = createLocalAIClient({ fetcher: async url => {
    if (url.endsWith('/models')) return models();
    began();
    return new Promise(resolve => { deliver = resolve; });
  } });
  await client.configure({ port: 1234 });
  const controller = new AbortController();
  const pending = client.complete(input, controller.signal);
  const rejected = assert.rejects(pending, hasCode('cancelled'));
  await started;
  controller.abort();
  await rejected;
  let cancelled = false;
  deliver(new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'application/json' } }));
  await turn();
  assert.equal(cancelled, true);
});

test('model retrieval times out at 15 seconds without configuring or leaking its key', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const client = createLocalAIClient({ fetcher: async () => new Promise(() => {}) });
  const pending = client.configure({ port: 1234, key: 'synthetic-timeout-secret' });
  const rejected = assert.rejects(pending, error => error.status === 504 && error.code === 'timeout' && !String(error).includes('synthetic-timeout-secret'));
  t.mock.timers.tick(14_999);
  await assert.rejects(client.configure({ port: 11434 }), hasCode('busy'));
  t.mock.timers.tick(1);
  await rejected;
  assert.equal((await client.status()).configured, false);
});

test('completion timeout is 180 seconds and releases busy state', async t => {
  let stall = true;
  const client = createLocalAIClient({ fetcher: async url => url.endsWith('/models') ? models() : stall ? new Promise(() => {}) : completion() });
  await client.configure({ port: 1234 });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = client.complete(input);
  const rejected = assert.rejects(pending, hasCode('timeout'));
  t.mock.timers.tick(179_999);
  await assert.rejects(client.models(), hasCode('busy'));
  t.mock.timers.tick(1);
  await rejected;
  stall = false;
  assert.equal((await client.complete(input)).content, 'Local answer');
});

test('all local network actions share a ten-per-minute limit while status stays available', async () => {
  let time = 0;
  let calls = 0;
  const client = createLocalAIClient({ now: () => time, fetcher: async url => { calls++; return fake(url); } });
  await client.configure({ port: 1234 });
  for (let index = 0; index < 9; index++) await client.models();
  await assert.rejects(client.models(), hasCode('local_limit'));
  await assert.rejects(client.complete(input), hasCode('local_limit'));
  await assert.rejects(client.configure({ port: 11434 }), hasCode('local_limit'));
  assert.equal((await client.status()).configured, true);
  assert.equal(calls, 10);
  time = 60_000;
  await client.models();
  assert.equal(calls, 11);
});
