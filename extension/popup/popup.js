const els = {
  status: document.getElementById("status"),
  sessionId: document.getElementById("sessionId"),
  eventCount: document.getElementById("eventCount"),
  apiCount: document.getElementById("apiCount"),
  errorCount: document.getElementById("errorCount"),
  description: document.getElementById("description"),
  sendReport: document.getElementById("sendReport"),
  retryReports: document.getElementById("retryReports"),
  clearRecording: document.getElementById("clearRecording"),
  minimizeTracker: document.getElementById("minimizeTracker"),
  trackerBody: document.getElementById("trackerBody"),
  apiBaseUrl: document.getElementById("apiBaseUrl"),
  allowedOrigins: document.getElementById("allowedOrigins"),
  userIdentifier: document.getElementById("userIdentifier"),
  captureSensitive: document.getElementById("captureSensitive"),
  showFloatingWidget: document.getElementById("showFloatingWidget"),
  retentionMinutes: document.getElementById("retentionMinutes"),
  saveSettings: document.getElementById("saveSettings"),
  message: document.getElementById("message")
};

load();

els.sendReport.addEventListener("click", submitReport);
els.retryReports.addEventListener("click", retryReports);
els.clearRecording.addEventListener("click", clearRecording);
els.saveSettings.addEventListener("click", saveSettings);
els.minimizeTracker.addEventListener("click", toggleMinimized);

async function load() {
  const { trackerSnapshot, settings, pendingReports = [] } = await chrome.storage.local.get([
    "trackerSnapshot",
    "settings",
    "pendingReports"
  ]);

  els.apiBaseUrl.value = settings?.apiBaseUrl || "http://localhost:4010";
  els.allowedOrigins.value = (settings?.allowedOrigins || ["https://uat.example.com"]).join("\n");
  els.userIdentifier.value = settings?.userIdentifier || trackerSnapshot?.session?.userIdentifier || "";
  els.captureSensitive.checked = Boolean(settings?.captureSensitive);
  els.showFloatingWidget.checked = Boolean(settings?.showFloatingWidget);
  els.retentionMinutes.value = settings?.retentionMinutes || 15;
  applyMinimized(Boolean(settings?.popupMinimized));

  if (!trackerSnapshot?.session) {
    els.status.textContent = pendingReports.length
      ? `Not tracking. Pending reports: ${pendingReports.length}`
      : "Not tracking on this page";
    return;
  }

  els.status.textContent = pendingReports.length
    ? `Tracking. Pending reports: ${pendingReports.length}`
    : "Tracking";
  els.sessionId.textContent = trackerSnapshot.session.sessionId;
  els.eventCount.textContent = trackerSnapshot.events?.length || 0;
  els.apiCount.textContent = trackerSnapshot.networkEvents?.length || 0;
  els.errorCount.textContent = trackerSnapshot.errors?.length || 0;
}

async function submitReport() {
  try {
    const { trackerSnapshot } = await chrome.storage.local.get(["trackerSnapshot"]);

    if (!trackerSnapshot?.session) {
      setMessage("No active UAT session found.", "error");
      return;
    }

    const issueId = `UAT-${Math.floor(1000 + Math.random() * 9000)}`;
    const { settings } = await chrome.storage.local.get(["settings"]);
    const userIdentifier = els.userIdentifier.value.trim() || settings?.userIdentifier || trackerSnapshot.session.userIdentifier || "";
    const currentPage = trackerSnapshot.pages?.[0] || {};
    const report = {
      captureSensitive: Boolean(settings?.captureSensitive || els.captureSensitive.checked),
      session: {
        ...trackerSnapshot.session,
        userIdentifier,
        endedAt: new Date().toISOString()
      },
      issue: {
        issueId,
        description: els.description.value.trim(),
        currentUrl: currentPage.pageUrl || trackerSnapshot.session.applicationUrl
      },
      pages: trackerSnapshot.pages || [],
      events: trackerSnapshot.events || [],
      networkEvents: trackerSnapshot.networkEvents || [],
      errors: trackerSnapshot.errors || []
    };

    els.sendReport.disabled = true;
    els.sendReport.classList.add("loading");
    setMessage("Sending report...");

    const response = await sendMessage({ type: "SUBMIT_REPORT", report });

    if (response.ok) {
      setMessage(`Report submitted successfully. Issue ID: ${response.issueId}`, "success");
      els.description.value = "";
    } else if (response.queued) {
      setMessage(`Backend not reachable. Saved locally for retry. ${response.error || ""}`, "warning");
    } else {
      setMessage(response.error || "Unable to send report.", "error");
    }
  } catch (error) {
    setMessage(error?.message || "Unable to send report.", "error");
  } finally {
    els.sendReport.disabled = false;
    els.sendReport.classList.remove("loading");
    load();
  }
}

