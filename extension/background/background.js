const DEFAULT_SETTINGS = {
  apiBaseUrl: "http://localhost:4010",
  allowedOrigins: ["https://uat.example.com"],
  retentionMinutes: 15,
  userIdentifier: "",
  captureSensitive: false,
  showFloatingWidget: false,
  maskSelectors: ["[data-uat-mask='true']"]
};

chrome.runtime.onInstalled.addListener(async () => {
  const saved = await chrome.storage.local.get(["settings"]);
  if (!saved.settings) {
    await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  }
});

chrome.tabs.onCreated.addListener(tab => {
  inheritTrackingFromOpener(tab).catch(() => {});
});

chrome.tabs.onRemoved.addListener(tabId => {
  removeTrackedTab(tabId).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "GET_SETTINGS") {
    Promise.all([
      chrome.storage.local.get(["settings"]),
      getTrackingContext(sender)
    ]).then(([{ settings }, trackingContext]) => {
      sendResponse({
        ok: true,
        settings: { ...DEFAULT_SETTINGS, ...(settings || {}) },
        tab: {
          tabId: sender.tab?.id ?? null,
          windowId: sender.tab?.windowId ?? null,
          inheritedTracking: trackingContext.inheritedTracking,
          inheritedFromTabId: trackingContext.inheritedFromTabId,
          trackedSessionId: trackingContext.sessionId
        }
      });
    });
    return true;
  }

  if (message?.type === "SAVE_TAB_SNAPSHOT") {
    saveTabSnapshot(sender, message.snapshot)
      .then(snapshot => sendResponse({ ok: true, trackerSnapshot: snapshot }))
      .catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === "SAVE_SETTINGS") {
    const nextSettings = { ...DEFAULT_SETTINGS, ...(message.settings || {}) };
    chrome.storage.local.set({ settings: nextSettings }).then(() => {
      sendResponse({ ok: true, settings: nextSettings });
    });
    return true;
  }

  if (message?.type === "SUBMIT_REPORT") {
    submitReport(message.report)
      .then(result => sendResponse({ ok: true, ...result }))
      .catch(async error => {
        await queuePendingReport(message.report);
        sendResponse({ ok: false, queued: true, error: error?.message || String(error) });
      });
    return true;
  }

  if (message?.type === "CLEAR_RECORDING") {
    clearRecordingEverywhere()
      .then(() => sendResponse({ ok: true }))
      .catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === "RETRY_PENDING_REPORTS") {
    retryPendingReports()
      .then(result => sendResponse({ ok: true, ...result }))
      .catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
});

async function submitReport(report) {
  const { settings } = await chrome.storage.local.get(["settings"]);
  const apiBaseUrl = (settings?.apiBaseUrl || DEFAULT_SETTINGS.apiBaseUrl).replace(/\/+$/g, "");

  const response = await fetch(`${apiBaseUrl}/api/reports`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(report)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    throw new Error(data.error || `Report upload failed with HTTP ${response.status}`);
  }

  return { issueId: data.issueId };
}

async function queuePendingReport(report) {
  const { pendingReports = [] } = await chrome.storage.local.get(["pendingReports"]);
  const exists = pendingReports.some(item => item.issue?.issueId === report.issue?.issueId);
  if (!exists) {
    pendingReports.push(report);
    await chrome.storage.local.set({ pendingReports });
  }
}

async function retryPendingReports() {
  const { pendingReports = [] } = await chrome.storage.local.get(["pendingReports"]);
  const remaining = [];
  const uploaded = [];

  for (const report of pendingReports) {
    try {
      const result = await submitReport(report);
      uploaded.push(result.issueId);
    } catch {
      remaining.push(report);
    }
  }

  await chrome.storage.local.set({ pendingReports: remaining });
  return { uploaded, remaining: remaining.length };
}

async function saveTabSnapshot(sender, snapshot = {}) {
  const { tabSnapshots = {} } = await chrome.storage.local.get(["tabSnapshots"]);
  const tabId = sender.tab?.id ?? snapshot.page?.tabId ?? snapshot.tabId;
  const key = String(snapshot.key ?? snapshot.page?.pageInstanceId ?? tabId ?? Date.now());
  const updatedAt = Date.now();
  const nextSnapshot = {
    ...snapshot,
    key,
    page: {
      ...(snapshot.page || {}),
      tabId: tabId ?? null,
      windowId: sender.tab?.windowId ?? snapshot.page?.windowId ?? null,
      updatedAt
    },
    updatedAt
  };
  const nextTabSnapshots = pruneTabSnapshots({
    ...tabSnapshots,
    [key]: nextSnapshot
  }, nextSnapshot.session?.sessionId);
  const trackerSnapshot = mergeTabSnapshots(nextTabSnapshots, nextSnapshot.session?.sessionId);

  await chrome.storage.local.set({
    tabSnapshots: nextTabSnapshots,
    trackerSnapshot
  });
  await rememberTrackedTab(tabId, nextSnapshot.session?.sessionId, nextSnapshot.page?.inheritedTracking);

  return trackerSnapshot;
}

