(function (global) {
  let requestId = 0;
  // Bump this query string when deploying worker/SDK fixes so Edge does not reuse a stale SharedWorker script.
  const SHARED_SCAN_WORKER_URL =
    "shared-scan-worker.js?v=20260513-edge-sharedworker-7";
  const SHARED_SCAN_WORKER_NAME = "webfxscan-shared-worker";
  const DEBUG_LOG_LIMIT = 200;

  // Page-side proxy for the SharedWorker-owned WebFxScan instance.
  function WebFxScanSharedClient(props) {
    if (typeof global.SharedWorker === "undefined") {
      throw new Error("SharedWorker is not supported by this browser.");
    }

    const self = this;
    // Functions cannot be sent through postMessage, so callbacks stay on the page.
    this._callbacks = {};
    this._props = props || {};
    this._directClient = null;
    this._pendingRequests = {};
    this._clientId = createDebugId("tab");

    // Create the worker lazily after the page has requested Local Network Access.
    this._worker = null;
    this._port = null;
    this._workerReady = null;

    debugLog("client:create", {
      clientId: this._clientId,
      href: global.location ? global.location.href : "",
    });

    const disconnectPort = function () {
      try {
        if (!self._port) return;
        // Tell the worker this tab should no longer receive broadcast events.
        self._port.postMessage({ type: "disconnect", clientId: self._clientId });
        debugLog("client:disconnect", { clientId: self._clientId });
      } catch (error) {
        // Ignore unload-time delivery failures.
      }
    };

    // pagehide covers tab close, reload, and navigation in Chromium more reliably than beforeunload alone.
    global.addEventListener("pagehide", disconnectPort);
    global.addEventListener("beforeunload", disconnectPort);
  }

  WebFxScanSharedClient.prototype.connect = function (props) {
    const self = this;
    const {
      ip = "localhost",
      port = "17778",
      errorCallback = function () {},
      closeCallback = function () {},
      eventCallback = function () {},
      ipExceptionCallback = function () {},
    } = props || {};

    // Keep original connect callbacks local and let worker events call them later.
    this._callbacks.errorCallback = errorCallback;
    this._callbacks.closeCallback = closeCallback;
    this._callbacks.eventCallback = eventCallback;
    this._callbacks.ipExceptionCallback = ipExceptionCallback;

    if (this._directClient) {
      return this._directClient.connect(props);
    }

    return ensureLocalNetworkAccess(self, ip, port)
      .then(function () {
        // Build the SharedWorker only after Edge/Chrome has had a chance to grant localhost access.
        return ensureWorker(self);
      })
      .then(function () {
        return request(self, "connect", { ip, port }).catch(function (error) {
          // Some Chromium builds allow page WebSockets to localhost but reject
          // the same localhost WSS connection when it originates in a SharedWorker.
          if (error && error.error === 9007 && isDirectFallbackAllowed()) {
            return switchToDirectClient(self, props, error);
          }

          if (error && error.error === 9007) {
            debugLog("shared-worker-connect-failed-no-fallback", {
              clientId: self._clientId,
              error,
            });
          }

          throw error;
        });
      });
  };

  WebFxScanSharedClient.prototype.close = function () {
    if (this._directClient) return this._directClient.close();
    return request(this, "close");
  };

  WebFxScanSharedClient.prototype.init = function () {
    if (this._directClient) return this._directClient.init();
    return request(this, "init");
  };

  WebFxScanSharedClient.prototype.getDeviceList = function () {
    if (this._directClient) return this._directClient.getDeviceList();
    return request(this, "getDeviceList");
  };

  WebFxScanSharedClient.prototype.getFileList = function () {
    if (this._directClient) return this._directClient.getFileList();
    return request(this, "getFileList");
  };

  WebFxScanSharedClient.prototype.setScanner = function (props) {
    if (this._directClient) return this._directClient.setScanner(props || {});
    return request(this, "setScanner", props || {});
  };

  WebFxScanSharedClient.prototype.setAutoScanCallback = function (props) {
    const { callback = function () {} } = props || {};
    // The worker broadcasts auto-scan events; this tab invokes its own UI callback.
    this._callbacks.autoScanCallback = callback;
    if (this._directClient) return this._directClient.setAutoScanCallback(props || {});
    return request(this, "setAutoScanCallback");
  };

  WebFxScanSharedClient.prototype.setBeforeAutoScanCallback = function (props) {
    const { callback = function () {} } = props || {};
    // Keep the UI loading-mask callback on the page.
    this._callbacks.beforeAutoScanCallback = callback;
    if (this._directClient) return this._directClient.setBeforeAutoScanCallback(props || {});
    return request(this, "setBeforeAutoScanCallback");
  };

  WebFxScanSharedClient.prototype.scan = function (props) {
    const {
      callback = null,
      eventCallback = null,
      timeout = null,
      hideBase64 = false,
    } = props || {};

    if (typeof callback === "function") {
      // Scan progress callbacks belong to the tab that started the scan.
      this._callbacks.scanCallback = callback;
    }

    if (typeof eventCallback === "function") {
      this._callbacks.scanEventCallback = eventCallback;
    }

    if (this._directClient) return this._directClient.scan(props || {});
    return request(this, "scan", { timeout, hideBase64 });
  };

  WebFxScanSharedClient.prototype.convert = function (props) {
    if (this._directClient) return this._directClient.convert(props || {});
    return request(this, "convert", props || {});
  };

  WebFxScanSharedClient.prototype.exportPdf = function (filelist) {
    if (this._directClient) return this._directClient.exportPdf(filelist);
    return request(this, "exportPdf", { filelist });
  };

  WebFxScanSharedClient.prototype.rotate = function (props) {
    if (this._directClient) return this._directClient.rotate(props || {});
    return request(this, "rotate", props || {});
  };

  WebFxScanSharedClient.prototype.deleteAll = function () {
    if (this._directClient) return this._directClient.deleteAll();
    return request(this, "deleteAll");
  };

  WebFxScanSharedClient.prototype.deleteFile = function (filename) {
    if (this._directClient) return this._directClient.deleteFile(filename);
    return request(this, "deleteFile", { filename });
  };

  WebFxScanSharedClient.prototype.getVersion = function () {
    if (this._directClient) return this._directClient.getVersion();
    // Read the static SDK version in the page so version display does not create the worker too early.
    return new WebFxScan(this._props).getVersion();
  };

  WebFxScanSharedClient.prototype.calibrate = function () {
    if (this._directClient) return this._directClient.calibrate();
    return request(this, "calibrate");
  };

  WebFxScanSharedClient.prototype.setSocketMsgCollector = function (props) {
    const { callback = function () {} } = props || {};
    // Log collection stays page-local while socket traffic is observed in the worker.
    this._callbacks.socketMsgCollector = callback;
    if (this._directClient) return this._directClient.setSocketMsgCollector(props || {});
    return request(this, "setSocketMsgCollector");
  };

  WebFxScanSharedClient.prototype.ejectPaper = function (props) {
    if (this._directClient) return this._directClient.ejectPaper(props || {});
    return request(this, "ejectPaper", props || {});
  };

  WebFxScanSharedClient.prototype.getPaperStatus = function () {
    if (this._directClient) return this._directClient.getPaperStatus();
    return request(this, "getPaperStatus");
  };

  function request(client, method, args) {
    const id = ++requestId;

    return ensureWorker(client).then(function () {
      return new Promise(function (resolve, reject) {
        // Match worker responses back to the original SDK-like Promise.
        client._pendingRequests[id] = { resolve, reject };
        debugLog("request:send", {
          clientId: client._clientId,
          id,
          method,
          args: summarizeForLog(args || {}),
        });

        try {
          client._port.postMessage({
            type: "request",
            id,
            method,
            clientId: client._clientId,
            args: stripFunctions(args || {}),
          });
        } catch (error) {
          delete client._pendingRequests[id];
          debugLog("request:postMessage-error", {
            clientId: client._clientId,
            id,
            method,
            message: error.message || String(error),
          });
          reject({
            result: false,
            message: error.message || "Failed to post request to SharedWorker.",
            error: 9999,
          });
        }
      });
    });
  }

  function ensureWorker(client) {
    if (client._port) {
      return client._workerReady || Promise.resolve(client._port);
    }

    if (client._workerReady) {
      return client._workerReady;
    }

    client._workerReady = new Promise(function (resolve, reject) {
      let settled = false;
      let readyTimer = null;

      const settleOk = function () {
        if (settled) return;
        settled = true;
        clearTimeout(readyTimer);
        global.__webfxScanTransport = "shared-worker";
        resolve(client._port);
      };

      const settleError = function (error) {
        if (settled) return;
        settled = true;
        clearTimeout(readyTimer);
        client._workerReady = null;
        reject(error);
      };

      try {
        // One SharedWorker instance is shared by tabs with the same browser profile, origin, name, and URL.
        client._worker = new SharedWorker(
          SHARED_SCAN_WORKER_URL,
          SHARED_SCAN_WORKER_NAME
        );
        client._port = client._worker.port;

        client._port.onmessage = function (event) {
          if (event.data && event.data.type === "ready") {
            debugLog("worker:ready", event.data.data || {});
            settleOk();
            return;
          }

          handleWorkerMessage(client, event.data);
        };

        client._port.onmessageerror = function (event) {
          console.warn("[SharedScanClient] Worker message clone failed:", event);
        };

        client._worker.onerror = function (event) {
          const error = {
            result: false,
            message: event.message || "SharedWorker error.",
            error: 9999,
          };

          rejectAllPending(client, error);
          client._worker = null;
          client._port = null;
          client._workerReady = null;
          settleError(error);
        };

        client._port.start();
        client._port.postMessage({
          type: "client-ready",
          clientId: client._clientId,
          href: global.location ? global.location.href : "",
          // Strip functions before crossing the worker boundary.
          props: stripFunctions(client._props || {}),
        });

        readyTimer = setTimeout(function () {
          // Older cached workers may not send a ready message; continue so the real request can report the SDK error.
          settleOk();
        }, 1500);
      } catch (error) {
        client._worker = null;
        client._port = null;
        client._workerReady = null;
        settleError({
          result: false,
          message: error.message || "Failed to create SharedWorker.",
          error: 9999,
        });
      }
    });

    return client._workerReady;
  }

  function switchToDirectClient(client, connectProps, originalError) {
    console.warn(
      "[SharedScanClient] SharedWorker WSS connect failed with 9007; falling back to page WebSocket because directFallback=1 is set.",
      originalError
    );

    client._directClient = new WebFxScan(client._props);
    global.__webfxScanTransport = "direct-fallback";
    return client._directClient.connect(connectProps);
  }

  function isDirectFallbackAllowed() {
    // Keep fallback opt-in only; otherwise 1014 can look like a SharedWorker issue when it is direct mode.
    if (!global.location || !global.location.search) return false;
    return new URLSearchParams(global.location.search).get("directFallback") === "1";
  }

  function ensureLocalNetworkAccess(client, ip, port) {
    // Chrome's Local Network Access prompt must be triggered from the page.
    // SharedWorker local requests can fail if the site has not been granted permission yet.
    if (typeof global.fetch !== "function" || !isLikelyLoopbackHost(ip)) {
      return Promise.resolve();
    }

    const protocol = global.location ? global.location.protocol : "";
    if (protocol !== "https:") {
      return Promise.resolve();
    }

    const url = `https://${ip}:${port}/?lna=${Date.now()}`;
    const controller =
      typeof AbortController !== "undefined" ? new AbortController() : null;
    const timeoutMs = 30000;
    const timeoutId = setTimeout(function () {
      if (controller) controller.abort();
    }, timeoutMs);

    debugLog("lna:warmup-start", {
      clientId: client._clientId,
      url,
      timeoutMs,
    });

    return fetch(url, {
        mode: "no-cors",
        cache: "no-store",
        targetAddressSpace: "local",
        signal: controller ? controller.signal : undefined,
      })
      .then(function () {
        clearTimeout(timeoutId);
        debugLog("lna:warmup-ok", {
          clientId: client._clientId,
          url,
        });
      })
      .catch(function (error) {
        clearTimeout(timeoutId);
        const isTimeout = error && error.name === "AbortError";
        debugLog(isTimeout ? "lna:warmup-timeout" : "lna:warmup-error", {
          clientId: client._clientId,
          url,
          message: error && error.message ? error.message : String(error),
        });

        throw {
          result: false,
          message: isTimeout
            ? "Local Network Access permission was not granted within 30 seconds. Please allow this site to access localhost and try again."
            : "Local Network Access warm-up failed. Please open https://localhost:17778/ in this Edge profile, trust the certificate, allow local network access, and try again.",
          error: 9007,
          data: {
            localNetworkAccess: isTimeout ? "timeout" : "failed",
          },
        };
      });
  }

  function isLikelyLoopbackHost(host) {
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "[::1]"
    );
  }

  function handleWorkerMessage(client, message) {
    if (!message || typeof message !== "object") return;

    if (message.type === "debug") {
      debugLog("worker:" + message.event, message.data || {});
      return;
    }

    if (message.type === "response") {
      // Resolve or reject the Promise created by request().
      const pending = client._pendingRequests[message.id];
      if (!pending) return;

      delete client._pendingRequests[message.id];

      if (message.ok) {
        debugLog("response:ok", {
          clientId: client._clientId,
          id: message.id,
          method: message.method || "",
          result: summarizeForLog(message.result || {}),
        });
        pending.resolve(message.result);
      } else {
        debugLog("response:error", {
          clientId: client._clientId,
          id: message.id,
          method: message.method || "",
          error: message.error || {},
        });
        pending.reject(message.error);
      }
      return;
    }

    if (message.type === "event") {
      // Worker events represent SDK callbacks that cannot cross as functions.
      handleWorkerEvent(client, message.event, message.args || {});
    }
  }

  function handleWorkerEvent(client, eventName, args) {
    // Translate worker event names back into the callback shape used by main.js.
    switch (eventName) {
      case "connectEvent":
        callIfFunction(client._callbacks.eventCallback, args.code, args.data);
        break;
      case "connectError":
        callIfFunction(client._callbacks.errorCallback, args.event);
        break;
      case "close":
        callIfFunction(client._callbacks.closeCallback, args.event);
        break;
      case "ipException":
        callIfFunction(client._callbacks.ipExceptionCallback, args.dataObj);
        break;
      case "autoScan":
        callIfFunction(
          client._callbacks.autoScanCallback,
          args.file,
          args.errCode
        );
        break;
      case "beforeAutoScan":
        callIfFunction(client._callbacks.beforeAutoScanCallback);
        break;
      case "scanCallback":
        callIfFunction(client._callbacks.scanCallback, args.file);
        break;
      case "scanEvent":
        callIfFunction(client._callbacks.scanEventCallback, args.code);
        break;
      case "socketMsg":
        callIfFunction(
          client._callbacks.socketMsgCollector,
          args.log,
          args.msgType
        );
        break;
      default:
        console.warn("[SharedScanClient] Unknown worker event:", eventName);
    }
  }

  function callIfFunction(callback) {
    if (typeof callback !== "function") return;

    const args = Array.prototype.slice.call(arguments, 1);
    callback.apply(null, args);
  }

  function rejectAllPending(client, error) {
    // Worker startup failures should reject every outstanding API call.
    Object.keys(client._pendingRequests).forEach(function (id) {
      client._pendingRequests[id].reject(error);
      delete client._pendingRequests[id];
    });
  }

  function stripFunctions(value) {
    // Structured clone cannot transfer functions, so remove them recursively.
    if (typeof value === "function") return undefined;
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(stripFunctions);

    const result = {};
    Object.keys(value).forEach(function (key) {
      const fixedValue = stripFunctions(value[key]);
      if (typeof fixedValue !== "undefined") {
        result[key] = fixedValue;
      }
    });
    return result;
  }

  function createDebugId(prefix) {
    return `${prefix}-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
  }

  function debugLog(eventName, data) {
    // Keep a small page-side log so support can copy it from DevTools.
    const entry = {
      time: new Date().toISOString(),
      event: eventName,
      data: data || {},
    };

    global.__webfxScanDebug = global.__webfxScanDebug || [];
    global.__webfxScanDebug.push(entry);
    if (global.__webfxScanDebug.length > DEBUG_LOG_LIMIT) {
      global.__webfxScanDebug.shift();
    }

    if (global.console && typeof global.console.log === "function") {
      global.console.log("[SharedScanClient]", eventName, data || {});
    }
  }

  function summarizeForLog(value) {
    // Avoid logging scanned image/base64 payloads while still showing which API/config was used.
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return { type: "array", length: value.length };

    const result = {};
    Object.keys(value).forEach(function (key) {
      const currentValue = value[key];
      if (key.toLowerCase().includes("base64")) {
        result[key] = "[base64 omitted]";
      } else if (typeof currentValue === "string" && currentValue.length > 120) {
        result[key] = currentValue.slice(0, 120) + "...";
      } else if (currentValue && typeof currentValue === "object") {
        result[key] = summarizeForLog(currentValue);
      } else {
        result[key] = currentValue;
      }
    });
    return result;
  }

  global.WebFxScanSharedClient = WebFxScanSharedClient;
  global.createWebFxScanClient = function (props) {
    global.__webfxScanDebug = global.__webfxScanDebug || [];
    // SharedWorker requires a real origin; file:// would create unsafe fallback behavior.
    if (global.location && global.location.protocol === "file:") {
      throwSharedWorkerSetupError(
        "SharedWorker cannot be used reliably from file://. Please open this demo from a local web server, for example http://127.0.0.1:18080/."
      );
    }

    if (typeof global.SharedWorker === "undefined") {
      // Do not fall back to direct mode because that opens one scanner session per tab.
      throwSharedWorkerSetupError(
        "SharedWorker is not supported by this browser. This demo will not fall back to direct WebSocket mode because that can open the scanner more than once."
      );
    }

    try {
      const client = new WebFxScanSharedClient(props);
      // Debug flag for checking the active transport from DevTools.
      global.__webfxScanTransport = "shared-worker-pending";
      return client;
    } catch (error) {
      throwSharedWorkerSetupError(
        "Failed to create SharedWorker. Please open this demo from the same local web server URL in every tab.",
        error
      );
    }
  };

  function throwSharedWorkerSetupError(message, originalError) {
    global.__webfxScanTransport = "shared-worker-unavailable";
    console.error("[SharedScanClient]", message, originalError || "");
    alert(message);
    throw originalError || new Error(message);
  }
})(window);
