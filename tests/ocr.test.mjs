import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough, Writable} from 'node:stream';
import {readFileSync} from 'node:fs';
import {createDesktopOCR, decodeOCRImage, validateOCRResult, MAX_OCR_BYTES} from '../desktop/ocr.mjs';

// These tiny fixture headers test preflight parsing, not image decompression.
// The native ImageIO helper performs full decoding before Vision sees an image.
function png(width = 1, height = 1, extraChunk) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const chunk = (type, data) => {
    const value = Buffer.alloc(12 + data.length); value.writeUInt32BE(data.length);
    value.write(type, 4, 'ascii'); data.copy(value, 8); return value;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([signature, chunk('IHDR', header), ...(extraChunk ? [chunk(extraChunk, Buffer.alloc(8))] : []), chunk('IEND', Buffer.alloc(0))]);
}
function jpeg(width = 1, height = 1) {
  const value = Buffer.from([255, 216, 255, 192, 0, 11, 8, 0, 0, 0, 0, 1, 1, 0x11, 0, 255, 217]);
  value.writeUInt16BE(height, 7); value.writeUInt16BE(width, 9); return value;
}
const dataURL = (bytes = png(), mime = 'image/png') => `data:${mime};base64,${bytes.toString('base64')}`;
const result = (overrides = {}) => ({text: '16.10.2026\t09:00 bis 11:00\tPrototyping',
  lines: [{text: '16.10.2026', x: 0.05, y: 0.1, width: 0.2, height: 0.03},
    {text: '09:00 bis 11:00', x: 0.3, y: 0.1, width: 0.25, height: 0.03},
    {text: 'Prototyping', x: 0.6, y: 0.1, width: 0.2, height: 0.03}],
  engine: 'Apple Vision', warnings: ['Erkanntes Datum bitte prüfen.'], ...overrides});
function fakeProcess({onInput, response = {ok: true, value: result()}, code = 0, chunks, stderr = ''} = {}) {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kills = []; child.input = [];
  child.kill = signal => { child.kills.push(signal); return true; };
  child.stdin = new Writable({
    write(bytes, _encoding, callback) { child.input.push(Buffer.from(bytes)); child.inputReference = bytes; callback(); },
    final(callback) {
      callback();
      setImmediate(() => {
        if (onInput) { onInput(child); return; }
        if (stderr) child.stderr.write(stderr);
        for (const bytes of chunks || [Buffer.from(JSON.stringify(response))]) child.stdout.write(bytes);
        child.stdout.end(); child.emit('close', code);
      });
    }
  });
  return child;
}

test('preflight accepts only canonical JPEG/PNG data URLs and reads dimensions from their own bytes', () => {
  const image = decodeOCRImage({dataURL: dataURL(png(320, 240))});
  assert.deepEqual([image.mime, image.width, image.height], ['image/png', 320, 240]);
  assert.equal(image.bytes.length, png().length);
  const photograph = decodeOCRImage({dataURL: dataURL(jpeg(640, 480), 'image/jpeg')});
  assert.deepEqual([photograph.width, photograph.height], [640, 480]);
  for (const invalid of [
    'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/gif;base64,R0lGODk=',
    dataURL(png(), 'image/jpeg'), dataURL(jpeg(), 'image/png'),
    'data:image/png;base64,not valid base64!', 'data:image/png;base64,AB==',
    dataURL().slice(0, -1), 'https://example.org/photo.png', '/Users/name/photo.png'
  ]) assert.throws(() => decodeOCRImage({dataURL: invalid}));
});

test('renderer messages cannot select paths, commands, file types or helper arguments', async () => {
  let spawns = 0;
  const ocr = createDesktopOCR({platform: 'darwin', spawnProcess: () => { spawns++; return fakeProcess(); }});
  for (const payload of [{path: '/tmp/a'}, {dataURL: dataURL(), path: '/tmp/a'},
    {dataURL: dataURL(), command: 'curl'}, {dataURL: dataURL(), args: ['secret']},
    {dataURL: dataURL(), mime: 'image/jpeg'}, [], null])
    await assert.rejects(ocr(payload));
  assert.equal(spawns, 0);
});

