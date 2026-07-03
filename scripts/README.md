# Dev / verification tooling

These scripts drive and inspect the **running** Tauri app through the WebView2
Chrome DevTools Protocol. Node 24's built-in `WebSocket` and `node:sqlite` are
used — no npm dependencies.

## Enable CDP

The app must be launched with a remote debugging port:

```powershell
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9222'
npm run tauri dev
```

Without the env var the scripts fail at `http://127.0.0.1:9222/json`.

## Scripts

| Script | Purpose |
|---|---|
| `cdp.mjs` | Shared CDP client. Exports `send(method, params)`, `evaljs(expr)` (in-page eval, returns by value), `mouseDrag(x1,y1,x2,y2)` (synthetic pointer drag), `sleep`, `events`, `ws`. Import it; don't run it. |
| `screenshot.mjs <out.png>` | Captures the webview to a PNG (verify UI visually). |
| `console.mjs` | Hard-reloads the page, dumps console errors/exceptions and a DOM sanity summary. **Run this after big component restructures** — Vite HMR can leave the page in a broken half-state that only a reload clears. |
| `inspect-db.cjs <path-to-db>` | Lists tables + activities + row counts via `node:sqlite` (read-only; safe while the app runs). DB lives at `%APPDATA%\com.chardoh.timeline\timeline.db`. |
| `example-ui-test.mjs` | Worked example: reloads, picks a *visible, hit-testable* block, does a cross-lane drag, then a chip drop into a lane, asserting on resulting styles. Copy this pattern for new interaction tests. |

## Hard-won gotchas

- **Pick drag targets with `document.elementFromPoint`**, not just
  `getBoundingClientRect` — rects ignore clipping/overlap, so a block half
  behind the left gutter or under an overlapping block will swallow the press.
- Wheel events: `Input.dispatchMouseEvent` with `type: 'mouseWheel'`.
- Synthetic drags: press → several small `mouseMoved` steps (~25ms apart) →
  release; single-jump moves don't trigger interact.js reliably.
- Only ONE app instance can hold port 9222/5173 — check for stale `app.exe` /
  Vite processes before relaunching (`netstat -ano | findstr :5173`).
- The DB can be read while the app runs (WAL), but don't write to it from
  outside the app.
