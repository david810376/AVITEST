// Versioned import avoids stale SDK code when the hosted demo is redeployed.
importScripts("scan.js?v=20260513-edge-sharedworker-10");

// The worker owns the only real WebFxScan instance for this browser origin.
const WORKER_VERSION = "20260513-edge-sharedworker-10";
const workerId = createDebugId("worker");
const scanInstance = new WebFxScan({ mode: "dev" });
const ports = new Set();
const portIds = new Map();
let nextPortId = 0;

// Serialize scanner commands because WebScan2 rejects overlapping API calls.
let requestQueue = Promise.resolve();
let connectState = "idle";
let connectPromise = null;
let initialized = false;
let initResult = null;
let deviceListResult = null;

// Cache the last scanner setup so a second tab does not re-open the same device.
let scannerConfigKey = null;
let scannerConfigResult = null;

// SDK callbacks are registered once in the worker, then broadcast back to pages.
let autoScanCallbackEnabled = false;
let beforeAutoScanCallbackEnabled = false;
let socketMsgCollectorEnabled = false;

self.onconnect = function (event) {
  const port = event.ports[0];
  const portId = ++nextPortId;
  ports.add(port);
  portIds.set(port, portId);
  broadcastDebug("connect-port", getWorkerState({ portId }));

  port.onmessage = function (messageEvent) {
    handlePortMessage(port, messageEvent.data);
  };

  port.start();
};

function handlePortMessage(port, message) {
  if (!message || typeof message !== "object") return;

  // Remove closed tabs from the broadcast list.
  if (message.type === "disconnect") {
    const portId = getPortId(port);
    ports.delete(port);
    portIds.delete(port);
    broadcastDebug("disconnect-port", getWorkerState({ portId }));
    if (ports.size === 0) {
      // When the last tab leaves, release WebScan2 so another browser/app can open the scanner.
      broadcastDebug("close-last-port", getWorkerState({ portId }));
      closeConnection().catch((error) => {
        console.warn("[SharedScanWorker] close after disconnect failed:", error);
        broadcastDebug("close-last-port-error", {
          ...getWorkerState({ portId }),
          error: serializeError(error),
        });
      });
    }
    return;
  }

  if (message.type === "client-ready") {
    // Let the page know the worker loaded successfully before it sends scanner commands.
    const portId = getPortId(port);
    const readyState = getWorkerState({
      portId,
      clientId: message.clientId || "",
      href: message.href || "",
    });
    broadcastDebug("client-ready", readyState);
    postToPort(port, { type: "ready", data: readyState });
    return;
  }

  if (message.type !== "request") return;

  const { id, method, args = {} } = message;
  const portId = getPortId(port);
  broadcastDebug(
    "request-start",
    getWorkerState({
      portId,
      clientId: message.clientId || "",
      id,
      method,
      args: summarizeForLog(args),
    })
  );
  // Callback registration and version reads do not touch the scanner command queue.
  const run = isImmediateMethod(method)
    ? executeMethod(port, method, args)
    : enqueueRequest(() => executeMethod(port, method, args));

  Promise.resolve(run)
    .then((result) => {
      broadcastDebug(
        "request-ok",
        getWorkerState({
          portId,
          clientId: message.clientId || "",
          id,
          method,
          result: summarizeForLog(result),
        })
      );
      postToPort(port, {
        type: "response",
        id,
        method,
        ok: true,
        result,
      });
    })
    .catch((error) => {
      const serializedError = serializeError(error);
      broadcastDebug(
        "request-error",
        getWorkerState({
          portId,
          clientId: message.clientId || "",
          id,
          method,
          error: serializedError,
        })
      );
      postToPort(port, {
        type: "response",
        id,
        method,
        ok: false,
        error: serializedError,
      });
    });
}

function isImmediateMethod(method) {
  return [
    "getVersion",
    "setAutoScanCallback",
    "setBeforeAutoScanCallback",
    "setSocketMsgCollector",
  ].includes(method);
}

