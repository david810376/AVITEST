$(document).ready(function () {
  const isDebug = false;

  // --- 1. Shared Worker 初始化 ---
  let mySharedWorker;
  if (window.SharedWorker) {
    try {
      // 建立 worker 實例 (請確保目錄下有 worker.js)
      mySharedWorker = new SharedWorker('worker.js');
      
      // 啟動通訊埠
      mySharedWorker.port.start();

      // 監聽來自 Worker 的同步訊息
      mySharedWorker.port.onmessage = function (e) {
        const { type, payload, activeConnections } = e.data;
        console.log(`[SharedWorker] 收到類型: ${type}, 目前連線數: ${activeConnections}`);
        
        // 範例：如果其他分頁掃描完成了，本頁面也記錄一條 Log
        if (type === 'SCAN_COMPLETED') {
          view.addLogEntry(JSON.stringify({ 
            info: "其他分頁已完成掃描", 
            count: payload.count 
          }), "down");
        }
      };

      console.log('Shared Worker 連線成功');
    } catch (err) {
      console.error('Shared Worker 初始化失敗:', err);
    }
  }

  /*** Events ***/
  // send scan command to server
  $("#scan").on("click", async function () {
    try {
      view.displayLoadingMask(true);
      const { result, message, data, error } = await MyScan.scan();
      if (result) {
        imageAction.clear();
        view.displayLoadingMask(false);
        data.map((file) => {
          imageAction.addImage(file);
        });
        imageAction.updateTotal(data.length);
        imageAction.to(1);

        // --- 2. 掃描成功後，透過 Shared Worker 通知其他分頁 ---
        if (mySharedWorker) {
          mySharedWorker.port.postMessage({
            type: 'SCAN_COMPLETED',
            payload: { count: data.length, timestamp: Date.now() }
          });
        }

      } else {
        console.log(error);
      }
    } catch (e) {
      console.warn(e);
      view.displayLoadingMask(false);
      const { error = "unknown" } = e;
      alert(`Scan error: ${error}`);
    }
  });

  // form component change event
  $("#device-name").on("change", async function (e) {
    const selectedDeviceName = this.value;
    
    // 找到選中設備的完整資訊
    const selectedDevice = globalParam.deviceOptions.find(device => device.deviceName === selectedDeviceName);
    
    if (selectedDevice) {
      // 更新 source 選項
      const { source = {} } = selectedDevice;
      const { value: sourceAry = [] } = source;
      view.setSourceOpts(sourceAry);
      
      // 更新其他選項（如果有）
      updateFormOptions(selectedDevice);
      
      // 設定預設值並更新伺服器屬性
      const defaultSource = sourceAry[0] || "";
      $("#source").val(defaultSource);
      
      // 這裡也可以同步設備選擇狀態到其他分頁
      if (mySharedWorker) {
        mySharedWorker.port.postMessage({
          type: 'DEVICE_CHANGED',
          payload: { deviceName: selectedDeviceName }
        });
      }
    }
  });

  // 其他現有的 Event Listeners (省略重複部分，請保留你原始碼中的其他 $("#xxx").on("change", ...))
  // ... 包括 #source, #pixel-type, #resolution 等等 ...

  /*** Functions ***/
  function updateFormOptions(device) {
    // 根據選擇的設備更新 UI (解析 capabilities)
    // 這裡保留你原始的實作邏輯
  }

  // --- 原有的 Library Wrapper 邏輯 ---
  function serialize(obj) {
    if (typeof obj === "function") {
      return obj.toString();
    }
    if (obj === null || typeof obj !== "object") {
      return obj;
    }
    if (Array.isArray(obj)) {
      return obj.map((item) => serialize(item));
    }
    const serializedObj = {};
    for (const key in obj) {
      if (obj.hasOwnProperty(key)) {
        serializedObj[key] = serialize(obj[key]);
      }
    }
    return serializedObj;
  }

  function wrapLib(instance) {
    Object.getOwnPropertyNames(Object.getPrototypeOf(instance))
      .filter(
        (prop) => typeof instance[prop] === "function" && prop !== "constructor"
      )
      .forEach((methodName) => wrapLibHanlder(instance, methodName));
  }

  function wrapLibHanlder(instance, methodName) {
    const originalMethod = instance[methodName];
    instance[methodName] = async function (...args) {
      const log = { API: methodName, args: serialize(args) };
      view.addLogEntry(JSON.stringify(log), "up");
      let result = {};
      try {
        result = await originalMethod.apply(this, args);
      } catch (e) {
        result = e;
        const resultLog = { API: methodName, return: serialize(result) };
        view.addLogEntry(JSON.stringify(resultLog), "down");
        throw e;
      }
      const resultLog = { API: methodName, return: serialize(result) };
      view.addLogEntry(JSON.stringify(resultLog), "down");
      return result;
    };
  }

  // 初始化執行
  if (typeof MyScan !== "undefined") {
    wrapLib(MyScan);
  }
});