test('image byte, pixel and dimension limits are enforced before starting a helper', () => {
  assert.throws(() => decodeOCRImage({dataURL: dataURL(Buffer.alloc(MAX_OCR_BYTES + 1))}), /8 MiB/);
  assert.throws(() => decodeOCRImage({dataURL: dataURL(png(10000, 2001))}), /Millionen Pixeln/);
  assert.throws(() => decodeOCRImage({dataURL: dataURL(png(10001, 1))}), /Millionen Pixeln/);
  assert.throws(() => decodeOCRImage({dataURL: dataURL(jpeg(10000, 2001), 'image/jpeg')}), /Millionen Pixeln/);
  assert.throws(() => decodeOCRImage({dataURL: dataURL(png(0, 1))}));
  assert.throws(() => decodeOCRImage({dataURL: dataURL(png(10, 10, 'acTL'))}));
  const truncated = png().subarray(0, png().length - 3);
  assert.throws(() => decodeOCRImage({dataURL: dataURL(truncated)}));
  assert.equal(decodeOCRImage({dataURL: dataURL(png(10000, 2000))}).width, 10000);
});

test('the helper receives only stdin bytes through a fixed nonshell command; stdout positions survive', async () => {
  const child = fakeProcess(), calls = [];
  const ocr = createDesktopOCR({platform: 'darwin', helperPath: '/fixed/application/ocr-helper', spawnProcess: (...args) => { calls.push(args); return child; }});
  const value = await ocr({dataURL: dataURL()});
  assert.deepEqual(value, result());
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/fixed/application/ocr-helper');
  assert.deepEqual(calls[0][1], []);
  assert.equal(calls[0][2].shell, false);
  assert.deepEqual(calls[0][2].stdio, ['pipe', 'pipe', 'pipe']);
  assert.ok(!JSON.stringify(calls).includes('data:image/'));
  assert.deepEqual(Buffer.concat(child.input), png());
  assert.ok(child.inputReference.every(byte => byte === 0), 'Transient main-process image buffers should be wiped after process completion');
});

test('chunked JSON output is assembled but excessive or malformed helper output is never returned', async () => {
  const serialized = Buffer.from(JSON.stringify({ok: true, value: result()}));
  const split = fakeProcess({chunks: [serialized.subarray(0, 10), serialized.subarray(10)]});
  const ocr = createDesktopOCR({platform: 'darwin', spawnProcess: () => split});
  assert.equal((await ocr({dataURL: dataURL()})).engine, 'Apple Vision');
  for (const chunks of [[Buffer.alloc(256 * 1024 + 1, 65)], [Buffer.from('broken JSON')],
    [Buffer.from(JSON.stringify({ok: true, value: result(), rawImage: 'PRIVATE_IMAGE'}))]]) {
    const child = fakeProcess({chunks});
    await assert.rejects(createDesktopOCR({platform: 'darwin', spawnProcess: () => child})({dataURL: dataURL()}));
    assert.ok(child.kills.includes('SIGKILL'));
  }
});

test('helper failures discard private stderr and sanitized messages do not expose filenames or image data', async () => {
  const secret = '/Users/private/foto.jpg data:image/png;base64,PRIVATE';
  for (const response of [{ok: false, code: 'invalidImage', error: secret}, {ok: false, code: 'unknown', error: secret}, {ok: false, code: '__proto__', error: secret}]) {
    const child = fakeProcess({response, code: 1, stderr: secret});
    await assert.rejects(createDesktopOCR({platform: 'darwin', spawnProcess: () => child})({dataURL: dataURL()}), error => {
      assert.ok(!error.message.includes('PRIVATE'));
      assert.ok(!error.message.includes('/Users/private'));
      return true;
    });
  }
  const missing = new EventEmitter(); missing.stdout = new PassThrough(); missing.stderr = new PassThrough();
  missing.stdin = new PassThrough(); missing.kill = () => true;
  setImmediate(() => missing.emit('error', Object.assign(new Error(secret), {code: 'ENOENT'})));
  await assert.rejects(createDesktopOCR({platform: 'darwin', spawnProcess: () => missing})({dataURL: dataURL()}), /OCR-Komponente fehlt/);
});

