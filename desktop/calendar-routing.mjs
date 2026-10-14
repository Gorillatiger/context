import {createHash,randomUUID} from 'node:crypto';
import {createCalendarProviders, CalendarError} from '../connectors/calendar.mjs';
import {createNangoCalendarProviders} from '../connectors/nango-calendar.mjs';

// Existing desktop OAuth remains an explicit alternative. Nango bindings only
// select their own service; Drive is independent of the calendar connection.
export function createCalendarRouting({nango, direct = createCalendarProviders()} = {}) {
  const cloud = createNangoCalendarProviders({nango}), overrides = new Map();
  const directSession = randomUUID(), directGenerations = new Map([['google',0],['outlook',0]]);
  const service = provider => {
    if (!['google','outlook'].includes(provider)) throw new CalendarError(400,'invalid_provider','Unbekannter Kalenderanbieter.');
    return provider === 'google' ? 'google-calendar' : 'outlook';
  };
  const signature = id => {
    const value = nango.localStatus(id);
    return JSON.stringify([value.integrationId,value.connectionId,value.revision]);
  };
  // A configured Nango service remains the selected route after disconnect.
  // Dormant direct credentials are usable only after explicit direct setup.
  const useServiceCloud = id => {
    if(!nango.localStatus(id).integrationId)return false;
    if(overrides.has(id)&&overrides.get(id)===signature(id))return false;
    // Once a new Nango binding takes over, do not resurrect a previous direct
    // selection merely because disconnect restores its old empty signature.
    overrides.delete(id);return true;
  };
  const useCloud = provider => useServiceCloud(service(provider));
  const route = provider => useCloud(provider) ? cloud : direct;
  // This opaque, process-local identity is a batch fence, not an account token.
  // Refreshing access tokens leaves it stable; a new binding or direct login
  // makes a before/after status comparison fail without disclosing account IDs.
  const generation = (provider, selectedCloud) => createHash('sha256').update(
    JSON.stringify(selectedCloud ? ['nango',provider,signature(service(provider))]
      : ['direct',provider,directSession,directGenerations.get(provider)]),
  ).digest('hex');
  const advanceDirect = provider => directGenerations.set(provider,directGenerations.get(provider)+1);
  return {
    async status(provider) {
      if (!provider) return Object.fromEntries(await Promise.all(['google','outlook'].map(async p => [p,await this.status(p)])));
      const selectedCloud=useCloud(provider);
      const before=generation(provider,selectedCloud);
      const result = await (selectedCloud?cloud:direct).status(provider);
      if(provider==='google'){
        const driveCloud=useServiceCloud('google-drive');
        const drive=driveCloud?await nango.status('google-drive'):await direct.status('google');
        result.driveEnabled=driveCloud?drive.connected===true&&drive.capabilities?.driveRead===true:drive.connected===true&&drive.driveEnabled===true;
        result.driveBackend=driveCloud?'nango':'direct';
      }
      if(selectedCloud!==useCloud(provider)||before!==generation(provider,selectedCloud))
        throw new CalendarError(499,'cancelled','Die Kalenderverbindung wurde während der Abfrage gewechselt.');
      return {...result, generation:before, backend:selectedCloud?'nango':'direct', nangoAvailable:!!nango.localStatus(service(provider)).integrationId};
    },
    configure(provider, body) { const id=service(provider),result = direct.configure(provider,body); advanceDirect(provider);overrides.set(id,signature(id));if(provider==='google')overrides.set('google-drive',signature('google-drive'));return result; },
    disconnect(provider) { if(useCloud(provider))return nango.disconnect(service(provider));advanceDirect(provider);return direct.disconnect(provider); },
    async connect(provider, signal) {
      if (!useCloud(provider)) {advanceDirect(provider);return direct.connect(provider,signal);}
      const id = randomUUID(), cancel = () => {void nango.handle({action:'cancel',id});};
      if(signal?.aborted) throw new CalendarError(409,'cancelled','Anmeldung abgebrochen.');
      signal?.addEventListener('abort',cancel,{once:true});
      try { await nango.handle({action:'connect',service:service(provider),id}); return this.status(provider); }
      finally { signal?.removeEventListener('abort',cancel); }
    },
    calendars(provider, signal) { return route(provider).calendars(provider,signal); },
    events(provider, body, signal) { return route(provider).events(provider,body,signal); },
    sync(provider, body, signal) { return route(provider).sync(provider,body,signal); },
    driveFiles(provider, signal) { service(provider); return (useServiceCloud('google-drive')?cloud:direct).driveFiles(provider,signal); },
    driveText(provider, body, signal) { service(provider); return (useServiceCloud('google-drive')?cloud:direct).driveText(provider,body,signal); }
  };
}
