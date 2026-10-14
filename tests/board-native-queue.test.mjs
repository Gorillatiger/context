import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { safeSpacesURL } from '../dist/agent-browser.js';

const sourceURL = new URL('../desktop/main.mjs', import.meta.url);
const courseURL = name => `https://spaces.th-koeln.de/${name}/`;
const turn = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function until(predicate, message) {
  for (let i = 0; i < 20 && !predicate(); i++) await turn();
  assert.ok(predicate(), message);
}

// Run the production agent body and its actual module-level queue initializer.
// Only Electron's browser, emitted events and page reads are replaced by stubs.
async function harness() {
  const source = await readFile(sourceURL, 'utf8');
  const start = source.indexOf('async function agent(message)');
  const end = source.indexOf('\nawait app.whenReady();', start);
  assert.ok(start >= 0 && end > start, 'production agent function is present');
  const initializers = source.match(/^(?:let|const|var)\s+[A-Za-z_$][\w$]*\s*=\s*Promise\.resolve\(\)\s*;?\s*$/gm) || [];
  assert.ok(initializers.length, 'production native scan queue has an explicit initializer');

  const requests = new Map(), loads = [], events = [], throttling = [], reads = [];
  let currentURL = courseURL('initial'), activeLoads = 0, maxActiveLoads = 0, nextID = 0;
  const webContents = {
    isDestroyed: () => false,
    getURL: () => currentURL,
    setBackgroundThrottling: enabled => throttling.push(enabled),
    async loadURL(url) {
      const gate = deferred();
      loads.push({ url, resolve: gate.resolve, reject: gate.reject });
      activeLoads++;
      maxActiveLoads = Math.max(maxActiveLoads, activeLoads);
      try {
        await gate.promise;
        currentURL = url;
      } finally {
        activeLoads--;
      }
    }
  };
  const scan = { id: 'board-scan', view: { webContents }, links: new Set(), controls: new Set(), readAt: '' };
  const context = vm.createContext({
    AbortController, DOMException, setTimeout, clearTimeout,
    activeScanRequest: undefined, crawlLease: undefined, crawlLeaseTimer: undefined,
    requests, boardScanTab: scan, tabs: new Map(), active: 'visible-user-tab',
    scanTab: () => scan, safeSpacesURL,
    read: async tab => {
      assert.equal(tab, scan);
      reads.push(currentURL);
      return { url: currentURL, text: '', boardLinks: [], links: [], controls: [] };
    },
    emit: (type, detail) => events.push({ type, detail })
  });
  const helpers = source.slice(source.indexOf('function agentWait('), source.indexOf('async function loaded('));
  vm.runInContext(`${initializers.join('\n')}\n${helpers}\n${source.slice(start, end)}`, context, { filename: 'desktop/main.mjs:agent' });

  return {
    loads, events, throttling, reads, requests,
    get maxActiveLoads() { return maxActiveLoads; },
    request(name) {
      const id = `00000000-0000-0000-0000-${String(++nextID).padStart(12, '0')}`;
      return { id, promise: context.agent({ type: 'request', id, scan: true, command: 'start', url: courseURL(name) }) };
    },
    cancel: id => context.agent({ type: 'cancel', id })
  };
}

test('cancelled active scan and immediate continuation never navigate the shared view concurrently', { timeout: 3000 }, async () => {
  const h = await harness(), first = h.request('first');
  await until(() => h.loads.length === 1, 'first scan starts');
  await h.cancel(first.id);
  const second = h.request('second');
  await turn();
  assert.equal(h.loads.length, 1, 'continuation waits for the cancelled native operation to settle');
  assert.deepEqual(h.throttling, [false], 'queued continuation does not touch throttling');

  h.loads[0].resolve();
  await first.promise;
  await until(() => h.loads.length === 2, 'continuation starts after the old operation releases the queue');
  assert.equal(h.maxActiveLoads, 1);
  assert.deepEqual(h.throttling, [false, true, false], 'old finally cannot re-throttle an already running continuation');
  assert.ok(h.requests.has(second.id));
  assert.equal(h.events.length, 0, 'cancelled scan emits no stale page');
  assert.equal(h.reads.length, 0, 'cancelled scan does not read the old page');

  h.loads[1].resolve();
  await second.promise;
  assert.equal(h.maxActiveLoads, 1);
  assert.deepEqual(h.throttling, [false, true, false, true]);
  assert.deepEqual(h.reads, [courseURL('second')]);
  assert.deepEqual(h.events.map(e => e.detail.id), [second.id]);
  assert.equal(h.requests.size, 0);
});

test('cancelled waiting scan never starts and does not block the next queued scan', { timeout: 3000 }, async () => {
  const h = await harness(), first = h.request('first');
  await until(() => h.loads.length === 1, 'first scan starts');
  const cancelled = h.request('cancelled');
  await turn();
  await h.cancel(cancelled.id);
  const last = h.request('last');
  await turn();
  assert.equal(h.loads.length, 1);

  h.loads[0].resolve();
  await first.promise;
  await cancelled.promise;
  await until(() => h.loads.length === 2, 'scan after cancelled queue entry starts');
  assert.deepEqual(h.loads.map(load => load.url), [courseURL('first'), courseURL('last')]);
  assert.equal(h.maxActiveLoads, 1);
  assert.deepEqual(h.throttling, [false, true, false], 'cancelled queue entry does not toggle throttling');

  h.loads[1].resolve();
  await last.promise;
  assert.deepEqual(h.events.map(e => e.detail.id), [first.id, last.id]);
  assert.deepEqual(h.reads, [courseURL('first'), courseURL('last')]);
  assert.deepEqual(h.throttling, [false, true, false, true]);
  assert.equal(h.requests.size, 0);
});

test('native navigation failure restores throttling and releases the scan queue', { timeout: 3000 }, async () => {
  const h = await harness(), failed = h.request('failed');
  await until(() => h.loads.length === 1, 'first scan starts');
  const next = h.request('next');
  await turn();
  assert.equal(h.loads.length, 1);

  h.loads[0].reject(new Error('Synthetic navigation failure'));
  await failed.promise;
  await until(() => h.loads.length === 2, 'next scan starts after navigation error');
  assert.equal(h.maxActiveLoads, 1);
  assert.deepEqual(h.throttling, [false, true, false]);
  const failure = h.events.find(e => e.detail.id === failed.id);
  assert.equal(failure?.detail.error, 'Synthetic navigation failure');
  assert.equal(h.reads.length, 0);

  h.loads[1].resolve();
  await next.promise;
  assert.deepEqual(h.events.map(e => e.detail.id), [failed.id, next.id]);
  assert.deepEqual(h.reads, [courseURL('next')]);
  assert.deepEqual(h.throttling, [false, true, false, true]);
  assert.equal(h.requests.size, 0);
});
