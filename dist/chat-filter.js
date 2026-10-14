const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function whatsappFilterURL(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && u.hostname === 'web.whatsapp.com' && !u.port && !u.username && !u.password; }
  catch { return false; }
}
export function chatFilterSnapshot(value) {
  const rows = input => Array.isArray(input) ? [...new Map(input.slice(0,500).flatMap(row => {
    if (!row || typeof row.id !== 'string' || !row.id || row.id.length > 300 || /[\u0000-\u001f]/.test(row.id) || typeof row.title !== 'string' || !row.title.trim()) return [];
    return [[row.id, {id:row.id, title:row.title.replace(/[\u0000-\u001f]/g,' ').trim().slice(0,160), identity:row.identity === 'dom' ? 'dom' : 'name'}]];
  })).values()] : [];
  return {supported:value?.supported === true, enabled:value?.enabled === true, pickerOpen:value?.pickerOpen === true,
    selected:rows(value?.selected).slice(0,100), chats:rows(value?.chats), warning:typeof value?.warning === 'string' ? value.warning.slice(0,1000) : '',
    storage:value?.storage === 'encrypted' ? 'encrypted' : 'session'};
}

/* Chat names live in this controller's memory; only the native, encrypted
   preference store saves the user's explicit selection. Never workspace/AI. */
