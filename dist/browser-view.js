import {createChatFilter} from './chat-filter.js';
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const icon = (name) =>
  `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${{ back: '<path d="m14 6-6 6 6 6"/>', forward: '<path d="m10 6 6 6-6 6"/>', reload: '<path d="M20 7v5h-5M19 12a7 7 0 1 1-2-5"/>', close: '<path d="m6 6 12 12M6 18 18 6"/>', plus: '<path d="M12 5v14M5 12h14"/>', go: '<path d="M5 12h14m-6-6 6 6-6 6"/>', focus: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>', restore: '<path d="M3 8h5V3m8 0v5h5M3 16h5v5m8 0v-5h5"/>', agent: '<path d="M12 3v18M3 12h18M6 6l12 12M6 18 18 6"/>', lock: '<rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>' }[name]}</svg>`;
const toolNames = {
  "spaces.th-koeln.de": "Spaces",
  "web.whatsapp.com": "WhatsApp",
  "chat.coco.study": "Mattermost",
  "git.coco.study": "GitLab",
  "th-koeln.sciebo.de": "Sciebo",
  "webmail.th-koeln.de": "TH-Mail",
};
export function browserSite(url) {
  try {
    const host = new URL(url).hostname;
    return toolNames[host] || host;
  } catch {
    return "Neuer Tab";
  }
}
let state = { active: "", tabs: [] };
export function desktopBrowserAvailable() {
  return typeof window.contextDesktop?.browser === "function";
}
export function createBrowserView({ onChange, onOpen, onError }) {
  let cleanup,
    focus = false;
  const chatFilter = createChatFilter({onChange, layout: () => window.dispatchEvent(new CustomEvent('context-browser-layout'))});
  window.addEventListener('context-chat-filter', event => chatFilter.receive(event.detail));
  const send = async (message) => {
    try {
      const response = await window.contextDesktop.browser(message);
      if (response?.error) onError(response.error);
    } catch {
      onError("Der Browser konnte den Auftrag nicht ausführen.");
    }
  };
  const setFocus = (next) => {
    focus = next;
    document.body.classList.toggle("browser-focus", focus);
    onChange();
  };
  const leaveFocus = () => {
    if (!focus) return;
    setFocus(false);
    document.querySelector("#browser-focus")?.focus({ preventScroll: true });
  };
  window.addEventListener("context-browser-state", (event) => {
    state = event.detail;
    chatFilter.setContext(state.tabs.find(tab => tab.id === state.active));
    onChange();
  });
  window.addEventListener("context-browser-open", () => onOpen());
  window.addEventListener("context-browser-address", () => {
    onOpen();
    document.querySelector("#browser-address")?.focus();
    document.querySelector("#browser-address")?.select();
  });
  window.addEventListener("context-browser-escape", () => {
    if (chatFilter.isOpen()) {void chatFilter.hide().then(() => document.querySelector('[data-cf-action="show"]')?.focus()); return;}
    if (document.querySelector("#context-agent-panel:not([hidden])"))
      window.dispatchEvent(
        new CustomEvent("context-agent-toggle", { detail: { open: false } }),
      );
    else leaveFocus();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === 'Escape' && chatFilter.isOpen()) {event.preventDefault(); void chatFilter.hide().then(() => document.querySelector('[data-cf-action="show"]')?.focus()); return;}
    if (
      event.key === "Escape" &&
      focus &&
      document.body.classList.contains("browser-active") &&
      !document.querySelector("dialog[open]")
    ) {
      event.preventDefault();
      leaveFocus();
    }
    const tab = event.target.closest?.(
      '[role="tab"][data-browser-action="select"]',
    );
    if (!tab || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
      return;
    const index = state.tabs.findIndex((t) => t.id === tab.dataset.id),
      last = state.tabs.length - 1;
    if (index < 0 || last < 0) return;
    event.preventDefault();
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? last
          : event.key === "ArrowLeft"
            ? (index + last) % (last + 1)
            : (index + 1) % (last + 1);
    const id = state.tabs[next].id;
    void send({ type: "select", id }).then(() =>
      document
        .querySelector(`[role="tab"][data-id="${CSS.escape(id)}"]`)
        ?.focus({ preventScroll: true }),
    );
  });
  document.addEventListener("submit", (event) => {
    if (event.target.id !== "browser-address-form") return;
    event.preventDefault();
    let value = event.target.elements.address.value.trim();
    if (!value) return;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) value = "https://" + value;
    void send({ type: "navigate", id: state.active, url: value });
  });
  document.addEventListener('input', event => {if (event.target.id === 'cf-search') chatFilter.search(event.target.value);});
  document.addEventListener('change', event => {
    if (event.target.matches('[data-cf-chat]')) chatFilter.change(event.target.dataset.cfChat, event.target.checked);
    if (event.target.matches('[data-cf-assistant]')) void chatFilter.setAssistant(event.target.checked);
  });
  document.addEventListener('submit', event => {
    if (!event.target.matches?.('[data-cf-add]')) return;
    event.preventDefault(); void chatFilter.addByName(event.target.elements['cf-add-name']?.value ?? new FormData(event.target).get('cf-add-name') ?? event.target.querySelector('input')?.value);
  });
  document.addEventListener("click", (event) => {
    const filterButton = event.target.closest('[data-cf-action]');
    if (filterButton) {
      if (filterButton.dataset.cfAction === 'show' && !chatFilter.isOpen()) {
        window.dispatchEvent(new CustomEvent('context-agent-toggle', {detail:{open:false}}));
      }
      chatFilter.click(filterButton.dataset.cfAction);
      if (chatFilter.isOpen()) document.querySelector('#cf-search')?.focus({preventScroll:true});
      return;
    }
    const local = event.target.closest("[data-browser-ui]");
    if (local?.dataset.browserUi === "focus") {
      setFocus(!focus);
      return;
    }
    const button = event.target.closest("[data-browser-action]");
    if (!button) return;
    void send({
      type: button.dataset.browserAction,
      id: button.dataset.id || state.active,
      ...(button.dataset.url ? { url: button.dataset.url } : {}),
    });
  });
  function render() {
    const t = state.tabs.find((t) => t.id === state.active);
    return `<div class="browser-surface"><header class="browser-heading"><div><h1>Browser</h1><span class="browser-heading-caption">Deine Tools an einem Ort.</span></div>${desktopBrowserAvailable() ? `<button id="browser-focus" type="button" class="browser-focus-button" data-browser-ui="focus" aria-pressed="${focus}" title="${focus ? "Fokusansicht verlassen · Esc" : "Seitenleiste ausblenden und mehr Platz schaffen"}">${icon(focus ? "restore" : "focus")}<span>${focus ? "Fokus verlassen" : "Fokusansicht"}</span></button>` : ""}</header>${
      !desktopBrowserAvailable()
        ? `<div class="empty-state"><h2>Öffne Context Browser auf deinem Mac.</h2><p>Die Mac-App bietet echte Browser-Tabs und deine angemeldeten Tools. Fremde Seiten lassen sich in dieser Webansicht nicht einbetten.</p></div>`
        : `<div class="browser-workbench ${chatFilter.isOpen()?'chat-filter-open':''}"><section class="context-browser" aria-label="Browser"><div class="browser-tabbar"><div class="browser-tabs" role="tablist" aria-label="Geöffnete Webseiten">${state.tabs.map((tab) => `<div class="browser-tab ${tab.id === state.active ? "selected" : ""}"><button type="button" role="tab" aria-selected="${tab.id === state.active}" tabindex="${tab.id === state.active ? "0" : "-1"}" data-browser-action="select" data-id="${tab.id}" title="${esc((tab.title || "Neuer Tab") + " · " + browserSite(tab.url))}"><span class="browser-tab-site" aria-hidden="true">${esc(browserSite(tab.url).slice(0, 2).toUpperCase())}</span><span class="browser-tab-title">${esc(tab.title || "Neuer Tab")}</span></button><button type="button" class="browser-tab-close" aria-label="Tab ${esc(tab.title || browserSite(tab.url))} schließen" data-browser-action="close" data-id="${tab.id}">${icon("close")}</button></div>`).join("")}</div><button type="button" class="browser-new-tab" data-browser-action="new" aria-label="Neuen Browser-Tab öffnen" title="Neuer Tab · ⌘T">${icon("plus")}</button></div><div class="browser-controls"><div class="browser-history-controls"><button type="button" aria-label="Zurück" title="Zurück" data-browser-action="back" ${!t?.back ? "disabled" : ""}>${icon("back")}</button><button type="button" aria-label="Vorwärts" title="Vorwärts" data-browser-action="forward" ${!t?.forward ? "disabled" : ""}>${icon("forward")}</button><button type="button" aria-label="${t?.loading ? "Laden anhalten" : "Seite neu laden"}" title="${t?.loading ? "Laden anhalten" : "Neu laden · ⌘R"}" data-browser-action="${t?.loading ? "stop" : "reload"}" ${!t ? "disabled" : ""}>${icon(t?.loading ? "close" : "reload")}</button></div><form id="browser-address-form"><label class="sr-only" for="browser-address">Webadresse</label><span class="browser-address-icon" title="HTTPS-Verbindung" aria-hidden="true">${icon("lock")}</span><input id="browser-address" name="address" type="text" inputmode="url" autocomplete="off" spellcheck="false" placeholder="Webadresse eingeben" value="${esc(t?.url || "")}"><button type="submit" aria-label="Adresse öffnen" title="Adresse öffnen">${icon("go")}</button></form>${chatFilter.renderButton()}<button id="browser-assistant-toggle" type="button" class="browser-assistant-button" data-action="context-agent" aria-label="Kontextassistent öffnen" title="Context Assistent · ⌘⇧K">${icon("agent")}<span>Assistent</span></button></div>${t?.error ? `<div class="browser-error" role="alert">${esc(t.error)}</div>` : ""}<div id="browser-page-slot" class="browser-page-slot">${
            !t
              ? `<div class="browser-start"><span class="ki-welcome-mark" aria-hidden="true">${icon("plus")}</span><h2>Womit möchtest du weiterarbeiten?</h2><p>Öffne dein Tool oder gib eine Webadresse ein.</p><div>${[
                  ["Spaces", "https://spaces.th-koeln.de/"],
                  ["Mattermost", "https://chat.coco.study/"],
                  ["GitLab", "https://git.coco.study/"],
                  ["Sciebo", "https://th-koeln.sciebo.de/"],
                ]
                  .map(
                    ([name, url]) =>
                      `<button class="button secondary" data-browser-action="new" data-url="${url}">${name} ↗</button>`,
                  )
                  .join("")}</div></div>`
              : ""
          }</div><div class="browser-footer"><span class="browser-page-status" role="status">${t?.loading ? "Seite wird geladen …" : t ? esc(browserSite(t.url)) + " · HTTPS" : "Kein Tab geöffnet"}</span><span class="browser-session-status">${state.session?.warning ? "Sitzungsspeicher prüfen" : state.session?.mode === "encrypted" ? "Sitzung lokal gesichert" : "Website-Sitzung lokal"}</span><span class="browser-shortcuts">⌘L Adresse · ⌘T Neuer Tab</span></div></section>${chatFilter.renderPanel()}<aside id="browser-agent-slot"></aside></div><details class="browser-note"><summary>Browserdaten &amp; Datenschutz${state.session?.warning ? " · Hinweis" : ""}</summary><p>${state.session?.mode === "encrypted" ? "Sitzungscookies für TH-Dienste werden verschlüsselt lokal gesichert. " : ""}${state.session?.warning ? esc(state.session.warning) + " " : ""}Websites und Assistenten-Chats sind getrennt gespeichert. Beim Besuch erhält die Website deine IP-Adresse und ihre eigenen Sitzungsdaten. Kamera, Mikrofon, Standort und Website-Benachrichtigungen sind gesperrt. Keine eingebauten Analyse-Tracker.</p></details>`
    }</div>`;
  }
  function mount() {
    cleanup?.();
    cleanup = undefined;
    document.body.classList.toggle("browser-focus", focus);
    const slot = document.querySelector("#browser-page-slot");
    if (!desktopBrowserAvailable() || !slot) return;
    let last = "",
      pending = false,
      disposed = false;
    const update = () => {
      const r = slot.getBoundingClientRect(),
        blocked =
          !!document.querySelector("dialog[open]") ||
          document.body.classList.contains("nav-open");
      const visible =
        !!state.active &&
        slot.isConnected &&
        r.width > 0 &&
        r.height > 0 &&
        !blocked;
      const current =
        visible ||
        (!blocked &&
          !!state.active &&
          !!document.querySelector(".browser-workbench.agent-open, .browser-workbench.chat-filter-open"));
      const message = {
        type: "frame",
        owner: "browser",
        visible,
        current,
        focus,
        rect: { x: r.x, y: r.y, width: r.width, height: r.height },
        clip: { x: 0, y: 0, width: innerWidth, height: innerHeight },
      };
      const value = JSON.stringify(message);
      if (value !== last) {
        last = value;
        void send(message);
      }
    };
    const schedule = () => {
      if (pending) return;
      pending = true;
      queueMicrotask(() => {
        pending = false;
        if (!disposed) update();
      });
    };
    const resize = new ResizeObserver(schedule);
    resize.observe(slot);
    const mutation = new MutationObserver(schedule);
    document
      .querySelectorAll("dialog")
      .forEach((d) =>
        mutation.observe(d, { attributes: true, attributeFilter: ["open"] }),
      );
    mutation.observe(document.body, {
      attributes: true,
      attributeFilter: ["class"],
    });
    window.addEventListener("resize", schedule);
    window.addEventListener("context-agent-layout", schedule);
    window.addEventListener("context-browser-layout", schedule);
    document.addEventListener("scroll", schedule, true);
    cleanup = () => {
      disposed = true;
      resize.disconnect();
      mutation.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("context-agent-layout", schedule);
      window.removeEventListener("context-browser-layout", schedule);
      document.removeEventListener("scroll", schedule, true);
    };
    schedule();
  }
  return {
    render,
    mount,
    hide() {
      const wasMounted=!!cleanup;
      void chatFilter.hide();
      cleanup?.();
      cleanup = undefined;
      focus = false;
      document.body.classList.remove("browser-focus");
      if (wasMounted&&desktopBrowserAvailable()) void send({ type: "detach",owner:"browser" });
    },
  };
}
if (typeof window !== "undefined" && window.contextDesktop?.onEvent)
  window.contextDesktop.onEvent((payload) => {
    if (
      [
        "context-chat-filter",
        "context-browser-state",
        "context-browser-open",
        "context-browser-address",
        "context-browser-escape",
        "context-browser-page",
        "context-agent-browser",
        "context-agent-toggle",
        "context-browser-layout",
      ].includes(payload?.type)
    )
      window.dispatchEvent(
        new CustomEvent(payload.type, { detail: payload.detail }),
      );
  });
