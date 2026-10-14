import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { SPEECH_MODELS, SPEECH_VAD, createSpeechModelStore, isSpeechModelDownloadURL } from '../desktop/speech-models.mjs';

const whisperBytes = Buffer.from('fixture: multilingual Whisper small');
const vadBytes = Buffer.from('fixture: Silero VAD');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const models = { small: { ...SPEECH_MODELS.small, bytes: whisperBytes.length, sha256: hash(whisperBytes) } };
const vad = { ...SPEECH_VAD, bytes: vadBytes.length, sha256: hash(vadBytes) };
async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'context-speech-models-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const calls = [], events = [];
  const fetchImpl = options.fetchImpl || (async (url, init) => {
    calls.push({ url, init });
    const bytes = url.includes(vad.filename) ? vadBytes : whisperBytes;
    return new Response(bytes, { headers: { 'content-length': String(bytes.length) } });
  });
  const store = createSpeechModelStore({ directory, models, vad, fetchImpl, emit: event => events.push(event), ...options });
  return { directory, calls, events, store };
}

test('speech model manifest pins multilingual small, turbo and Silero to official immutable revisions', () => {
  assert.deepEqual(Object.keys(SPEECH_MODELS), ['small', 'large-v3-turbo']);
  assert.equal(SPEECH_MODELS.small.filename, 'ggml-small.bin');
  assert.equal(SPEECH_MODELS.small.bytes, 487601967);
  assert.equal(SPEECH_MODELS['large-v3-turbo'].bytes, 1624555275);
  assert.equal(SPEECH_VAD.bytes, 885098);
  for (const model of [...Object.values(SPEECH_MODELS), SPEECH_VAD]) {
    assert.match(model.revision, /^[a-f0-9]{40}$/);
    assert.match(model.sha256, /^[a-f0-9]{64}$/);
    assert.ok(model.url.startsWith(`https://huggingface.co/${model.repository}/resolve/${model.revision}/`));
    assert.ok(!model.filename.includes('.en.'));
  }
});

test('speech model download domains reject foreign origins, LAN, HTTP, credentials and port tricks', () => {
  for (const allowed of ['https://huggingface.co/model', 'https://cdn-lfs.hf.co/model', 'https://us.aws.cdn.hf.co/model', 'https://cas-bridge.xethub.hf.co/model']) {
    assert.equal(isSpeechModelDownloadURL(allowed), true, allowed);
  }
  for (const denied of ['http://huggingface.co/model', 'https://127.0.0.1/model', 'https://192.168.1.1/model',
    'https://huggingface.co:9443/model', 'https://user:password@huggingface.co/model', 'https://hf.co.attacker.example/model',
    'https://attacker-hf.co/model', 'file:///tmp/model', 'invalid']) assert.equal(isSpeechModelDownloadURL(denied), false, denied);
});

test('ensure and status remain offline when models are missing', async t => {
  const { store, calls } = await fixture(t);
  const status = await store.status();
  assert.equal(status.models[0].available, false);
  assert.equal(status.models[0].integrity, 'missing');
  assert.equal(status.vad.available, false);
  await assert.rejects(store.ensure('small'), { code: 'MODEL_MISSING' });
  assert.equal(calls.length, 0);
});

test('download verifies both files, reports combined progress, and subsequent ensure is offline', async t => {
  const { store, calls, events, directory } = await fixture(t);
  const result = await store.download('small');
  assert.equal(result.modelPath, path.join(directory, models.small.filename));
  assert.equal(result.vadPath, path.join(directory, vad.filename));
  assert.equal(result.bytes, whisperBytes.length + vadBytes.length);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.init.redirect, 'manual');
    assert.equal(call.init.credentials, 'omit');
    assert.equal(call.init.headers['Accept-Encoding'], 'identity');
  }
  assert.ok(events.every(event => event.event === 'download' && event.model === 'small'));
  assert.equal(events.at(-1).available, true);
  assert.equal(events.at(-1).received, result.bytes);
  assert.equal(events.filter(event => event.phase === 'verifying').length, 2);
  const fresh = createSpeechModelStore({ directory, models, vad, fetchImpl: () => { throw new Error('offline'); } });
  assert.deepEqual(await fresh.ensure('small'), result);
  const state = await fresh.status();
  assert.equal(state.models[0].available, true);
  assert.equal(state.models[0].integrity, 'verified');
  assert.deepEqual((await fs.readdir(directory)).sort(), [models.small.filename, vad.filename].sort());
});

test('an already downloaded Whisper file still requires the VAD model and is not downloaded twice', async t => {
  const { store, directory, calls } = await fixture(t);
  await fs.writeFile(path.join(directory, models.small.filename), whisperBytes);
  await assert.rejects(store.ensure('small'), { code: 'MODEL_MISSING' });
  assert.equal((await store.status()).models[0].available, false);
  await store.download('small');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes(vad.filename));
  await store.download('small');
  assert.equal(calls.length, 1);
});

