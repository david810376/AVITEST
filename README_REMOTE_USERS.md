# WebFXScan Remote/Vercel User Setup

This demo can be hosted on Vercel, but the scanner service still runs on each user's own PC.

The browser connects like this:

```text
https://avitest-seven.vercel.app/
  -> wss://localhost:17778/webscan2
  -> C:\Program Files\Plustek\WebFXScan2\WebScan2.exe
```

If it works on one PC but not another, the other PC is usually missing one of these local requirements.

## Required On Each User PC

1. Install Plustek WebFXScan2.
2. Start `WebScan2.exe`.
3. Make sure `C:\Program Files\Plustek\WebFXScan2\LibWebFxScan.ini` contains:

```ini
[WebSetting]
Port = 17778
Certificate=Davetest.pfx
WSS=1
```

4. Trust the local WSS certificate in Windows Current User trusted roots.
5. Use one browser/profile for testing. Edge and Chrome do not share SharedWorker state.
6. In Edge/Chrome, allow Local Network Access when the browser asks the Vercel site to access `localhost`.

## Quick Setup

Open PowerShell and run this from the `WebFXScan` folder:

```powershell
.\setup-webscan2-client.ps1
```

The script checks WebFXScan2, imports `Davetest.pfx`, starts `WebScan2.exe` if needed, and verifies that:

```text
https://localhost:17778/
```

reaches WebScan2. A `501 Not Implemented` response is OK for this test.

It also verifies that WebScan2 accepts a WebSocket handshake with this Origin:

```text
Origin: https://avitest-seven.vercel.app
```

Expected handshake result:

```text
101 Switching Protocols
```

## Browser Test

In the same browser that will open the Vercel demo, visit:

```text
https://localhost:17778/
```

Expected result after certificate setup:

```text
501 Not Implemented
```

Then open:

```text
https://avitest-seven.vercel.app/
```

If Chrome or Edge shows a permission prompt similar to local network / nearby devices / access devices on your local network, choose Allow.

Chromium browsers may block public websites from connecting to loopback addresses such as `localhost`, `127.0.0.1`, or `::1` until this permission is granted. The demo triggers a page-level local request before the SharedWorker connects, because SharedWorker requests cannot reliably show the permission prompt by themselves.

After deploying a SharedWorker fix, close every tab of the Vercel demo and reopen it. SharedWorker scripts can stay alive while any tab for the same origin is still open, so an old worker can keep running even after the files on Vercel changed.

## Notes

- `localhost` means the user's own computer, not Vercel.
- SharedWorker only shares tabs in the same browser, same profile, and same origin.
- Chrome, Edge, incognito windows, and Codex in-app browser do not share the same worker.
- If one browser already opened the scanner, another browser can still get scanner-busy errors.
- If the local demo works but Vercel does not, run the setup script and check the `101 Switching Protocols` Origin test.
- If Edge works but Chrome does not, check that browser's local network permission for `https://avitest-seven.vercel.app/` first.
- If the page WebSocket works but the SharedWorker WebSocket fails with `9007`, first make sure the Vercel deployment includes the lazy-worker version of `shared-scan-client.js`. The worker must be created after the page-level local network warm-up.
- If the active transport becomes `direct-fallback`, the page is connected but tabs are not sharing one scanner session. Treat that as a browser permission/deployment problem to fix before multi-tab testing.

You can check the active transport in DevTools:

```js
window.__webfxScanTransport
```

Expected values:

```text
shared-worker-pending
shared-worker
direct-fallback
shared-worker-unavailable
```
