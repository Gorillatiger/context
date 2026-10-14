import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createCalendarProviders } from '../connectors/calendar.mjs';
import { createNangoCalendarProviders } from '../connectors/nango-calendar.mjs';
import { calendarRefreshRange } from '../dist/calendar-auto-refresh.js';
import { reconcileCalendarEvents } from '../dist/calendar-refresh.js';
import { validateCalendarEvent } from '../dist/calendar-engine.js';

const calendarId = 'synthetic-calendar', from = '2026-10-01T00:00:00.000Z', to = '2026-11-01T00:00:00.000Z';
const range = { calendarId, from, to };
const graphNext = (url, page, key = '$skiptoken') => {
  const next = new URL(url);
  for (const name of ['$skip', '$skiptoken', '$skipToken']) next.searchParams.delete(name);
  next.searchParams.set(key, key === '$skip' ? String(page * 250) : 'opaque-page-' + page);
  return next.href;
};
const raw = (provider, id, title = 'Termin ' + id) => provider === 'google'
  ? { id, summary: title, start: { dateTime: '2026-10-14T10:00:00+02:00' }, end: { dateTime: '2026-10-14T11:00:00+02:00' } }
  : { id, subject: title, isAllDay: false, start: { dateTime: '2026-10-14T08:00:00', timeZone: 'UTC' }, end: { dateTime: '2026-10-14T09:00:00', timeZone: 'UTC' } };
const page = (provider, items, next, url) => provider === 'google'
  ? { items, ...(next === undefined ? {} : { nextPageToken: next }) }
  : { value: items, ...(next === undefined ? {} : { '@odata.nextLink': typeof next === 'number' ? graphNext(url, next) : next }) };

async function fixture(mode, provider, handler) {
  const calls = [], bindings = { connected: true, integrationId: 'synthetic-integration', connectionId: 'synthetic-account', revision: '1:0', capabilities: { calendarRead: true } };
  let client;
  const dispatch = async (url, options) => {
    assert.equal(options.method || 'GET', 'GET');
    const parsed = new URL(url);
    const service = provider === 'google' ? 'google-calendar' : 'outlook';
    assert.ok(['www.googleapis.com', 'graph.microsoft.com'].includes(parsed.hostname));
    if (parsed.pathname.endsWith('/calendarList')) return { items: [{ id: calendarId, summary: 'Kalender' }] };
    if (parsed.pathname === '/v1.0/me/calendars') return { value: [{ id: calendarId, name: 'Kalender' }] };
    const expectedPath = provider === 'google' ? '/calendar/v3/calendars/' + calendarId + '/events' : '/v1.0/me/calendars/' + calendarId + '/calendarView';
    assert.equal(parsed.pathname, expectedPath);
    calls.push({ url: parsed, options, service });
    return handler(parsed, calls.length, { bindings, client, options });
  };
  if (mode === 'direct') {
    client = createCalendarProviders({
      now: () => 0, openExternal: async () => {},
      callbackFactory: async () => ({ redirectURI: 'http://127.0.0.1:54321/oauth/callback', result: Promise.resolve('synthetic-code'), close() {} }),
      fetcher: async (url, options) => {
        if (url.includes('/token')) return Response.json({ access_token: 'synthetic-token', refresh_token: 'synthetic-refresh', expires_in: 3600, token_type: 'Bearer' });
        const value = await dispatch(url, options);
        return value instanceof Response ? value : Response.json(value);
      },
    });
    client.configure(provider, provider === 'google' ? { clientId: 'synthetic.apps.googleusercontent.com', driveEnabled: false } : { clientId: '12345678-1234-1234-1234-123456789abc', tenant: 'common' });
    await client.connect(provider);
  } else {
    client = createNangoCalendarProviders({ nango: {
      status: () => structuredClone(bindings),
      proxy: async (_service, options) => {
        const url = new URL(options.path, provider === 'google' ? 'https://www.googleapis.com' : 'https://graph.microsoft.com');
        for (const [key, value] of Object.entries(options.params || {})) url.searchParams.set(key, value);
        const value = await dispatch(url.href, options);
        if (value instanceof Response) return { status: value.status, headers: { 'content-type': 'application/json' }, data: await value.json() };
        return { status: 200, headers: { 'content-type': 'application/json' }, data: value };
      },
    } });
  }
  await client.calendars(provider);
  return { client, calls, bindings, read: signal => client.events(provider, range, signal) };
}