test('corrupt cached model is detected before loading without a network repair', async t => {
  const { store, directory, calls } = await fixture(t);
  await store.download('small');
  const changed = Buffer.from(whisperBytes); changed[0] ^= 1;
  await fs.writeFile(path.join(directory, models.small.filename), changed);
  await assert.rejects(store.ensure('small'), { code: 'MODEL_INTEGRITY' });
  assert.equal((await store.status()).models[0].integrity, 'invalid');
  assert.equal(calls.length, 2);
});

test('same-size tampering invalidates the per-process digest cache', async t => {
  const { store, directory } = await fixture(t);
  await store.download('small'); await store.ensure('small');
  const filename = path.join(directory, models.small.filename);
  const before = await fs.stat(filename);
  const changed = Buffer.from(whisperBytes); changed[1] ^= 1;
  await fs.writeFile(filename, changed);
  await fs.utimes(filename, before.atime, before.mtime);
  await assert.rejects(store.ensure('small'), { code: 'MODEL_INTEGRITY' });
});

test('a checksum failure removes the partial file and preserves an existing model', async t => {
  const changed = Buffer.from(whisperBytes); changed[0] ^= 1;
  const { store, directory, events } = await fixture(t, { fetchImpl: async () => new Response(changed) });
  await fs.writeFile(path.join(directory, models.small.filename), 'previous invalid file');
  await assert.rejects(store.download('small'), { code: 'MODEL_INTEGRITY' });
  assert.equal(await fs.readFile(path.join(directory, models.small.filename), 'utf8'), 'previous invalid file');
  assert.equal((await fs.readdir(directory)).filter(name => name.endsWith('.part')).length, 0);
  assert.equal(events.at(-1).phase, 'error');
  assert.equal(events.at(-1).code, 'MODEL_INTEGRITY');
});

test('unexpected content-length is rejected before writing a partial file', async t => {
  const { store, directory } = await fixture(t, { fetchImpl: async () => new Response(whisperBytes, { headers: { 'content-length': '999999' } }) });
  await assert.rejects(store.download('small'), { code: 'MODEL_DOWNLOAD_SIZE' });
  assert.deepEqual(await fs.readdir(directory), []);
});

test('oversized response is bounded to the manifest size and cleaned up', async t => {
  const { store, directory } = await fixture(t, { fetchImpl: async () => new Response(Buffer.concat([whisperBytes, Buffer.from('excess')])) });
  await assert.rejects(store.download('small'), { code: 'MODEL_DOWNLOAD_SIZE' });
  assert.deepEqual(await fs.readdir(directory), []);
});

test('truncated response cannot become an available model', async t => {
  const { store, directory } = await fixture(t, { fetchImpl: async () => new Response(whisperBytes.subarray(0, 4)) });
  await assert.rejects(store.download('small'), { code: 'MODEL_DOWNLOAD_SIZE' });
  assert.deepEqual(await fs.readdir(directory), []);
});

test('cancelled download removes parts and the next explicit download can succeed', async t => {
  const abort = new AbortController();
  const { directory, store } = await fixture(t, { emit: event => {
    if (event.phase === 'downloading' && event.fileReceived > 0) abort.abort();
  } });
  await assert.rejects(store.download('small', { signal: abort.signal }), { code: 'ABORTED' });
  assert.deepEqual(await fs.readdir(directory), []);
  await store.download('small');
  assert.equal((await store.status()).models[0].available, true);
});

test('cancelling during integrity verification also prevents the atomic rename', async t => {
  const abort = new AbortController();
  const { store, directory } = await fixture(t, { emit: event => { if (event.phase === 'verifying') abort.abort(); } });
  await assert.rejects(store.download('small', { signal: abort.signal }), { code: 'ABORTED' });
  assert.deepEqual(await fs.readdir(directory), []);
});

test('an already aborted request never contacts the model server', async t => {
  const { store, calls } = await fixture(t);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(store.download('small', { signal: abort.signal }), { code: 'ABORTED' });
  assert.equal(calls.length, 0);
});

test('manual allowed CDN redirect works and requests have no authentication headers', async t => {
  const seen = [];
  const { store } = await fixture(t, { fetchImpl: async (url, init) => {
    seen.push({ url, init });
    if (url === models.small.url) return new Response(null, { status: 302, headers: { location: 'https://us.aws.cdn.hf.co/model' } });
    return new Response(url.includes(vad.filename) ? vadBytes : whisperBytes);
  } });
  await store.download('small');
  assert.equal(seen.length, 3);
  assert.equal(seen[1].url, 'https://us.aws.cdn.hf.co/model');
  assert.ok(seen.every(({ init }) => !Object.hasOwn(init.headers, 'Authorization') && !Object.hasOwn(init.headers, 'Cookie')));
});

