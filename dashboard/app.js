const state = {
  selectedIssueId: null,
  details: null,
  issues: [],
  stats: null,
  activeTab: "network",
  networkMethod: "all"
};

const els = {
  issuesBody: document.getElementById("issuesBody"),
  issueCount: document.getElementById("issueCount"),
  refreshIssues: document.getElementById("refreshIssues"),
  clearAllLogs: document.getElementById("clearAllLogs"),
  statusFilter: document.getElementById("statusFilter"),
  dateFrom: document.getElementById("dateFrom"),
  dateTo: document.getElementById("dateTo"),
  clearDateFilters: document.getElementById("clearDateFilters"),
  toggleOverview: document.getElementById("toggleOverview"),
  overviewInsights: document.getElementById("overviewInsights"),
  pageLoader: document.getElementById("pageLoader"),
  toast: document.getElementById("toast"),
  emptyState: document.getElementById("emptyState"),
  detailPanel: document.getElementById("detailPanel"),
  detailTitle: document.getElementById("detailTitle"),
  detailMeta: document.getElementById("detailMeta"),
  description: document.getElementById("description"),
  deleteIssue: document.getElementById("deleteIssue"),
  timeline: document.getElementById("timeline"),
  network: document.getElementById("network"),
  methodTabs: document.getElementById("methodTabs"),
  networkLogs: document.getElementById("networkLogs"),
  errors: document.getElementById("errors"),
  environment: document.getElementById("environment")
};

els.refreshIssues.addEventListener("click", () => loadIssues({ showMessage: true }));
els.clearAllLogs.addEventListener("click", clearAllLogs);
els.statusFilter.addEventListener("change", () => loadIssues());
els.dateFrom.addEventListener("change", () => loadIssues());
els.dateTo.addEventListener("change", () => loadIssues());
els.dateFrom.addEventListener("input", formatDateInput);
els.dateTo.addEventListener("input", formatDateInput);
els.clearDateFilters.addEventListener("click", clearDateFilters);
els.toggleOverview.addEventListener("click", toggleOverview);
els.deleteIssue.addEventListener("click", deleteSelectedIssue);

document.querySelectorAll("[data-date-preset]").forEach(button => {
  button.addEventListener("click", () => applyDatePreset(button.dataset.datePreset));
});

document.querySelectorAll("[data-status-action]").forEach(button => {
  button.addEventListener("click", () => updateStatus(button.dataset.statusAction));
});

document.querySelectorAll(".tab").forEach(button => {
  button.addEventListener("click", () => showTab(button.dataset.tab));
});

loadIssues();

async function loadIssues(options = {}) {
  setLoading(true, "Loading issues...");

  try {
    const params = new URLSearchParams();
    if (els.statusFilter.value !== "all") {
      params.set("status", els.statusFilter.value);
    }
    const dateFrom = parseDisplayDate(els.dateFrom.value);
    const dateTo = parseDisplayDate(els.dateTo.value);

    if (els.dateFrom.value && !dateFrom) {
      showToast("Use dd/mm/yyyy format for From date.", "error");
      return;
    }
    if (els.dateTo.value && !dateTo) {
      showToast("Use dd/mm/yyyy format for To date.", "error");
      return;
    }

    if (dateFrom) {
      params.set("dateFrom", dateFrom);
    }
    if (dateTo) {
      params.set("dateTo", dateTo);
    }

    const [data, stats] = await Promise.all([
      fetchJson(`/api/issues${params.size ? `?${params}` : ""}`),
      fetchJson("/api/issues/stats/summary")
    ]);
    state.issues = data.issues || [];
    state.stats = stats;
    els.issueCount.textContent = state.issues.length;
    renderOverviewInsights();

    if (!state.issues.some(issue => issue.issue_id === state.selectedIssueId)) {
      state.selectedIssueId = null;
      state.details = null;
      renderEmptyState();
    }

    els.issuesBody.innerHTML = state.issues.map(issue => `
      <tr class="issue-row ${issue.issue_id === state.selectedIssueId ? "active" : ""}" data-id="${escapeHtml(issue.issue_id)}">
        <td><strong>${escapeHtml(issue.issue_id)}</strong></td>
        <td>${escapeHtml(getIssueUser(issue))}</td>
        <td>${formatDate(issue.created_at)}</td>
        <td><span class="badge ${escapeHtml(issue.status)}">${escapeHtml(issue.status)}</span></td>
      </tr>
    `).join("") || `
      <tr>
        <td colspan="4" class="table-empty">No issues found for this filter.</td>
      </tr>
    `;

    document.querySelectorAll(".issue-row").forEach(row => {
      row.addEventListener("click", () => loadIssue(row.dataset.id));
    });

    if (options.showMessage) {
      showToast("Issue list refreshed.", "success");
    }
  } catch (error) {
    showToast(error.message || "Unable to load issues.", "error");
  } finally {
    setLoading(false);
  }
}

