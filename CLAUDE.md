# Timeline — desktop time-blocking app

Tauri 2.x (Rust) + plain Svelte 5 (runes) + Vite + TypeScript. **Not SvelteKit** —
single window, no routing. Persistence via tauri-plugin-sql (SQLite),
drag/resize via interact.js, tauri-plugin-notification + system tray wired but
notifications/sound are NOT built yet.

The stack is fixed; don't propose alternatives. Work in incremental phases,
explain non-obvious choices, verify before claiming done.

## Run / verify

```powershell
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"   # fresh shells lack cargo
npm run tauri dev                                      # Vite must get port 5173 (strictPort)
npm run check                                          # svelte-check + tsc — run before handing back
```

- Check for stale `app.exe` / Vite listeners on 5173 before relaunching.
- **UI verification tooling** (CDP into the live WebView2: screenshots,
  synthetic drags, console dumps, DB inspection): see `scripts/README.md`.
  Launch with `$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9222'` to enable.
- After large component restructures, Vite HMR can leave the page broken
  (blank pane, stale gestures) — hard-reload the webview (`node scripts/console.mjs`).
- DB: `%APPDATA%\com.chardoh.timeline\timeline.db`. Read-only inspection while
  the app runs is safe (`node scripts/inspect-db.cjs <path>`), never write externally.
- Delete the DB file to reset to a fresh migration + seed state.

## Architecture (src/)

- `App.svelte` — the layout shell: columns-first flex, [left col][shared
  vertical splitter][right col], each column stacking [top pane][its OWN
  horizontal splitter][bottom pane] — the two columns' height splits are
  independent (staggered dividers are correct). Three fractions (`vSplit`,
  `leftHSplit`, `rightHSplit`) are the source of truth (top panes get calc()
  heights, bottoms flex:1), persisted as `timeline.layout-splits.v2`, clamped
  to a 110px pane floor at drag time. Splitters use pointer capture so panel
  gestures never see the drag; every pane wrapper needs `min-width:0;
  min-height:0` or flex children refuse to shrink.
