let csrfToken = "";
let onUnauthorized = () => {};
let refreshing = null;

export function setCsrf(value) {
  csrfToken = value || "";
}

export function setUnauthorizedHandler(handler) {
  onUnauthorized = handler;
}

function authHeaders(method, extra = {}) {
  const headers = { ...extra };
  if (method !== "GET" && method !== "HEAD" && csrfToken) headers["X-CSRF-Token"] = csrfToken;
  return headers;
}

function canRefresh(path) {
  return path !== "/api/auth/refresh" && !path.startsWith("/api/auth/password");
}

export function refreshSession() {
  if (!refreshing) {
    const refresh = async () => {
      // Cookies are shared between tabs. Re-check after obtaining the lock so
      // only one tab rotates a refresh token; replay detection stays strict.
      const current = await fetch("/api/me", { credentials: "same-origin", cache: "no-store" });
      if (current.ok) {
        const data = await current.json();
        setCsrf(data.csrfToken);
        return data;
      }
      if (current.status !== 401) throw new Error("The pantry is unavailable. Try again.");
      const response = await fetch("/api/auth/refresh", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(data.error || "Sign in again.");
        error.status = response.status;
        throw error;
      }
      setCsrf(data.csrfToken);
      return data;
    };
    const locks = globalThis.navigator?.locks;
    refreshing = (locks ? locks.request("aim-session-refresh", refresh) : refresh()).finally(() => {
      refreshing = null;
    });
  }
  return refreshing;
}

export async function api(path, { method = "GET", body, retried = false, headers: extra = {} } = {}) {
  const headers = authHeaders(method, extra);
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(path, {
    method,
    headers,
    credentials: "same-origin",
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const type = response.headers.get("content-type") || "";
  if (response.ok && (type.includes("text/csv") || response.headers.get("content-disposition")?.startsWith("attachment"))) {
    return response.blob();
  }
  const data = await response.json().catch(() => ({}));
  if ((response.status === 401 || (response.status === 403 && data.code === "csrf")) && !retried && canRefresh(path)) {
    try {
      await refreshSession();
      return api(path, { method, body, retried: true, headers: extra });
    } catch (error) {
      if (error.status === 401) { setCsrf(""); onUnauthorized(); }
      throw error;
    }
  } else if (response.status === 401) {
    setCsrf("");
    onUnauthorized();
  }
  if (!response.ok) {
    const error = new Error(data.error || "The request failed.");
    error.threadId = data.threadId || "";
    throw error;
  }
  return data;
}

export async function streamChat(body, onEvent, retried = false) {
  const headers = authHeaders("POST", { "Content-Type": "application/json", Accept: "text/event-stream" });
  const response = await fetch("/api/chat", {
    method: "POST",
    headers,
    credentials: "same-origin",
    body: JSON.stringify({ ...body, stream: true }),
  });
  const type = response.headers.get("content-type") || "";
  if (!type.includes("text/event-stream")) {
    const data = await response.json().catch(() => ({}));
    if ((response.status === 401 || (response.status === 403 && data.code === "csrf")) && !retried) {
      try {
        await refreshSession();
        return streamChat(body, onEvent, true);
      } catch (error) {
        if (error.status === 401) { setCsrf(""); onUnauthorized(); }
        throw error;
      }
    } else if (response.status === 401) {
      setCsrf("");
      onUnauthorized();
    }
    if (!response.ok) {
      const error = new Error(data.error || "The request failed.");
      error.threadId = data.threadId || "";
      throw error;
    }
    onEvent("done", data);
    return;
  }
  if (!response.body) throw new Error("The assistant could not reply.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let threadId = "";
  let finished = false;
  const handle = (raw) => {
    let eventName = "message";
    const dataLines = [];
    for (const line of raw.split("\n")) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) return;
    const data = JSON.parse(dataLines.join(""));
    if (data.threadId) threadId = data.threadId;
    if (eventName === "done" || eventName === "error") finished = true;
    onEvent(eventName, data);
  };
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() || "";
    for (const chunk of chunks) {
      if (!chunk.trim()) continue;
      handle(chunk);
      await new Promise((resolve) => setTimeout(resolve, 16));
    }
  }
  if (buffer.trim()) handle(buffer);
  if (!finished) {
    const error = new Error("The assistant stopped before the reply finished.");
    error.threadId = threadId;
    throw error;
  }
}

export function rupee(value) {
  if (value == null || value === "") return "—";
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 2,
  }).format(Number(value));
}

export function indiaDate(iso) {
  if (!iso) return "—";
  const [year, month, day] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

export function monthLabel(month) {
  const [year, mon] = month.split("-").map(Number);
  return new Intl.DateTimeFormat("en-IN", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, mon - 1, 1)));
}

export function statusLabel(status) {
  if (status === "due") return "Due";
  if (status === "not_enough_history") return "Not enough history";
  return "On track";
}