function enqueueRequest(task) {
  // Keep the chain alive even if one command fails.
  const run = requestQueue.then(task, task);
  requestQueue = run.catch(() => {});
  return run;
}

async function executeMethod(port, method, args) {
  switch (method) {
    case "connect":
      return connectOnce(args);
    case "close":
      return closeConnection();
    case "init":
      return initOnce();
    case "getVersion":
      return scanInstance.getVersion();
    case "getDeviceList":
      return getDeviceListOnce();
    case "getFileList":
      return scanInstance.getFileList();
    case "setScanner":
      // Avoid sending duplicate open/set-device commands from every tab.
      return setScannerOnce(args);
    case "scan":
      return scanInstance.scan({
        ...args,
        // Per-scan callbacks belong to the requesting tab only.
        callback: (file) => {
          postEvent(port, "scanCallback", { file });
        },
        eventCallback: (code) => {
          postEvent(port, "scanEvent", { code });
        },
      });
    case "convert":
      return scanInstance.convert(args);
    case "exportPdf":
      return scanInstance.exportPdf(args.filelist);
    case "rotate":
      return scanInstance.rotate(args);
    case "deleteAll":
      return scanInstance.deleteAll();
    case "deleteFile":
      return scanInstance.deleteFile(args.filename);
    case "calibrate":
      return scanInstance.calibrate();
    case "ejectPaper":
      return scanInstance.ejectPaper(args);
    case "getPaperStatus":
      return scanInstance.getPaperStatus();
    case "setAutoScanCallback":
      return enableAutoScanCallback();
    case "setBeforeAutoScanCallback":
      return enableBeforeAutoScanCallback();
    case "setSocketMsgCollector":
      return enableSocketMsgCollector();
    default:
      throw {
        result: false,
        message: `SharedWorker API is not supported: ${method}`,
        error: 9001,
      };
  }
}

function connectOnce(args = {}) {
  // If a tab already opened the socket, later tabs reuse it.
  if (isSocketOpen()) {
    connectState = "connected";
    return Promise.resolve(successResponse({ alreadyConnected: true }));
  }

  if (connectState === "connecting" && connectPromise) {
    return connectPromise;
  }

  // WebScan2 is configured for WSS on localhost in LibWebFxScan.ini.
  connectState = "connecting";
  connectPromise = scanInstance
    .connect({
      ip: args.ip || "localhost",
      port: args.port || "17778",
      errorCallback: (event) => {
        // A failed socket invalidates cached initialization state.
        connectState = "idle";
        initialized = false;
        initResult = null;
        deviceListResult = null;
        scannerConfigKey = null;
        scannerConfigResult = null;
        broadcastEvent("connectError", { event: serializeSocketEvent(event) });
      },
      closeCallback: (event) => {
        // If WebScan2 closes, later tabs must reconnect and reinitialize.
        connectState = "idle";
        initialized = false;
        initResult = null;
        deviceListResult = null;
        scannerConfigKey = null;
        scannerConfigResult = null;
        broadcastEvent("close", { event: serializeSocketEvent(event) });
      },
      eventCallback: (code, data) => {
        broadcastEvent("connectEvent", { code, data });
      },
      ipExceptionCallback: (dataObj) => {
        broadcastEvent("ipException", { dataObj });
      },
    })
    .then((result) => {
      connectState = "connected";
      return result;
    })
    .catch((error) => {
      connectState = "idle";
      throw error;
    })
    .finally(() => {
      connectPromise = null;
    });

  return connectPromise;
}

async function closeConnection() {
  // Closing the shared socket clears all state owned by this worker.
  broadcastDebug("close-connection", getWorkerState({}));
  initialized = false;
  initResult = null;
  deviceListResult = null;
  scannerConfigKey = null;
  scannerConfigResult = null;
  connectState = "idle";
  return scanInstance.close();
}

