const UAT_TRACKER_STATE = {
  settings: null,
  enabled: false,
  session: null,
  tab: {},
  pageInstanceId: "",
  events: [],
  networkEvents: [],
  errors: []
};

const SECRET_KEY_PATTERNS = [
  /authorization/i,
  /cookie/i,
  /set-cookie/i,
  /api[-_]?key/i,
  /access[-_]?token/i,
  /refresh[-_]?token/i,
  /password/i,
  /secret/i
];

init();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "CLEAR_PAGE_RECORDING") return;

  resetRecordedActivity()
    .then(() => sendResponse({ ok: true }))
    .catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));

  return true;
});

async function init() {
  const config = await sendMessage({ type: "GET_SETTINGS" });
  const settings = config.settings;
  UAT_TRACKER_STATE.settings = settings;
  UAT_TRACKER_STATE.tab = config.tab || {};
  UAT_TRACKER_STATE.pageInstanceId = createPageInstanceId();
  UAT_TRACKER_STATE.enabled =
    isAllowedLocation(location.href, settings.allowedOrigins || []) ||
    Boolean(UAT_TRACKER_STATE.tab.inheritedTracking);

  if (!UAT_TRACKER_STATE.enabled) return;

  UAT_TRACKER_STATE.session = await getOrCreateSession();
  UAT_TRACKER_STATE.session = await refreshSessionIdentity(UAT_TRACKER_STATE.session);
  injectNetworkHook();
  bindUiCapture();
  bindErrorCapture();
  bindNetworkCapture();
  mountDraggableTracker();
  recordEvent("page_view", { url: location.href, title: document.title });
}

function createPageInstanceId() {
  return crypto.randomUUID?.() || `page-${Date.now()}-${randomHex(2)}`;
}

function isAllowedLocation(url, allowedOrigins) {
  return allowedOrigins.some(origin => {
    const clean = String(origin || "").trim().replace(/\/+$/g, "");
    return clean && url.startsWith(clean);
  });
}

async function getOrCreateSession() {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const saved = await chrome.storage.local.get(["session"]);

  if (saved.session?.sessionId && Date.now() - saved.session.createdAt < 24 * 60 * 60 * 1000) {
    return saved.session;
  }

  const session = {
    sessionId: `UAT-${today}-${randomHex(3)}`,
    createdAt: Date.now(),
    startedAt: new Date().toISOString(),
    applicationUrl: location.href,
    userIdentifier: getUserIdentifier(),
    browserInfo: {
      userAgent: navigator.userAgent,
      language: navigator.language,
      platform: navigator.platform
    }
  };

  await chrome.storage.local.set({ session });
  return session;
}

async function refreshSessionIdentity(session) {
  const nextSession = {
    ...session,
    applicationUrl: location.href,
    userIdentifier: getUserIdentifier() || session.userIdentifier || ""
  };

  await chrome.storage.local.set({ session: nextSession });
  return nextSession;
}

function getUserIdentifier() {
  const configuredUser = String(UAT_TRACKER_STATE.settings?.userIdentifier || "").trim();
  if (configuredUser) return configuredUser;

  const keys = [
    "user",
    "currentUser",
    "profile",
    "account",
    "auth",
    "loggedInUser",
    "username",
    "email"
  ];

  for (const storage of [localStorage, sessionStorage]) {
    for (const key of keys) {
      const value = readStorageValue(storage, key);
      const user = extractUserIdentifier(value);
      if (user) return user;
    }
  }

  return "";
}

function readStorageValue(storage, key) {
  try {
    return storage.getItem(key);
  } catch {
    return "";
  }
}

function extractUserIdentifier(value) {
  if (!value) return "";
  const clean = String(value).trim();

  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) return clean;
  if (/^[A-Za-z0-9._-]{3,80}$/.test(clean) && !clean.includes("{")) return clean;

  try {
    const parsed = JSON.parse(clean);
    return findUserIdentifier(parsed);
  } catch {
    const emailMatch = clean.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    return emailMatch?.[0] || "";
  }
}

function findUserIdentifier(value) {
  if (!value || typeof value !== "object") return "";
  const preferredKeys = ["email", "username", "userName", "name", "displayName", "login", "sub"];

  for (const key of preferredKeys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }

  for (const nested of Object.values(value)) {
    const candidate = findUserIdentifier(nested);
    if (candidate) return candidate;
  }

  return "";
}