async function loadIssue(issueId) {
  state.selectedIssueId = issueId;
  setLoading(true, "Opening issue logs...");
  renderDetailSkeleton(issueId);

  try {
    state.details = await fetchJson(`/api/issues/${encodeURIComponent(issueId)}`);

    document.querySelectorAll(".issue-row").forEach(row => {
      row.classList.toggle("active", row.dataset.id === issueId);
    });

    renderDetail();
  } catch (error) {
    showToast(error.message || "Unable to open issue.", "error");
  } finally {
    setLoading(false);
  }
}

function renderEmptyState() {
  els.emptyState.hidden = false;
  els.detailPanel.hidden = true;
}

function renderDetailSkeleton(issueId) {
  els.emptyState.hidden = true;
  els.detailPanel.hidden = false;
  els.detailTitle.textContent = `Issue #${issueId}`;
  els.detailMeta.textContent = "Loading captured logs...";
  els.description.textContent = "";
  els.timeline.innerHTML = `<div class="skeleton-block"></div><div class="skeleton-block short"></div>`;
  els.methodTabs.innerHTML = "";
  els.networkLogs.innerHTML = "";
  els.errors.innerHTML = "";
  els.environment.textContent = "";
}

function renderDetail() {
  const { issue, events, networkEvents } = state.details;
  els.emptyState.hidden = true;
  els.detailPanel.hidden = false;
  els.detailTitle.textContent = `Issue #${issue.issue_id}`;
  els.detailMeta.textContent = [
    `Session ${issue.session_id}`,
    getIssueUser(issue),
    issue.application_url || ""
  ].filter(Boolean).join(" | ");
  els.description.textContent = issue.description || "No description provided.";
  updateActionState(issue.status || "new");

  const timelineRows = [
    ...events.map(event => ({
      timestamp: event.timestamp,
      label: event.event_type,
      detail: event.event_data
    })),
    ...networkEvents.map(event => ({
      timestamp: event.timestamp,
      label: `${event.method || "GET"} ${getUrlPath(event.url)}`,
      detail: event,
      failed: !event.status || event.status >= 400
    }))
  ].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

  els.timeline.innerHTML = timelineRows.map(item => renderLogItem("timeline-item", item)).join("")
    || `<div class="empty-panel">No timeline events captured.</div>`;

  renderNetworkEvents(networkEvents);

  const errorEvents = timelineRows.filter(item =>
    item.label?.toLowerCase().includes("error") || item.failed
  );

  els.errors.innerHTML = errorEvents.map(event => renderLogItem("error-item", {
    ...event,
    failed: true
  })).join("") || `<div class="empty-panel">No errors captured.</div>`;

  els.environment.textContent = JSON.stringify({
    userIdentifier: getIssueUser(issue),
    tokenVisibility: hasMaskedSecrets({ events, networkEvents })
      ? "Some security values are masked. Enable capture tokens and cookies in the tracker before reporting to store raw values."
      : "Raw captured values are visible for this report.",
    environment: issue.environment,
    startedAt: issue.started_at,
    endedAt: issue.ended_at,
    browserInfo: issue.browser_info,
    applicationUrl: issue.application_url
  }, null, 2);

  showTab(state.activeTab);
}