async function initOnce() {
  // LibWFX_Init only needs to run once per shared socket.
  if (initialized && initResult) {
    broadcastDebug("init-cache-hit", getWorkerState({ result: initResult }));
    return initResult;
  }

  try {
    initResult = await scanInstance.init();
    initialized = true;
    broadcastDebug("init-ok", getWorkerState({ result: initResult }));
    return initResult;
  } catch (error) {
    // WebScan2 can report 1014 when another tab already initialized the shared service.
    if (isServerOccupiedError(error)) {
      initialized = true;
      initResult = successResponse({
        alreadyInitialized: true,
        originalError: getErrorCode(error),
      });
      broadcastDebug("init-occupied-treated-as-ok", {
        ...getWorkerState({ result: initResult }),
        error: serializeError(error),
      });
      return initResult;
    }

    broadcastDebug("init-error", {
      ...getWorkerState({}),
      error: serializeError(error),
    });
    throw error;
  }
}

async function getDeviceListOnce() {
  // Device options are the same for every tab in this shared browser session.
  if (deviceListResult) {
    broadcastDebug(
      "get-device-list-cache-hit",
      getWorkerState({ result: summarizeForLog(deviceListResult) })
    );
    return deviceListResult;
  }

  try {
    deviceListResult = await scanInstance.getDeviceList();
    broadcastDebug(
      "get-device-list-ok",
      getWorkerState({ result: summarizeForLog(deviceListResult) })
    );
    return deviceListResult;
  } catch (error) {
    if (isServerOccupiedError(error) && deviceListResult) {
      broadcastDebug("get-device-list-occupied-cache-hit", {
        ...getWorkerState({ result: summarizeForLog(deviceListResult) }),
        error: serializeError(error),
      });
      return deviceListResult;
    }

    broadcastDebug("get-device-list-error", {
      ...getWorkerState({}),
      error: serializeError(error),
    });
    throw error;
  }
}

async function setScannerOnce(args = {}) {
  // Use a stable key so property order differences do not cause duplicate setup.
  const nextConfigKey = stableStringify(args);

  if (scannerConfigKey === nextConfigKey && scannerConfigResult) {
    broadcastDebug(
      "set-scanner-cache-hit",
      getWorkerState({ scannerConfigKey })
    );
    return successResponse({ alreadyConfigured: true });
  }

  try {
    const result = await scanInstance.setScanner(args);
    // Save successful configuration for later tabs with the same scanner settings.
    scannerConfigKey = nextConfigKey;
    scannerConfigResult = result;
    broadcastDebug(
      "set-scanner-ok",
      getWorkerState({ scannerConfigKey, result: summarizeForLog(result) })
    );
    return result;
  } catch (error) {
    // WebScan2 can return 1014 when the same scanner is already open.
    if (isServerOccupiedError(error)) {
      scannerConfigKey = nextConfigKey;
      scannerConfigResult = successResponse({
        alreadyConfigured: true,
        originalError: getErrorCode(error),
      });
      broadcastDebug("set-scanner-occupied-treated-as-ok", {
        ...getWorkerState({ scannerConfigKey, result: scannerConfigResult }),
        error: serializeError(error),
      });
      return scannerConfigResult;
    }

    broadcastDebug("set-scanner-error", {
      ...getWorkerState({ scannerConfigKey }),
      error: serializeError(error),
    });
    throw error;
  }
}

function isServerOccupiedError(error) {
  // Normalize the SDK's busy/open-device error so init and setScanner can share handling.
  return getErrorCode(error) === 1014;
}

function getErrorCode(error) {
  if (!error || typeof error !== "object") return 0;
  return error.error || error.errCode || error.code || 0;
}

function enableAutoScanCallback() {
  // Only register the SDK callback once; each event is broadcast to all tabs.
  if (autoScanCallbackEnabled) {
    return Promise.resolve(successResponse({ alreadyEnabled: true }));
  }

  autoScanCallbackEnabled = true;
  return scanInstance.setAutoScanCallback({
    callback: (file, errCode) => {
      broadcastEvent("autoScan", { file, errCode });
    },
  });
}