test('bounded timeout kills the helper and releases the single-photo lock for the next request', async () => {
  const hanging = fakeProcess({onInput: () => {}}), normal = fakeProcess(); let calls = 0;
  const ocr = createDesktopOCR({platform: 'darwin', timeoutMs: 5, spawnProcess: () => ++calls === 1 ? hanging : normal});
  const pending = ocr({dataURL: dataURL()});
  await assert.rejects(ocr({dataURL: dataURL()}), /bereits lokal gelesen/);
  await assert.rejects(pending, /zu lange/);
  assert.deepEqual(hanging.kills, ['SIGKILL']);
  assert.equal((await ocr({dataURL: dataURL()})).text, result().text);
});

test('non-Mac use fails locally instead of selecting a network OCR fallback', async () => {
  let called = false;
  await assert.rejects(createDesktopOCR({platform: 'linux', spawnProcess: () => { called = true; }})({dataURL: dataURL()}), /nicht verfügbar/);
  assert.equal(called, false);
});

test('recognized text and table positions are bounded and validated instead of accepting helper side channels', () => {
  for (const override of [{text: 'x'.repeat(20001)}, {engine: 'Remote OCR'}, {rawImage: 'secret'},
    {lines: []}, {warnings: Array(11).fill('warning')}, {warnings: ['x'.repeat(241)]}])
    assert.throws(() => validateOCRResult(result(override)));
  for (const badLine of [{...result().lines[0], x: -0.1}, {...result().lines[0], x: 0.9, width: 0.2},
    {...result().lines[0], height: 0}, {...result().lines[0], y: NaN},
    {...result().lines[0], text: 'first\nsecond'}, {...result().lines[0], image: 'secret'}])
    assert.throws(() => validateOCRResult(result({lines: [badLine]})));
  assert.throws(() => validateOCRResult(result({lines: Array.from({length: 21}, () => ({...result().lines[0], text: 'x'.repeat(1000)}))})), /20.000/);
});

test('OCR IPC reuses exact trusted-hub authorization and packaging compiles/unpacks a fixed helper', () => {
  const main = readFileSync(new URL('../desktop/main.mjs', import.meta.url), 'utf8');
  const preload = readFileSync(new URL('../desktop/preload.cjs', import.meta.url), 'utf8');
  const build = readFileSync(new URL('../desktop/build.mjs', import.meta.url), 'utf8');
  assert.match(main, /\['ocr',desktopOCR\]/);
  assert.match(main, /ipcMain\.handle\('context:'\+name,async\(e,message\)=>\{trusted\(e\)/);
  assert.match(preload, /ocr:message=>ipcRenderer\.invoke\('context:ocr',message\)/);
  assert.match(build, /execFileSync\('\/usr\/bin\/xcrun',\['swiftc'/);
  assert.match(build, /'__TEXT','-Xlinker','__info_plist'/);
  assert.match(build, /dev\.hazylabs\.context\.ocr/);
  assert.match(build, /asar:\{unpack:'[^']*ocr-helper[^']*'\}/);
  const helper = readFileSync(new URL('../desktop/ocr.swift', import.meta.url), 'utf8');
  assert.match(helper, /FileHandle\.standardInput/);
  assert.ok(!/URLSession|contentsOfFile|write\(to:|fileURLWithPath|Process\(/.test(helper));
});