export function createChatFilter({bridge = globalThis.window?.contextDesktop, onChange = () => {}, layout = () => {}} = {}) {
  let snapshot = chatFilterSnapshot(), context = '', supported = false, open = false, busy = false, search = '', error = '', epoch = 0;
  let draft = new Map(), disposed = false, cancelChain = Promise.resolve();
  const available = () => typeof bridge?.chatFilter === 'function';
  const notify = () => { if (!disposed) {onChange(); layout();} };
  async function request(message) {
    const reply = await bridge.chatFilter(message);
    if (reply?.ok === false || reply?.error) throw new Error(reply.error || 'Die Chat-Auswahl konnte nicht aktualisiert werden.');
    return chatFilterSnapshot(reply?.ok === true ? reply.value : reply);
  }
  function isCurrent(token) { return !disposed && token === epoch; }
  function read(next) { snapshot = next; }
  function releasePicker() {
    if (!available()) return Promise.resolve();
    cancelChain = cancelChain.catch(() => {}).then(() => request({op:'picker',open:false})).catch(() => {});
    return cancelChain;
  }
  async function refresh() {
    if (!available() || !supported || busy) return;
    const token = epoch; busy = true; error = ''; notify();
    try { const next = await request({op:'discover'}); if (isCurrent(token)) read(next); }
    catch (e) { if (isCurrent(token)) error = e.message; }
    finally { if (isCurrent(token)) {busy = false; notify();} }
  }
  async function show() {
    if (!available() || !supported || busy) return;
    const token = epoch; open = true; busy = true; search = ''; error = ''; notify();
    try {
      await cancelChain;
      const next = await request({op:'picker',open:true});
      if (!isCurrent(token) || !open) {if (!open) await releasePicker(); return;}
      read(next); draft = new Map(next.selected.map(row => [row.id,row]));
      const found = await request({op:'discover'});
      if (isCurrent(token) && open) read(found);
    } catch (e) { if (isCurrent(token)) error = e.message; }
    finally { if (isCurrent(token)) {busy = false; notify();} }
  }
  async function hide() {
    if (!open) return;
    open = false; busy = false; epoch += 1; error = ''; notify(); await releasePicker();
  }
  async function apply() {
    if (!open || busy || !draft.size || !supported) return;
    const token = epoch; busy = true; error = ''; notify();
    try {
      const next = await request({op:'set',enabled:true,selected:[...draft.values()]});
      if (!isCurrent(token)) return;
      read(next);
      await request({op:'picker',open:false});
      if (isCurrent(token)) open = false;
    } catch (e) { if (isCurrent(token)) error = e.message; }
    finally { if (isCurrent(token)) {busy = false; notify();} }
  }
  async function allChats() {
    if (busy || !available() || !supported) return;
    const token = epoch; busy = true; error = ''; notify();
    try {
      const next = await request({op:'set',enabled:false,selected:snapshot.selected});
      if (isCurrent(token)) {read(next); await request({op:'picker',open:false}); if (isCurrent(token)) open = false;}
    }
    catch (e) {if (isCurrent(token)) error = e.message;}
    finally {if (isCurrent(token)) {busy = false; notify();}}
  }
  function choices() {return [...new Map([...snapshot.chats,...draft.values()].map(row => [row.id,row])).values()];}
  function renderButton() {
    if (!supported || !available()) return '';
    return `<button type="button" class="browser-filter-button" data-cf-action="show" aria-pressed="${snapshot.enabled}" aria-expanded="${open}" aria-controls="chat-filter-panel" title="CoCo-Chats für diesen Browser auswählen"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M4 5h16l-6 7v6l-4 2v-8Z"/></svg><span>CoCo-Fokus${snapshot.enabled?' · '+snapshot.selected.length:''}</span></button>`;
  }
  function renderPanel() {
    if (!open || !supported) return '';
    const rows = choices().filter(row => row.title.toLocaleLowerCase('de').includes(search.toLocaleLowerCase('de')));
    return `<aside id="chat-filter-panel" class="cf-panel" aria-label="CoCo-Chat-Auswahl"><div class="cf-toolbar"><div><span class="small-label">NUR IN DIESEM BROWSER</span><h2>Deine CoCo-Chats</h2></div><button type="button" class="icon-button" data-cf-action="close" aria-label="Chat-Auswahl schließen">×</button></div><p class="cf-status">Wähle deine Kurschats und Gruppen. Während der Auswahl siehst du alle WhatsApp-Chats.</p><label class="cf-search" for="cf-search">Chats finden<input id="cf-search" type="search" maxlength="160" placeholder="Kurs oder Chatname …" value="${esc(search)}" autocomplete="off"></label><div class="cf-actions"><button type="button" class="text-link" data-cf-action="refresh" ${busy?'disabled':''}>${busy?'Wird gelesen …':'Aktualisieren'}</button><button type="button" class="text-link" data-cf-action="suggest" ${busy?'disabled':''}>CoCo markieren</button></div><p class="cf-status" role="status">${draft.size} ausgewählt · ${snapshot.chats.length} gefundene Chats</p>${error?`<p class="cf-status cf-error" role="alert">${esc(error)}</p>`:''}<div class="cf-chat-list">${rows.map(row => `<label class="cf-chat-row"><input id="cf-chat-${esc(encodeURIComponent(row.id))}" type="checkbox" data-cf-chat="${esc(row.id)}" ${draft.has(row.id)?'checked':''} ${busy?'disabled':''}><span><strong>${esc(row.title)}</strong><small>${snapshot.chats.some(chat=>chat.id===row.id)?'In diesem Browser gefunden':'Gespeicherte Auswahl'}</small></span></label>`).join('')||`<p class="cf-empty">${busy?'WhatsApp wird geprüft …':search?'Kein passender Chat in der geladenen Liste.':'Scrolle oder suche in WhatsApp und aktualisiere danach diese Liste.'}</p>`}</div>${snapshot.warning?(snapshot.chats.length?`<details class="cf-privacy cf-warning"><summary>Hinweise zur Chat-Zuordnung</summary><p>${esc(snapshot.warning)}</p></details>`:`<p class="cf-status cf-warning">${esc(snapshot.warning)}</p>`):''}<details class="cf-privacy"><summary>Lokaler Filter &amp; Datenschutz</summary><p>${snapshot.storage==='encrypted'?'Deine Auswahl wird verschlüsselt auf diesem Gerät gespeichert.':'Die Auswahl bleibt in dieser Sitzung; verschlüsseltes Speichern ist derzeit nicht verfügbar.'} Für den Filter werden nur Chatnamen und deine Auswahl gelesen. Keine Nachrichtentexte, Bilder oder Übermittlung an die KI. Weitere Chats erscheinen nach Scrollen oder Suchen in WhatsApp.</p></details><div class="cf-actions cf-footer"><button type="button" class="button secondary" data-cf-action="all" ${busy?'disabled':''}>Alle Chats</button><button type="button" class="button primary" data-cf-action="apply" ${busy||!draft.size?'disabled':''}>${busy?'Bitte kurz warten …':'Fokus aktivieren'}</button></div></aside>`;
  }
  return {
    renderButton, renderPanel, isOpen:() => open, available,
    state:() => ({...snapshot,open,busy,search,error,draft:[...draft.values()]}),
    setContext(tab) {
      const next = String(tab?.id || '') + '|' + String(tab?.url || '') + '|' + String(tab?.loading === true);
      if (next === context || disposed) return;
      const wasOpen = open;
      context = next; epoch += 1; supported = whatsappFilterURL(tab?.url); open = false; busy = false; error = ''; search = ''; draft.clear();
      snapshot = chatFilterSnapshot(); if (wasOpen) void releasePicker();
      if (!available() || !supported) return;
      const token = epoch;
      void request({op:'status'}).then(next => {if (isCurrent(token)) {read(next); notify();}}).catch(() => {});
    },
    receive(detail) {
      if (disposed || !supported || busy) return;
      const next = chatFilterSnapshot(detail);
      if (open && !next.pickerOpen) {open = false; epoch += 1;}
      if (JSON.stringify(next) === JSON.stringify(snapshot)) return;
      read(next); notify();
    },
    click(action) {
      if (action === 'show') void (open ? hide() : show());
      else if (action === 'close') void hide();
      else if (action === 'refresh') void refresh();
      else if (action === 'apply') void apply();
      else if (action === 'all') void allChats();
      else if (action === 'suggest' && open && !busy) {
        for (const row of snapshot.chats) if (/\b(?:co\s*co|code\s*(?:&|und|and)\s*context)\b/iu.test(row.title)) draft.set(row.id,row);
        notify();
      }
    },
    change(id, checked) {
      if (!open || busy) return;
      const row = choices().find(row => row.id === id); if (!row) return;
      if (checked && !draft.has(id) && draft.size >= 100) {error = 'Du kannst bis zu 100 Chats auswählen.'; notify(); return;}
      if (checked) draft.set(id,row); else draft.delete(id); error = ''; notify();
    },
    search(value) {search = String(value).slice(0,160); notify();},
    hide, dispose() {disposed = true; epoch += 1; open = false; void releasePicker(); draft.clear(); snapshot = chatFilterSnapshot();}
  };
}
