import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createReadStream, createWriteStream} from 'node:fs';
import {chmod, copyFile, mkdir, readFile, rename, rm, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {pipeline} from 'node:stream/promises';
import {Readable} from 'node:stream';

export const WHISPER_SOURCE = Object.freeze({
  version: '1.9.2',
  url: 'https://codeload.github.com/ggml-org/whisper.cpp/tar.gz/refs/tags/v1.9.2',
  sha256: 'a6abd064fcca8b85e794d205abf328c522e9451db43a3eadc178b883b7d0e9cd',
});
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultCache = path.resolve(root, '../../work/speech-build');

async function digest(file) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}
async function exists(file) { try { await stat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
export async function ensureWhisperSource(cache, {fetchImpl = fetch} = {}) {
  await mkdir(cache, {recursive: true});
  const archive = path.join(cache, `whisper-${WHISPER_SOURCE.version}.tar.gz`);
  if (await exists(archive) && await digest(archive) !== WHISPER_SOURCE.sha256) await rm(archive);
  if (!await exists(archive)) {
    const temporary = archive + '.part';
    try {
      const response = await fetchImpl(WHISPER_SOURCE.url, {signal: AbortSignal.timeout(300_000), redirect: 'follow'});
      if (!response.ok || !response.body) throw new Error(`whisper.cpp download failed (${response.status}).`);
      const bytes = Number(response.headers.get('content-length'));
      if (Number.isFinite(bytes) && bytes > 32 * 1024 * 1024) throw new Error('Unexpected source archive size.');
      let received = 0;
      const bounded = async function* (source) {
        for await (const chunk of source) {
          received += chunk.length;
          if (received > 32 * 1024 * 1024) throw new Error('Source archive exceeded its size limit.');
          yield chunk;
        }
      };
      await pipeline(Readable.fromWeb(response.body), bounded, createWriteStream(temporary, {mode: 0o600}));
      if (await digest(temporary) !== WHISPER_SOURCE.sha256) throw new Error('whisper.cpp source SHA-256 mismatch; refusing to build.');
      await rename(temporary, archive);
    } finally { await rm(temporary, {force: true}); }
  }
  const source = path.join(cache, `whisper.cpp-${WHISPER_SOURCE.version}`);
  const marker = path.join(cache, 'source-integrity.json');
  let verified = false;
  try { const value = JSON.parse(await readFile(marker, 'utf8')); verified = value.sha256 === WHISPER_SOURCE.sha256 && await exists(path.join(source, 'include/whisper.h')); } catch {}
  if (!verified) {
    await rm(source, {recursive: true, force: true});
    await command('tar', ['-xzf', archive, '-C', cache]);
    await writeFile(marker, JSON.stringify({version: WHISPER_SOURCE.version, sha256: WHISPER_SOURCE.sha256}) + '\n', {mode: 0o600});
  }
  return source;
}
async function command(executable, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {stdio: 'inherit', shell: false, ...options});
    child.on('error', reject);
    child.on('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${executable} failed (${signal || code}).`)));
  });
}
async function cmakeCommand() {
  if (process.env.CONTEXT_CMAKE) return process.env.CONTEXT_CMAKE;
  // A task-local PyPI CMake install is supported without changing global Python
  // or requiring Homebrew. End-user builds normally use cmake from PATH.
  const local = path.resolve(root, '../../work/speech-tools/cmake/data/bin', process.platform === 'win32' ? 'cmake.exe' : 'cmake');
  return await exists(local) ? local : 'cmake';
}
export async function buildSpeech({cache = process.env.CONTEXT_SPEECH_BUILD_DIR || defaultCache, cpuOnly = false} = {}) {
  const source = await ensureWhisperSource(cache);
  const build = path.join(cache, `build-${process.platform}-${process.arch}-${cpuOnly ? 'cpu' : 'auto'}`);
  const cmake = await cmakeCommand();
  const metal = process.platform === 'darwin' && !cpuOnly;
  const configure = ['-S', path.join(root, 'native/speech'), '-B', build,
    `-DWHISPER_SOURCE_DIR=${source}`, '-DCMAKE_BUILD_TYPE=Release',
    `-DGGML_METAL=${metal ? 'ON' : 'OFF'}`, '-DGGML_METAL_EMBED_LIBRARY=ON',
    '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded'];
  if (process.platform === 'darwin') configure.push('-DCMAKE_OSX_DEPLOYMENT_TARGET=13.3');
  await command(cmake, configure);
  await command(cmake, ['--build', build, '--config', 'Release', '--target', 'speech-helper', '--parallel', '4']);
  const executable = process.platform === 'win32' ? 'speech-helper.exe' : 'speech-helper';
  const candidates = [path.join(build, 'bin', executable), path.join(build, 'bin', 'Release', executable)];
  const compiled = (await Promise.all(candidates.map(exists))).findIndex(Boolean);
  if (compiled < 0) throw new Error('CMake did not produce the speech helper.');
  const destination = path.join(root, 'desktop', executable);
  await copyFile(candidates[compiled], destination);
  if (process.platform !== 'win32') await chmod(destination, 0o755);
  if (process.platform === 'darwin') await command('/usr/bin/codesign', ['--force', '--sign', '-', destination]);
  await writeFile(path.join(root, 'desktop/speech-build.json'), JSON.stringify({
    whisper: WHISPER_SOURCE.version, sourceSha256: WHISPER_SOURCE.sha256,
    platform: process.platform, arch: process.arch, metal, cpuFallback: true,
    helperSha256: await digest(destination),
  }, null, 2) + '\n');
  console.log(`Built local speech helper: ${destination}`);
  return destination;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await buildSpeech({cpuOnly: process.argv.includes('--cpu')}); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