function randomHex(bytes) {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return Array.from(buffer).map(item => item.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function injectNetworkHook() {
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("injected/network-hook.js");
  script.onload = () => script.remove();
  (document.documentElement || document.head).appendChild(script);
}

function bindUiCapture() {
  document.addEventListener("click", event => {
    const target = event.target;
    recordEvent("click", {
      element: getElementSummary(target),
      page: location.pathname
    });
  }, true);

  document.addEventListener("change", event => {
    const target = event.target;
    recordEvent("change", {
      element: getElementSummary(target),
      value: getSafeElementValue(target),
      page: location.pathname
    });
  }, true);

  document.addEventListener("input", debounce(event => {
    const target = event.target;
    recordEvent("input", {
      element: getElementSummary(target),
      value: getSafeElementValue(target),
      page: location.pathname
    });
  }, 500), true);

  window.addEventListener("popstate", () => {
    recordEvent("navigation", { url: location.href, page: location.pathname });
  });
}

function bindErrorCapture() {
  window.addEventListener("error", event => {
    recordError("window_error", {
      message: event.message,
      source: event.filename,
      line: event.lineno,
      column: event.colno
    });
  });

  window.addEventListener("unhandledrejection", event => {
    recordError("unhandled_rejection", {
      message: String(event.reason?.message || event.reason || "Unhandled promise rejection")
    });
  });
}

function bindNetworkCapture() {
  window.addEventListener("message", event => {
    if (event.source !== window || event.data?.type !== "UAT_NETWORK_EVENT") return;
    recordNetworkEvent(event.data.payload);
  });
}

function recordEvent(type, data) {
  pushRolling("events", {
    sessionId: UAT_TRACKER_STATE.session.sessionId,
    timestamp: new Date().toISOString(),
    type,
    url: location.href,
    ...getPageContext(),
    data: maskSensitive(data)
  });
}

function recordError(type, data) {
  const errorEvent = {
    sessionId: UAT_TRACKER_STATE.session.sessionId,
    timestamp: new Date().toISOString(),
    type,
    url: location.href,
    ...getPageContext(),
    data: maskSensitive(data)
  };
  pushRolling("errors", errorEvent);
  pushRolling("events", errorEvent);
}

function recordNetworkEvent(payload) {
  const event = {
    sessionId: UAT_TRACKER_STATE.session.sessionId,
    timestamp: new Date().toISOString(),
    method: payload.method,
    url: payload.url,
    status: payload.status || 0,
    duration: payload.duration || 0,
    ...getPageContext(),
    request: maskSensitive(payload.request || {}),
    response: maskSensitive(payload.response || {})
  };

  pushRolling("networkEvents", event);

  if (event.status >= 400 || event.status === 0) {
    recordError("network_error", event);
  }
}

function pushRolling(key, event) {
  UAT_TRACKER_STATE[key].push(event);
  trimRollingBuffers();
  persistSnapshot();
}

function trimRollingBuffers() {
  const retentionMs = Number(UAT_TRACKER_STATE.settings?.retentionMinutes || 15) * 60 * 1000;
  const minTime = Date.now() - retentionMs;

  ["events", "networkEvents", "errors"].forEach(key => {
    UAT_TRACKER_STATE[key] = UAT_TRACKER_STATE[key]
      .filter(event => Date.parse(event.timestamp) >= minTime)
      .slice(-1500);
  });
}

function getPageContext() {
  return {
    tabId: UAT_TRACKER_STATE.tab?.tabId ?? null,
    windowId: UAT_TRACKER_STATE.tab?.windowId ?? null,
    pageInstanceId: UAT_TRACKER_STATE.pageInstanceId,
    pageUrl: location.href,
    pageTitle: document.title,
    inheritedTracking: Boolean(UAT_TRACKER_STATE.tab?.inheritedTracking),
    inheritedFromTabId: UAT_TRACKER_STATE.tab?.inheritedFromTabId ?? null
  };
}

async function getCombinedSnapshot() {
  const { trackerSnapshot } = await chrome.storage.local.get(["trackerSnapshot"]);
  if (trackerSnapshot?.session?.sessionId === UAT_TRACKER_STATE.session?.sessionId) {
    return trackerSnapshot;
  }

  return getLocalSnapshot();
}

function getLocalSnapshot() {
  return {
    session: UAT_TRACKER_STATE.session,
    pages: [{
      ...getPageContext(),
      updatedAt: Date.now(),
      events: UAT_TRACKER_STATE.events.length,
      networkEvents: UAT_TRACKER_STATE.networkEvents.length,
      errors: UAT_TRACKER_STATE.errors.length
    }],
    events: UAT_TRACKER_STATE.events,
    networkEvents: UAT_TRACKER_STATE.networkEvents,
    errors: UAT_TRACKER_STATE.errors,
    updatedAt: Date.now()
  };
}

function persistSnapshot() {
  const snapshot = getLocalSnapshot();

  return sendMessage({
    type: "SAVE_TAB_SNAPSHOT",
    snapshot: {
      key: UAT_TRACKER_STATE.pageInstanceId,
      ...snapshot,
      page: snapshot.pages[0]
    }
  }).catch(() => {
    return chrome.storage.local.set({ trackerSnapshot: snapshot });
  });
}

async function resetRecordedActivity() {
  UAT_TRACKER_STATE.events = [];
  UAT_TRACKER_STATE.networkEvents = [];
  UAT_TRACKER_STATE.errors = [];
  UAT_TRACKER_STATE.session = await getOrCreateSession();
  UAT_TRACKER_STATE.session = await refreshSessionIdentity(UAT_TRACKER_STATE.session);
  await persistSnapshot();
}

function mountDraggableTracker() {
  if (document.getElementById("uat-tracker-widget-host")) return;

  const host = document.createElement("div");
  host.id = "uat-tracker-widget-host";
  host.style.position = "fixed";
  host.style.zIndex = "2147483647";
  host.style.right = "18px";
  host.style.bottom = "18px";

  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .widget {
        width: 300px;
        border: 1px solid #276477;
        border-radius: 8px;
        background: #08111f;
        color: #e5f7fb;
        box-shadow: 0 18px 48px rgba(2, 6, 23, 0.34);
        font: 12px "Segoe UI", system-ui, sans-serif;
        overflow: hidden;
      }
      .head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 9px 10px;
        background: linear-gradient(90deg, #0e7490, #4338ca);
        cursor: move;
        user-select: none;
      }
      .brand { display: flex; align-items: center; gap: 8px; min-width: 0; }
      .logo {
        position: relative;
        width: 34px;
        height: 34px;
        border-radius: 50%;
        background: linear-gradient(135deg, #d9e5e5 0 50%, #a7b6bb 51% 100%);
        box-shadow: inset 0 0 0 1px rgba(15, 23, 42, 0.22);
      }
      .logo::before,
      .logo::after {
        content: "";
        position: absolute;
        inset: 7px 13px 7px 10px;
        clip-path: polygon(54% 0, 100% 0, 66% 42%, 100% 42%, 30% 100%, 48% 54%, 0 54%);
      }
      .logo::before { background: #0f9aa6; transform: translateX(-3px); }
      .logo::after { background: #d6aa27; transform: translateX(4px); }
      .title { font-weight: 900; font-size: 13px; }
      .status { color: #bbf7d0; font-size: 11px; }
      .actions { display: flex; gap: 6px; }
      button {
        position: relative;
        border: 0;
        border-radius: 6px;
        min-width: 28px;
        height: 26px;
        background: rgba(255,255,255,0.16);
        color: white;
        cursor: pointer;
        font-weight: 900;
      }
      .body { padding: 10px; background: rgba(15,23,42,0.97); }
      .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; margin-bottom: 8px; }
      .metric { border: 1px solid #243754; border-radius: 7px; padding: 7px; }
      .metric span { display: block; color: #9cc8d7; font-size: 10px; }
      .metric strong { display: block; margin-top: 2px; overflow-wrap: anywhere; }
      textarea {
        width: 100%;
        min-height: 54px;
        box-sizing: border-box;
        border: 1px solid #315070;
        border-radius: 7px;
        background: #020617;
        color: #f8fafc;
        padding: 7px;
        resize: vertical;
      }
      .report {
        width: 100%;
        margin-top: 7px;
        background: #0891b2;
      }
      .clear {
        width: 100%;
        margin-top: 7px;
        border: 1px solid #7f1d1d;
        background: #991b1b;
      }
      button.loading { color: transparent; }
      button.loading::after {
        content: "";
        position: absolute;
        left: 50%;
        top: 50%;
        width: 16px;
        height: 16px;
        margin: -8px 0 0 -8px;
        border: 3px solid rgba(255,255,255,0.35);
        border-top-color: #ffffff;
        border-radius: 50%;
        animation: spin 700ms linear infinite;
      }
      .msg { min-height: 16px; margin-top: 7px; color: #bae6fd; overflow-wrap: anywhere; }
      .msg.success { color: #86efac; }
      .msg.error { color: #fca5a5; }
      footer {
        border-top: 1px solid #243754;
        padding-top: 8px;
        margin-top: 8px;
        color: #dbeafe;
        text-align: center;
        font-size: 11px;
        font-weight: 700;
      }
      .widget.minimized {
        width: auto;
        border-radius: 999px;
      }
      .widget.minimized .body,
      .widget.minimized .title,
      .widget.minimized .status {
        display: none;
      }
      .widget.minimized .head {
        padding: 7px;
        border-radius: 999px;
      }
      @keyframes spin {
        to { transform: rotate(360deg); }
      }
    </style>
    <div class="widget minimized" id="widget">
      <div class="head" id="dragHandle">
        <div class="brand">
          <div class="logo" aria-hidden="true"></div>
          <div>
            <div class="title">UAT Tracker</div>
            <div class="status">Tracking</div>
          </div>
        </div>
        <div class="actions">
          <button id="toggle" title="Expand tracker">+</button>
        </div>
      </div>
      <div class="body">
        <div class="grid">
          <div class="metric"><span>Session</span><strong id="widgetSession">-</strong></div>
          <div class="metric"><span>API Calls</span><strong id="widgetApis">0</strong></div>
          <div class="metric"><span>Events</span><strong id="widgetEvents">0</strong></div>
          <div class="metric"><span>Errors</span><strong id="widgetErrors">0</strong></div>
        </div>
        <textarea id="widgetDescription" placeholder="What went wrong?"></textarea>
        <button class="report" id="widgetReport">Report Issue</button>
        <button class="clear" id="widgetClear">Clear Recorded Activity</button>
        <div class="msg">Clearing removes unsent API calls, UI events, errors, and this local session.</div>
        <div class="msg" id="widgetMessage"></div>
        <footer>UAT Tracker by 47Billion. Copyright (c) 2026 47Billion.</footer>
      </div>
    </div>
  `;

  document.documentElement.appendChild(host);

  const widget = shadow.getElementById("widget");
  const toggle = shadow.getElementById("toggle");
  const message = shadow.getElementById("widgetMessage");

  toggle.addEventListener("click", event => {
    event.stopPropagation();
    const minimized = widget.classList.toggle("minimized");
    toggle.textContent = minimized ? "+" : "-";
    toggle.title = minimized ? "Expand tracker" : "Minimize tracker";
  });

  const reportButton = shadow.getElementById("widgetReport");
  reportButton.addEventListener("click", async () => {
    message.className = "msg";
    message.textContent = "Sending report...";
    reportButton.disabled = true;
    reportButton.classList.add("loading");

    try {
      const result = await submitCurrentSnapshot(shadow.getElementById("widgetDescription").value.trim());

      if (result.ok) {
        message.className = "msg success";
        message.textContent = `Submitted. Issue ID: ${result.issueId}`;
        shadow.getElementById("widgetDescription").value = "";
      } else {
        message.className = "msg error";
        message.textContent = result.error || "Unable to submit report.";
      }
    } catch (error) {
      message.className = "msg error";
      message.textContent = error?.message || "Unable to submit report.";
    } finally {
      reportButton.disabled = false;
      reportButton.classList.remove("loading");
    }
  });

  shadow.getElementById("widgetClear").addEventListener("click", async () => {
    const confirmed = confirm(
      "Clear all recorded activity for this browser session?\n\nThis will remove unsent API calls, UI events, errors, and the current session. Already submitted reports in the admin dashboard will not be deleted."
    );

    if (!confirmed) return;

    await sendMessage({ type: "CLEAR_RECORDING" });
    updateTrackerWidget(shadow);
    message.className = "msg success";
    message.textContent = "Recorded activity cleared. Refresh the page to start a new session.";
  });

  bindWidgetDrag(host, shadow.getElementById("dragHandle"));
  setInterval(() => updateTrackerWidget(shadow), 1000);
  updateTrackerWidget(shadow);
}

function updateTrackerWidget(shadow) {
  chrome.storage.local.get(["trackerSnapshot"]).then(({ trackerSnapshot }) => {
    const snapshot = trackerSnapshot?.session?.sessionId === UAT_TRACKER_STATE.session?.sessionId
      ? trackerSnapshot
      : getLocalSnapshot();

    shadow.getElementById("widgetSession").textContent = snapshot.session?.sessionId || "-";
    shadow.getElementById("widgetApis").textContent = snapshot.networkEvents?.length || 0;
    shadow.getElementById("widgetEvents").textContent = snapshot.events?.length || 0;
    shadow.getElementById("widgetErrors").textContent = snapshot.errors?.length || 0;
  });
}

function bindWidgetDrag(host, handle) {
  let drag = null;

  handle.addEventListener("pointerdown", event => {
    drag = {
      startX: event.clientX,
      startY: event.clientY,
      left: host.offsetLeft,
      top: host.offsetTop,
      moved: false
    };
    host.style.right = "auto";
    host.style.bottom = "auto";
    handle.setPointerCapture(event.pointerId);
  });

  handle.addEventListener("pointermove", event => {
    if (!drag) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    drag.moved = drag.moved || Math.abs(dx) + Math.abs(dy) > 5;
    const nextLeft = Math.max(8, Math.min(window.innerWidth - host.offsetWidth - 8, drag.left + dx));
    const nextTop = Math.max(8, Math.min(window.innerHeight - host.offsetHeight - 8, drag.top + dy));
    host.style.left = `${nextLeft}px`;
    host.style.top = `${nextTop}px`;
  });

  handle.addEventListener("pointerup", () => {
    drag = null;
  });
}

async function submitCurrentSnapshot(description) {
  persistSnapshot();
  const snapshot = await getCombinedSnapshot();
  const session = snapshot.session || UAT_TRACKER_STATE.session;
  const issueId = `UAT-${Math.floor(1000 + Math.random() * 9000)}`;
  return sendMessage({
    type: "SUBMIT_REPORT",
    report: {
      captureSensitive: Boolean(UAT_TRACKER_STATE.settings?.captureSensitive),
      session: {
        ...session,
        userIdentifier: getUserIdentifier() || session?.userIdentifier || "",
        endedAt: new Date().toISOString()
      },
      issue: {
        issueId,
        description,
        currentUrl: location.href
      },
      pages: snapshot.pages || [],
      events: snapshot.events || [],
      networkEvents: snapshot.networkEvents || [],
      errors: snapshot.errors || []
    }
  });
}

function getElementSummary(element) {
  if (!element || element.nodeType !== Node.ELEMENT_NODE) return {};

  return {
    tag: element.tagName?.toLowerCase(),
    text: getSafeText(element),
    id: element.id || "",
    name: element.getAttribute("name") || "",
    type: element.getAttribute("type") || "",
    role: element.getAttribute("role") || "",
    testId: element.getAttribute("data-testid") || "",
    selector: buildSelector(element)
  };
}

function getSafeText(element) {
  if (isMaskedElement(element)) return "***masked***";
  return String(element.innerText || element.textContent || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 120);
}

function getSafeElementValue(element) {
  if (isMaskedElement(element)) return "***masked***";
  if (["password", "email", "tel"].includes(String(element.type || "").toLowerCase())) {
    return "***masked***";
  }
  return String(element.value || "").slice(0, 500);
}

function isMaskedElement(element) {
  if (!element?.closest) return false;
  if (element.closest("[data-uat-mask='true']")) return true;
  return String(element.type || "").toLowerCase() === "password";
}

function buildSelector(element) {
  if (element.id) return `#${CSS.escape(element.id)}`;
  const parts = [];
  let current = element;

  while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 4) {
    let part = current.tagName.toLowerCase();
    if (current.classList.length) {
      part += `.${Array.from(current.classList).slice(0, 2).map(item => CSS.escape(item)).join(".")}`;
    }
    parts.unshift(part);
    current = current.parentElement;
  }

  return parts.join(" > ");
}

function maskSensitive(value) {
  if (UAT_TRACKER_STATE.settings?.captureSensitive === true) return value;
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value.replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer ***masked***");
  if (Array.isArray(value)) return value.map(maskSensitive);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        SECRET_KEY_PATTERNS.some(pattern => pattern.test(key))
          ? "***masked***"
          : maskSensitive(nested)
      ])
    );
  }
  return value;
}

function debounce(fn, wait) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, response => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve(response);
    });
  });
}
