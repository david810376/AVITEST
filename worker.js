// worker.js
let ports = [];

onconnect = function (e) {
  const port = e.ports[0];
  ports.push(port);

  port.onmessage = function (event) {
    // 當收到任何一個分頁傳來的消息，就廣播給所有人（包括發送者）
    const msg = event.data;
    
    ports.forEach(p => {
      p.postMessage({
        type: msg.type,
        payload: msg.payload,
        activeConnections: ports.length
      });
    });
  };

  port.start();
};