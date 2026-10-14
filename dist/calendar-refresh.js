import { MAX_CALENDAR_EVENTS, validateCalendarEvent, validateCalendarEvents } from './calendar-engine.js';

// Pulls only; provider writes remain in the explicitly configured Outlook sync.
// Provider adapters namespace IDs by provider + calendar ID + external event ID.
// Neither titles nor dates establish identity: distinct overlapping events are valid.
export function reconcileCalendarEvents(previous, incoming, options = {}) {
  const next = validateCalendarEvents(previous, options);
  if (!Array.isArray(incoming) || incoming.length > MAX_CALENDAR_EVENTS)
    throw new Error('Der Kalender unterstützt höchstens 2000 Termine pro Abgleich.');

  const unique = new Map();
  let duplicates = 0;
  for (const input of incoming) {
    const event = validateCalendarEvent(input, options);
    if (!['outlook', 'google'].includes(event.source.kind))
      throw new Error('Der Kalenderabgleich erwartet Termine aus Outlook oder Google.');
    const first = unique.get(event.id);
    if (first) {
      if (JSON.stringify(first) !== JSON.stringify(event))
        throw new Error('Widersprüchliche Kalender-Termin-ID. Der vorherige Kalender bleibt erhalten.');
      duplicates++;
    } else unique.set(event.id, event);
  }

  const indices = new Map(next.map((event, index) => [event.id, index]));
  let added = 0, updated = 0, unchanged = 0;
  for (const event of unique.values()) {
    const index = indices.get(event.id);
    if (index === undefined) {
      next.push(event);
      added++;
      continue;
    }
    const existing = next[index];
    // An accidental ID collision must never replace a local event or an event
    // from the other provider. The adapters always supply the external ID.
    if (existing.source.kind !== event.source.kind ||
        (existing.source.externalId && event.source.externalId &&
         existing.source.externalId !== event.source.externalId))
      throw new Error('Die Kalender-Termin-ID gehört zu einer anderen Quelle. Der vorherige Kalender bleibt erhalten.');
    // Course assignment is local metadata; a provider refresh cannot erase it.
    const replacement = { ...event, projectId: existing.projectId || event.projectId };
    if (JSON.stringify(existing) === JSON.stringify(replacement)) unchanged++;
    else {
      next[index] = replacement;
      updated++;
    }
  }
  // Check the combined workspace before callers can commit any mutation.
  const events = validateCalendarEvents(next, options);
  return { events, added, updated, unchanged, duplicates, changed: added > 0 || updated > 0 };
}

export async function readConnectedCalendarEvents({ request, connections, from, to, signal, filterEvents = events => events }) {
  const events = [], warnings = [], calendars = {}, providers = [];
  const check = () => { if (signal?.aborted) throw new DOMException('Abgebrochen', 'AbortError'); };
  for (const provider of ['outlook', 'google']) {
    if (connections[provider]?.connected !== true) continue;
    check();
    const list = await request('calendars', { provider, signal });
    check();
    if (!Array.isArray(list?.calendars) || list.calendars.length > 50) throw new Error('Die Kalenderliste konnte nicht vollständig geprüft werden.');
    calendars[provider] = list.calendars;
    warnings.push(...(list.warnings || []));
    if (list.truncated || list.complete === false) warnings.push('Die Kalenderliste ist unvollständig.');
    const seen = new Set();
    for (const calendar of list.calendars) {
      if (typeof calendar?.id !== 'string' || !calendar.id || seen.has(calendar.id)) throw new Error('Der Anbieter hat eine ungültige Kalenderzuordnung geliefert.');
      seen.add(calendar.id); check();
      const result = await request('events', { provider, body: { calendarId: calendar.id, from, to }, signal });
      check();
      if (!Array.isArray(result?.events)) throw new Error('Der Anbieter hat keine gültige Terminliste geliefert.');
      if (result.truncated || result.complete === false) warnings.push(`${provider === 'outlook' ? 'Outlook' : 'Google'}: ${calendar.title || 'Kalender'} wurde nur teilweise gelesen.`);
      warnings.push(...(result.warnings || []));
      events.push(...filterEvents(result.events, provider, calendar.id));
      if (events.length > MAX_CALENDAR_EVENTS) throw new Error('Der lokale Kalender unterstützt höchstens 2.000 Termine. Wähle einen kleineren Zeitraum.');
    }
    providers.push(provider);
  }
  check();
  if (!providers.length) throw new Error('Verbinde zuerst Outlook oder Google Kalender.');
  return { events, warnings: [...new Set(warnings)], calendars, providers };
}
