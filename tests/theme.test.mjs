import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

const source = await readFile(new URL('../dist/theme.js', import.meta.url), 'utf8');
const tick = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
function fixture({stored, dark = false, blocked = false, bridge} = {}) {
  const data = new Map(stored ? [['context-appearance-v1', stored]] : []);
  const events = new Map(), mediaEvents = new Map(), attributes = new Map();
  const button = {setAttribute: (key, value) => attributes.set(key, value)};
  const select = {value: ''}, status = {textContent: ''}, meta = {setAttribute: (key, value) => attributes.set('meta-' + key, value)};
  const document = {documentElement: {dataset: {}}, querySelector: () => meta,
    querySelectorAll: selector => selector === '[data-theme-toggle]' ? [button] : selector === '[data-theme-preference]' ? [select] : [status]};
  const media = {matches: dark, addEventListener: (key, fn) => mediaEvents.set(key, fn), removeEventListener: key => mediaEvents.delete(key)};
  const storage = {getItem: key => data.get(key) ?? null, setItem: (key, value) => { if (blocked) throw new Error('blocked'); data.set(key, value); }};
  const window = {matchMedia: () => media, contextDesktop: bridge,
    addEventListener: (key, fn) => events.set(key, fn), removeEventListener: key => events.delete(key)};
  Object.defineProperty(window, 'localStorage', {get() { if (blocked) throw new Error('blocked'); return storage; }});
  runInNewContext(source, {window, document, console});
  return {theme: window.contextTheme, document, data, attributes, select, status, events, mediaEvents,
    system(value) { media.matches = value; mediaEvents.get('change')?.({matches: value}); },
    storage(key, newValue) { events.get('storage')?.({key, newValue}); }};
}

test('saved dark appearance is applied synchronously before application rendering', () => {
  const f = fixture({stored: 'dark'});
  assert.equal(f.document.documentElement.dataset.theme, 'dark');
  assert.equal(f.select.value, 'dark'); assert.equal(f.attributes.get('aria-pressed'), 'true');
  assert.equal(f.attributes.get('meta-content'), '#191417');
});

test('system mode follows OS changes; explicit choices stay stable and toggle persists', () => {
  const f = fixture({dark: true});
  assert.equal(f.theme.getState().preference, 'system');
  f.system(false); assert.equal(f.theme.getState().resolved, 'light');
  f.theme.setPreference('dark'); f.system(false); assert.equal(f.theme.getState().resolved, 'dark');
  f.theme.toggle(); assert.equal(f.data.get('context-appearance-v1'), 'light');
  assert.equal(f.attributes.get('aria-label'), 'Darkmode aktivieren');
  f.theme.setPreference('system'); f.system(true); assert.equal(f.theme.getState().resolved, 'dark');
});

test('blocked or corrupt storage never prevents opening or changing appearance', () => {
  const blocked = fixture({blocked: true});
  assert.equal(blocked.theme.setPreference('dark'), true); assert.equal(blocked.theme.getState().saved, false);
  assert.match(blocked.status.textContent, /Sitzung/);
  const corrupt = fixture({stored: 'javascript:alert(1)', dark: true});
  assert.equal(corrupt.theme.getState().preference, 'system');
  assert.equal(corrupt.theme.setPreference('invalid'), false);
  assert.equal(corrupt.document.documentElement.dataset.theme, 'dark');
});

test('cross-tab changes and removed preferences update colours without touching workspace storage', () => {
  const f = fixture({stored: 'light', dark: true});
  f.storage('other-workspace', 'dark'); assert.equal(f.theme.getState().resolved, 'light');
  f.storage('context-appearance-v1', 'dark'); assert.equal(f.theme.getState().resolved, 'dark');
  f.storage('context-appearance-v1', null); assert.equal(f.theme.getState().preference, 'system');
  assert.equal(f.theme.getState().resolved, 'dark');
  assert.deepEqual([...f.data.keys()], ['context-appearance-v1']);
});