async function retryReports() {
  try {
    const response = await sendMessage({ type: "RETRY_PENDING_REPORTS" });
    if (response.ok) {
      setMessage(`Uploaded ${response.uploaded.length}. Remaining: ${response.remaining}`, "success");
    } else {
      setMessage(response.error || "Retry failed.", "error");
    }
  } catch (error) {
    setMessage(error?.message || "Retry failed.", "error");
  } finally {
    load();
  }
}

async function clearRecording() {
  const confirmed = confirm(
    "Clear all recorded activity for this browser session?\n\nThis will remove unsent API calls, UI events, errors, and the current session. Already submitted reports in the admin dashboard will not be deleted."
  );

  if (!confirmed) return;

  try {
    els.clearRecording.disabled = true;
    await sendMessage({ type: "CLEAR_RECORDING" });
    els.sessionId.textContent = "-";
    els.eventCount.textContent = "0";
    els.apiCount.textContent = "0";
    els.errorCount.textContent = "0";
    setMessage("Recorded activity cleared. Refresh the UAT page to start a new session.", "success");
    await load();
  } catch (error) {
    setMessage(error?.message || "Unable to clear recorded activity.", "error");
  } finally {
    els.clearRecording.disabled = false;
  }
}

async function saveSettings() {
  const settings = {
    apiBaseUrl: els.apiBaseUrl.value.trim().replace(/\/+$/g, ""),
    allowedOrigins: els.allowedOrigins.value
      .split(/\n|,/)
      .map(item => item.trim())
      .filter(Boolean),
    retentionMinutes: Number(els.retentionMinutes.value || 15),
    userIdentifier: els.userIdentifier.value.trim(),
    captureSensitive: els.captureSensitive.checked,
    showFloatingWidget: els.showFloatingWidget.checked
  };

  const { session, trackerSnapshot } = await chrome.storage.local.get(["session", "trackerSnapshot"]);
  if (session || trackerSnapshot?.session) {
    const nextSession = session ? { ...session, userIdentifier: settings.userIdentifier } : session;
    const nextSnapshot = trackerSnapshot?.session
      ? {
          ...trackerSnapshot,
          session: { ...trackerSnapshot.session, userIdentifier: settings.userIdentifier }
        }
      : trackerSnapshot;

    await chrome.storage.local.set({
      ...(nextSession ? { session: nextSession } : {}),
      ...(nextSnapshot ? { trackerSnapshot: nextSnapshot } : {})
    });
  }

  await sendMessage({ type: "SAVE_SETTINGS", settings });
  setMessage("Settings saved. Refresh the UAT page to apply widget visibility.", "success");
}

async function toggleMinimized() {
  const minimized = !els.trackerBody.hidden;
  const { settings } = await chrome.storage.local.get(["settings"]);
  await sendMessage({
    type: "SAVE_SETTINGS",
    settings: { ...(settings || {}), popupMinimized: minimized }
  });
  applyMinimized(minimized);
}

function applyMinimized(minimized) {
  els.trackerBody.hidden = minimized;
  els.minimizeTracker.textContent = minimized ? "+" : "-";
  els.minimizeTracker.title = minimized ? "Expand tracker" : "Minimize tracker";
}

function setMessage(message, type = "info") {
  els.message.textContent = message;
  els.message.className = type;
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, response => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }

      if (!response) {
        reject(new Error("No response from extension background service."));
        return;
      }

      resolve(response);
    });
  });
}
