// Static, bundled brand assets. No favicon service, remote request or user URL.
const logos = Object.freeze({
  spaces: ['spaces'], mattermost: ['mattermost'], gitlab: ['gitlab'],
  sciebo: ['sciebo'], whatsapp: ['whatsapp'], signal: ['signal'],
  miro: ['miro'], zoom: ['zoom'], webmail: ['webmail'], mail: ['webmail'],
  obsidian: ['obsidian'], openrouter: ['openrouter'], kiconnect: ['kiconnect'],
  outlook: ['outlook'], google: ['googlecalendar', 'googledrive'],
  'github-submissions': ['github'], projects: ['github', 'gitlab']
});
const shapes = Object.freeze({
  'calendar-import': '<rect x="4" y="5" width="16" height="16" rx="2"/><path d="M8 3v4m8-4v4M4 11h16m-8 3v5m-3-3 3 3 3-3"/>',
  'calendar-photo': '<rect x="3" y="5" width="18" height="16" rx="2"/><circle cx="8" cy="10" r="1.5"/><path d="m4 19 5-5 3 3 4-6 5 8"/>',
  inventory: '<path d="m3 7 9-4 9 4-9 4Z"/><path d="M3 7v10l9 4 9-4V7m-9 4v10"/>',
  bookmarks: '<path d="M6 3h12v18l-6-4-6 4Z"/>',
  context: '<path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8m0-12.8L5.6 18.4"/>',
  web: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z"/>'
});
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function brandClass(id) {
  const name = Object.hasOwn(logos, id) ? logos[id][0] : '';
  return name ? `service-${name}` : '';
}
export function brandLogo(id, {small = false, color = 'violet', fallback = 'LK'} = {}) {
  const assets = Object.hasOwn(logos, id) ? logos[id] : null;
  const palette = ['violet','blue','peach','green','yellow'].includes(color) ? color : 'violet';
  const size = small ? ' small' : '';
  if (assets) return `<span class="tool-icon brand-logo brand-${assets[0]}${assets.length > 1 ? ' brand-pair' : ''}${size}" aria-hidden="true">${assets.map(asset => `<img src="./brands/${asset}.svg" alt="" width="40" height="40" decoding="async" draggable="false">`).join('')}</span>`;
  if (Object.hasOwn(shapes, id)) return `<span class="tool-icon module-icon ${palette}${size}" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${shapes[id]}</svg></span>`;
  return `<span class="tool-icon ${palette}${size}" aria-hidden="true">${esc(fallback)}</span>`;
}
