import { createSpacesSearch } from '../connectors/spaces-search.mjs';

/** Use the existing provider partition; never export or copy its cookies. */
export function createDesktopSpacesSearch({ providerSession, now } = {}) {
  if (typeof providerSession?.fetch !== 'function') throw new TypeError('Invalid Spaces browser session.');
  return createSpacesSearch({
    fetchImpl: async (url, options) => {
      const target = new URL(url);
      if (target.origin !== 'https://spaces.th-koeln.de' || target.username || target.password || target.hash ||
          options.method !== 'GET' || options.redirect !== 'manual') throw new TypeError('Invalid Spaces browser request.');
      const response = await providerSession.fetch(url, { ...options, credentials: 'include', bypassCustomProtocolHandlers: true });
      // Electron documents Response.url/type as incorrect for Session.fetch.
      // The core still checks manual redirect status/flags, MIME and body bounds;
      // only this native transport binds metadata to its already validated URL.
      return { url, status: response.status, ok: response.ok, redirected: response.redirected,
        headers: response.headers, body: response.body };
    },
    ...(now ? { now } : {})
  });
}
