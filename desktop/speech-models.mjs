import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

// Sizes and hashes are the upstream Git LFS pointer metadata at these immutable
// revisions. No mutable "main" URL, custom model URL, audio, or transcript enters
// this store. Whisper and the converted Silero model are distributed under MIT.
const WHISPER_REPOSITORY = 'ggerganov/whisper.cpp';
const descriptor = (id, label, repository, revision, filename, bytes, sha256) => Object.freeze({
  id, label, repository, revision, filename, bytes, sha256,
  url: `https://huggingface.co/${repository}/resolve/${revision}/${filename}`,
  source: `https://huggingface.co/${repository}/blob/${revision}/${filename}`,
});

export const SPEECH_MODELS = Object.freeze({
  small: descriptor('small', 'Whisper small · mehrsprachig', WHISPER_REPOSITORY,
    '5359861c739e955e79d9a303bcbc70fb988958b1', 'ggml-small.bin', 487601967,
    '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b'),
  'large-v3-turbo': descriptor('large-v3-turbo', 'Whisper large-v3-turbo · mehrsprachig', WHISPER_REPOSITORY,
    '98aa99a0a9db05ae2342309f5096248665f7cba3', 'ggml-large-v3-turbo.bin', 1624555275,
    '1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69'),
});

export const SPEECH_VAD = descriptor('silero-v5.1.2', 'Silero VAD 5.1.2', 'ggml-org/whisper-vad',
  'e5614ed76a5dd4b03fad5068c89efcd2617a9d1e', 'ggml-silero-v5.1.2.bin', 885098,
  '29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf');

function failure(code, message) { const error = new Error(message); error.code = code; return error; }
function abortCheck(signal) { if (signal?.aborted) throw failure('ABORTED', 'Modelldownload oder Modellprüfung abgebrochen.'); }
function fingerprint(stat) { return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':'); }

// Redirects are limited to Hugging Face's HTTPS model/CDN domains. In particular,
// a redirect to loopback, LAN, another host, HTTP, or a URL with credentials fails.
export function isSpeechModelDownloadURL(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') &&
      (url.hostname === 'huggingface.co' || url.hostname === 'hf.co' || url.hostname.endsWith('.hf.co'));
  } catch { return false; }
}

/**
 * Trusted main-process model store. `models` / `vad` injection is for small test
 * fixtures only; renderer IPC accepts model IDs, never paths or URLs. `ensure`
 * is entirely offline and fails with MODEL_MISSING rather than starting a fetch.
 */
