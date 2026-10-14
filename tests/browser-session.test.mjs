import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  sessionCookie,
  cookieDetails,
  parseSessionSnapshot,
  createProviderSessionKeeper,
  providerPreferences,
  WEBSITE_PARTITION,
  allowProviderPopup,
} from "../desktop/browser-session.mjs";
const cookie = (extra = {}) => ({
  name: "__Host-campus",
  value: "synthetic-login-cookie",
  domain: "spaces.th-koeln.de",
  path: "/",
  hostOnly: true,
  httpOnly: true,
  secure: true,
  sameSite: "lax",
  session: true,
  ...extra,
});
const at = 1_800_000_000_000;
const fakeCrypto = () => {
  const key = randomBytes(32);
  return {
    async isAsyncEncryptionAvailable() {
      return true;
    },
    async encryptStringAsync(text) {
      const iv = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", key, iv);
      return Buffer.concat([
        iv,
        cipher.update(text),
        cipher.final(),
        cipher.getAuthTag(),
      ]);
    },
    async decryptStringAsync(buffer) {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        buffer.subarray(0, 12),
      );
      decipher.setAuthTag(buffer.subarray(-16));
      return {
        result: Buffer.concat([
          decipher.update(buffer.subarray(12, -16)),
          decipher.final(),
        ]).toString(),
      };
    },
  };
};
class Jar extends EventEmitter {
  constructor(values = []) {
    super();
    this.values = values;
  }
  async get(filter) {
    return this.values.filter(
      (c) => filter.session === undefined || filter.session === c.session,
    );
  }
  async set(details) {
    this.values.push({
      ...details,
      domain: details.domain || new URL(details.url).hostname,
      hostOnly: !details.domain,
      session: true,
    });
  }
  async flushStore() {
    this.flushed = true;
  }
}
async function fixture(fn) {
  const profile = await mkdtemp(
    path.join(os.tmpdir(), "context-session-test-"),
  );
  try {
    await fn(profile);
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
}
test("campus cookies retain HttpOnly Secure SameSite and host-only boundaries", () => {
  assert.deepEqual(sessionCookie(cookie()), cookie());
  const details = cookieDetails(cookie());
  assert.equal(details.url, "https://spaces.th-koeln.de/");
  assert.equal(details.domain, undefined);
  assert.equal(details.httpOnly, true);
  assert.equal(details.secure, true);
  assert.equal(details.sameSite, "lax");
  assert.equal(details.expirationDate, undefined);
  assert.equal(
    cookieDetails(
      cookie({ name: "campus", domain: ".th-koeln.de", hostOnly: false }),
    ).domain,
    ".th-koeln.de",
  );
});
test("only app campus session cookies are copied, not persistent cookies or other accounts", () => {
  for (const extra of [
    { domain: "evil-th-koeln.de" },
    { domain: "spaces.th-koeln.de.evil.test" },
    { domain: "localhost" },
    { domain: "127.0.0.1" },
    { domain: "google.com" },
    { session: false, expirationDate: at / 1000 + 1000 },
    { session: true, expirationDate: at / 1000 + 1000 },
  ])
    assert.equal(sessionCookie(cookie(extra)), null);
  for (const domain of [
    "auth.coco.study",
    "git.coco.study",
    "chat.coco.study",
    "th-koeln.sciebo.de",
    "login.th-koeln.de",
  ])
    assert.ok(sessionCookie(cookie({ domain })));
});
test("malformed cookie attributes and security prefix downgrades are refused", () => {
  for (const extra of [
    { name: "cookie\nsecret" },
    { value: "bad\u0000value" },
    { path: "bad" },
    { sameSite: "anything" },
    { sameSite: "no_restriction", secure: false },
    { secure: false },
    { domain: ".spaces.th-koeln.de", hostOnly: true },
    { hostOnly: false },
    { path: "/other" },
    { value: "a".repeat(16385) },
    { httpOnly: "true" },
  ])
    assert.equal(sessionCookie(cookie(extra)), null);
});
test("snapshots reject stale future duplicate records and secret-bearing extra fields", () => {
  const encode = (extra = {}) =>
    JSON.stringify({ version: 1, savedAt: at, cookies: [cookie()], ...extra });
  assert.equal(parseSessionSnapshot(encode(), at).length, 1);
  for (const extra of [
    { savedAt: at - 31 * 86400_000 },
    { savedAt: at + 60001 },
    { version: 2 },
    { cookies: [cookie(), cookie()] },
    { token: "secret" },
    { cookies: [{ ...cookie(), password: "secret" }] },
    { cookies: [cookie({ domain: "evil.test" })] },
  ])
    assert.throws(() => parseSessionSnapshot(encode(extra), at));
});
test("session vault uses ciphertext and file permissions, not plaintext or export fields", async () =>
  fixture(async (profile) => {
    const jar = new Jar([
        cookie(),
        cookie({
          name: "persistent",
          session: false,
          expirationDate: at / 1000 + 1000,
        }),
      ]),
      keeper = createProviderSessionKeeper({
        cookies: jar,
        crypto: fakeCrypto(),
        profile,
        now: () => at,
      });
    await keeper.start();
    const bytes = await readFile(path.join(profile, "campus-session.enc"));
    assert.ok(!bytes.toString().includes("synthetic-login-cookie"));
    assert.equal(
      (await stat(path.join(profile, "campus-session.enc"))).mode & 0o777,
      0o600,
    );
    assert.equal(keeper.status().mode, "encrypted");
    assert.ok(!JSON.stringify(keeper.status()).includes("cookie"));
    keeper.dispose();
  }));
test("restart restores the session but never overwrites a newer Chromium cookie", async () =>
  fixture(async (profile) => {
    const crypto = fakeCrypto(),
      a = new Jar([cookie()]),
      first = createProviderSessionKeeper({
        cookies: a,
        crypto,
        profile,
        now: () => at,
      });
    await first.start();
    first.dispose();
    const b = new Jar(),
      second = createProviderSessionKeeper({
        cookies: b,
        crypto,
        profile,
        now: () => at + 1000,
      });
    await second.start();
    assert.equal(second.status().restored, 1);
    assert.equal(b.values[0].value, "synthetic-login-cookie");
    second.dispose();
    const c = new Jar([
        cookie({
          value: "newer",
          session: false,
          expirationDate: at / 1000 + 5000,
        }),
      ]),
      third = createProviderSessionKeeper({
        cookies: c,
        crypto,
        profile,
        now: () => at + 2000,
      });
    await third.start();
    assert.equal(c.values.length, 1);
    assert.equal(c.values[0].value, "newer");
    assert.equal(third.status().restored, 0);
    third.dispose();
  }));
test("logout removal is persisted and cannot resurrect a session after restart", async () =>
  fixture(async (profile) => {
    const crypto = fakeCrypto(),
      jar = new Jar([cookie()]),
      keeper = createProviderSessionKeeper({
        cookies: jar,
        crypto,
        profile,
        now: () => at,
      });
    await keeper.start();
    jar.values = [];
    jar.emit("changed", {}, cookie(), "explicit", true);
    await keeper.flush();
    keeper.dispose();
    const next = new Jar(),
      again = createProviderSessionKeeper({
        cookies: next,
        crypto,
        profile,
        now: () => at + 1000,
      });
    await again.start();
    assert.equal(next.values.length, 0);
    assert.equal(again.status().restored, 0);
    again.dispose();
  }));
test("unavailable OS encryption never writes a plaintext fallback", async () =>
  fixture(async (profile) => {
    const jar = new Jar([cookie()]),
      crypto = {
        async isAsyncEncryptionAvailable() {
          return false;
        },
      },
      keeper = createProviderSessionKeeper({ cookies: jar, crypto, profile });
    await keeper.start();
    await keeper.flush();
    assert.equal(keeper.status().mode, "unavailable");
    await assert.rejects(readFile(path.join(profile, "campus-session.enc")));
    assert.equal(jar.flushed, true);
    keeper.dispose();
  }));
test("damaged ciphertext does not leak values or replace the stored recovery data", async () =>
  fixture(async (profile) => {
    const bytes = Buffer.from("invalid ciphertext");
    await writeFile(path.join(profile, "campus-session.enc"), bytes);
    const jar = new Jar(),
      keeper = createProviderSessionKeeper({
        cookies: jar,
        crypto: fakeCrypto(),
        profile,
      });
    await keeper.start();
    assert.equal(keeper.status().mode, "unavailable");
    assert.equal(jar.values.length, 0);
    assert.deepEqual(
      await readFile(path.join(profile, "campus-session.enc")),
      bytes,
    );
    keeper.dispose();
  }));
test("login popup shares the website partition with sandbox and no preload", () => {
  const preferences = providerPreferences();
  assert.equal(preferences.partition, WEBSITE_PARTITION);
  assert.equal(preferences.sandbox, true);
  assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.webSecurity, true);
  assert.equal(preferences.nodeIntegration, false);
  assert.equal(preferences.preload, undefined);
  assert.equal(
    allowProviderPopup(
      "https://login.th-koeln.de/nidp/",
      "https://spaces.th-koeln.de/",
      0,
    ),
    true,
  );
  assert.equal(
    allowProviderPopup("about:blank", "https://th-koeln.sciebo.de/", 0),
    true,
  );
});
test("popup bounds deny local URLs unsafe origins and excessive windows", () => {
  for (const url of [
    "http://example.org",
    "https://127.0.0.1/",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "data:text/html,hi",
    "https://user:password@example.org",
  ])
    assert.equal(
      allowProviderPopup(url, "https://spaces.th-koeln.de/", 0),
      false,
    );
  assert.equal(
    allowProviderPopup("about:blank", "http://127.0.0.1:4318/", 0),
    false,
  );
  assert.equal(
    allowProviderPopup(
      "https://spaces.th-koeln.de/",
      "https://spaces.th-koeln.de/",
      4,
    ),
    false,
  );
});
test("failed cookie checkpoint after logout leaves a pending marker and never revives an old login", async () =>
  fixture(async (profile) => {
    const crypto = fakeCrypto(),
      jar = new Jar([cookie()]),
      first = createProviderSessionKeeper({
        cookies: jar,
        crypto,
        profile,
        now: () => at,
      });
    await first.start();
    const encrypt = crypto.encryptStringAsync;
    crypto.encryptStringAsync = async () => {
      throw new Error("synthetic encryption failure");
    };
    jar.values = [];
    jar.emit("changed", {}, cookie(), "explicit", true);
    await first.flush();
    assert.equal(first.status().mode, "unavailable");
    first.dispose();
    crypto.encryptStringAsync = encrypt;
    const next = new Jar(),
      second = createProviderSessionKeeper({
        cookies: next,
        crypto,
        profile,
        now: () => at + 1000,
      });
    await second.start();
    assert.equal(second.status().restored, 0);
    assert.equal(next.values.length, 0);
    second.dispose();
  }));