- `lib/timeline-scale.ts` — time↔pixel CONSTANTS + pure helpers: `BASE_PPH`
  (120, the UNZOOMED px/hour — the LIVE value is reactive, see view.svelte.ts),
  `anchor` (app-launch epoch; module evaluates once), `snapTime` (15-min grid,
  ZOOM-INDEPENDENT — only display density changes with zoom, never the snap),
  `NOW_LINE_FRACTION` (0.25), `RULER_HEIGHT` (28), `BASE_LANE_HEIGHT` (88, the
  UNZOOMED main lane), `LANE_PAD`, `STALE_MS` (10 min), and
  `assignSubLanes(blocks, now)` (greedy first-fit interval → sub-lane index +
  count; touching endpoints don't overlap). **Expiry collapse:** blocks whose
  end < now−STALE_MS ("stale") create NO demand — `count` derives from non-stale
  blocks alone; stale blocks take the lowest existing lane they fit, else CLAMP
  to the last (stale-over-stale overlap is fine). A track never grows for
  history. Never redefine these locally.
- `lib/view.svelte.ts` — **THE single LIVE source for the TIME axis scale.**
  `view.timeScale` is reactive $state; `pixelsPerHour()` = `BASE_PPH*timeScale`,
  `pxPerMs()`, `xOf(t)` are functions that READ it, so any template/derived that
  calls them re-renders on zoom and the rAF loop always gets the current value.
  There must be NO captured copies of `k`. Clamp ≈ [30,960] px/hour;
  `persistTimeScale()` saves to localStorage (alongside laneScale).
- `lib/lane-geometry.ts` — **THE single source of truth for VERTICAL lane
  geometry.** `computeGeometry(tracks, blocks, laneHeight, now)` returns everything
  height-related: `subLaneHeight` (main = laneHeight, child index≥1 = ½),
  `subLaneOffsetY`, `trackHeight`/`trackOffsetY` (running sums), `blockRect`
  (top+height, inset scales with sub-lane height), `bandRect` (for drag-commit),
  `contentHeight`, and `yToTrack` (pointer→track over variable bands). NO
  `* laneHeight` arithmetic exists anywhere else — every consumer reads this.
- `lib/db.ts` — typed data access. Tables: `activities`, `tracks` (lanes/genres),
  `scheduled_blocks` (has `track_id`), `activity_track_eligibility` (m:n join;
  the UI holds it to exactly ONE row per activity for now), `time_entries`
  (completion ledger; row per completed block with BOTH activity_id and
  track_id + seconds, plus `source_block_id` — nullable, UNIQUE when set via a
  partial index, `ON DELETE SET NULL`; rows predating v4 have NULL source). Timestamps = epoch ms INTEGER. `deleteTrack` reassigns
  both blocks AND stranded eligibility to the lowest-sort_order remaining track.
  `deleteActivity` explicitly deletes blocks + time rows + eligibility (doesn't
  trust the connection's `foreign_keys` pragma even though the FKs are CASCADE);
  `restoreActivitySnapshot` is its inverse (re-inserts with original ids) for
  the pool's shift-click undo. **`completeBlock(block)` is the SINGLE write site
  for time_entries** — see the ledger invariant below. Read helpers for the
  (unbuilt) stats panel: `getTotalsByTrack()`, `getTotalsByActivity()` (SUM
  grouped, aliased `seconds`), `getTimeEntries({since?,until?})` (raw rows).
- `src-tauri/src/lib.rs` — plugin registration, tray, and **sqlx migrations**
  (v1 base tables, v2 tracks + block track_id, v3 eligibility +
  time_entries.track_id, v4 time_entries.source_block_id + partial unique
  index). Migrations run on `Database.load` with the exact
  string `sqlite:timeline.db`. SQLite gotcha: ADD COLUMN can't be NOT NULL +
  REFERENCES → rebuild-table pattern (see v2); nullable REFERENCES is fine (v3).
- `lib/store.svelte.ts` — shared `$state` store (activities, tracks, blocks,
  eligibility map, `reconciled`/`catchUpLogged` completion flags) + optimistic
  mutators (`rescheduleBlock`, `resizeBlock`, `scheduleActivity`, `addTrack`,
  `removeTrack`, `addActivity`, `removeActivity`, `setEligibleTrack`). Also
  `isEligible()` (sync check), `dragUI` (transient chip-drag state),
  `activityManagerUI` (shared open flag so the pool's "+" chip can trigger the
  ActivityManager dropdown — one add-activity codepath), and the
  completion engine: `completeDue(now)` completes every due scheduled block via
  the idempotent `completeBlock` gate, flips its reactive status, and returns
  the ones IT completed (caller does side effects); `startupCatchUp()` runs it
  once at launch (silent) then sets `reconciled`. `removeTrack`/`removeActivity`
  reload the whole store.
- `lib/Timeline.svelte` — the top-left pane: header (TrackManager + glued
  date readout + clock chip), lane-label gutter, scrolling body. The header
  date = local date of the time under the now-line mark
  (`timeAtPaneX(translateX, nowLineX)`), recomputed from the 1s tick and the
  free-scroll handlers (wheel/pan/Now) — never the rAF loop; a day-key guard
  skips redundant re-formats. rAF loop writes track transform,
  now-line x, clock chip directly to the DOM (not through reactivity); a
  separate 1s interval drives block temporal classes AND live completion
  detection (`completeDue` when `store.reconciled`, guarded against overlap) —
  each newly-completed block fires ONE notification (tauri-plugin-notification)
  + ONE Web-Audio chime. A quiet toast reports the startup catch-up count.
  **Overlap sub-lanes + zoom (DERIVED, never stored):** `geom` ($derived.by =
  `computeGeometry(store.tracks, store.blocks, laneHeight, now)`, event-driven,
  not per-frame) is the single geometry source (see lane-geometry.ts). It also
  recomputes when a block crosses the stale threshold — a `staleKey` derived
  (count of stale blocks) changes value only on a real transition, so quiet 1s
  ticks don't churn geometry (`now` is read UNTRACKED). CHILD
  sub-lanes (index≥1) render at HALF the main height; `.block.child` shows a
  single truncated line (no duration, no finish label). Overlapping in an
  eligible track is ALLOWED; only eligibility bounces. Y→track = `geom.yToTrack`
  (drag, scroll-adjusted) or `.lane-row[data-track-id]` hit-test (pool drop);
  the drag-commit lands at `geom.bandRect(track, sub)` (exact top+height). Blocks
  + lane-rows + gutter-labels ride vertical-scroll layers (`-laneScrollY`,
  shift+wheel over lane bodies, clamped to `contentHeight-paneHeight`); ruler,
  ticks, now-line, particle canvas stay full-pane-height. Particle emission uses
  `geom.blockRect(b).top - laneScrollY`. **Wheel over the GUTTER = zoom**:
  `laneHeight = BASE_LANE_HEIGHT * laneScale`, laneScale ∈ [0.5, 2.5] persisted
  as `timeline.lane-scale.v1`; anchored to the cursor (capture content-y, scale,
  set laneScrollY so it lands back under the cursor); applied immediately with
  the block `top` transition suspended (`.zooming`, cleared 150ms after the last
  wheel) so bursts don't smear. **THREE distinct wheel surfaces:** lane-body =
  time pan (`handleWheel`), label-gutter = lane zoom (`handleGutterWheel`),
  hour-strip `.ruler` = TIME zoom (`handleRulerWheel`, stops propagation). Time
  zoom: FOLLOW mode changes `view.timeScale` only — translateX = `nowLineX −
  xOf(now)` re-pins the needle by construction (no cursor math); FREE mode
  anchors the cursor (capture absolute time under pointer, set freeBaseX so it
  lands back). Ticks use an ADAPTIVE ladder (`TICK_INTERVALS_MS` 5m…6h; smallest
  whose on-screen spacing ≥ 70px; HH:MM labels; rebuild guarded on interval+range).
  **DRAG = vertical pan**, shared by the GUTTER and the LANE BODY: one core
  (`beginPan(event, el)` / `movePan` / `endPan`, entered via
  `handleGutterPointerDown` and `handleLanePointerDown`) pointer-captures on
  whichever surface started it and writes the SAME shared `laneScrollY` (gutter +
  lane-rows + blocks stay locked), direct-manipulation (content follows the
  pointer 1:1; drag down → scroll up the list), hard-clamped to
  `[0, contentHeight−paneHeight]`. Lane-body pan engages only when the lanes
  overflow and only on EMPTY space — presses that `closest('.block,
  .resize-zone, .now-button')` are left to interact.js / the button, so block
  drag/resize is untouched; horizontal time-pan stays on the wheel (a lane-body
  drag is purely vertical). A ~4px threshold gates engagement (plain click never
  jitters); `.gutter`/`.timeline` show `grab`/`grabbing` (`.panning`); the reflow
  transition is suspended for the pan (`zooming`); gutter wheel-zoom is IGNORED
  while pressed (`panPointerId !== null` → drag wins until release); release does
  a short momentum glide (exp decay ~120ms, clamped, killed by any new
  pointerdown). Pan writes scroll only — no per-move layout.
  Placed blocks:
  plain drag = reschedule (time + lane), right-edge drag = resize,
  **right-click = delete that one block immediately** (no confirm, no context
  menu — `contextmenu` handler calls preventDefault; Undo toast). Blocks carry
  `data-block-id` for exact targeting. `removeBlock`/`restoreBlock` in the store
  handle the optimistic delete + undo (never touches the time ledger).
- `lib/ActivityPool.svelte` — chips, ghost-clone drag, drop→(time, lane) gated
  by eligibility (reject = shake + toast, no block). Chip gestures:
  **right-click opens a small context menu whose Delete button removes the
  activity** (blocks + eligibility cascade; Undo toast) — unlike timeline
  blocks, chips are never deleted directly; plain `tap` opens the eligibility
  popover; plain drag creates a block; `doubletap` quick-schedules a block at
  Date.now() in the eligible track (via the same scheduleActivity path; snaps
  free mode home by clicking the Now button). The single-tap popover is
  DEFERRED ~250ms and cancelled by doubletap so a double-click never flashes
  the popover; tap/doubletap ignore non-left buttons. The context menu is a
  fixed-position element (immune to the pool's overflow:hidden), closed by any
  outside pointerdown or a drag start. The `tap`/popover path is guarded
  against firing after a drag via a `down`-reset flag. Eligibility popover: checkboxes rendered for the
  multi-select future but single-select today (checking swaps, last can't be
  unchecked). A dashed "+" chip pinned after the real chips opens the
  ActivityManager dropdown via `activityManagerUI.open` — a plain button,
  deliberately outside `chipDrag` so it has no drag/popover/delete behavior.
- `lib/TrackManager.svelte` — tracks dropdown (add / remove, min 1 enforced in db.ts).
- `lib/ActivityManager.svelte` — activities dropdown in the pool header
  (add with name/color/track, two-click inline delete confirm — no native
  `confirm()` in the webview).

## Invariants that keep the whole thing consistent

- Forward mapping: on-track x = `xOf(t)`; block top = `RULER_HEIGHT + laneIndex·LANE_HEIGHT + LANE_PAD`.
- Inverse mapping (drops AND drag-ends): `t = anchor + (screenX − trackRect.left) / PX_PER_MS`
  — measured against the **track element's rect** (it embodies the current
  translate), valid in both follow and free scroll modes. Never compute time
  from accumulated interact.js deltas; never assume now sits under the now-line.
- Scroll modes: FOLLOW translate is a PURE function of the wall clock
  (`followX(now) = NOW_LINE_X - (now-anchor)*PX_PER_MS`) recomputed every rAF
  frame — no delta accumulation, no lerp (those would reintroduce resume lag).
  FREE freezes at `freeBaseX + panPx`. "Now" button tweens back (recomputing the
  moving target per frame) but SNAPS instead when the gap exceeds one screen.
- Resume-from-background snap: rAF and the 1s `setInterval` are paused/throttled
  while minimized, so on return we recompute SYNCHRONOUSLY rather than waiting
  for the loop. `render(Date.now())` + an immediate tick fire from BOTH a
  `visibilitychange`→visible handler AND Tauri `getCurrentWindow().onFocusChanged`
  (a minimized desktop window may not fire visibilitychange). The snap is
  idempotent; FREE mode is left frozen (render re-applies its offset, no drift).
- Gesture arbitration on one element via selectors: block drag has
  `ignoreFrom: '.resize-zone'`; resize uses `edges: { right: '.resize-zone' }`;
  background pan (on the pane) has `ignoreFrom: '.block'`.
- During gestures: move only `transform` (drag) or inline width (resize); on
  end, write the final snapped inline style FIRST, then update the store (the
  re-render produces the identical value → no flash).
- Svelte actions holding store objects MUST implement `update(newParam)` —
  keyed each reuses DOM nodes after store reloads and closures go stale otherwise.
- Runtime-toggled classes must appear in the template (`class:x={...}`), not
  `classList.add`, or Svelte strips the scoped CSS as unused.
- **A `<canvas>` is a replaced element** — `position:absolute; inset:0` alone
  leaves its CSS box at the intrinsic (width/height-attribute) size, so with a
  dpr backing store (e.g. width=838 for a 670px pane) it renders 1.25× too wide
  and drawings drift right. Always set explicit CSS `width:100%; height:100%`
  and keep the backing store in the width/height attributes (scaled by dpr, with
  `ctx.setTransform(dpr,…)` so you draw in CSS px). The particle canvas learned
  this the hard way.
- **Don't rely on interact.js's `tap` for a must-fire click action on a
  draggable element.** Any sub-pixel jitter during the press makes interact
  start a drag, and a started-then-aborted drag never emits `tap`, so the
  action silently misses. Zero-movement synthetic clicks hide this — real hands
  always jitter. Delete therefore rides native events fully outside interact's
  tap/drag arbitration: `contextmenu` (right-click) on both blocks (immediate
  delete, preventDefault = no menu) and chips (opens the Delete context menu).
  interact only drags with the LEFT button, so right presses never gesture.
- Block styling: the grayed "spent" look is ONE overlay treatment (`.consumed`
  inside the block: dark tint + backdrop-filter grayscale, pointer-events none).
  Fully past/completed blocks get a static full-width overlay; a block under
  the needle gets a `.live` overlay whose width the rAF loop drives from
  (now − start)·PX_PER_MS — **purely cosmetic, never mutates block data**. The
  8px soft edge OVERHANGS the front and slides past the block's overflow clip
  at 100%, so a finishing dissolve equals the static past look with no style
  swap (keep the CSS 8px in sync with DISSOLVE_EDGE_PX). Dissolving blocks also
  emit red **ember particles** at the burn line: ONE `<canvas class="particles">`
  over the pane (z:5, above blocks), a pooled ring-buffer (cap 200, oldest die
  first) drawn from the EXISTING rAF loop — no per-particle DOM, no per-frame
  alloc. Emits only while `liveOverlays.size > 0` and the needle is on-screen
  (`translateX + xOf(now)` ∈ [0, canvasW]); zero per-frame work once nothing
  dissolves and the pool drains (one clear then skip). Killed on hide
  (visibilitychange) and disabled under `prefers-reduced-motion`; palette read
  once from --now-core/--now-halo. `.active-now` outline
  = still-scheduled AND start ≤ now < end. The "now" instrument — needle
  (`.now-line` z:6, top cap `::before`), the `.clock` PILL (the rounded HH:MM:SS
  capsule at the needle top / NOW_LINE_X: token border + halo box-shadow + inner
  glow + surface sheen; its `::after` notch is the needle→pill join, faded in
  free mode via `class:detached={mode==='free'}`), and the glued centered
  `.now-marker` field (date + outline-glow HH:MM:SS) — all share tokens on
  `.timeline-wrap` (`--now-core`/`--now-halo`/`--now-glow`/`--now-sheen-*`, glow
  via color-mix): retune one token, all restyle. Intensity hierarchy needle >
  pill > date. NOTE two live HH:MM:SS timestamps exist (the moving `.clock`
  pill AND the glued `.now-marker`). ONE `@keyframes now-sheen`
  (background-position) drives all three sheens; each sets its axis via
  `--sheen-from/--sheen-to` (pill sheen is a z-index:-1 `::before`, under the
  digits, inside an isolation stacking context).
  The header field's clock is the ACTUAL time in HH:MM:SS (second-guarded on
  the 1s tick, tabular-nums so ticking seconds never reflow), independent of the
  free-mode marker-anchor date; it wears an outline+halo text treatment
  (-webkit-text-stroke in --now-core + layered --now-halo text-shadow) — the
  marker's star, stronger than the date, subtler than the needle. All paint —
  the per-second update is a bare text swap, no layout.
- A block's `track_id` must always be within its activity's eligible set:
  pool drops AND cross-lane block drags check `isEligible()` and reject/snap
  back otherwise. No activity may ever have zero eligibility rows
  (`setActivityEligibleTrack` deletes non-targets first; `deleteTrack`
  re-points stranded rows; seeding inserts a row per seeded activity).
- **Time-ledger invariant:** `time_entries` has exactly ONE writer,
  `completeBlock`. Time is recorded ONLY when a block cleanly transitions to
  `completed` (end_time reached while it still exists, uncanceled/undeleted) —
  NEVER on active/future/delete/cancel. `completeBlock` is idempotent + the
  atomic claim: a status-guarded `UPDATE ... WHERE status='scheduled'` gates the
  ledger INSERT so re-ticks never duplicate a row (SQLite serializes writes, so
  no BEGIN/COMMIT needed — tauri-plugin-sql pools connections, so a multi-stmt
  transaction across execute() calls isn't reliably atomic anyway). On top of
  the behavioral claim, "one row per completed block" is STRUCTURAL since v4:
  INSERT OR IGNORE + the partial unique index on source_block_id. seconds =
  duration_seconds. Deletion never WRITES the ledger: deleting an activity
  removes its rows; deleting a single completed block keeps its logged row
  (time was legitimately spent) with source_block_id nulled by FK — which also
  confirms the pool runs with foreign_keys=ON.
- **Un-completing** is the SOLE reverser: `uncompleteBlock(block)` mirrors
  `completeBlock` — a status-guarded `UPDATE ... WHERE status='completed'` claim,
  then `DELETE FROM time_entries WHERE source_block_id = id`. Idempotent; if no
  ledger row is found (legacy NULL source_block_id) it still reverts status but
  `console.warn`s. It fires event-driven from `store.maybeUncomplete(block)`,
  called at the END of `rescheduleBlock`/`resizeBlock`: if the block is
  `completed` AND its new end_time is now in the future → uncomplete (status →
  scheduled, ledger row gone) + bump `store.ledgerVersion`. The reverse direction
  needs no new code — the existing 1s `completeDue` tick re-completes it once its
  end passes, inserting exactly ONE fresh row (INSERT OR IGNORE + unique index).
  **HARD INVARIANT (verified via CDP): complete→uncomplete→complete nets exactly
  ONE ledger row — never two, never zero.** `store.ledgerVersion` is a bump
  counter signalling any ledger change for the (future) stats panel to re-query.
- Completion side effects (notification + sound) fire ONLY from the live tick,
  ONE per newly-completed block. Startup catch-up (`startupCatchUp`, gated
  before the live tick via `store.reconciled`) logs blocks that ended while
  closed SILENTLY (no per-block notif/sound), with one summary toast.

## Known limitations / roadmap

Overlapping blocks in the same track now auto-expand into derived sub-lanes
(see Timeline.svelte above) — no more visual collisions. Block deletion is via
right-click (on a pool chip = context-menu Delete removes the activity + its
blocks; on a placed block = delete that one block immediately).
The completion-logging engine is built (blocks complete → gray + notif + sound +
one time_entries row; catch-up on launch). Remaining, not yet built: the STATS
panel (BR quadrant) reading `getTotalsByTrack`/`getTotalsByActivity`/
`getTimeEntries`; the avatar (BL); tray behaviors (close-to-tray). Wait for the
user's phase prompt before starting these.
