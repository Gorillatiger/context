// Miro REST API v2, boards:read. Never expose an arbitrary provider proxy.
// https://developers.miro.com/reference/get-specific-board-1
// https://developers.miro.com/reference/get-items-1
export const MIRO_SERVICE = Object.freeze({
  label: 'Miro', providers: ['miro'], origin: 'https://api.miro.com',
  defaults: {boardRead: true},
});

export function miroProxyRoute(method, value) {
  if (method !== 'GET' || typeof value !== 'string') return null;
  const match = /^\/v2\/boards\/([^/]+)(\/items)?$/.exec(value);
  if (!match) return null;
  let board;
  try { board = decodeURIComponent(match[1]); } catch { return null; }
  return /^[a-zA-Z0-9_=-]{4,100}$/.test(board) ? 'boardRead' : null;
}

export function miroProxyParams(path, params = {}) {
  const items = path.endsWith('/items');
  if (Object.keys(params).some(key => !items || !['limit','cursor'].includes(key))) return false;
  if (params.limit !== undefined && !/^(?:[1-4][0-9]|50)$/.test(String(params.limit))) return false;
  return params.cursor === undefined || typeof params.cursor === 'string' &&
    params.cursor.length > 0 && params.cursor.length <= 2048 && !/[\x00-\x20\x7f]/.test(params.cursor);
}