for (const mode of ['direct', 'nango']) for (const provider of ['google', 'outlook']) {
  const label = mode + ' ' + provider + ': ';
  test(label + 'the real five-month startup range passes while the 180-day request fence remains bounded', async () => {
    const startup = calendarRefreshRange('2000-01', { automatic: true, today: '2026-10-14' });
    assert.ok(Date.parse(startup.to) - Date.parse(startup.from) > 120 * 86400000);
    const f = await fixture(mode, provider, url => page(provider, [], undefined, url));
    const result = await f.client.events(provider, { calendarId, ...startup });
    assert.equal(result.complete, true);
    assert.equal(f.calls[0].url.searchParams.get(provider === 'google' ? 'timeMin' : 'startDateTime'), startup.from);
    assert.equal(f.calls[0].url.searchParams.get(provider === 'google' ? 'timeMax' : 'endDateTime'), startup.to);
    const maxTo = new Date(Date.parse(from) + 180 * 86400000).toISOString();
    assert.equal((await f.client.events(provider, { calendarId, from, to: maxTo })).complete, true);
    const before = f.calls.length;
    await assert.rejects(f.client.events(provider, { calendarId, from, to: new Date(Date.parse(maxTo) + 1).toISOString() }), { code: 'invalid_range' });
    assert.equal(f.calls.length, before);
  });
  test(label + 'reads more than 250 events, keeps original range/selection and deduplicates overlap by stable ID', async () => {
    const f = await fixture(mode, provider, (url, number) => {
      const ids = number === 1 ? Array.from({ length: 250 }, (_, i) => 'event-' + i) : number === 2 ? ['event-249', ...Array.from({ length: 10 }, (_, i) => 'event-' + (250 + i))] : ['event-260'];
      return page(provider, ids.map(id => raw(provider, id)), number < 3 ? provider === 'google' ? 'page-' + number : number : undefined, url);
    });
    const result = await f.read();
    assert.equal(result.events.length, 261); assert.equal(result.pages, 3); assert.equal(result.complete, true); assert.equal(result.truncated, false);
    assert.equal(new Set(result.events.map(event => event.id)).size, 261);
    assert.equal(result.events[0].id, provider + '-' + createHash('sha256').update(calendarId + '\0event-0').digest('hex').slice(0, 32));
    for (const { url, options } of f.calls) {
      assert.equal(url.searchParams.get(provider === 'google' ? 'timeMin' : 'startDateTime'), from);
      assert.equal(url.searchParams.get(provider === 'google' ? 'timeMax' : 'endDateTime'), to);
      assert.equal(url.searchParams.get(provider === 'google' ? 'maxResults' : '$top'), '250');
      if (provider === 'outlook') assert.equal(options.headers.Prefer, 'outlook.timezone="UTC"');
      if (mode === 'nango') assert.ok(!Object.keys(options.headers).some(key => /authorization|cookie/i.test(key)));
    }
  });
  test(label + 'stops at exactly eight pages/2000 raw entries and visibly marks remaining pages', async () => {
    const f = await fixture(mode, provider, (url, number) => page(provider, Array.from({ length: 250 }, (_, i) => raw(provider, 'event-' + ((number - 1) * 250 + i))), provider === 'google' ? 'page-' + number : number, url));
    const result = await f.read();
    assert.equal(f.calls.length, 8); assert.equal(result.events.length, 2000); assert.equal(result.pages, 8);
    assert.equal(result.complete, false); assert.equal(result.truncated, true); assert.match(result.warnings.join(' '), /8 Seiten.*2\.000/);
    assert.ok(!JSON.stringify(result).includes('opaque-page'));
  });
  test(label + 'the eighth terminal page is complete rather than truncated merely for reaching the bound', async () => {
    const f = await fixture(mode, provider, (url, number) => page(provider, Array.from({ length: 250 }, (_, i) => raw(provider, 'event-' + ((number - 1) * 250 + i))), number < 8 ? provider === 'google' ? 'page-' + number : number : undefined, url));
    const result = await f.read(); assert.equal(result.complete, true); assert.equal(result.truncated, false); assert.equal(result.events.length, 2000);
  });
  test(label + 'failed or malformed later pages return no partial calendar', async () => {
    for (const failure of ['transport', 'shape', 'oversize']) {
      const f = await fixture(mode, provider, (url, number) => {
        if (number === 1) return page(provider, [raw(provider, 'first')], provider === 'google' ? 'next-page' : 1, url);
        if (failure === 'transport') return Response.json({ error: { message: 'synthetic-private-provider-content' } }, { status: 503 });
        return page(provider, failure === 'shape' ? [null] : Array.from({ length: 251 }, (_, i) => raw(provider, String(i))), undefined, url);
      });
      await assert.rejects(f.read(), error => ['provider_error', 'connection_failed', 'invalid_response'].includes(error.code) && !error.message.includes('synthetic-private'));
      assert.equal(f.calls.length, 2);
    }
  });
  test(label + 'repeated pagination cursors fail instead of looping or claiming completion', async () => {
    const f = await fixture(mode, provider, url => page(provider, [], provider === 'google' ? 'same-token' : graphNext(url, 1), url));
    await assert.rejects(f.read(), { code: 'invalid_response' }); assert.equal(f.calls.length, 2);
  });
  test(label + 'same-ID conflicting page content fails atomically', async () => {
    const f = await fixture(mode, provider, (url, number) => page(provider, [raw(provider, 'same-id', number === 1 ? 'First title' : 'Different title')], number === 1 ? provider === 'google' ? 'next' : 1 : undefined, url));
    await assert.rejects(f.read(), { code: 'invalid_response' }); assert.equal(f.calls.length, 2);
  });
  test(label + 'skips isolated zero/reversed durations with an anonymous count and retains old local copies', async () => {
    const zero = raw(provider, 'synthetic-private-zero-id', 'synthetic-private-zero-title'); zero.end = structuredClone(zero.start);
    const reversed = raw(provider, 'synthetic-private-reversed-id', 'synthetic-private-reversed-title');
    reversed.end.dateTime = provider === 'google' ? '2026-10-14T09:00:00+02:00' : '2026-10-14T07:00:00';
    const f = await fixture(mode, provider, url => page(provider, [raw(provider, 'valid'), zero, reversed], undefined, url));
    const result = await f.read();
    assert.equal(result.events.length, 1); assert.equal(result.events[0].source.externalId, 'valid');
    assert.equal(result.complete, false); assert.equal(result.truncated, false);
    assert.equal(result.warnings.length, 1); assert.match(result.warnings[0], /^2 Termine ohne positive Dauer/);
    assert.ok(!JSON.stringify(result.warnings).includes('synthetic-private'));
    const previous = [zero, reversed].map(item => validateCalendarEvent({
      id: provider + '-' + createHash('sha256').update(calendarId + '\0' + item.id).digest('hex').slice(0, 32),
      title: 'Bereits vorhandener Termin', projectId: 'prototyping',
      start: '2026-10-14T08:00:00Z', end: '2026-10-14T09:00:00Z',
      source: { kind: provider, externalId: item.id },
    }));
    const before = JSON.stringify(previous);
    const merged = reconcileCalendarEvents(previous, result.events, { projectIds: ['prototyping'] });
    assert.equal(merged.added, 1); assert.equal(merged.updated, 0); assert.equal(merged.events.length, 3);
    assert.deepEqual(merged.events.slice(0, 2), previous); assert.equal(JSON.stringify(previous), before);
  });
  test(label + 'unsupported all-day durations and Outlook timezone skips are reported separately', async () => {
    const day = (id, end) => provider === 'google'
      ? { id, summary: 'synthetic-private-day-title', start: { date: '2026-10-14' }, end: { date: end } }
      : { id, subject: 'synthetic-private-day-title', isAllDay: true, start: { dateTime: '2026-10-14T00:00:00', timeZone: 'UTC' }, end: { dateTime: end + 'T00:00:00', timeZone: 'UTC' }, originalStartTimeZone: 'UTC', originalEndTimeZone: 'UTC' };
    const items = [raw(provider, 'valid'), day('zero-day', '2026-10-14'), day('reversed-day', '2026-10-13')];
    if (provider === 'outlook') items.push({ ...day('unknown-zone-day', '2026-10-15'), originalStartTimeZone: 'Synthetic/Unknown', originalEndTimeZone: 'Synthetic/Unknown' });
    const f = await fixture(mode, provider, url => page(provider, items, undefined, url));
    const result = await f.read(); assert.equal(result.events.length, 1); assert.equal(result.complete, false);
    assert.equal(result.warnings.filter(warning => /^2 Termine ohne positive Dauer/.test(warning)).length, 1);
    assert.equal(result.warnings.length, provider === 'outlook' ? 2 : 1);
    if (provider === 'outlook') assert.equal(result.warnings.filter(warning => /^1 Outlook-Ganztagstermine.*Zeitzone/.test(warning)).length, 1);
    assert.ok(!JSON.stringify(result.warnings).includes('synthetic-private'));
  });
  test(label + 'valid versus invalid copies of one raw ID fail before row skipping in either page order', async () => {
    for (const invalidFirst of [false, true]) for (const reversed of [false, true]) {
      const valid = raw(provider, 'synthetic-private-conflict-id');
      const invalid = structuredClone(valid); invalid.end = structuredClone(valid.start);
      if (reversed) invalid.end.dateTime = provider === 'google' ? '2026-10-14T09:00:00+02:00' : '2026-10-14T07:00:00';
      const entries = invalidFirst ? [invalid, valid] : [valid, invalid];
      const f = await fixture(mode, provider, (url, number) => page(provider, [entries[number - 1]], number === 1 ? provider === 'google' ? 'next' : 1 : undefined, url));
      await assert.rejects(f.read(), error => error.code === 'invalid_response' && !error.message.includes('synthetic-private'));
      assert.equal(f.calls.length, 2);
    }
  });
  test(label + 'identical skipped raw repetitions count one omitted event and do not mutate the previous calendar', async () => {
    const zero = raw(provider, 'repeated-zero'); zero.end = structuredClone(zero.start);
    const f = await fixture(mode, provider, (url, number) => page(provider, [zero], number === 1 ? provider === 'google' ? 'next' : 1 : undefined, url));
    const result = await f.read(); assert.deepEqual(result.events, []); assert.equal(result.complete, false);
    assert.match(result.warnings[0], /^1 Termin ohne positive Dauer/);
    const old = validateCalendarEvent({ id: 'local-old', title: 'Unverändert', start: '2026-10-14T08:00:00Z', end: '2026-10-14T09:00:00Z' });
    const merged = reconcileCalendarEvents([old], result.events); assert.equal(merged.changed, false); assert.deepEqual(merged.events, [old]);
  });
  test(label + 'malformed date/time data remains an atomic failure rather than an unsupported-duration skip', async () => {
    const invalid = raw(provider, 'invalid-time'); invalid.end.dateTime = 'synthetic-private-malformed-time';
    const f = await fixture(mode, provider, url => page(provider, [raw(provider, 'valid'), invalid], undefined, url));
    await assert.rejects(f.read(), error => ['invalid_range', 'invalid_response'].includes(error.code) && !error.message.includes('synthetic-private'));
  });
  test(label + 'cancellation prevents the next page and account changes discard already read pages', async () => {
    const abort = new AbortController();
    const first = await fixture(mode, provider, (url, number) => {
      abort.abort(); return page(provider, [raw(provider, 'first')], provider === 'google' ? 'next' : 1, url);
    });
    await assert.rejects(first.read(abort.signal), { code: 'cancelled' }); assert.equal(first.calls.length, 1);
    const second = await fixture(mode, provider, (url, number, { client, bindings }) => {
      if (number === 2) { if (mode === 'direct') client.disconnect(provider); else bindings.revision = '2:0'; }
      return page(provider, [raw(provider, 'event-' + number)], number === 1 ? provider === 'google' ? 'next' : 1 : undefined, url);
    });
    await assert.rejects(second.read(), { code: 'cancelled' }); assert.equal(second.calls.length, 2);
  });
}

