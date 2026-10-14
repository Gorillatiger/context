/* Runs before the stylesheets so a saved dark appearance never flashes light.
   Preference changes update colours only: chat, mail and note drafts stay put. */
(() => {
  'use strict';
  const key = 'context-appearance-v1';
  const valid = value => ['system', 'light', 'dark'].includes(value);
  const root = document.documentElement;
  const listeners = new Set();
  let storage, stored, storageAvailable = true;
  try { storage = window.localStorage; stored = storage.getItem(key); }
  catch { storageAvailable = false; }
  let preference = valid(stored) ? stored : 'system';
  let media;
  try { media = window.matchMedia('(prefers-color-scheme: dark)'); }
  catch { media = {matches: false}; }
  let resolved = preference === 'system' ? (media.matches ? 'dark' : 'light') : preference;
  let revision = 0, nativeConfigured = false, disposed = false;
  let nativeError = '', nativePending = 0, nativeQueue = Promise.resolve();
  const bridge = window.contextDesktop;
  const nativeAvailable = typeof bridge?.theme === 'function';
  const snapshot = () => Object.freeze({preference, resolved, saved: storageAvailable || nativeConfigured, nativeAvailable, nativeError});

  function refreshControls() {
    for (const button of document.querySelectorAll('[data-theme-toggle]')) {
      const dark = resolved === 'dark';
      button.setAttribute('aria-pressed', String(dark));
      button.setAttribute('aria-label', dark ? 'Hellmodus aktivieren' : 'Darkmode aktivieren');
      button.setAttribute('title', dark ? 'Hellmodus aktivieren' : 'Darkmode aktivieren');
    }
    for (const select of document.querySelectorAll('[data-theme-preference]')) select.value = preference;
    for (const label of document.querySelectorAll('[data-theme-status]')) {
      label.textContent = nativeError || (!storageAvailable && !nativeConfigured
        ? 'Die Auswahl gilt für diese Sitzung. Speichern ist hier nicht möglich.'
        : preference === 'system'
          ? `Folgt deinem System · aktuell ${resolved === 'dark' ? 'dunkel' : 'hell'}.`
          : `Auf diesem Gerät gespeichert · ${resolved === 'dark' ? 'dunkel' : 'hell'}.`);
    }
  }

  function apply(nextResolved) {
    if (disposed) return;
    resolved = nextResolved || (preference === 'system' ? (media.matches ? 'dark' : 'light') : preference);
    root.dataset.theme = resolved;
    root.dataset.themePreference = preference;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', resolved === 'dark' ? '#191417' : '#fff7f8');
    refreshControls();
    const state = snapshot();
    for (const listener of listeners) { try { listener(state); } catch {} }
  }

  function cache() {
    try { storage ||= window.localStorage; storage.setItem(key, preference); storageAvailable = true; }
    catch { storageAvailable = false; }
  }

  function valueOf(reply) {
    if (reply?.ok === false) throw new Error(reply.error || 'Die Fensterdarstellung konnte nicht gespeichert werden.');
    const value = reply?.ok === true ? reply.value : reply;
    if (!valid(value?.preference) || !['light', 'dark'].includes(value?.resolved)) throw new Error('Ungültige Fensterdarstellung.');
    return value;
  }

  function syncNative(nextPreference, currentRevision) {
    if (!nativeAvailable || disposed) return;
    nativePending = currentRevision;
    nativeQueue = nativeQueue.catch(() => {}).then(async () => {
      if (disposed) return;
      try {
        const value = valueOf(await bridge.theme({op: 'set', preference: nextPreference}));
        if (disposed || currentRevision !== revision) return;
        nativeConfigured = value.configured === true;
        nativeError = '';
        apply(value.resolved);
      } catch {
        if (!disposed && currentRevision === revision) {
          nativeError = 'App-Farben sind aktiv. Die Fensterdarstellung konnte nicht gespeichert werden.';
          apply();
        }
      } finally {
        if (nativePending === currentRevision) nativePending = 0;
      }
    });
  }

  function setPreference(value) {
    if (!valid(value) || disposed) return false;
    preference = value;
    revision += 1;
    nativeError = '';
    cache();
    apply();
    syncNative(value, revision);
    return true;
  }

  function onSystem() { if (preference === 'system') apply(); }
  function onStorage(event) {
    if (event.key !== key && event.key !== null) return;
    preference = valid(event.newValue) ? event.newValue : 'system';
    revision += 1;
    nativeError = '';
    apply();
    syncNative(preference, revision);
  }
  if (media.addEventListener) media.addEventListener('change', onSystem);
  else media.addListener?.(onSystem);
  window.addEventListener('storage', onStorage);
  let unsubscribeNative;
  if (nativeAvailable) {
    unsubscribeNative = bridge.onEvent?.(event => {
      if (disposed || event?.type !== 'context-theme') return;
      const value = event.detail;
      if (!valid(value?.preference) || !['light', 'dark'].includes(value?.resolved)) return;
      if ((nativePending || nativeError) && value.preference !== preference) return;
      preference = value.preference;
      nativeConfigured = value.configured === true;
      cache();
      apply(value.resolved);
    });
  }

  window.contextTheme = Object.freeze({
    getState: snapshot, setPreference, refreshControls,
    toggle: () => setPreference(resolved === 'dark' ? 'light' : 'dark'),
    subscribe(listener) {
      if (typeof listener !== 'function' || disposed) return () => {};
      listeners.add(listener); listener(snapshot());
      return () => listeners.delete(listener);
    },
    dispose() {
      disposed = true;
      if (media.removeEventListener) media.removeEventListener('change', onSystem);
      else media.removeListener?.(onSystem);
      window.removeEventListener('storage', onStorage);
      unsubscribeNative?.(); listeners.clear();
    }
  });
  apply();
  if (nativeAvailable) {
    Promise.resolve().then(() => bridge.theme({op: 'get'})).then(reply => {
      if (disposed || revision !== 0) return;
      const value = valueOf(reply);
      if (value.configured !== true && valid(stored)) {
        revision += 1;
        syncNative(preference, revision);
        return;
      }
      preference = value.preference;
      nativeConfigured = value.configured === true;
      cache();
      apply(value.resolved);
    }).catch(() => {});
  }
})();