function renderNetworkEvents(networkEvents) {
  const methods = ["all", ...Array.from(new Set(
    networkEvents.map(event => String(event.method || "GET").toUpperCase())
  )).sort()];

  if (!methods.includes(state.networkMethod)) {
    state.networkMethod = "all";
  }

  els.methodTabs.innerHTML = methods.map(method => {
    const count = method === "all"
      ? networkEvents.length
      : networkEvents.filter(event => String(event.method || "GET").toUpperCase() === method).length;

    return `
      <button class="method-tab ${state.networkMethod === method ? "active" : ""}" data-method="${escapeHtml(method)}">
        ${escapeHtml(method.toUpperCase())} <span>${count}</span>
      </button>
    `;
  }).join("");

  els.methodTabs.querySelectorAll(".method-tab").forEach(button => {
    button.addEventListener("click", () => {
      state.networkMethod = button.dataset.method;
      renderNetworkEvents(networkEvents);
    });
  });

  const filteredEvents = state.networkMethod === "all"
    ? networkEvents
    : networkEvents.filter(event => String(event.method || "GET").toUpperCase() === state.networkMethod);

  els.networkLogs.innerHTML = filteredEvents.map(renderNetworkLogItem).join("")
    || `<div class="empty-panel">No API logs captured for this method.</div>`;
}

function renderLogItem(className, item) {
  return `
    <div class="${className}">
      <div class="time">${formatTime(item.timestamp)}</div>
      <div>
        <div class="log-title ${item.failed ? "failed" : ""}">${escapeHtml(item.label)}</div>
        <pre>${highlightMaskedSecrets(JSON.stringify(item.detail, null, 2))}</pre>
      </div>
    </div>
  `;
}

function renderNetworkLogItem(event) {
  const status = Number(event.status || 0);
  const method = String(event.method || "GET").toUpperCase();
  const failed = !status || status >= 400;
  const statusClass = failed ? "failed" : status >= 300 ? "redirect" : "success";
  const requestData = event.request_data || event.request || {};
  const responseData = event.response_data || event.response || {};
  const requestHeaders = requestData.headers || {};
  const responseHeaders = responseData.headers || {};
  const pageTitle = event.page_title || event.pageTitle || "";
  const pageUrl = event.page_url || event.pageUrl || "";

  return `
    <article class="api-log ${failed ? "failed-log" : ""}">
      <div class="api-log-time">${formatTime(event.timestamp)}</div>
      <div class="api-log-content">
        <div class="api-log-head">
          <span class="method-chip ${escapeHtml(method.toLowerCase())}">${escapeHtml(method)}</span>
          <strong title="${escapeHtml(event.url || "")}">${escapeHtml(event.url || "")}</strong>
          <span class="status-chip ${statusClass}">${status || "Failed"}</span>
          <span class="duration-chip">${event.duration ?? 0} ms</span>
        </div>
        ${pageTitle || pageUrl ? `
          <div class="api-page-context">
            <span>Captured on</span>
            <strong>${escapeHtml(pageTitle || "Untitled page")}</strong>
            ${pageUrl ? `<small title="${escapeHtml(pageUrl)}">${escapeHtml(pageUrl)}</small>` : ""}
          </div>
        ` : ""}

        <div class="api-sections">
          <section class="api-section request-section">
            <div class="section-title">Request</div>
            ${renderDataBlock("Headers", requestHeaders)}
            ${renderDataBlock("Payload", requestData.body)}
          </section>

          <section class="api-section response-section">
            <div class="section-title">Response</div>
            ${renderDataBlock("Headers", responseHeaders)}
            ${renderDataBlock("Body", responseData.body ?? responseData.error ?? responseData)}
          </section>
        </div>
      </div>
    </article>
  `;
}

function renderDataBlock(title, value) {
  const isEmpty = value === null ||
    value === undefined ||
    value === "" ||
    (typeof value === "object" && !Array.isArray(value) && !Object.keys(value).length);

  return `
    <div class="data-block">
      <div class="data-label">${escapeHtml(title)}</div>
      <pre class="${isEmpty ? "empty-code" : ""}">${isEmpty ? "No data" : formatJsonForDisplay(value)}</pre>
    </div>
  `;
}