for (const mode of ['direct', 'nango']) {
  test(mode + ' Google: treats tokens as opaque query values and never as target URLs', async () => {
    const token = 'https://evil.invalid/private?access_token=synthetic';
    const f = await fixture(mode, 'google', (url, number) => page('google', [raw('google', 'event-' + number)], number === 1 ? token : undefined, url));
    const result = await f.read(); assert.equal(result.complete, true); assert.equal(f.calls.length, 2);
    assert.equal(f.calls[1].url.origin, 'https://www.googleapis.com'); assert.equal(f.calls[1].url.searchParams.get('pageToken'), token);
  });
  test(mode + ' Google: malformed cursor values fail before a second request', async () => {
    for (const token of [null, {}, [], 1, true, 'bad\nvalue', 'bad value', 'bad\\value', 'x'.repeat(20001)]) {
      const f = await fixture(mode, 'google', url => page('google', [raw('google', 'first')], token, url));
      await assert.rejects(f.read(), { code: 'invalid_response' }); assert.equal(f.calls.length, 1);
    }
  });
  test(mode + ' Outlook: rejects foreign host/path/calendar/filter/cursors before following nextLink', async () => {
    const bad = [
      url => graphNext(url, 1).replace('https://graph.microsoft.com', 'https://evil.invalid'),
      url => graphNext(url, 1).replace('https://', 'http://'),
      url => graphNext(url, 1).replace('/calendarView?', '/events?'),
      url => graphNext(url, 1).replace(calendarId, 'other-calendar'),
      url => graphNext(url, 1).replace('https://graph.microsoft.com', 'https://synthetic@graph.microsoft.com'),
      url => graphNext(url, 1).replace('https://graph.microsoft.com', 'https://graph.microsoft.com:8443'),
      url => graphNext(url, 1) + '#fragment',
      url => { const next = new URL(graphNext(url, 1)); next.searchParams.set('startDateTime', '2025-01-01T00:00:00Z'); return next.href; },
      url => { const next = new URL(graphNext(url, 1)); next.searchParams.delete('endDateTime'); return next.href; },
      url => { const next = new URL(graphNext(url, 1)); next.searchParams.set('$select', 'body,attendees'); return next.href; },
      url => { const next = new URL(graphNext(url, 1)); next.searchParams.set('$top', '9999'); return next.href; },
      url => graphNext(url, 1) + '&access_token=synthetic',
      url => graphNext(url, 1) + '&$skiptoken=another',
      url => graphNext(url, 1) + '&$skip=250',
      url => { const next = new URL(graphNext(url, 1)); next.searchParams.set('$skiptoken', '\nprivate'); return next.href; },
      url => { const next = new URL(graphNext(url, 1)); next.searchParams.set('$skiptoken', ''); return next.href; },
      url => new URL(url).pathname + '?$skiptoken=opaque',
      () => null,
      () => true,
      () => ({ url: 'https://graph.microsoft.com/' }),
    ];
    for (const make of bad) {
      const f = await fixture(mode, 'outlook', url => page('outlook', [raw('outlook', 'first')], make(url), url));
      await assert.rejects(f.read(), { code: 'invalid_response' }); assert.equal(f.calls.length, 1);
    }
  });
  test(mode + ' Outlook: preserves a full validated nextLink with supported skip variants', async () => {
    for (const key of ['$skip', '$skiptoken', '$skipToken']) {
      const f = await fixture(mode, 'outlook', (url, number) => page('outlook', [raw('outlook', 'event-' + number)], number === 1 ? graphNext(url, 1, key) : undefined, url));
      const result = await f.read(); assert.equal(result.complete, true); assert.equal(f.calls.length, 2); assert.ok(f.calls[1].url.searchParams.has(key));
    }
  });
}