test('redirect to a foreign website or loopback is rejected without fetching it', async t => {
  for (const location of ['https://attacker.example/model', 'http://127.0.0.1:4318/api']) {
    let calls = 0;
    const { store, directory } = await fixture(t, { fetchImpl: async () => {
      calls++; return new Response(null, { status: 302, headers: { location } });
    } });
    await assert.rejects(store.download('small'), { code: 'MODEL_DOWNLOAD_ORIGIN' });
    assert.equal(calls, 1);
    assert.deepEqual(await fs.readdir(directory), []);
  }
});

test('redirect cycles are capped and cleaned up', async t => {
  let calls = 0;
  const { store, directory } = await fixture(t, { fetchImpl: async () => {
    calls++; return new Response(null, { status: 302, headers: { location: models.small.url } });
  } });
  await assert.rejects(store.download('small'), { code: 'MODEL_DOWNLOAD_ORIGIN' });
  assert.equal(calls, 6);
  assert.deepEqual(await fs.readdir(directory), []);
});

test('HTTP failures remain recoverable without a partial model file', async t => {
  const { store, directory, events } = await fixture(t, { fetchImpl: async () => new Response('unavailable', { status: 503 }) });
  await assert.rejects(store.download('small'), { code: 'MODEL_DOWNLOAD_HTTP' });
  assert.deepEqual(await fs.readdir(directory), []);
  assert.match(events.at(-1).message, /HTTP 503/);
});

test('parallel downloads are rejected rather than sharing cancellation or partial files', async t => {
  let unblock;
  const gate = new Promise(resolve => { unblock = resolve; });
  const { store } = await fixture(t, { fetchImpl: async url => {
    await gate; return new Response(url.includes(vad.filename) ? vadBytes : whisperBytes);
  } });
  const first = store.download('small');
  await assert.rejects(store.download('small'), { code: 'MODEL_DOWNLOAD_BUSY' });
  unblock(); await first;
});

test('unknown model IDs and path traversal never contact the network', async t => {
  const { store, calls } = await fixture(t);
  for (const id of ['../small', 'toString', '__proto__', 'tiny.en', null]) {
    await assert.rejects(store.download(id), { code: 'MODEL_UNKNOWN' });
  }
  assert.equal(calls.length, 0);
  assert.throws(() => createSpeechModelStore({ directory: '/tmp/models', models: {
    small: { ...models.small, filename: '../outside.bin' },
  }, vad }), /Manifest/);
});

test('symlink model files are rejected before load', { skip: process.platform === 'win32' }, async t => {
  const { store, directory } = await fixture(t);
  await fs.writeFile(path.join(directory, 'target.bin'), whisperBytes);
  await fs.symlink(path.join(directory, 'target.bin'), path.join(directory, models.small.filename));
  await fs.writeFile(path.join(directory, vad.filename), vadBytes);
  await assert.rejects(store.ensure('small'), { code: 'MODEL_INTEGRITY' });
});

test('symlink model directory is rejected before download', { skip: process.platform === 'win32' }, async t => {
  const { directory, calls } = await fixture(t);
  const target = path.join(directory, 'real'); await fs.mkdir(target);
  const link = path.join(directory, 'link'); await fs.symlink(target, link);
  const store = createSpeechModelStore({ directory: link, models, vad, fetchImpl: () => calls.push('fetch') });
  await assert.rejects(store.download('small'), { code: 'MODEL_DIRECTORY' });
  assert.equal(calls.length, 0);
});

test('symlink model directory is also rejected by offline ensure', { skip: process.platform === 'win32' }, async t => {
  const { directory } = await fixture(t);
  const target = path.join(directory, 'real'); await fs.mkdir(target);
  await fs.writeFile(path.join(target, models.small.filename), whisperBytes);
  await fs.writeFile(path.join(target, vad.filename), vadBytes);
  const link = path.join(directory, 'link'); await fs.symlink(target, link);
  const store = createSpeechModelStore({ directory: link, models, vad, fetchImpl: () => { throw new Error('offline'); } });
  await assert.rejects(store.ensure('small'), { code: 'MODEL_INTEGRITY' });
  assert.equal((await store.status()).models[0].available, false);
});

test('cancellation unblocks a stalled response body and cleans the active file', async t => {
  const abort = new AbortController(); let began, cancelled = false;
  const started = new Promise(resolve => { began = resolve; });
  const body = new ReadableStream({
    start(controller) { controller.enqueue(whisperBytes.subarray(0, 3)); },
    pull() { began(); return new Promise(() => {}); },
    cancel() { cancelled = true; },
  });
  const { store, directory } = await fixture(t, { fetchImpl: async () => new Response(body) });
  const task = store.download('small', { signal: abort.signal });
  await started; abort.abort();
  await assert.rejects(task, { code: 'ABORTED' });
  assert.equal(cancelled, true);
  assert.deepEqual(await fs.readdir(directory), []);
});

test('progress listener failure cannot corrupt the download or suppress cleanup', async t => {
  const { store } = await fixture(t, { emit: () => { throw new Error('observer failed'); } });
  await store.download('small');
  assert.equal((await store.status()).models[0].available, true);
});
