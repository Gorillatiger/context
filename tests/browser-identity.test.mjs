import test from "node:test";
import assert from "node:assert/strict";
import { chromiumUserAgent } from "../desktop/browser-identity.mjs";

const prefix =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)";
const chrome = "152.0.7942.32";
const expected = `${prefix} Chrome/${chrome} Safari/537.36`;

test("website identity removes app tokens including Electron's space-free product name", () => {
  for (const product of [
    "ContextBrowser/0.10.1",
    "Context Browser/0.10.1",
    "coco-context-hub/0.10.1",
    "A-Future-App-Name/1.0.0",
  ]) {
    const raw = `${prefix} ${product} Chrome/152.0.0.0 Electron/44.7.0 Safari/537.36`;
    assert.equal(chromiumUserAgent(raw, chrome), expected);
  }
});

test("website identity reports the real runtime version and remains stable when reapplied", () => {
  assert.equal(chromiumUserAgent(expected, chrome), expected);
  assert.equal(
    chromiumUserAgent(expected, "151.0.7900.0"),
    `${prefix} Chrome/151.0.7900.0 Safari/537.36`,
  );
});

test("Chromium platform information is preserved on other supported platforms", () => {
  for (const platform of ["Windows NT 10.0; Win64; x64", "X11; Linux x86_64"]) {
    const raw = expected.replace("Macintosh; Intel Mac OS X 10_15_7", platform);
    assert.equal(chromiumUserAgent(raw, chrome), raw);
  }
});

test("invalid runtime identities fail instead of sending a malformed header", () => {
  for (const [raw, version] of [
    [null, chrome],
    [expected + "\r\nX-Injected: true", chrome],
    ["ContextBrowser/1.0.0", chrome],
    [expected, undefined],
    [expected, "152"],
    [expected, "152.0.0.0\n"],
  ])
    assert.throws(() => chromiumUserAgent(raw, version));
});
