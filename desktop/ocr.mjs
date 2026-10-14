import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export const MAX_OCR_BYTES = 8 * 1024 * 1024;
export const MAX_OCR_PIXELS = 20_000_000;
export const MAX_OCR_TEXT = 20_000;
const MAX_DIMENSION = 10_000, MAX_LINES = 500, MAX_STDOUT = 256 * 1024;
const defaultHelper = fileURLToPath(new URL('./ocr-helper', import.meta.url)).replace(/([/\\])app\.asar([/\\])/, '$1app.asar.unpacked$2');
const messages = {
  invalidImage: 'Das Bild ist beschädigt oder kein einzelnes JPEG-/PNG-Bild.',
  imageLimit: 'Das Foto überschreitet die Grenze von 8 MiB oder 20 Millionen Pixeln.',
  noText: 'Im Foto wurde kein lesbarer Text erkannt. Verwende ein scharfes, gerades Bild.',
  unavailable: 'Die lokale Apple-Vision-Texterkennung ist auf diesem Mac nicht verfügbar.',
  recognitionFailed: 'Apple Vision konnte dieses Foto nicht lesen. Versuche ein anderes Bild.'
};
function dimensions(bytes, mime) {
  if (mime === 'image/png') {
    if (bytes.length < 45 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
        bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') throw new Error(messages.invalidImage);
    let offset = 8, ended = false;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8);
      if (length > bytes.length - offset - 12 || !/^[A-Za-z]{4}$/.test(type) || type === 'acTL') throw new Error(messages.invalidImage);
      offset += length + 12;
      if (type === 'IEND') { if (length || offset !== bytes.length) throw new Error(messages.invalidImage); ended = true; break; }
    }
    if (!ended) throw new Error(messages.invalidImage);
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  }
  if (bytes.length < 12 || bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) throw new Error(messages.invalidImage);
  let offset = 2;
  while (offset < bytes.length - 2) {
    if (bytes[offset++] !== 255) throw new Error(messages.invalidImage);
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++];
    if (marker === 0xDA || marker === 0xD9 || marker === undefined) break;
    if (marker === 0x01 || marker >= 0xD0 && marker <= 0xD7) continue;
    if (offset + 2 > bytes.length) throw new Error(messages.invalidImage);
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) throw new Error(messages.invalidImage);
    if ([0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF].includes(marker)) {
      if (length < 8) throw new Error(messages.invalidImage);
      return [bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)];
    }
    offset += length;
  }
  throw new Error(messages.invalidImage);
}
export function decodeOCRImage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message) || Object.keys(message).some(key => key !== 'dataURL') || typeof message.dataURL !== 'string')
    throw new Error('OCR erwartet ausschließlich ein JPEG-/PNG-Foto als dataURL.');
  if (message.dataURL.length > Math.ceil(MAX_OCR_BYTES / 3) * 4 + 32) throw new Error(messages.imageLimit);
  const match = /^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/]+={0,2})$/.exec(message.dataURL);
  if (!match || match[2].length % 4 !== 0) throw new Error(messages.invalidImage);
  const bytes = Buffer.from(match[2], 'base64');
  try {
    if (!bytes.length || bytes.length > MAX_OCR_BYTES) throw new Error(messages.imageLimit);
    if (bytes.toString('base64') !== match[2]) throw new Error(messages.invalidImage);
    const [width, height] = dimensions(bytes, match[1]);
    if (!width || !height || width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_OCR_PIXELS) throw new Error(messages.imageLimit);
    return {bytes, mime: match[1], width, height};
  } catch (error) { bytes.fill(0); throw error; }
}
function cleanString(value, max, empty = true) {
  return typeof value === 'string' && value.length <= max && (empty || value.trim()) && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
}
export function validateOCRResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['text', 'lines', 'engine', 'warnings'].includes(key)) ||
      value.engine !== 'Apple Vision' || !cleanString(value.text, MAX_OCR_TEXT, false) || !Array.isArray(value.lines) || !value.lines.length || value.lines.length > MAX_LINES ||
      !Array.isArray(value.warnings) || value.warnings.length > 10 || value.warnings.some(warning => !cleanString(warning, 240, false)))
    throw new Error('Die lokale Texterkennung hat kein gültiges begrenztes Ergebnis geliefert.');
  let characters = 0;
  const lines = value.lines.map(line => {
    if (!line || typeof line !== 'object' || Object.keys(line).some(key => !['text', 'x', 'y', 'width', 'height'].includes(key)) ||
        !cleanString(line.text, 1000, false) || /[\r\n\t]/.test(line.text) || ['x', 'y', 'width', 'height'].some(key => !Number.isFinite(line[key]) || line[key] < 0 || line[key] > 1) ||
        line.width === 0 || line.height === 0 || line.x + line.width > 1.000001 || line.y + line.height > 1.000001)
      throw new Error('Ungültige Textpositionen aus der lokalen Texterkennung.');
    characters += line.text.length;
    return {text: line.text, x: line.x, y: line.y, width: line.width, height: line.height};
  });
  if (characters > MAX_OCR_TEXT) throw new Error('Das lokale OCR-Ergebnis überschreitet 20.000 Zeichen.');
  return {text: value.text, lines, engine: 'Apple Vision', warnings: [...value.warnings]};
}
export function createDesktopOCR({spawnProcess = spawn, helperPath = defaultHelper, platform = process.platform, timeoutMs = 25_000} = {}) {
  let busy = false;
  return async message => {
    if (platform !== 'darwin') throw new Error(messages.unavailable);
    if (busy) throw new Error('Ein Foto wird bereits lokal gelesen. Warte, bis die Texterkennung fertig ist.');
    const image = decodeOCRImage(message);
    busy = true;
    try {
      return await new Promise((resolve, reject) => {
        let child, timer, ended = false, output = [], outputBytes = 0;
        const finish = (error, value) => {
          if (ended) return; ended = true; clearTimeout(timer); output = [];
          if (error) { try { child?.kill('SIGKILL'); } catch {} reject(error); } else resolve(value);
        };
        try {
          // The command/path is fixed by application code. No renderer-supplied
          // file path, argument, shell command or network client is accepted.
          child = spawnProcess(helperPath, [], {shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
            env: {LANG: 'de_DE.UTF-8', LC_ALL: 'de_DE.UTF-8', TMPDIR: process.env.TMPDIR || '/private/tmp'}});
          timer = setTimeout(() => finish(new Error('Die lokale Texterkennung hat zu lange gebraucht und wurde beendet.')), timeoutMs);
          child.once('error', error => finish(new Error(error.code === 'ENOENT' ? 'Die lokale OCR-Komponente fehlt. Verwende die aktuelle Context-Mac-App.' : messages.unavailable)));
          child.stderr?.on('error', () => {});
          child.stderr?.resume(); // OS/helper diagnostics are discarded, never logged or returned.
          child.stdout.on('error', () => finish(new Error(messages.recognitionFailed)));
          child.stdout.on('data', bytes => {
            if (ended) return;
            outputBytes += bytes.length;
            if (outputBytes > MAX_STDOUT) { finish(new Error('Die lokale Texterkennung hat zu viele Daten geliefert und wurde beendet.')); return; }
            output.push(Buffer.from(bytes));
          });
          child.once('close', code => {
            if (ended) return;
            try {
              let result; try { result = JSON.parse(Buffer.concat(output).toString('utf8')); } catch { throw new Error(messages.recognitionFailed); }
              if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error(messages.recognitionFailed);
              if (code !== 0 || result.ok !== true) throw new Error(Object.hasOwn(messages, result.code) ? messages[result.code] : messages.recognitionFailed);
              if (Object.keys(result).some(key => !['ok', 'value'].includes(key))) throw new Error(messages.recognitionFailed);
              finish(null, validateOCRResult(result.value));
            } catch (error) { finish(error); }
          });
          child.stdin.on('error', () => finish(new Error(messages.recognitionFailed)));
          child.stdin.end(image.bytes);
        } catch { finish(new Error(messages.unavailable)); }
      });
    } finally { image.bytes.fill(0); busy = false; }
  };
}
