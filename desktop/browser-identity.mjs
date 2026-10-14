// Keep Chromium's platform/WebKit identity and report its actual runtime version.
// Electron's app product token makes some sites reject an otherwise current engine.
export function chromiumUserAgent(defaultAgent, chromeVersion) {
  if (
    typeof defaultAgent !== "string" ||
    /[\r\n]/.test(defaultAgent) ||
    typeof chromeVersion !== "string" ||
    !/^\d+(?:\.\d+){3}$/.test(chromeVersion)
  )
    throw new Error("Ungültige Chromium-Browserkennung.");
  const platform = defaultAgent.match(
    /^(Mozilla\/5\.0 \([^)]+\) AppleWebKit\/[\d.]+ \(KHTML, like Gecko\))/,
  )?.[1];
  const safari = defaultAgent.match(/\bSafari\/[\d.]+\b/)?.[0];
  if (!platform || !safari)
    throw new Error("Die Chromium-Browserkennung konnte nicht ermittelt werden.");
  return `${platform} Chrome/${chromeVersion} ${safari}`;
}