async function updateStatus(status) {
  if (!state.selectedIssueId) return;
  setLoading(true, "Updating status...");

  try {
    await fetchJson(`/api/issues/${encodeURIComponent(state.selectedIssueId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status })
    });
    showToast(`Issue marked ${status}.`, "success");
    await loadIssues();
    if (state.selectedIssueId) {
      await loadIssue(state.selectedIssueId);
    }
  } catch (error) {
    showToast(error.message || "Unable to update status.", "error");
  } finally {
    setLoading(false);
  }
}

async function deleteSelectedIssue() {
  if (!state.selectedIssueId) return;
  if (!confirm(`Delete ${state.selectedIssueId} and its captured logs?`)) return;

  setLoading(true, "Deleting issue logs...");
  try {
    await fetchJson(`/api/issues/${encodeURIComponent(state.selectedIssueId)}`, { method: "DELETE" });
    showToast("Issue and logs deleted.", "success");
    state.selectedIssueId = null;
    state.details = null;
    await loadIssues();
  } catch (error) {
    showToast(error.message || "Unable to delete issue.", "error");
  } finally {
    setLoading(false);
  }
}

async function clearAllLogs() {
  if (!confirm("Delete all reported issues and captured logs?")) return;

  setLoading(true, "Clearing all logs...");
  try {
    await fetchJson("/api/issues", { method: "DELETE" });
    showToast("All logs cleared.", "success");
    state.selectedIssueId = null;
    state.details = null;
    await loadIssues();
  } catch (error) {
    showToast(error.message || "Unable to clear logs.", "error");
  } finally {
    setLoading(false);
  }
}

function clearDateFilters() {
  els.dateFrom.value = "";
  els.dateTo.value = "";
  loadIssues();
}

function applyDatePreset(preset) {
  const today = new Date();
  const from = new Date(today);

  if (preset === "today") {
    els.dateFrom.value = toDisplayDate(today);
    els.dateTo.value = toDisplayDate(today);
  } else {
    from.setDate(today.getDate() - Number(preset) + 1);
    els.dateFrom.value = toDisplayDate(from);
    els.dateTo.value = toDisplayDate(today);
  }

  loadIssues();
}

function toggleOverview() {
  const collapsed = document.body.classList.toggle("insights-collapsed");
  els.toggleOverview.textContent = collapsed ? "Show Insights" : "Hide Insights";
}

function updateActionState(status) {
  document.querySelectorAll("[data-status-action]").forEach(button => {
    button.classList.toggle("active-status", button.dataset.statusAction === status);
  });
}

function showTab(tabName) {
  state.activeTab = tabName;

  document.querySelectorAll(".tab").forEach(button => {
    button.classList.toggle("active", button.dataset.tab === tabName);
  });

  ["timeline", "network", "errors", "environment"].forEach(id => {
    document.getElementById(id).hidden = id !== tabName;
  });
}

function renderOverviewInsights() {
  els.overviewInsights.innerHTML = buildInsightsHtml();
}

function buildInsightsHtml() {
  const currentCounts = countStatuses(state.issues);
  const overallCounts = normalizeStatusRows(state.stats?.overall || []);
  const todayCounts = normalizeStatusRows(state.stats?.today || []);

  return `
    ${renderPieCard("Current Filter", currentCounts, "Issues matching the selected status/date filters.")}
    ${renderPieCard("Overall Issues", overallCounts, "All issues currently stored in the dashboard.")}
    ${renderPieCard("Today", todayCounts, "Issues reported today.")}
  `;
}

function renderPieCard(title, counts, caption) {
  const total = counts.new + counts.reviewed + counts.closed;
  const gradient = buildPieGradient(counts);

  return `
    <section class="chart-card">
      <div class="chart-head">
        <div>
          <strong>${escapeHtml(title)}</strong>
          <p>${escapeHtml(caption)}</p>
        </div>
        <span>${total}</span>
      </div>
      <div class="chart-row">
        <div class="pie" style="--pie:${escapeHtml(gradient)}">
          <span>${total}</span>
        </div>
        <div class="legend">
          ${renderLegendItem("New", counts.new, "new")}
          ${renderLegendItem("Reviewed", counts.reviewed, "reviewed")}
          ${renderLegendItem("Closed", counts.closed, "closed")}
        </div>
      </div>
    </section>
  `;
}

function renderLegendItem(label, count, status) {
  return `
    <div class="legend-item">
      <i class="${status}"></i>
      <span>${escapeHtml(label)}</span>
      <strong>${count}</strong>
    </div>
  `;
}

function buildPieGradient(counts) {
  const total = counts.new + counts.reviewed + counts.closed;
  if (!total) return "#e5edf2 0 100%";

  const newEnd = counts.new / total * 100;
  const reviewedEnd = newEnd + counts.reviewed / total * 100;

  return [
    `#ef4444 0 ${newEnd}%`,
    `#facc15 ${newEnd}% ${reviewedEnd}%`,
    `#16a34a ${reviewedEnd}% 100%`
  ].join(", ");
}

function countStatuses(issues) {
  return issues.reduce((counts, issue) => {
    const status = issue.status || "new";
    if (counts[status] !== undefined) counts[status] += 1;
    return counts;
  }, { new: 0, reviewed: 0, closed: 0 });
}

function normalizeStatusRows(rows) {
  return rows.reduce((counts, row) => {
    const status = row.status || "new";
    if (counts[status] !== undefined) counts[status] = Number(row.count || 0);
    return counts;
  }, { new: 0, reviewed: 0, closed: 0 });
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `Request failed: ${response.status}`);
  }

  return data;
}