export function createSpeechModelStore({ directory, emit = () => {}, fetchImpl = globalThis.fetch,
  models = SPEECH_MODELS, vad = SPEECH_VAD, downloadTimeoutMs = 60 * 60 * 1000 } = {}) {
  if (typeof directory !== 'string' || !directory) throw new TypeError('Ein lokales Modellverzeichnis ist erforderlich.');
  const root = path.resolve(directory);
  const verified = new Map();
  let downloading = false;
  const manifest = Object.freeze({ ...models });
  for (const artifact of [...Object.values(manifest), vad]) {
    if (!artifact || !/^[a-z0-9.-]+\.bin$/i.test(artifact.filename) || path.basename(artifact.filename) !== artifact.filename ||
      !Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0 || artifact.bytes > 2_000_000_000 ||
      !/^[a-f0-9]{64}$/.test(artifact.sha256) || !isSpeechModelDownloadURL(artifact.url)) {
      throw new TypeError('Ungültiges Sprachmodell-Manifest.');
    }
  }
  const notify = detail => { try { emit({ event: 'download', ...detail }); } catch { /* Observers cannot interrupt disk cleanup. */ } };
  const select = id => {
    if (typeof id !== 'string' || !Object.hasOwn(manifest, id)) throw failure('MODEL_UNKNOWN', 'Dieses Sprachmodell wird nicht unterstützt.');
    return manifest[id];
  };

  async function inspect(artifact, filename = path.join(root, artifact.filename), { signal, cache = true } = {}) {
    abortCheck(signal);
    let handle;
    try {
      const dir = await fs.lstat(root);
      if (!dir.isDirectory() || dir.isSymbolicLink()) return { integrity: 'invalid', available: false, error: 'Das Modellverzeichnis ist keine sichere lokale Ablage.' };
      const link = await fs.lstat(filename);
      if (!link.isFile() || link.isSymbolicLink()) return { integrity: 'invalid', available: false, error: 'Keine reguläre Modelldatei.' };
      handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.size !== BigInt(artifact.bytes)) {
        return { integrity: 'invalid', available: false, error: 'Die Größe der Modelldatei stimmt nicht.' };
      }
      const identity = fingerprint(before);
      if (cache && verified.get(filename) === identity) return { integrity: 'verified', available: true };
      const hash = createHash('sha256');
      const stream = handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024, end: artifact.bytes - 1 });
      const onAbort = () => stream.destroy(failure('ABORTED', 'Modellprüfung abgebrochen.'));
      signal?.addEventListener('abort', onAbort, { once: true });
      try { for await (const chunk of stream) { abortCheck(signal); hash.update(chunk); } }
      // Destroying a FileHandle stream closes the handle even with autoClose:
      // false. Keep it open until the post-read stat verifies the same file.
      finally { signal?.removeEventListener('abort', onAbort); }
      abortCheck(signal);
      const after = await handle.stat({ bigint: true });
      const digest = hash.digest('hex');
      if (fingerprint(after) !== identity || digest !== artifact.sha256) {
        verified.delete(filename);
        return { integrity: 'invalid', available: false, error: 'Die SHA-256-Prüfsumme der Modelldatei stimmt nicht.' };
      }
      if (cache) verified.set(filename, identity);
      return { integrity: 'verified', available: true };
    } catch (error) {
      if (error.code === 'ENOENT') return { integrity: 'missing', available: false };
      if (error.code === 'ABORTED' || signal?.aborted) throw failure('ABORTED', 'Modellprüfung abgebrochen.');
      return { integrity: 'invalid', available: false, error: 'Die lokale Modelldatei lässt sich nicht sicher prüfen.' };
    } finally { await handle?.close().catch(() => {}); }
  }

  async function status() {
    const vadStatus = await inspect(vad);
    const entries = [];
    for (const model of Object.values(manifest)) {
      const current = await inspect(model);
      entries.push({ ...model, ...current, downloaded: current.available,
        available: current.available && vadStatus.available, totalBytes: model.bytes + vad.bytes,
        downloadedBytes: (current.available ? model.bytes : 0) + (vadStatus.available ? vad.bytes : 0),
        ...(current.available && !vadStatus.available ? { error: 'Das Silero-VAD-Modell fehlt oder ist beschädigt.' } : {}),
      });
    }
    return { models: entries, vad: { ...vad, ...vadStatus } };
  }

  async function ensure(id = 'small', { signal } = {}) {
    const model = select(id);
    for (const artifact of [model, vad]) {
      const current = await inspect(artifact, undefined, { signal });
      if (!current.available) {
        throw failure(current.integrity === 'missing' ? 'MODEL_MISSING' : 'MODEL_INTEGRITY',
          current.integrity === 'missing' ? `${artifact.label} fehlt. Bitte das Modell zunächst herunterladen.` :
            `${artifact.label} ist beschädigt. Bitte das Modell erneut herunterladen.`);
      }
    }
    return { model: id, modelPath: path.join(root, model.filename), vadPath: path.join(root, vad.filename), bytes: model.bytes + vad.bytes };
  }

  async function responseFor(url, signal) {
    let next = url;
    for (let redirects = 0; redirects <= 5; redirects++) {
      abortCheck(signal);
      if (!isSpeechModelDownloadURL(next)) throw failure('MODEL_DOWNLOAD_ORIGIN', 'Der Modellserver hat auf eine nicht erlaubte Adresse verwiesen.');
      const response = await fetchImpl(next, { signal, redirect: 'manual', cache: 'no-store', credentials: 'omit',
        headers: { Accept: 'application/octet-stream', 'Accept-Encoding': 'identity' } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location || redirects === 5) throw failure('MODEL_DOWNLOAD_ORIGIN', 'Die Modelladresse enthält zu viele oder ungültige Weiterleitungen.');
        next = new URL(location, next).href;
        continue;
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw failure('MODEL_DOWNLOAD_HTTP', `Der Modelldownload ist fehlgeschlagen (HTTP ${response.status}).`);
      }
      // A faulty injected fetch or unexpected response must not silently follow
      // an unvalidated URL even though production fetch is redirect:manual.
      if (response.url && !isSpeechModelDownloadURL(response.url)) {
        await response.body.cancel();
        throw failure('MODEL_DOWNLOAD_ORIGIN', 'Die Antwort stammt von einer nicht erlaubten Modelladresse.');
      }
      return response;
    }
    throw failure('MODEL_DOWNLOAD_ORIGIN', 'Die Modelladresse lässt sich nicht sicher auflösen.');
  }

  async function download(id = 'small', { signal } = {}) {
    const model = select(id);
    abortCheck(signal);
    if (downloading) throw failure('MODEL_DOWNLOAD_BUSY', 'Es läuft bereits ein Modelldownload.');
    downloading = true;
    const total = model.bytes + vad.bytes;
    let received = 0;
    try {
      try { await fs.mkdir(root, { recursive: true, mode: 0o700 }); }
      catch { throw failure('MODEL_DIRECTORY', 'Das lokale Modellverzeichnis lässt sich nicht anlegen. Prüfe Zugriffsrechte und freien Speicherplatz.'); }
      const dir = await fs.lstat(root);
      if (!dir.isDirectory() || dir.isSymbolicLink()) throw failure('MODEL_DIRECTORY', 'Das Modellverzeichnis ist keine sichere lokale Ablage.');
      for (const artifact of [model, vad]) {
        abortCheck(signal);
        const progress = (phase, fileReceived, extra = {}) => notify({ model: id, file: artifact.id, phase,
          received: received + fileReceived, total, fileReceived, fileTotal: artifact.bytes, ...extra });
        const current = await inspect(artifact, undefined, { signal });
        if (current.available) { progress('complete', artifact.bytes); received += artifact.bytes; continue; }
        const temporary = path.join(root, `${artifact.filename}.${randomUUID()}.part`);
        let handle, reader;
        const timeout = AbortSignal.timeout(downloadTimeoutMs);
        const operationSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
        let onAbort;
        try {
          progress('downloading', 0);
          const response = await responseFor(artifact.url, operationSignal);
          const length = response.headers.get('content-length');
          if (length !== null && (!/^\d+$/.test(length) || Number(length) !== artifact.bytes)) {
            await response.body.cancel();
            throw failure('MODEL_DOWNLOAD_SIZE', 'Der Modellserver meldet eine unerwartete Dateigröße.');
          }
          handle = await fs.open(temporary, 'wx', 0o600);
          reader = response.body.getReader();
          onAbort = () => { void reader.cancel().catch(() => {}); };
          operationSignal.addEventListener('abort', onAbort, { once: true });
          let fileReceived = 0, lastProgress = 0;
          for (;;) {
            abortCheck(operationSignal);
            const { value, done } = await reader.read();
            abortCheck(operationSignal);
            if (done) break;
            if (!(value instanceof Uint8Array) || value.byteLength > artifact.bytes - fileReceived) {
              throw failure('MODEL_DOWNLOAD_SIZE', 'Der Modelldownload überschreitet die erwartete Dateigröße.');
            }
            let offset = 0;
            while (offset < value.byteLength) {
              abortCheck(operationSignal);
              const result = await handle.write(value, offset, value.byteLength - offset, null);
              if (!result.bytesWritten) throw failure('MODEL_DOWNLOAD_DISK', 'Die Modelldatei konnte nicht geschrieben werden.');
              offset += result.bytesWritten;
            }
            fileReceived += value.byteLength;
            if (Date.now() - lastProgress >= 100 || fileReceived === artifact.bytes) {
              progress('downloading', fileReceived); lastProgress = Date.now();
            }
          }
          if (fileReceived !== artifact.bytes) throw failure('MODEL_DOWNLOAD_SIZE', 'Der Modelldownload ist unvollständig.');
          await handle.sync();
          await handle.close(); handle = undefined;
          progress('verifying', fileReceived);
          const integrity = await inspect(artifact, temporary, { signal: operationSignal, cache: false });
          if (!integrity.available) throw failure('MODEL_INTEGRITY', 'Die heruntergeladene Modelldatei hat eine falsche SHA-256-Prüfsumme.');
          abortCheck(operationSignal);
          const target = path.join(root, artifact.filename);
          await fs.rename(temporary, target);
          verified.delete(target);
          progress('complete', fileReceived);
          received += artifact.bytes;
        } catch (error) {
          if (signal?.aborted) throw failure('ABORTED', 'Modelldownload abgebrochen.');
          if (timeout.aborted) throw failure('MODEL_DOWNLOAD_TIMEOUT', 'Der Modelldownload hat zu lange gedauert. Bitte erneut versuchen.');
          if (error.code?.startsWith('MODEL_') || error.code === 'ABORTED') throw error;
          throw failure('MODEL_DOWNLOAD_FAILED', 'Das Modell konnte nicht heruntergeladen werden. Prüfe Verbindung und freien Speicherplatz.');
        } finally {
          if (onAbort) operationSignal.removeEventListener('abort', onAbort);
          await reader?.cancel().catch(() => {});
          reader?.releaseLock();
          await handle?.close().catch(() => {});
          await fs.rm(temporary, { force: true }).catch(() => {});
        }
      }
      const result = await ensure(id, { signal });
      notify({ model: id, phase: 'complete', received: total, total, available: true });
      return result;
    } catch (error) {
      notify({ model: id, phase: error.code === 'ABORTED' ? 'cancelled' : 'error', received, total,
        code: error.code || 'MODEL_DOWNLOAD_FAILED', message: error.message });
      throw error;
    } finally { downloading = false; }
  }

  return Object.freeze({ status, ensure, download });
}
