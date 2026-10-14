import {
  createCalendarProviders,
  CalendarError,
} from "../connectors/calendar.mjs";

// This bridge is for the trusted hub only; main.mjs must enforce its main-frame check.
export function createDesktopCalendar(options = {}) {
  const providers = options.providers || createCalendarProviders(options),
    requests = new Map();
  const validID = (id) =>
    typeof id === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id);
  return async (message) => {
    if (
      !message ||
      typeof message !== "object" ||
      Array.isArray(message) ||
      Object.keys(message).some(
        (k) => !["action", "provider", "body", "id"].includes(k),
      )
    )
      throw new CalendarError(
        400,
        "invalid_request",
        "Ungültige Kalender-Anfrage.",
      );
    const { action, provider, body, id } = message;
    if (action === "cancel") {
      if (!validID(id))
        throw new CalendarError(
          400,
          "invalid_request",
          "Ungültige Anfragekennung.",
        );
      requests.get(id)?.abort();
      return;
    }
    if (action === "status" && body === undefined)
      return providers.status(provider);
    if (action === "configure") return providers.configure(provider, body);
    if (action === "disconnect" && body === undefined)
      return providers.disconnect(provider);
    if (
      ![
        "connect",
        "calendars",
        "events",
        "driveFiles",
        "driveText",
        "sync",
      ].includes(action) ||
      !validID(id) ||
      requests.has(id) ||
      (["connect", "calendars", "driveFiles"].includes(action) &&
        body !== undefined)
    )
      throw new CalendarError(
        400,
        "invalid_request",
        "Ungültige Kalender-Aktion.",
      );
    const controller = new AbortController();
    requests.set(id, controller);
    try {
      return ["events", "driveText", "sync"].includes(action)
        ? await providers[action](provider, body, controller.signal)
        : await providers[action](provider, controller.signal);
    } finally {
      requests.delete(id);
    }
  };
}
