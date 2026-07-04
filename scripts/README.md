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
| `sanitize-glb.mjs <file.glb>` | Fixes Unity glTFast exports whose nodes declare `skin` over meshes with no JOINTS_0/WEIGHTS_0 (three's `normalizeSkinWeights` crashes with "reading 'count'"). Strips the bogus skin refs in place. **Run on any re-exported avatar model before dropping it into `public/models/`.** |
| `verify-vrm.mjs [glb\|vrm]` | Navigates the app to the default chain (`glb`) or the `?avatar=/models/test.vrm` dev override (`vrm`) and dumps the AvatarPanel mode/clips/expressions/spring-joint state. |
| `verify-vrm-behavior.mjs` | Full VRM behavioral suite against test.vrm: mouse-tracked lookAt + 5s idle-return, spring-bone sway on model nudge, expression facade, delta-clamp hitch survival, orbit/home. |
| `verify-profiles.mjs` | End-to-end profiles regression: boot identity, tab guards, switch-with-reload into Test, block completion isolated to Test's ledger, switch back, add "Zeta" via real key events, remove via ✕ (file deleted). Leaves scratch blocks in the Test profile (that's what it's for). |
| `sanitize-vrma.mjs <files...>` | Fixes UniVRM .vrma exports whose hips bone was stripped (`humanBones.hips.node = -1` + orphaned root-motion channels → three-vrm-animation crashes / model at Infinity / facing issues). Appends a HipsRoot node with rest transform read from the first hips keyframes and rewires the channels. **Run on any new .vrma before dropping it into `public/models/vrma/`** (and add it to AvatarPanel's VRMA_MANIFEST). |
| `verify-vrma.mjs` | VRMA pipeline suite: load/retarget of all manifest clips, random cycling with no immediate repeats, manual dropdown hold, lookAt during playback, action-leak check after rapid switching. |

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
