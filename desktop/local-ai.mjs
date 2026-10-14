import { KIError, validateChat } from '../connectors/ki.mjs';

const DEFAULT_PORT = 1234;
const MODEL_TTL = 300_000;
const JSON_LIMIT = 1_000_000;
const REQUEST_LIMIT = 512_000;
const PROVIDER = 'Lokales Modell';
const safeErrors = new WeakSet();

function failure(status, code, message) {
  const error = new KIError(status, code, message);
  safeErrors.add(error);
  return error;
}

function abortCheck(signal) {
  if (signal?.aborted)
    throw failure(499, 'cancelled', 'Anfrage abgebrochen.');
}

// Also bound a stalled fetch/stream supplied by an adapter that ignores signal.
function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

function cancelBody(response) {
  try {
    Promise.resolve(response?.body?.cancel()).catch(() => {});
  } catch {}
}

async function limitedJSON(response, signal) {
  if (
    !/^application\/(?:json|[a-z0-9!#$&^_.+-]+\+json)\s*(?:;|$)/i.test(
      response.headers.get('content-type') || '',
    )
  ) {
    cancelBody(response);
    throw failure(502, 'invalid_response', 'Der lokale Modellserver hat keine gültige JSON-Antwort geliefert.');
  }
  const lengthHeader = response.headers.get('content-length');
  if (/^\d+$/.test(lengthHeader || '') && Number(lengthHeader) > JSON_LIMIT) {
    cancelBody(response);
    throw failure(502, 'response_limit', 'Die lokale KI-Antwort war zu groß. Bitte die Frage eingrenzen.');
  }
  const reader = response.body?.getReader();
  if (!reader)
    throw failure(502, 'invalid_response', 'Der lokale Modellserver hat keine Antwort geliefert.');
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      length += value.byteLength;
      if (length > JSON_LIMIT)
        throw failure(502, 'response_limit', 'Die lokale KI-Antwort war zu groß. Bitte die Frage eingrenzen.');
      chunks.push(Buffer.from(value));
    }
    if (signal.aborted) throw signal.reason;
    let result;
    try {
      result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    } catch {
      throw failure(502, 'invalid_response', 'Der lokale Modellserver hat keine gültige JSON-Antwort geliefert.');
    }
    if (!result || typeof result !== 'object' || Array.isArray(result))
      throw failure(502, 'invalid_response', 'Der lokale Modellserver hat keine gültige JSON-Antwort geliefert.');
    return result;
  } catch (error) {
    try { Promise.resolve(reader.cancel()).catch(() => {}); } catch {}
    throw error;
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

function configuration(value) {
  if (
    !value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).some(key => !['port', 'key'].includes(key))
  ) throw failure(400, 'invalid_request', 'Bitte nur den lokalen Port und optional einen API-Schlüssel angeben.');
  const port = value.port === undefined ? DEFAULT_PORT : value.port;
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 4318)
    throw failure(400, 'invalid_port', 'Bitte einen lokalen Port von 1024 bis 65535 wählen. Port 4318 ist für Context reserviert.');
  if (
    value.key !== undefined &&
    (typeof value.key !== 'string' || value.key.length > 4096 || /[\x00-\x1f\x7f]/.test(value.key))
  ) throw failure(400, 'invalid_key', 'Bitte einen gültigen lokalen API-Schlüssel eingeben.');
  return { port, key: value.key?.trim() || '' };
}