function enableBeforeAutoScanCallback() {
  // Button-push/auto-scan preparation should be shared across all tabs.
  if (beforeAutoScanCallbackEnabled) {
    return Promise.resolve(successResponse({ alreadyEnabled: true }));
  }

  beforeAutoScanCallbackEnabled = true;
  return scanInstance.setBeforeAutoScanCallback({
    callback: () => {
      broadcastEvent("beforeAutoScan", {});
    },
  });
}

function enableSocketMsgCollector() {
  // Socket message logging is global because the worker owns the socket.
  if (socketMsgCollectorEnabled) {
    return Promise.resolve(successResponse({ alreadyEnabled: true }));
  }

  socketMsgCollectorEnabled = true;
  return scanInstance.setSocketMsgCollector({
    callback: (log, msgType) => {
      broadcastEvent("socketMsg", { log, msgType });
    },
  });
}

function isSocketOpen() {
  // Reach into the SDK state to detect whether the shared WebSocket is reusable.
  const socket = scanInstance?.serverInstance?.state?.socket;
  return socket && socket.readyState === WebSocket.OPEN;
}

function successResponse(data = {}) {
  return {
    result: true,
    data,
    message: "OK",
  };
}

function stableStringify(value) {
  // JSON.stringify preserves insertion order, so sort keys before caching configs.
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

function postEvent(port, eventName, args = {}) {
  postToPort(port, {
    type: "event",
    event: eventName,
    args,
  });
}

function broadcastEvent(eventName, args = {}) {
  // Shared callbacks such as auto-scan must notify every connected tab.
  ports.forEach((port) => {
    postEvent(port, eventName, args);
  });
}

function postToPort(port, message) {
  try {
    port.postMessage(message);
  } catch (error) {
    console.warn("[SharedScanWorker] postMessage failed:", error);
  }
}

function broadcastDebug(eventName, data = {}) {
  // Send worker diagnostics to page consoles so remote users can copy one log stream.
  const message = {
    type: "debug",
    event: eventName,
    data: {
      time: new Date().toISOString(),
      workerId,
      version: WORKER_VERSION,
      ...data,
    },
  };

  ports.forEach((port) => {
    postToPort(port, message);
  });
}

function getWorkerState(extra = {}) {
  return {
    portCount: ports.size,
    connectState,
    initialized,
    hasInitResult: Boolean(initResult),
    hasScannerConfig: Boolean(scannerConfigKey),
    socketReadyState: getSocketReadyState(),
    ...extra,
  };
}

function getSocketReadyState() {
  const socket = scanInstance?.serverInstance?.state?.socket;
  if (!socket) return "none";

  switch (socket.readyState) {
    case WebSocket.CONNECTING:
      return "CONNECTING";
    case WebSocket.OPEN:
      return "OPEN";
    case WebSocket.CLOSING:
      return "CLOSING";
    case WebSocket.CLOSED:
      return "CLOSED";
    default:
      return String(socket.readyState);
  }
}

function getPortId(port) {
  return portIds.get(port) || 0;
}

function createDebugId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function summarizeForLog(value) {
  // Avoid logging scanned image/base64 payloads while still showing which API/config was used.
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return { type: "array", length: value.length };

  const result = {};
  Object.keys(value).forEach((key) => {
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

function serializeSocketEvent(event) {
  // Browser socket events are not safely structured-cloneable as-is.
  if (!event || typeof event !== "object") {
    return {};
  }

  return {
    type: event.type || "",
    code: event.code || 0,
    reason: event.reason || "",
    wasClean: Boolean(event.wasClean),
    message: event.message || "",
  };
}

function serializeError(error) {
  // Keep rejected worker responses in the same shape as the original SDK errors.
  if (!error || typeof error !== "object") {
    return {
      result: false,
      message: String(error || "unknown"),
      error: 9999,
    };
  }

  return {
    result: error.result === false ? false : false,
    message: error.message || String(error),
    error: error.error || error.errCode || 9999,
    data: error.data || {},
  };
}