test('native saved preference is authoritative; first-install renderer preference migrates once', async () => {
  const calls = [];
  const f = fixture({stored: 'dark', bridge: {theme: async message => {
    calls.push(message); return {ok: true, value: {preference: 'light', resolved: 'light', configured: true}};
  }}});
  await tick(); assert.equal(f.theme.getState().preference, 'light'); assert.equal(calls.length, 1);
  const migration = [];
  const second = fixture({stored: 'dark', bridge: {theme: async message => {
    migration.push(message); return {ok: true, value: {preference: message.preference || 'system', resolved: message.preference || 'light', configured: message.op === 'set'}};
  }}});
  await tick(); assert.deepEqual(migration.map(m => m.op), ['get', 'set']);
  assert.equal(migration[1].preference, 'dark'); assert.equal(second.theme.getState().resolved, 'dark');
});

test('late startup result cannot override a newer user choice', async () => {
  let complete;
  const f = fixture({bridge: {theme: message => message.op === 'get'
    ? new Promise(resolve => { complete = resolve; })
    : Promise.resolve({ok: true, value: {preference: message.preference, resolved: message.preference, configured: true}})}});
  await tick(); f.theme.setPreference('dark');
  complete({ok: true, value: {preference: 'light', resolved: 'light', configured: true}});
  await tick(); assert.equal(f.theme.getState().resolved, 'dark');
});

test('rapid native changes are sequenced and stale echoed events cannot replace latest choice', async () => {
  let event, release;
  const choices = [];
  const f = fixture({bridge: {
    onEvent: fn => { event = fn; return () => {}; },
    theme: async message => {
      if (message.op === 'get') return {preference: 'system', resolved: 'light', configured: true};
      choices.push(message.preference);
      if (message.preference === 'dark') await new Promise(resolve => { release = resolve; });
      return {preference: message.preference, resolved: message.preference, configured: true};
    }
  }});
  await tick(); f.theme.setPreference('dark'); await tick(); f.theme.setPreference('light');
  event({type: 'context-theme', detail: {preference: 'dark', resolved: 'dark', configured: true}});
  assert.equal(f.theme.getState().resolved, 'light'); release(); await tick();
  assert.deepEqual(choices, ['dark', 'light']); assert.equal(f.theme.getState().resolved, 'light');
});

test('native persistence failure keeps usable app colours and reports the limitation', async () => {
  let event;
  const f = fixture({bridge: {onEvent: fn => {event = fn; return () => {};}, theme: async message => message.op === 'get'
    ? {preference: 'system', resolved: 'light', configured: false}
    : {ok: false, error: 'Disk full'}}});
  await tick(); f.theme.setPreference('dark'); await tick();
  assert.equal(f.theme.getState().resolved, 'dark'); assert.equal(f.data.get('context-appearance-v1'), 'dark');
  assert.match(f.status.textContent, /Fensterdarstellung/);
  event({type: 'context-theme', detail: {preference: 'system', resolved: 'light', configured: false}});
  assert.equal(f.theme.getState().resolved, 'dark'); assert.equal(f.data.get('context-appearance-v1'), 'dark');
});

test('native OS updates refresh controls and dispose removes appearance listeners', async () => {
  let event, unsubscribed = false;
  const f = fixture({bridge: {theme: async () => ({preference: 'system', resolved: 'light', configured: true}),
    onEvent: fn => { event = fn; return () => { unsubscribed = true; }; }}});
  await tick(); event({type: 'context-theme', detail: {preference: 'system', resolved: 'dark', configured: true}});
  assert.equal(f.theme.getState().resolved, 'dark'); assert.equal(f.select.value, 'system');
  f.theme.dispose(); f.system(false); assert.equal(f.theme.getState().resolved, 'dark');
  assert.equal(unsubscribed, true); assert.equal(f.events.size, 0); assert.equal(f.mediaEvents.size, 0);
});

test('theme bootstrap and stylesheet use existing self-only CSP without inline injection', async () => {
  const html = await readFile(new URL('../dist/index.html', import.meta.url), 'utf8');
  assert.ok(html.indexOf('src="./theme.js"') < html.indexOf('href="./styles.css"'));
  assert.ok(html.indexOf('href="./dark-theme.css"') > html.indexOf('href="./speech.css"'));
  assert.match(html, /script-src 'self'; style-src 'self'/);
  assert.doesNotMatch(source, /innerHTML|fetch\(|insertAdjacentHTML/);
});
