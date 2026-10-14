import { randomUUID } from "node:crypto";
import * as files from "node:fs/promises";
import path from "node:path";
import { browserURL } from "./policy.mjs";

export const WEBSITE_PARTITION = "persist:context-websites";
const LIMIT = 2_000_000,
  MAX_COOKIES = 1000,
  MAX_AGE = 30 * 86400_000;
const DOMAINS = ["th-koeln.de", "coco.study", "sciebo.de"];
const sameSites = new Set(["unspecified", "no_restriction", "lax", "strict"]);
export function providerPreferences() {
  return {
    partition: WEBSITE_PARTITION,
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    navigateOnDragDrop: false,
  };
}
export function allowProviderPopup(url, opener, count) {
  try {
    browserURL(opener);
    if (!Number.isSafeInteger(count) || count < 0 || count >= 4) return false;
    if (url === "about:blank") return true;
    browserURL(url);
    return true;
  } catch {
    return false;
  }
}
export function sessionCookie(raw) {
  if (
    !raw ||
    raw.session !== true ||
    raw.expirationDate !== undefined ||
    typeof raw.domain !== "string" ||
    typeof raw.name !== "string" ||
    typeof raw.value !== "string"
  )
    return null;
  const domain = raw.domain.toLowerCase(),
    host = domain.replace(/^\./, "");
  if (
    !DOMAINS.some((d) => host === d || host.endsWith("." + d)) ||
    !/^\.?[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(domain) ||
    domain.length > 253
  )
    return null;
  if (
    raw.name.length > 512 ||
    raw.value.length > 16384 ||
    /[\x00-\x20\x7f()<>@,;:\\"/\[\]?={}]/.test(raw.name) ||
    /[\x00-\x1f\x7f]/.test(raw.value)
  )
    return null;
  if (
    typeof raw.hostOnly !== "boolean" ||
    typeof raw.secure !== "boolean" ||
    typeof raw.httpOnly !== "boolean" ||
    !sameSites.has(raw.sameSite)
  )
    return null;
  const cookiePath = raw.path;
  if (
    typeof cookiePath !== "string" ||
    !cookiePath.startsWith("/") ||
    cookiePath.length > 2048 ||
    /[\x00-\x1f\x7f]/.test(cookiePath) ||
    (raw.hostOnly && domain.startsWith("."))
  )
    return null;
  if (
    (raw.sameSite === "no_restriction" && !raw.secure) ||
    (raw.name.startsWith("__Secure-") && !raw.secure) ||
    (raw.name.startsWith("__Host-") &&
      (!raw.secure || !raw.hostOnly || cookiePath !== "/"))
  )
    return null;
  return {
    name: raw.name,
    value: raw.value,
    domain,
    path: cookiePath,
    hostOnly: raw.hostOnly,
    secure: raw.secure,
    httpOnly: raw.httpOnly,
    sameSite: raw.sameSite,
    session: true,
  };
}
const identity = (c) =>
  JSON.stringify([c.domain.replace(/^\./, ""), c.path, c.name]);
export function cookieDetails(cookie) {
  const c = sessionCookie(cookie);
  if (!c) throw new Error("Ungültige Sitzung.");
  return {
    url: "https://" + c.domain.replace(/^\./, "") + "/",
    name: c.name,
    value: c.value,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    sameSite: c.sameSite,
    ...(c.hostOnly ? {} : { domain: c.domain }),
  };
}
export function parseSessionSnapshot(text, now = Date.now()) {
  if (typeof text !== "string" || Buffer.byteLength(text) > LIMIT)
    throw new Error("Ungültiger Sitzungsspeicher.");
  const data = JSON.parse(text);
  if (
    !data ||
    data.version !== 1 ||
    Object.keys(data).some(
      (k) => !["version", "savedAt", "cookies"].includes(k),
    ) ||
    !Number.isSafeInteger(data.savedAt) ||
    data.savedAt > now + 60000 ||
    data.savedAt < now - MAX_AGE ||
    !Array.isArray(data.cookies) ||
    data.cookies.length > MAX_COOKIES
  )
    throw new Error("Ungültiger Sitzungsspeicher.");
  const cookies = data.cookies.map((c) => {
    const clean = sessionCookie(c);
    if (!clean || Object.keys(c).some((k) => !Object.keys(clean).includes(k)))
      throw new Error("Ungültiger Sitzungsspeicher.");
    return clean;
  });
  if (new Set(cookies.map(identity)).size !== cookies.length)
    throw new Error("Ungültiger Sitzungsspeicher.");
  return cookies;
}

// Credentials never cross IPC. The vault holds only this app's supported campus
// session cookies; Chromium owns ordinary persistent cookies and other storage.
export function createProviderSessionKeeper({
  cookies,
  crypto,
  profile,
  fs = files,
  now = Date.now,
  onChange = () => {},
}) {
  const target = path.join(profile, "campus-session.enc"),
    pendingFile = path.join(profile, "campus-session.pending");
  let mode = "initializing",
    warning = "",
    restored = 0,
    queue = Promise.resolve(),
    timer,
    started = false,
    dirty = false,
    startPromise;
  const status = () => ({ mode, warning, restored, shared: true });
  const publish = () => onChange(status());
  const fail = () => {
    mode = "unavailable";
    warning =
      "Sitzungen können momentan nicht verschlüsselt gesichert werden. Prüfe den macOS-Schlüsselbund. Reguläre Browser-Cookies bleiben im Profil.";
    publish();
  };
  const encryptionAvailable = async () =>
    process.platform !== "linux" && (await crypto.isAsyncEncryptionAvailable());
  const changed = () => {
    if (!started) return;
    dirty = true;
    queue = queue
      .then(() => fs.writeFile(pendingFile, "pending", { mode: 0o600 }))
      .catch(fail);
    clearTimeout(timer);
    timer = setTimeout(() => {
      void save();
    }, 350);
    timer.unref?.();
  };
  async function writeSnapshot() {
    if (!dirty || mode === "unavailable") return;
    dirty = false;
    await fs.writeFile(pendingFile, "pending", { mode: 0o600 });
    const current = (await cookies.get({ session: true }))
      .map(sessionCookie)
      .filter(Boolean);
    if (current.length > MAX_COOKIES)
      throw new Error("Sitzungsspeicher zu groß.");
    const plaintext = JSON.stringify({
      version: 1,
      savedAt: now(),
      cookies: current,
    });
    if (Buffer.byteLength(plaintext) > LIMIT)
      throw new Error("Sitzungsspeicher zu groß.");
    const encrypted = await crypto.encryptStringAsync(plaintext);
    if (!Buffer.isBuffer(encrypted) || encrypted.length > LIMIT + 4096)
      throw new Error("Ungültiger Sitzungsspeicher.");
    const temporary = path.join(
      profile,
      "campus-session." + randomUUID() + ".tmp",
    );
    try {
      await fs.writeFile(temporary, encrypted, { mode: 0o600, flag: "wx" });
      await fs.rename(temporary, target);
    } finally {
      await fs.unlink(temporary).catch(() => {});
    }
    if (!dirty)
      await fs.unlink(pendingFile).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    mode = "encrypted";
    publish();
  }
  function save() {
    clearTimeout(timer);
    queue = queue.then(writeSnapshot).catch(() => {
      dirty = true;
      fail();
    });
    return queue;
  }
  function start() {
    if (startPromise) return startPromise;
    startPromise = initialize();
    return startPromise;
  }
  async function initialize() {
    try {
      if (!(await encryptionAvailable()))
        throw new Error("Verschlüsselung nicht verfügbar.");
      let data;
      try {
        const stat = await fs.lstat(target);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > LIMIT + 4096)
          throw new Error("Ungültiger Sitzungsspeicher.");
        data = await fs.readFile(target);
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      let incomplete = false;
      try {
        await fs.lstat(pendingFile);
        incomplete = true;
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      if (incomplete) {
        warning =
          "Die letzte Sitzung wurde nicht vollständig gesichert. Melde dich bei Bedarf erneut an.";
      }
      if (data && !incomplete) {
        const decoded = await crypto.decryptStringAsync(data);
        let saved;
        try {
          saved = parseSessionSnapshot(decoded.result, now());
        } catch {
          saved = [];
          warning =
            "Der lokale Sitzungsstand ist veraltet oder ungültig. Melde dich erneut an.";
        }
        const existing = new Set(
          (await cookies.get({}))
            .filter(
              (c) => typeof c.domain === "string" && typeof c.path === "string",
            )
            .map(identity),
        );
        for (const cookie of saved) {
          if (existing.has(identity(cookie))) continue;
          try {
            await cookies.set(cookieDetails(cookie));
            restored++;
          } catch {
            warning = "Einige lokale Sitzungen benötigen eine neue Anmeldung.";
          }
        }
      }
      mode = "encrypted";
      started = true;
      cookies.on("changed", changed);
      dirty = true;
      await save();
    } catch {
      started = true;
      cookies.on("changed", changed);
      fail();
    }
    publish();
    return status();
  }
  async function flush() {
    clearTimeout(timer);
    if (startPromise) await startPromise;
    await queue;
    await save();
    try {
      await cookies.flushStore();
    } catch {
      warning = "Browser-Cookies konnten nicht vollständig gesichert werden.";
      publish();
    }
  }
  function dispose() {
    clearTimeout(timer);
    cookies.off("changed", changed);
    started = false;
  }
  return { start, flush, status, dispose };
}
