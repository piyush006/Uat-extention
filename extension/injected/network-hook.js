(function installUatNetworkHook() {
  window.__UAT_SESSION_TRACKER_CAPTURE_ENABLED__ = true;
  if (window.__UAT_SESSION_TRACKER_NETWORK_HOOKED__) return;
  window.__UAT_SESSION_TRACKER_NETWORK_HOOKED__ = true;

  const originalFetch = window.fetch;
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

  window.addEventListener("message", event => {
    if (event.source !== window || event.data?.type !== "UAT_TRACKING_STATE") return;
    window.__UAT_SESSION_TRACKER_CAPTURE_ENABLED__ = Boolean(event.data.enabled);
  });

  window.fetch = async function trackedFetch(input, init = {}) {
    if (!window.__UAT_SESSION_TRACKER_CAPTURE_ENABLED__) {
      return originalFetch.apply(this, arguments);
    }

    const startedAt = performance.now();
    const request = normalizeFetchRequest(input, init);

    try {
      const response = await originalFetch.apply(this, arguments);
      const cloned = response.clone();
      const responseBody = await readResponseBody(cloned);

      emitNetwork({
        ...request,
        status: response.status,
        duration: Math.round(performance.now() - startedAt),
        response: {
          headers: headersToObject(response.headers),
          body: responseBody
        }
      });

      return response;
    } catch (error) {
      emitNetwork({
        ...request,
        status: 0,
        duration: Math.round(performance.now() - startedAt),
        response: { error: error?.message || String(error) }
      });
      throw error;
    }
  };

  XMLHttpRequest.prototype.open = function trackedOpen(method, url) {
    if (!window.__UAT_SESSION_TRACKER_CAPTURE_ENABLED__) {
      return originalOpen.apply(this, arguments);
    }

    this.__uatRequest = {
      method,
      url: new URL(url, location.href).href,
      headers: {}
    };
    return originalOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function trackedSetHeader(key, value) {
    if (this.__uatRequest) this.__uatRequest.headers[key] = value;
    return originalSetRequestHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function trackedSend(body) {
    if (!window.__UAT_SESSION_TRACKER_CAPTURE_ENABLED__) {
      return originalSend.apply(this, arguments);
    }

    const startedAt = performance.now();
    const request = this.__uatRequest || {};
    request.body = parseBody(body);

    this.addEventListener("loadend", () => {
      emitNetwork({
        method: request.method || "GET",
        url: request.url || "",
        request: {
          headers: request.headers || {},
          body: request.body
        },
        status: this.status || 0,
        duration: Math.round(performance.now() - startedAt),
        response: {
          body: parseBody(this.responseText)
        }
      });
    });

    return originalSend.apply(this, arguments);
  };

  function normalizeFetchRequest(input, init) {
    const url = typeof input === "string" ? input : input?.url;
    const method = init.method || input?.method || "GET";
    const headers = headersToObject(init.headers || input?.headers || {});

    return {
      method,
      url: new URL(url, location.href).href,
      request: {
        headers,
        body: parseBody(init.body)
      }
    };
  }

  function headersToObject(headers) {
    if (!headers) return {};
    if (headers instanceof Headers) return Object.fromEntries(headers.entries());
    if (Array.isArray(headers)) return Object.fromEntries(headers);
    return { ...headers };
  }

  async function readResponseBody(response) {
    const contentType = response.headers.get("content-type") || "";
    const text = await response.text().catch(() => "");
    if (!text) return null;
    if (contentType.includes("application/json")) return parseBody(text);
    return text.slice(0, 10000);
  }

  function parseBody(body) {
    if (!body) return null;
    if (typeof body !== "string") return "[binary/form-data body]";

    try {
      return JSON.parse(body);
    } catch {
      return body.slice(0, 10000);
    }
  }

  function emitNetwork(payload) {
    window.postMessage({ type: "UAT_NETWORK_EVENT", payload }, "*");
  }
})();