export function createLocalAIClient({ fetcher = fetch, now = Date.now } = {}) {
  // Server credential, configuration and catalog live only in this closure.
  let configured = null;
  let cachedModels = null;
  let cachedAt = 0;
  let active = false;
  let requests = [];

  const summary = (config = configured) => ({
    storage: config?.key ? 'session' : null,
    provider: PROVIDER,
    port: config?.port || DEFAULT_PORT,
    local: true,
  });
  const catalogResult = models => ({
    models: models.map(({ id }) => ({ id })),
    ...summary(),
  });
  const ready = () => {
    if (!configured)
      throw failure(503, 'not_configured', 'Der lokale Modellserver ist noch nicht verbunden. Bitte den Server starten und den Port verbinden.');
    return configured;
  };
  const begin = signal => {
    if (signal != null && !(signal instanceof AbortSignal))
      throw failure(400, 'invalid_request', 'Ungültiges Abbruchsignal.');
    abortCheck(signal);
    if (active)
      throw failure(429, 'busy', 'Eine lokale KI-Anfrage läuft bereits. Bitte kurz warten.');
    const current = now();
    requests = requests.filter(at => current - at < 60_000);
    if (requests.length >= 10)
      throw failure(429, 'local_limit', 'Bitte kurz warten. Höchstens zehn lokale KI-Anfragen pro Minute.');
    active = true;
    requests.push(current);
  };

  async function request(config, path, body, externalSignal) {
    abortCheck(externalSignal);
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    if (serialized && Buffer.byteLength(serialized, 'utf8') > REQUEST_LIMIT)
      throw failure(400, 'request_limit', 'Die lokale KI-Anfrage ist zu groß. Bitte den Chat kürzen.');
    const timeout = new AbortController();
    const timer = setTimeout(
      () => timeout.abort(new DOMException('Local model timeout', 'TimeoutError')),
      body === undefined ? 15_000 : 180_000,
    );
    timer.unref?.();
    const signal = AbortSignal.any([timeout.signal, ...(externalSignal ? [externalSignal] : [])]);
    const url = `http://127.0.0.1:${config.port}/v1${path}`;
    let response;
    try {
      const pending = Promise.resolve(fetcher(url, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Accept: 'application/json',
          ...(config.key ? { Authorization: `Bearer ${config.key}` } : {}),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(serialized === undefined ? {} : { body: serialized }),
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        signal,
      }));
      pending.then(result => { if (signal.aborted) cancelBody(result); }, () => {});
      response = await abortable(pending, signal);
      if (signal.aborted) throw signal.reason;
      if (response.redirected || (response.url && response.url !== url) || (response.status >= 300 && response.status < 400)) {
        cancelBody(response);
        throw failure(502, 'redirect_blocked', 'Der lokale Modellserver hat eine Weiterleitung versucht. Weiterleitungen sind gesperrt.');
      }
      if (!response.ok) {
        cancelBody(response);
        if ([401, 403].includes(response.status))
          throw failure(502, 'access_denied', 'Der lokale Modellserver hat den Zugriff abgelehnt. Bitte den lokalen API-Schlüssel prüfen.');
        if (response.status === 429)
          throw failure(429, 'provider_limit', 'Der lokale Modellserver ist ausgelastet. Bitte später erneut versuchen.');
        throw failure(502, 'provider_error', 'Der lokale Modellserver konnte die Anfrage nicht beantworten. Bitte den Server und das ausgewählte Modell prüfen.');
      }
      return await limitedJSON(response, signal);
    } catch (error) {
      if (externalSignal?.aborted)
        throw failure(499, 'cancelled', 'Anfrage abgebrochen.');
      if (timeout.signal.aborted || error?.name === 'TimeoutError')
        throw failure(504, 'timeout', 'Der lokale Modellserver hat zu lange gebraucht. Bitte erneut versuchen.');
      // Never propagate local server error bodies, adapter errors or headers.
      if (safeErrors.has(error)) throw error;
      throw failure(502, 'connection_failed', 'Der lokale Modellserver ist nicht erreichbar. Bitte den Server starten und den Port prüfen.');
    } finally {
      clearTimeout(timer);
      if (signal.aborted) cancelBody(response);
    }
  }

  async function getModels(config, signal) {
    const data = await request(config, '/models', undefined, signal);
    if (!Array.isArray(data.data) || data.data.length > 200)
      throw failure(502, 'invalid_models', 'Der lokale Modellserver hat keine gültige Modellliste geliefert.');
    const models = [...new Set(data.data.map(model => model?.id).filter(id =>
      typeof id === 'string' && id.trim() && id.length <= 160 && !/[\x00-\x1f\x7f]/.test(id),
    ))].map(id => ({ id }));
    if (!models.length)
      throw failure(502, 'no_models', 'Der lokale Modellserver bietet keine verwendbaren Modelle an. Bitte ein Modell im Server bereitstellen.');
    return models;
  }

  return {
    async status() {
      return { configured: !!configured, ...summary() };
    },
    async usage(signal) {
      if (signal != null && !(signal instanceof AbortSignal))
        throw failure(400, 'invalid_request', 'Ungültige Limitabfrage.');
      abortCheck(signal);
      ready();
      return { provider: 'local', status: 'not_applicable', checkedAt: new Date(now()).toISOString() };
    },
    async models(signal) {
      const config = ready();
      begin(signal);
      try {
        const models = await getModels(config, signal);
        abortCheck(signal);
        cachedModels = models;
        cachedAt = now();
        return catalogResult(models);
      } finally { active = false; }
    },
    async configure(value, signal) {
      const candidate = configuration(value);
      begin(signal);
      try {
        const models = await getModels(candidate, signal);
        abortCheck(signal);
        configured = candidate;
        cachedModels = models;
        cachedAt = now();
        return catalogResult(models);
      } finally { active = false; }
    },
    async complete(value, signal) {
      const input = validateChat(value);
      const config = ready();
      begin(signal);
      try {
        let models = cachedModels;
        if (!models || now() - cachedAt >= MODEL_TTL) {
          models = await getModels(config, signal);
          cachedModels = models;
          cachedAt = now();
        }
        abortCheck(signal);
        if (!models.some(model => model.id === input.model))
          throw failure(400, 'unknown_model', 'Dieses Modell ist nicht in der Modellliste deines lokalen Servers.');
        const result = await request(config, '/chat/completions', { ...input, stream: false }, signal);
        abortCheck(signal);
        const content = result.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || !content.trim() || content.length > 50_000)
          throw failure(502, 'invalid_completion', 'Der lokale Modellserver hat keine verwendbare Textantwort geliefert.');
        return {
          content,
          model: input.model,
          finishReason: typeof result.choices?.[0]?.finish_reason === 'string'
            ? result.choices[0].finish_reason.slice(0, 30) : null,
          ...(Number.isSafeInteger(result.usage?.total_tokens) && result.usage.total_tokens >= 0
            ? { totalTokens: result.usage.total_tokens } : {}),
        };
      } finally { active = false; }
    },
  };
}