test("expired snapshots are safely replaced instead of disabling future encrypted storage", async () =>
  fixture(async (profile) => {
    const crypto = fakeCrypto();
    await writeFile(
      path.join(profile, "campus-session.enc"),
      await crypto.encryptStringAsync(
        JSON.stringify({
          version: 1,
          savedAt: at - 31 * 86400_000,
          cookies: [cookie()],
        }),
      ),
    );
    const jar = new Jar(),
      keeper = createProviderSessionKeeper({
        cookies: jar,
        crypto,
        profile,
        now: () => at,
      });
    await keeper.start();
    assert.equal(keeper.status().mode, "encrypted");
    assert.match(keeper.status().warning, /veraltet/);
    assert.equal(jar.values.length, 0);
    jar.values = [cookie({ value: "new-login" })];
    jar.emit("changed", {}, jar.values[0], "inserted", false);
    await keeper.flush();
    keeper.dispose();
    const next = new Jar(),
      again = createProviderSessionKeeper({
        cookies: next,
        crypto,
        profile,
        now: () => at + 1000,
      });
    await again.start();
    assert.equal(next.values[0].value, "new-login");
    again.dispose();
  }));
test("startup is idempotent and a close during initialization waits for its encrypted snapshot", async () =>
  fixture(async (profile) => {
    const crypto = fakeCrypto(),
      jar = new Jar([cookie()]);
    const available = crypto.isAsyncEncryptionAvailable;
    let release;
    crypto.isAsyncEncryptionAvailable = () =>
      new Promise((resolve) => {
        release = () => resolve(true);
      });
    const keeper = createProviderSessionKeeper({
      cookies: jar,
      crypto,
      profile,
      now: () => at,
    });
    const first = keeper.start();
    assert.equal(first, keeper.start());
    let flushed = false;
    const closing = keeper.flush().then(() => {
      flushed = true;
    });
    await Promise.resolve();
    assert.equal(flushed, false);
    release();
    await first;
    await closing;
    assert.equal(jar.listenerCount("changed"), 1);
    assert.ok(
      (await readFile(path.join(profile, "campus-session.enc"))).length,
    );
    keeper.dispose();
    crypto.isAsyncEncryptionAvailable = available;
  }));