async function getTrackingContext(sender) {
  const tabId = sender.tab?.id;
  if (!tabId) {
    return { inheritedTracking: false, inheritedFromTabId: null, sessionId: null };
  }

  const { trackedTabs = {} } = await chrome.storage.local.get(["trackedTabs"]);
  let tabState = trackedTabs[String(tabId)];

  if (!tabState && sender.tab?.openerTabId) {
    const openerState = trackedTabs[String(sender.tab.openerTabId)];
    if (openerState?.sessionId) {
      tabState = {
        sessionId: openerState.sessionId,
        inheritedTracking: true,
        inheritedFromTabId: sender.tab.openerTabId,
        updatedAt: Date.now()
      };
      await chrome.storage.local.set({
        trackedTabs: {
          ...trackedTabs,
          [String(tabId)]: tabState
        }
      });
    }
  }

  return {
    inheritedTracking: Boolean(tabState?.inheritedTracking),
    inheritedFromTabId: tabState?.inheritedFromTabId ?? null,
    sessionId: tabState?.sessionId ?? null
  };
}

async function inheritTrackingFromOpener(tab) {
  if (!tab?.id || !tab.openerTabId) return;

  const { trackedTabs = {} } = await chrome.storage.local.get(["trackedTabs"]);
  const openerState = trackedTabs[String(tab.openerTabId)];
  if (!openerState?.sessionId) return;

  await chrome.storage.local.set({
    trackedTabs: {
      ...trackedTabs,
      [String(tab.id)]: {
        sessionId: openerState.sessionId,
        inheritedTracking: true,
        inheritedFromTabId: tab.openerTabId,
        updatedAt: Date.now()
      }
    }
  });
}

async function rememberTrackedTab(tabId, sessionId, inheritedTracking = false) {
  if (!tabId || !sessionId) return;

  const { trackedTabs = {} } = await chrome.storage.local.get(["trackedTabs"]);
  await chrome.storage.local.set({
    trackedTabs: {
      ...trackedTabs,
      [String(tabId)]: {
        ...(trackedTabs[String(tabId)] || {}),
        sessionId,
        inheritedTracking: Boolean(inheritedTracking || trackedTabs[String(tabId)]?.inheritedTracking),
        inheritedFromTabId: trackedTabs[String(tabId)]?.inheritedFromTabId ?? null,
        updatedAt: Date.now()
      }
    }
  });
}

async function removeTrackedTab(tabId) {
  const { trackedTabs = {}, tabSnapshots = {} } = await chrome.storage.local.get(["trackedTabs", "tabSnapshots"]);
  const nextTrackedTabs = { ...trackedTabs };
  delete nextTrackedTabs[String(tabId)];

  await chrome.storage.local.set({ trackedTabs: nextTrackedTabs, tabSnapshots });
}

function pruneTabSnapshots(tabSnapshots, sessionId) {
  const maxAgeMs = 24 * 60 * 60 * 1000;
  const minUpdatedAt = Date.now() - maxAgeMs;

  return Object.fromEntries(
    Object.entries(tabSnapshots).filter(([, snapshot]) =>
      snapshot?.session?.sessionId === sessionId &&
      Number(snapshot.updatedAt || snapshot.page?.updatedAt || 0) >= minUpdatedAt
    )
  );
}

function mergeTabSnapshots(tabSnapshots, sessionId) {
  const snapshots = Object.values(tabSnapshots)
    .filter(snapshot => snapshot?.session?.sessionId === sessionId);
  const newest = snapshots
    .slice()
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))[0];

  if (!newest?.session) {
    return null;
  }

  const events = sortByTimestamp(snapshots.flatMap(snapshot => snapshot.events || []));
  const networkEvents = sortByTimestamp(snapshots.flatMap(snapshot => snapshot.networkEvents || []));
  const errors = sortByTimestamp(snapshots.flatMap(snapshot => snapshot.errors || []));
  const pages = snapshots
    .map(snapshot => ({
      ...(snapshot.page || {}),
      events: snapshot.events?.length || 0,
      networkEvents: snapshot.networkEvents?.length || 0,
      errors: snapshot.errors?.length || 0
    }))
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));

  return {
    session: newest.session,
    pages,
    events,
    networkEvents,
    errors,
    updatedAt: Date.now()
  };
}

function sortByTimestamp(items) {
  return items.sort((a, b) => Date.parse(a.timestamp || 0) - Date.parse(b.timestamp || 0));
}

async function clearRecordingEverywhere() {
  await chrome.storage.local.remove(["session", "trackerSnapshot", "tabSnapshots", "trackedTabs"]);

  const tabs = await chrome.tabs.query({});

  await Promise.all(
    tabs
      .filter(tab => tab.id)
      .map(tab => chrome.tabs.sendMessage(tab.id, { type: "CLEAR_PAGE_RECORDING" }).catch(() => {}))
  );
}
