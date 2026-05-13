(function (global) {
  let requestId = 0;

  // Page-side proxy for the SharedWorker-owned WebFxScan instance.
  function WebFxScanSharedClient(props) {
    if (typeof global.SharedWorker === "undefined") {
      throw new Error("SharedWorker is not supported by this browser.");
    }

    const self = this;
    // Functions cannot be sent through postMessage, so callbacks stay on the page.
    this._callbacks = {};
    this._pendingRequests = {};

    // One SharedWorker instance is shared by tabs with the same browser profile and origin.
    this._worker = new SharedWorker(
      "shared-scan-worker.js",
      "webfxscan-shared-worker"
    );
    this._port = this._worker.port;

    this._port.onmessage = function (event) {
      handleWorkerMessage(self, event.data);
    };

    this._worker.onerror = function (event) {
      rejectAllPending(self, {
        result: false,
        message: event.message || "SharedWorker error.",
        error: 9999,
      });
    };

    this._port.start();
    this._port.postMessage({
      type: "client-ready",
      // Strip functions before crossing the worker boundary.
      props: stripFunctions(props || {}),
    });

    global.addEventListener("beforeunload", function () {
      try {
        // Tell the worker this tab should no longer receive broadcast events.
        self._port.postMessage({ type: "disconnect" });
      } catch (error) {
        // Ignore unload-time delivery failures.
      }
    });
  }

  WebFxScanSharedClient.prototype.connect = function (props) {
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

    return request(this, "connect", { ip, port });
  };

  WebFxScanSharedClient.prototype.close = function () {
    return request(this, "close");
  };

  WebFxScanSharedClient.prototype.init = function () {
    return request(this, "init");
  };

  WebFxScanSharedClient.prototype.getDeviceList = function () {
    return request(this, "getDeviceList");
  };

  WebFxScanSharedClient.prototype.getFileList = function () {
    return request(this, "getFileList");
  };

  WebFxScanSharedClient.prototype.setScanner = function (props) {
    return request(this, "setScanner", props || {});
  };

  WebFxScanSharedClient.prototype.setAutoScanCallback = function (props) {
    const { callback = function () {} } = props || {};
    // The worker broadcasts auto-scan events; this tab invokes its own UI callback.
    this._callbacks.autoScanCallback = callback;
    return request(this, "setAutoScanCallback");
  };

  WebFxScanSharedClient.prototype.setBeforeAutoScanCallback = function (props) {
    const { callback = function () {} } = props || {};
    // Keep the UI loading-mask callback on the page.
    this._callbacks.beforeAutoScanCallback = callback;
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

    return request(this, "scan", { timeout, hideBase64 });
  };

  WebFxScanSharedClient.prototype.convert = function (props) {
    return request(this, "convert", props || {});
  };

  WebFxScanSharedClient.prototype.exportPdf = function (filelist) {
    return request(this, "exportPdf", { filelist });
  };

  WebFxScanSharedClient.prototype.rotate = function (props) {
    return request(this, "rotate", props || {});
  };

  WebFxScanSharedClient.prototype.deleteAll = function () {
    return request(this, "deleteAll");
  };

  WebFxScanSharedClient.prototype.deleteFile = function (filename) {
    return request(this, "deleteFile", { filename });
  };

  WebFxScanSharedClient.prototype.getVersion = function () {
    return request(this, "getVersion");
  };

  WebFxScanSharedClient.prototype.calibrate = function () {
    return request(this, "calibrate");
  };

  WebFxScanSharedClient.prototype.setSocketMsgCollector = function (props) {
    const { callback = function () {} } = props || {};
    // Log collection stays page-local while socket traffic is observed in the worker.
    this._callbacks.socketMsgCollector = callback;
    return request(this, "setSocketMsgCollector");
  };

  WebFxScanSharedClient.prototype.ejectPaper = function (props) {
    return request(this, "ejectPaper", props || {});
  };

  WebFxScanSharedClient.prototype.getPaperStatus = function () {
    return request(this, "getPaperStatus");
  };

  function request(client, method, args) {
    const id = ++requestId;

    return new Promise(function (resolve, reject) {
      // Match worker responses back to the original SDK-like Promise.
      client._pendingRequests[id] = { resolve, reject };
      client._port.postMessage({
        type: "request",
        id,
        method,
        args: stripFunctions(args || {}),
      });
    });
  }

  function handleWorkerMessage(client, message) {
    if (!message || typeof message !== "object") return;

    if (message.type === "response") {
      // Resolve or reject the Promise created by request().
      const pending = client._pendingRequests[message.id];
      if (!pending) return;

      delete client._pendingRequests[message.id];

      if (message.ok) {
        pending.resolve(message.result);
      } else {
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

  global.WebFxScanSharedClient = WebFxScanSharedClient;
  global.createWebFxScanClient = function (props) {
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
      global.__webfxScanTransport = "shared-worker";
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