function setLoading(isLoading, label = "Loading...") {
  els.pageLoader.hidden = !isLoading;
  els.pageLoader.setAttribute("aria-label", label);
  els.refreshIssues.disabled = isLoading;
  els.clearAllLogs.disabled = isLoading;
}

function showToast(message, type = "info") {
  els.toast.textContent = message;
  els.toast.className = `toast ${type}`;
  els.toast.hidden = false;

  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    els.toast.hidden = true;
  }, 3200);
}

function getIssueUser(issue) {
  return issue.user_identifier || "Not captured";
}

function getUrlPath(value) {
  try {
    return new URL(value || "http://local").pathname;
  } catch {
    return value || "/";
  }
}

function formatDate(value) {
  return value ? new Date(value).toLocaleString() : "-";
}

function formatTime(value) {
  return value ? new Date(value).toLocaleTimeString() : "-";
}

function toIsoDate(value) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function toDisplayDate(value) {
  const day = String(value.getDate()).padStart(2, "0");
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const year = value.getFullYear();
  return `${day}/${month}/${year}`;
}

function parseDisplayDate(value) {
  const clean = String(value || "").trim();
  if (!clean) return "";

  const match = clean.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return "";

  const [, day, month, year] = match;
  const parsed = new Date(Number(year), Number(month) - 1, Number(day));
  if (
    parsed.getFullYear() !== Number(year) ||
    parsed.getMonth() !== Number(month) - 1 ||
    parsed.getDate() !== Number(day)
  ) {
    return "";
  }

  return toIsoDate(parsed);
}

function formatDateInput(event) {
  const digits = event.target.value.replace(/\D/g, "").slice(0, 8);
  const parts = [];

  if (digits.length > 0) parts.push(digits.slice(0, 2));
  if (digits.length > 2) parts.push(digits.slice(2, 4));
  if (digits.length > 4) parts.push(digits.slice(4, 8));

  event.target.value = parts.join("/");
}

function highlightMaskedSecrets(value) {
  return escapeHtml(value).replaceAll("***masked***", "<mark>***masked***</mark>");
}

function formatJsonForDisplay(value) {
  const json = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return syntaxHighlightJson(json);
}

function syntaxHighlightJson(value) {
  return highlightMaskedSecrets(value).replace(
    /(&quot;(\\u[a-fA-F0-9]{4}|\\[^u]|[^\\&])*&quot;(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
    match => {
      let className = "json-number";
      if (match.startsWith("&quot;")) {
        className = match.endsWith(":") ? "json-key" : "json-string";
      } else if (match === "true" || match === "false") {
        className = "json-boolean";
      } else if (match === "null") {
        className = "json-null";
      }
      return `<span class="${className}">${match}</span>`;
    }
  );
}

function hasMaskedSecrets(value) {
  return JSON.stringify(value).includes("***masked***");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
