import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {access, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {ensureWhisperSource, WHISPER_SOURCE} from '../desktop/build-speech.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const helper = path.join(root, 'desktop', process.platform === 'win32' ? 'speech-helper.exe' : 'speech-helper');
let nativeAvailable = true;
try { await access(helper); } catch { nativeAvailable = false; }
const native = {skip: nativeAvailable ? false : 'Run node desktop/build-speech.mjs on this operating system first.'};
const id = '6dcac024-160e-4149-8ac8-7e460cfc58f8';

function frame(type, payload) {
  const value = Buffer.concat([Buffer.from([type]), payload]);
  const header = Buffer.alloc(4); header.writeUInt32LE(value.length);
  return Buffer.concat([header, value]);
}
function command(value) { return frame(1, Buffer.from(JSON.stringify(value))); }
function launch(t) {
  const child = spawn(helper, [], {stdio: ['pipe', 'pipe', 'pipe'], shell: false});
  let text = '', stderr = '', events = [];
  child.stdout.on('data', bytes => {
    text += bytes;
    let newline;
    while ((newline = text.indexOf('\n')) >= 0) {
      events.push(JSON.parse(text.slice(0, newline))); text = text.slice(newline + 1);
    }
  });
  child.stderr.on('data', bytes => { stderr += bytes; });
  const exited = new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', (code, signal) => resolve({code, signal})); });
  t.after(async () => { if (child.exitCode === null) child.kill(); await exited; });
  return {
    child, exited, events, stderr: () => stderr,
    async wait(predicate) {
      const started = Date.now();
      while (Date.now() - started < 5000) {
        const result = events.find(predicate); if (result) return result;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error('Native helper did not produce the expected event.');
    },
  };
}

test('native helper reports missing models without accepting recording', native, async t => {
  const probe = launch(t);
  probe.child.stdin.write(command({op: 'start', id}));
  assert.equal((await probe.wait(event => event.event === 'error')).code, 'MODEL_NOT_READY');
  assert.equal(probe.events.some(event => event.event === 'started'), false);
  probe.child.stdin.end(command({op: 'shutdown'}));
  assert.equal((await probe.exited).code, 0);
});
test('native helper rejects an oversized binary frame before allocation', native, async t => {
  const probe = launch(t), header = Buffer.alloc(4); header.writeUInt32LE(16 * 1024 * 1024);
  probe.child.stdin.end(header);
  assert.equal((await probe.wait(event => event.event === 'error')).code, 'PROTOCOL_SIZE');
  assert.equal((await probe.exited).code, 0);
});
test('native helper releases resources after a truncated packet', native, async t => {
  const probe = launch(t), header = Buffer.alloc(4); header.writeUInt32LE(100);
  probe.child.stdin.end(Buffer.concat([header, Buffer.from([1, 2, 3])]));
  assert.equal((await probe.wait(event => event.event === 'error')).code, 'PROTOCOL_TRUNCATED');
  assert.equal((await probe.exited).code, 0);
});
test('native helper rejects malformed JSON without echoing command contents', native, async t => {
  const probe = launch(t);
  probe.child.stdin.write(frame(1, Buffer.from('secret words that are not valid JSON')));
  assert.equal((await probe.wait(event => event.event === 'error')).code, 'PROTOCOL_JSON');
  assert.doesNotMatch(JSON.stringify(probe.events) + probe.stderr(), /secret words/);
});
test('native helper rejects a PCM payload with incomplete Float32 samples', native, async t => {
  const probe = launch(t);
  probe.child.stdin.write(frame(2, Buffer.concat([Buffer.from(id), Buffer.alloc(4 * 100 + 3)])));
  assert.equal((await probe.wait(event => event.event === 'error')).code, 'PROTOCOL_TYPE');
});
test('native helper rejects non-finite microphone samples', native, async t => {
  const probe = launch(t), samples = Buffer.alloc(4 * 512); samples.writeFloatLE(NaN);
  probe.child.stdin.write(frame(2, Buffer.concat([Buffer.from(id), samples])));
  const error = await probe.wait(event => event.event === 'error');
  assert.equal(error.code, 'PCM_INVALID'); assert.equal(error.id, id);
});
test('native helper reports a missing Silero model and stays unavailable', native, async t => {
  const probe = launch(t);
  probe.child.stdin.write(command({op: 'load', modelPath: '/missing-small.bin', vadPath: '/missing-silero.bin', gpu: 'cpu'}));
  assert.equal((await probe.wait(event => event.event === 'error')).code, 'VAD_LOAD');
  probe.child.stdin.write(command({op: 'start', id}));
  assert.equal((await probe.wait(event => event.code === 'MODEL_NOT_READY')).id, id);
});
test('source bootstrap refuses a download whose SHA256 differs from the pinned release', async t => {
  const cache = await mkdtemp(path.join(os.tmpdir(), 'context-speech-source-'));
  t.after(() => rm(cache, {recursive: true, force: true}));
  await assert.rejects(ensureWhisperSource(cache, {fetchImpl: async () => new Response('untrusted source archive')}), /SHA-256 mismatch/);
  await assert.rejects(access(path.join(cache, `whisper-${WHISPER_SOURCE.version}.tar.gz`)));
  await assert.rejects(access(path.join(cache, `whisper-${WHISPER_SOURCE.version}.tar.gz.part`)));
});
test('source bootstrap removes a corrupt cached archive before re-fetching', async t => {
  const cache = await mkdtemp(path.join(os.tmpdir(), 'context-speech-source-'));
  t.after(() => rm(cache, {recursive: true, force: true}));
  const archive = path.join(cache, `whisper-${WHISPER_SOURCE.version}.tar.gz`);
  await writeFile(archive, 'corrupt cache');
  let requests = 0;
  await assert.rejects(ensureWhisperSource(cache, {fetchImpl: async () => { requests++; return new Response('bad archive'); }}), /SHA-256 mismatch/);
  assert.equal(requests, 1); await assert.rejects(readFile(archive));
});
