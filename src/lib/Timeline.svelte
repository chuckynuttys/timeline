<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import interact from 'interactjs';
  import {
    anchor,
    assignSubLanes,
    BASE_LANE_HEIGHT,
    NOW_LINE_FRACTION,
    RULER_HEIGHT,
    snapTime,
    STALE_MS,
  } from './timeline-scale';
  import {
    view,
    xOf,
    pxPerMs,
    pixelsPerHour,
    persistTimeScale,
    clampTimeScale,
  } from './view.svelte';
  import { computeGeometry } from './lane-geometry';
  import {
    store,
    dragUI,
    isEligible,
    completeDue,
    rescheduleBlock,
    resizeBlock,
    removeBlock,
    restoreBlock,
  } from './store.svelte';
  import { getTotalsByActivity, getTotalsByTrack } from './db';
  import {
    isPermissionGranted,
    requestPermission,
    sendNotification,
  } from '@tauri-apps/plugin-notification';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import TrackManager from './TrackManager.svelte';
  import type { ScheduledBlock } from './db';

  /** Blocks can never be resized below the snap grid: 15 minutes. */
  const MIN_DURATION_S = 900;
  /** Soft dissolve-front width; keep in sync with the 8px in .consumed CSS. */
  const DISSOLVE_EDGE_PX = 8;

  /* ---- dissolve-front particle emission (pure garnish; canvas, not DOM) ---- */
  const MAX_PARTICLES = 420; // hard cap (+20% headroom); oldest die first
  const EMIT_PER_SEC = 18.9; // trickle per dissolving block (+20%, jittered by rng)
  const BURST_MIN = 32;
  const BURST_RANGE = 20; // completion burst: 32–52 particles (+20%)
  const P_SPEED = 1.93; // spread-velocity multiplier (vertical / radial)
  const P_LEFT = 2.32; // leftward-drift multiplier (P_SPEED +20%; all added vel goes LEFT)
  const P_LIFE = 1.2; // lifetime multiplier (+20%)
  const P_GRAVITY = 200; // downward accel (px/s²) — embers arc and fall
  const P_TAU = Math.PI * 2;
  /** Min block pixel-width at the CURRENT zoom (snap grid is time-fixed at 15m,
   *  but its pixel size tracks the live scale). */
  const minWidthPx = () => MIN_DURATION_S * 1000 * pxPerMs();
  /** Extra time rendered past each visible edge so ticks never pop in at the border. */
  const TICK_BUFFER_MS = 2 * 3_600_000;
  /** "Now" button tween duration. */
  const RETURN_TWEEN_MS = 250;
  /** Adaptive tick ladder (ms). The strip shows the smallest interval whose
   *  on-screen spacing is at least MIN_TICK_SPACING_PX, so density stays legible
   *  from 30 to 960 px/hour. Labels are always HH:MM; the 15-min SNAP grid is
   *  independent of this (see SNAP_MS) — only display density changes. */
  const TICK_INTERVALS_MS = [5, 10, 15, 30, 60, 120, 180, 360].map(
    (m) => m * 60_000,
  );
  const MIN_TICK_SPACING_PX = 70;

  interface Tick {
    time: number;
    x: number;
    label: string;
    minor: boolean;
  }

  let paneWidth = $state(0);
  let ticks = $state<Tick[]>([]);
  // Observed size of this component's quadrant cell. The panes are now
  // user-resizable, so width/height can change at any moment; step 2 will
  // rewire the now-line / scroll / hit-testing math to these. For now they
  // are only captured (and logged) to prove the observer fires.
  let cellWidth = $state(0);
  let cellHeight = $state(0);
  let wrapEl: HTMLDivElement;
  let timelineEl: HTMLDivElement;
  let track: HTMLDivElement;
  let nowLine: HTMLDivElement;
  let clockEl: HTMLDivElement;

  /** id of the block currently being dragged, for the picked-up style. */
  let draggingId = $state<number | null>(null);
  /** id of the block currently being resized, plus its live duration for the badge. */
  let resizingId = $state<number | null>(null);
  let liveDurationS = $state(0);

  /** Undo affordance for the no-confirm shift-click block delete. */
  let blockUndo = $state<ScheduledBlock | null>(null);
  let blockUndoTimer: ReturnType<typeof setTimeout> | undefined;
  /** How long the Undo toast lingers after a shift-click delete. */
  const UNDO_MS = 6000;

  async function deleteBlockWithUndo(block: ScheduledBlock) {
    // Right-click is the immediate, no-confirm fast path. Deleting a block is
    // never completion — it records no time (see completeBlock in db.ts).
    let snapshot: ScheduledBlock;
    try {
      snapshot = await removeBlock(block);
    } catch (e) {
      console.error('Failed to delete block:', e);
      return;
    }
    clearTimeout(blockUndoTimer);
    blockUndo = snapshot;
    blockUndoTimer = setTimeout(() => (blockUndo = null), UNDO_MS);
  }

  async function undoBlockDelete() {
    if (!blockUndo) return;
    clearTimeout(blockUndoTimer);
    const block = blockUndo;
    blockUndo = null;
    try {
      await restoreBlock(block);
    } catch (e) {
      console.error('Failed to undo block delete:', e);
    }
  }

  /**
   * View mode. FOLLOW: the translate is a pure function of Date.now() and the
   * current time stays pinned under the now-line mark. FREE: the view is
   * frozen at freeBaseX + panPx and only user input moves it.
   */
  let mode = $state<'follow' | 'free'>('follow');
  let freeBaseX = 0;
  let panPx = 0;
  /** Bumping this token cancels an in-flight "Now" tween. */
  let tweenToken = 0;

  /** Coarse 1s clock for temporal block classification (past/active/future). */
  let currentTime = $state(Date.now());

  /** Header date readout: local calendar date of the time under the now-line
      mark. Weekday included — it's a productivity timeline. */
  const HEADER_DATE_FMT: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  };
  let headerDate = $state(
    new Date().toLocaleDateString(undefined, HEADER_DATE_FMT),
  );
  /** yyyymmdd key of the shown date, so we only re-format on a day change. */
  let headerDayKey = NaN;
  /** Live wall-clock HH:MM:SS in the marker field (actual now, even in free mode). */
  let headerClock = $state(formatClock(Date.now()));
  /** Second key, so the ~1s tick only re-renders the clock on a real second change. */
  let headerSecondKey = NaN;

  const nowLineX = $derived(paneWidth * NOW_LINE_FRACTION);
  const activityById = $derived(new Map(store.activities.map((a) => [a.id, a])));
  const trackById = $derived(new Map(store.tracks.map((t) => [t.id, t])));

  /** How far the lane area is scrolled down (px); shift+wheel AND gutter
   *  drag-to-pan share this ONE value (gutter + lane bodies stay in lockstep). */
  let laneScrollY = $state(0);
  /** Height of the .timeline scroll area (for vertical-overflow clamping). */
  let paneHeight = $state(0);
  let gutterEl: HTMLDivElement;

  /* ---- gutter drag-to-pan (vertical scroll by dragging the labels) ---------- */
  /** Movement before a press becomes a pan — a plain click never jitters. */
  const PAN_THRESHOLD_PX = 4;
  /** True only while a pan is actively engaged: drives the grabbing cursor and
   *  makes a drag "win" over gutter wheel-zoom until release. */
  let panning = $state(false);
  let panPointerId: number | null = null;
  let panEl: HTMLElement | null = null; // element holding capture for the active pan
  let panEngaged = false; // threshold crossed this gesture
  let panStartY = 0;
  let panStartScroll = 0;
  let panLastY = 0; // last sampled pointer y (for release velocity)
  let panLastT = 0; // ...and its timestamp
  let panVel = 0; // scroll-space velocity (laneScrollY px per ms) at release
  let momentumRaf = 0;

  /* ---- lane zoom (gutter wheel scales all track heights) ------------------- */
  const LANE_SCALE_KEY = 'timeline.lane-scale.v1';
  const MIN_SCALE = 0.5;
  const MAX_SCALE = 2.5;
  function loadLaneScale(): number {
    try {
      const v = Number(localStorage.getItem(LANE_SCALE_KEY));
      if (Number.isFinite(v) && v >= MIN_SCALE && v <= MAX_SCALE) return v;
    } catch {
      // storage unavailable — fall through to default
    }
    return 1;
  }
  /** Zoom factor; laneHeight = BASE_LANE_HEIGHT * laneScale (persisted). */
  let laneScale = $state(loadLaneScale());
  /** True while wheeling the gutter, so the reflow transition doesn't smear. */
  let zooming = $state(false);
  let zoomTimer: ReturnType<typeof setTimeout> | undefined;

  const laneHeight = $derived(BASE_LANE_HEIGHT * laneScale);

  /**
   * Part A trigger: an integer that changes ONLY when some block's staleness
   * flips (its end passes now - STALE_MS). It recomputes every second (reads
   * currentTime) but returns the SAME value until a real transition, so — thanks
   * to Svelte's value-equality on deriveds — it does NOT invalidate `geom` on
   * quiet ticks. This is the "reassign a track only when one of its blocks
   * crosses the threshold" cheapness, expressed declaratively.
   */
  const staleKey = $derived.by(() => {
    const before = currentTime - STALE_MS;
    let k = 0;
    for (const b of store.blocks) {
      if (b.start_time + b.duration_seconds * 1000 < before) k++;
    }
    return k;
  });

  /**
   * THE single geometry source — recomputed when blocks/tracks/laneHeight change
   * OR a block crosses the stale threshold (via staleKey), never per rAF frame.
   * `currentTime` is read UNTRACKED so the bare 1s tick doesn't churn geometry;
   * staleKey is the only time-driven trigger. Half-height child sub-lanes,
   * running-sum track offsets, block rects, y→track resolution all live in
   * computeGeometry; no `* laneHeight` arithmetic exists outside it.
   */
  const geom = $derived.by(() => {
    staleKey; // dependency: recompute on a staleness transition
    const now = untrack(() => currentTime);
    return computeGeometry(store.tracks, store.blocks, laneHeight, now);
  });

  const maxLaneScroll = $derived(Math.max(0, geom.contentHeight - paneHeight));

  // Keep the vertical scroll in range when tracks collapse / the pane resizes.
  $effect(() => {
    if (laneScrollY > maxLaneScroll) laneScrollY = maxLaneScroll;
  });

  /**
   * FOLLOW-mode container offset — a PURE function of the wall clock, with no
   * accumulation and no smoothing: NOW_LINE_X - xOf(now) (live scale).
   * Because it reads Date.now() fresh, the first frame after any pause (incl.
   * return-from-background) lands exactly on the current time. Never lerp this.
   */
  function followX(now: number): number {
    return nowLineX - xOf(now);
  }

  /** True once notification permission has been resolved as granted. */
  let notifyGranted = false;
  /** Lazily-created; a completion sound needs no audio asset. */
  let audioCtx: AudioContext | null = null;
  /** Quiet one-shot summary toast after startup catch-up. */
  let catchUpCount = $state(0);
  let catchUpShown = false;

  // Show the "logged N while you were away" toast once, when startup catch-up
  // reports a count (it lands after this component mounts).
  $effect(() => {
    if (store.catchUpLogged > 0 && !catchUpShown) {
      catchUpShown = true;
      catchUpCount = store.catchUpLogged;
      setTimeout(() => (catchUpCount = 0), 6000);
    }
  });

  /** Short two-note chime via Web Audio (no asset, no autoplay dependency). */
  function playCompletionSound() {
    try {
      audioCtx ??= new AudioContext();
      if (audioCtx.state === 'suspended') void audioCtx.resume();
      const ctx = audioCtx;
      const t0 = ctx.currentTime;
      const note = (freq: number, start: number, dur: number) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, t0 + start);
        gain.gain.exponentialRampToValueAtTime(0.18, t0 + start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + start + dur);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t0 + start);
        osc.stop(t0 + start + dur);
      };
      note(660, 0, 0.18);
      note(880, 0.15, 0.22);
    } catch (e) {
      console.error('completion sound failed', e);
    }
  }

  /** Proof-of-flow for the upcoming stats panel: dump the live aggregates. */
  function logStatsSnapshot() {
    Promise.all([getTotalsByTrack(), getTotalsByActivity()])
      .then(([byTrack, byActivity]) =>
        console.log('[stats] byTrack', byTrack, 'byActivity', byActivity),
      )
      .catch((e) => console.error('stats read failed', e));
  }

  /** One notification + one sound for a block that JUST completed live. */
  function announceCompletion(block: ScheduledBlock) {
    playCompletionSound();
    if (!notifyGranted) return;
    const name = activityById.get(block.activity_id)?.name ?? 'Activity';
    try {
      sendNotification({ title: `${name} finished`, body: 'Scheduled time reached' });
    } catch (e) {
      console.error('notification failed', e);
    }
  }

  /** Switch follow -> free, capturing the current follow offset so nothing jumps. */
  function enterFree() {
    tweenToken++; // interrupt a running "Now" tween, if any
    if (mode === 'free') return;
    freeBaseX = followX(Date.now());
    panPx = 0;
    mode = 'free';
  }

  function handleWheel(event: WheelEvent) {
    // Shift+wheel scrolls the lanes VERTICALLY (only when they overflow);
    // plain wheel is the existing horizontal time-pan, untouched.
    if (event.shiftKey && maxLaneScroll > 0) {
      event.preventDefault();
      const d = event.deltaY !== 0 ? event.deltaY : event.deltaX;
      laneScrollY = Math.max(0, Math.min(maxLaneScroll, laneScrollY + d));
      return;
    }
    enterFree();
    const delta =
      Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    panPx -= delta;
    updateHeaderDate(); // wheel-panning across midnight flips the date live
  }

  /**
   * Wheel over the LABEL GUTTER only = zoom all track heights. Multiplicative
   * per notch, clamped. ANCHORED to the cursor: the content point under the
   * mouse stays put — capture its content-y, scale, then set laneScrollY so it
   * lands back under the cursor. Applied immediately (no transition — bursts
   * would smear); `zooming` suspends the block reflow transition until ~150ms
   * after the last event. laneScale persists.
   */
  function handleGutterWheel(event: WheelEvent) {
    event.preventDefault();
    // Drag wins until release: a mid-pan zoom would rescale content under the
    // pointer and make the pan feel broken. Ignore wheel-zoom while pressed.
    if (panPointerId !== null) return;
    const oldScale = laneScale;
    const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1; // wheel up = bigger
    const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, oldScale * factor));
    if (newScale === oldScale) return; // already at a clamp

    // Content y under the cursor (only the sub-ruler content scales).
    const cy = event.clientY - gutterEl.getBoundingClientRect().top;
    const contentYold = cy + laneScrollY;
    const ratio = newScale / oldScale;
    const contentYnew = RULER_HEIGHT + (contentYold - RULER_HEIGHT) * ratio;
    const contentHeightNew = RULER_HEIGHT + (geom.contentHeight - RULER_HEIGHT) * ratio;
    const maxScrollNew = Math.max(0, contentHeightNew - paneHeight);

    laneScale = newScale;
    laneScrollY = Math.max(0, Math.min(maxScrollNew, contentYnew - cy));
    persistLaneScale();
    markZooming();
  }

  function persistLaneScale() {
    try {
      localStorage.setItem(LANE_SCALE_KEY, String(laneScale));
    } catch {
      // storage unavailable — density just won't survive restart
    }
  }

  /** Suspend the block reflow transition for ~150ms so a zoom burst doesn't
   *  smear; shared by lane zoom, time zoom, and pan-release. */
  function markZooming() {
    zooming = true;
    clearTimeout(zoomTimer);
    zoomTimer = setTimeout(() => (zooming = false), 150);
  }

  const clampScroll = (v: number) =>
    Math.max(0, Math.min(maxLaneScroll, v));

  /**
   * DRAG-TO-PAN — shared by the label gutter AND the lane body. Pointer events +
   * capture (on whichever surface started it) so the pan survives the pointer
   * leaving that surface mid-drag. Direct manipulation: the content follows the
   * pointer 1:1 (drag DOWN reveals earlier tracks), writing the SAME laneScrollY
   * the wheel already uses — no second scroll variable. A ~4px threshold gates
   * engagement so a plain click never jitters; the pan only writes laneScrollY
   * (no layout recompute), so it costs the same as native scrolling. `zooming` is
   * held for the duration so a mid-pan track collapse doesn't smear.
   */
  function beginPan(event: PointerEvent, el: HTMLElement) {
    if (event.button !== 0) return; // primary button only
    cancelMomentum(); // a new press kills any in-flight glide instantly
    panPointerId = event.pointerId;
    panEl = el;
    panEngaged = false;
    panStartY = event.clientY;
    panStartScroll = laneScrollY;
    panLastY = event.clientY;
    panLastT = event.timeStamp;
    panVel = 0;
    el.setPointerCapture(event.pointerId);
  }

  function movePan(event: PointerEvent) {
    if (panPointerId !== event.pointerId) return;
    const dy = event.clientY - panStartY;
    if (!panEngaged) {
      if (Math.abs(dy) < PAN_THRESHOLD_PX) return; // sub-threshold: not a pan yet
      panEngaged = true;
      panning = true; // grabbing cursor
      zooming = true; // suspend sub-lane reflow for the whole pan
      clearTimeout(zoomTimer);
    }
    // Content sticks to the pointer: down (dy>0) -> scroll up the list.
    laneScrollY = clampScroll(panStartScroll - dy);
    // Velocity sample (scroll units/ms) for release momentum.
    const dt = event.timeStamp - panLastT;
    if (dt > 0) {
      panVel = -(event.clientY - panLastY) / dt;
      panLastY = event.clientY;
      panLastT = event.timeStamp;
    }
  }

  function endPan(event: PointerEvent) {
    if (panPointerId !== event.pointerId) return;
    if (panEl?.hasPointerCapture(event.pointerId))
      panEl.releasePointerCapture(event.pointerId);
    panPointerId = null;
    panEl = null;
    const wasEngaged = panEngaged;
    panEngaged = false;
    panning = false;
    if (wasEngaged) startMomentum(); // release glide clears the reflow suspension
  }

  // Gutter surface: the whole gutter is a pan handle.
  function handleGutterPointerDown(event: PointerEvent) {
    beginPan(event, gutterEl);
  }

  /**
   * Lane-body surface: drag EMPTY track space to pan vertically too. Presses that
   * land on a block (or its resize zone) or the "Now" button are left to their
   * own handlers — interact.js block drags and the button click are untouched.
   * Only engages when the lanes actually overflow; horizontal time-pan stays on
   * the wheel, so a lane-body drag is purely vertical.
   */
  function handleLanePointerDown(event: PointerEvent) {
    if (maxLaneScroll <= 0) return; // nothing to scroll
    const target = event.target as HTMLElement;
    if (target.closest('.block, .resize-zone, .now-button')) return;
    beginPan(event, timelineEl);
  }

  /**
   * Brief momentum glide after a fast drag: exponential decay (~120ms constant,
   * dead within ~400ms), clamped to bounds, killed instantly by any new press.
   * Pure scroll writes — no per-frame layout.
   */
  function startMomentum() {
    const MIN_VEL = 0.02; // px/ms — below this, just stop
    const TAU = 120; // ms decay constant
    if (Math.abs(panVel) < MIN_VEL) {
      markZooming(); // nothing to glide; release the suspension shortly
      return;
    }
    let last = 0;
    const step = (ts: number) => {
      if (last === 0) last = ts;
      const dt = ts - last;
      last = ts;
      laneScrollY = clampScroll(laneScrollY + panVel * dt);
      panVel *= Math.exp(-dt / TAU);
      const atBound = laneScrollY <= 0 || laneScrollY >= maxLaneScroll;
      if (Math.abs(panVel) < MIN_VEL || atBound) {
        momentumRaf = 0;
        markZooming();
        return;
      }
      momentumRaf = requestAnimationFrame(step);
    };
    momentumRaf = requestAnimationFrame(step);
  }

  function cancelMomentum() {
    if (momentumRaf) {
      cancelAnimationFrame(momentumRaf);
      momentumRaf = 0;
    }
  }

  /**
   * Wheel over the HOUR-LABEL STRIP only = zoom the TIME axis. Multiplicative
   * per notch, clamped to [MIN,MAX]_TIME_SCALE. Anchoring splits by mode:
   *  - FOLLOW: anchor at the NOW-LINE. translateX is a pure function of
   *    Date.now() and the live scale (followX -> xOf), so simply changing the
   *    scale re-pins the current time under the needle automatically; no
   *    cursor math is added (that would fight the auto-pin).
   *  - FREE: anchor at the CURSOR. Capture the absolute time under the pointer
   *    BEFORE scaling, then set freeBaseX so that same time lands back under the
   *    pointer AFTER scaling (panPx folded to 0). The 15-min snap grid is
   *    unchanged — only display density moves.
   */
  function handleRulerWheel(event: WheelEvent) {
    event.preventDefault();
    const oldScale = view.timeScale;
    const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1; // wheel up = zoom in
    const newScale = clampTimeScale(oldScale * factor);
    if (newScale === oldScale) return; // already at a clamp

    if (mode === 'free') {
      // Absolute time currently under the cursor, at the OLD scale.
      const cursorPaneX =
        event.clientX - timelineEl.getBoundingClientRect().left;
      const tUnder = timeAtPaneX(freeBaseX + panPx, cursorPaneX);
      view.timeScale = newScale; // xOf now uses the new scale
      // Re-pin: cursorPaneX = xOf(tUnder) + freeBaseX  ->  solve for freeBaseX.
      freeBaseX = cursorPaneX - xOf(tUnder);
      panPx = 0;
    } else {
      // Follow mode pins the now-line by construction; just change the scale.
      view.timeScale = newScale;
    }
    persistTimeScale();
    updateHeaderDate();
    markZooming();
  }

  /** Tween back to the live follow position, then re-enter follow mode. */
  function returnToNow() {
    const token = ++tweenToken;
    const startX = freeBaseX + panPx;

    // The ease exists only for user free-mode panning; never animate a jump
    // larger than one screen (e.g. scrolled far away, or a huge time gap) —
    // snap straight to follow instead of a long slide.
    if (Math.abs(followX(Date.now()) - startX) > paneWidth) {
      panPx = 0;
      mode = 'follow';
      updateHeaderDate(); // snapped home — show today again immediately
      return;
    }

    const startT = performance.now();

    const step = (t: number) => {
      if (token !== tweenToken) return;
      const p = Math.min(1, (t - startT) / RETURN_TWEEN_MS);
      const ease = 1 - Math.pow(1 - p, 3);
      const target = followX(Date.now());
      freeBaseX = startX + (target - startX) * ease;
      panPx = 0;
      updateHeaderDate(); // the tween may sweep back across a day boundary
      if (p >= 1) {
        mode = 'follow';
        return;
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // Rolling window of ticks over whatever range the current translate shows.
  // Rebuilt only when the chosen interval OR the covered range changes (so a
  // zoom that switches the ladder rung forces a rebuild even at the same range).
  let tickIntervalMs = NaN;
  let firstTick = NaN;
  let lastTick = NaN;

  /** Smallest ladder interval whose on-screen spacing >= MIN_TICK_SPACING_PX. */
  function chooseTickInterval(): number {
    const k = pxPerMs();
    for (const iv of TICK_INTERVALS_MS) {
      if (iv * k >= MIN_TICK_SPACING_PX) return iv;
    }
    return TICK_INTERVALS_MS[TICK_INTERVALS_MS.length - 1];
  }

  /** Absolute time shown at pane-x for a given track translate (inverse of xOf). */
  function timeAtPaneX(translateX: number, paneX: number): number {
    return anchor + (paneX - translateX) / pxPerMs();
  }

  /**
   * Recompute the header date from the time currently sitting under the
   * now-line mark: timeAtPaneX(translateX, NOW_LINE_X) at the live scale, i.e.
   * timeAtPaneX at the marker. In follow mode this is exactly Date.now(); in
   * free mode it tracks the panned view across midnight boundaries. Called
   * from the coarse 1s tick and the free-scroll handlers — NOT the rAF loop;
   * the day-key guard makes repeat calls near-free.
   */
  function updateHeaderDate() {
    const translateX = mode === 'follow' ? followX(Date.now()) : freeBaseX + panPx;
    const d = new Date(timeAtPaneX(translateX, nowLineX));
    const key = d.getFullYear() * 10000 + d.getMonth() * 100 + d.getDate();
    if (key === headerDayKey) return;
    headerDayKey = key;
    headerDate = d.toLocaleDateString(undefined, HEADER_DATE_FMT);
  }

  /**
   * Live HH:MM:SS in the marker field. Always the ACTUAL current time (a clock,
   * not a scrub readout), so unlike the date it does NOT follow the free-mode
   * marker anchor. Second-guarded, so it only touches the clock span's text
   * node when the displayed second actually changes (no reflow — tabular-nums
   * keeps the width fixed). Driven by the existing ~1s tick, never the rAF loop.
   */
  function updateHeaderClock() {
    const now = Date.now();
    const key = Math.floor(now / 1000);
    if (key === headerSecondKey) return;
    headerSecondKey = key;
    headerClock = formatClock(now);
  }

  function updateTicks(translateX: number) {
    const interval = chooseTickInterval();
    const visibleFrom = timeAtPaneX(translateX, 0);
    const visibleTo = timeAtPaneX(translateX, paneWidth);
    const start = Math.floor((visibleFrom - TICK_BUFFER_MS) / interval);
    const end = Math.ceil((visibleTo + TICK_BUFFER_MS) / interval);
    // Rebuild on a range change OR a ladder-rung change (zoom at same range).
    if (interval === tickIntervalMs && start === firstTick && end === lastTick)
      return;
    tickIntervalMs = interval;
    firstTick = start;
    lastTick = end;

    // Midnight (00:00) reads as a full HH:MM like every other tick; the label
    // itself carries the date rollover, so no special major/minor split.
    const next: Tick[] = [];
    for (let i = start; i <= end; i++) {
      const time = i * interval;
      next.push({ time, x: xOf(time), label: formatClockHM(time), minor: false });
    }
    ticks = next;
  }

  function formatClock(t: number): string {
    const d = new Date(t);
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  onMount(() => {
    let raf = 0;

    // One frame's worth of positioning, extracted so it can also be applied
    // synchronously (outside rAF) the instant focus returns. FOLLOW reads the
    // wall clock directly, so this always lands on the true current time; FREE
    // re-applies its frozen offset (no drift).
    const render = (now: number) => {
      const translateX = mode === 'follow' ? followX(now) : freeBaseX + panPx;
      track.style.transform = `translate3d(${translateX}px, 0, 0)`;
      nowLine.style.left = `${xOf(now)}px`;
      const needleX = xOf(now) + translateX;
      const chipX = Math.max(44, Math.min(paneWidth - 44, needleX));
      clockEl.style.transform = `translate3d(${chipX}px, 0, 0) translate(-50%, -50%)`;
      clockEl.textContent = formatClock(now);
      updateTicks(translateX);

      // Dissolve fronts: PURELY COSMETIC — reads the block's stored times,
      // never writes them. consumedPx is time-space math, so the boundary
      // sits exactly under the needle in both follow and free mode.
      const k = pxPerMs(); // one live read per frame; no captured copies
      for (const [el, b] of liveOverlays) {
        const widthPx = b.duration_seconds * 1000 * k;
        const consumed = Math.min(Math.max((now - b.start_time) * k, 0), widthPx);
        el.style.width = `${consumed + DISSOLVE_EDGE_PX}px`;
      }
      return translateX;
    };

    const frame = () => {
      const now = Date.now();
      const translateX = render(now);
      stepParticles(now, translateX); // rAF-only garnish; render() alone is the snap path
      raf = requestAnimationFrame(frame);
    };

    // Particle canvas: size to the pane and read the ember palette before the
    // first frame. prefers-reduced-motion disables emission entirely.
    resizeCanvas();
    buildPalette();
    const rmq = window.matchMedia('(prefers-reduced-motion: reduce)');
    reducedMotion = rmq.matches;
    const onReducedMotion = () => {
      reducedMotion = rmq.matches;
      if (reducedMotion) killParticles();
    };
    rmq.addEventListener('change', onReducedMotion);

    raf = requestAnimationFrame(frame);

    interact(timelineEl).styleCursor(false).draggable({
      lockAxis: 'x',
      ignoreFrom: '.block',
      listeners: {
        start: () => enterFree(),
        move: (event) => {
          panPx += event.dx;
          updateHeaderDate(); // drag-panning across midnight flips the date live
        },
      },
    });

    // Resolve notification permission once (needed before the first live
    // completion can post a notification).
    void (async () => {
      try {
        notifyGranted =
          (await isPermissionGranted()) ||
          (await requestPermission()) === 'granted';
      } catch (e) {
        console.error('notification permission request failed', e);
      }
    })();

    // Live completion detection rides the coarse 1s clock (NOT the rAF loop).
    // Gated on store.reconciled so it never runs before startup catch-up, and
    // `completing` skips a tick if the previous async scan is still running.
    let completing = false;
    const runTick = () => {
      currentTime = Date.now();
      updateHeaderDate(); // also rolls the date over at local midnight
      updateHeaderClock(); // live HH:MM in the marker field
      if (!store.reconciled || completing) return;
      completing = true;
      completeDue(currentTime)
        .then((done) => {
          for (const block of done) announceCompletion(block);
          if (done.length > 0) logStatsSnapshot();
        })
        .catch((e) => console.error('completion detection failed', e))
        .finally(() => {
          completing = false;
        });
    };
    const clock = setInterval(runTick, 1000);

    // Return-from-background snap. rAF and setInterval are paused/throttled
    // while the window is hidden or minimized, so on return we recompute
    // synchronously here instead of waiting for the loop to resume — one exact
    // snap to the current time (follow is a pure function of Date.now(), so
    // there is never any catch-up slide or residual offset), plus an immediate
    // tick so block styling / now-line reflect true time at once. FREE mode is
    // left untouched (render just re-applies its frozen offset, no drift).
    const snapToNow = () => {
      render(Date.now());
      runTick();
      lastFrameT = 0; // resume fresh: no giant dt, no catch-up particles
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') snapToNow();
      else killParticles(); // hidden: drop garnish, emit nothing
    };
    document.addEventListener('visibilitychange', onVisibility);

    // Reinforcement: a minimized desktop window may not fire visibilitychange,
    // so also snap on the Tauri window regaining focus. The snap is idempotent,
    // so the two paths firing together is harmless.
    let unlistenFocus: (() => void) | undefined;
    getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (focused) snapToNow();
      })
      .then((un) => {
        unlistenFocus = un;
      })
      .catch((e) => console.error('window focus listener failed', e));

    const cellObserver = new ResizeObserver((entries) => {
      const rect = entries[entries.length - 1].contentRect;
      cellWidth = rect.width;
      cellHeight = rect.height;
      resizeCanvas(); // keep the particle canvas matched to the (dynamic) pane
      console.log(
        `[timeline cell] ${Math.round(cellWidth)} x ${Math.round(cellHeight)}`,
      );
    });
    cellObserver.observe(wrapEl);

    return () => {
      cancelAnimationFrame(raf);
      clearInterval(clock);
      document.removeEventListener('visibilitychange', onVisibility);
      rmq.removeEventListener('change', onReducedMotion);
      unlistenFocus?.();
      cellObserver.disconnect();
      interact(timelineEl).unset();
    };
  });

  /**
   * Registry of the dissolve overlays currently under the needle. Only these
   * are touched by the rAF loop — future blocks render no overlay and past
   * blocks get a static full-width one, so the 60fps work is bounded by how
   * many blocks intersect the needle right now. Registration/teardown rides
   * the template's {#if} lifecycle via this action.
   */
  const liveOverlays = new Map<HTMLElement, ScheduledBlock>();

  function consumedOverlay(node: HTMLElement, block: ScheduledBlock) {
    liveOverlays.set(node, block);
    return {
      update: (b: ScheduledBlock) => liveOverlays.set(node, b),
      destroy: () => {
        liveOverlays.delete(node);
        burstDone.delete(block.id); // a rescheduled block may burst again later
      },
    };
  }

  /* ---- Particle emission at the dissolve front (canvas overlay) ------------
   * A pooled, ring-buffered array drawn to ONE canvas — no per-particle DOM,
   * no per-frame allocation. Emits only while a block is dissolving; when
   * nothing is dissolving and all particles are dead, per-frame cost is zero
   * (one final clear, then skip). Everything runs inside the existing rAF loop.
   */
  interface Particle {
    active: boolean;
    x: number;
    y: number;
    vx: number;
    vy: number;
    life: number;
    maxLife: number;
    size: number;
    pi: number; // palette index
  }

  let particleCanvas: HTMLCanvasElement;
  let pctx: CanvasRenderingContext2D | null = null;
  let canvasW = 0;
  let canvasH = 0;
  const particles: Particle[] = Array.from({ length: MAX_PARTICLES }, () => ({
    active: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 1, size: 1, pi: 0,
  }));
  let head = 0; // ring-buffer write cursor: overwriting a live slot = oldest dies
  let liveCount = 0;
  let canvasDirty = false; // something was drawn, so an idle frame must clear once
  let lastFrameT = 0;
  let reducedMotion = false;
  /** rgb() strings derived once from --now-core/--now-halo (weighted to core). */
  let palette: string[] = ['rgb(255,92,97)', 'rgb(255,92,97)', 'rgb(229,72,77)', 'rgb(255,208,210)'];
  /** Block ids that already fired their completion burst (cleared on teardown). */
  const burstDone = new Set<number>();

  /** Normalize any CSS color to {r,g,b} using the 2D context's own parser. */
  function resolveColor(v: string): { r: number; g: number; b: number } {
    if (!pctx) return { r: 255, g: 92, b: 97 };
    pctx.fillStyle = '#000';
    pctx.fillStyle = v;
    const s = pctx.fillStyle;
    if (s[0] === '#') {
      return {
        r: parseInt(s.slice(1, 3), 16),
        g: parseInt(s.slice(3, 5), 16),
        b: parseInt(s.slice(5, 7), 16),
      };
    }
    const m = s.match(/[\d.]+/g);
    return m ? { r: +m[0], g: +m[1], b: +m[2] } : { r: 255, g: 92, b: 97 };
  }

  /** Read the shared now-tokens ONCE into an ember palette (re-run on retune). */
  function buildPalette() {
    const cs = getComputedStyle(wrapEl);
    const core = resolveColor(cs.getPropertyValue('--now-core').trim() || '#ff5c61');
    const halo = resolveColor(cs.getPropertyValue('--now-halo').trim() || '#e5484d');
    const bright = {
      r: (core.r + 255) >> 1, g: (core.g + 255) >> 1, b: (core.b + 255) >> 1,
    };
    const str = (c: { r: number; g: number; b: number }) => `rgb(${c.r}, ${c.g}, ${c.b})`;
    // weight toward core (2×), then halo, then a hot bright center
    palette = [str(core), str(core), str(halo), str(bright)];
  }

  /** Match the canvas backing store to the timeline pane at device resolution. */
  function resizeCanvas() {
    if (!particleCanvas || !timelineEl) return;
    const dpr = window.devicePixelRatio || 1;
    canvasW = timelineEl.clientWidth;
    canvasH = timelineEl.clientHeight;
    particleCanvas.width = Math.round(canvasW * dpr);
    particleCanvas.height = Math.round(canvasH * dpr);
    pctx = particleCanvas.getContext('2d');
    // setting .width reset the context — draw in CSS px, scaled by dpr for sharpness
    pctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    canvasDirty = true;
  }

  /** Init one pooled particle at the ring cursor (overwrites the oldest at cap). */
  function emit(x: number, y: number, vx: number, vy: number, life: number, size: number) {
    const p = particles[head];
    if (!p.active) liveCount++; // reviving a dead slot; overwriting a live one is net 0
    p.active = true;
    p.x = x; p.y = y; p.vx = vx; p.vy = vy;
    p.life = life; p.maxLife = life; p.size = size;
    p.pi = (Math.random() * palette.length) | 0;
    head = (head + 1) % MAX_PARTICLES;
  }

  /** One drifting ember off the burn line within a block's (sub-lane) segment. */
  function spawnEmber(needleX: number, b: ScheduledBlock) {
    const r = geom.blockRect(b);
    const top = r.top - laneScrollY; // content y -> on-screen (canvas) y
    const h = r.height;
    emit(
      needleX + (Math.random() * 3 - 1.5),
      top + Math.random() * h,
      -(15 + Math.random() * 45) * P_LEFT, // drift LEFT (carries the added velocity)
      ((Math.random() - 0.5) * 40 - 8) * P_SPEED, // vertical spread (unchanged)
      (0.5 + Math.random() * 0.7) * P_LIFE, // ~0.6–1.4s
      1 + Math.random() * 2, // 1–3px
    );
  }

  /** Finishing flourish: a small radial burst along the block's final edge. */
  function burstEmber(needleX: number, b: ScheduledBlock) {
    const r = geom.blockRect(b);
    const top = r.top - laneScrollY; // content y -> on-screen (canvas) y
    const h = r.height;
    const n = BURST_MIN + ((Math.random() * BURST_RANGE) | 0);
    for (let k = 0; k < n; k++) {
      const ang = Math.random() * P_TAU;
      const spd = (25 + Math.random() * 75) * P_SPEED;
      emit(
        needleX + (Math.random() * 3 - 1.5),
        top + Math.random() * h,
        Math.cos(ang) * spd - 20 * P_LEFT, // radial spread + LEFT bias (carries added vel)
        Math.sin(ang) * spd,
        (0.4 + Math.random() * 0.6) * P_LIFE,
        1 + Math.random() * 2.5,
      );
    }
  }

  /** Ephemeral garnish — drop everything (no catch-up) on hide / reduced motion. */
  function killParticles() {
    for (let i = 0; i < MAX_PARTICLES; i++) particles[i].active = false;
    liveCount = 0;
    head = 0;
    burstDone.clear();
    pctx?.clearRect(0, 0, canvasW, canvasH);
    canvasDirty = false;
  }

  /**
   * Per-frame particle step, called from the EXISTING rAF loop after render().
   * Emits from every dissolving block's needle-crossing, updates + draws the
   * pool, and does exactly nothing once the pool is empty and nothing dissolves.
   */
  function stepParticles(now: number, translateX: number) {
    if (!pctx) return;
    const dt = lastFrameT === 0 ? 0 : Math.min((now - lastFrameT) / 1000, 0.05);
    lastFrameT = now;

    const dissolving = liveOverlays.size > 0;

    // Emit: only while dissolving, only if the needle is on-screen, never under
    // reduced motion.
    if (!reducedMotion && dissolving && dt > 0) {
      const needleX = translateX + xOf(now);
      if (needleX >= 0 && needleX <= canvasW) {
        for (const b of liveOverlays.values()) {
          if (Math.random() < EMIT_PER_SEC * dt) spawnEmber(needleX, b);
          if (now >= blockEnd(b) && !burstDone.has(b.id)) {
            burstDone.add(b.id);
            burstEmber(needleX, b);
          }
        }
      }
    }

    if (liveCount > 0) {
      pctx.clearRect(0, 0, canvasW, canvasH);
      pctx.globalCompositeOperation = 'lighter'; // additive ember glow
      const damp = Math.exp(-1.6 * dt); // mild, frame-rate-independent deceleration
      for (let i = 0; i < MAX_PARTICLES; i++) {
        const p = particles[i];
        if (!p.active) continue;
        p.life -= dt;
        if (p.life <= 0) {
          p.active = false;
          liveCount--;
          continue;
        }
        p.vy += P_GRAVITY * dt; // gravity: pull downward before drag/integrate
        p.vx *= damp;
        p.vy *= damp;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        const a = p.life / p.maxLife;
        pctx.globalAlpha = a * a; // ease-out fade
        pctx.fillStyle = palette[p.pi];
        const s = p.size * (0.2 + 0.8 * a); // shrink full -> 20% over lifetime
        pctx.fillRect(p.x - s, p.y - s, s * 2, s * 2); // square ember, centered
      }
      pctx.globalAlpha = 1;
      pctx.globalCompositeOperation = 'source-over';
      canvasDirty = true;
    } else if (canvasDirty) {
      pctx.clearRect(0, 0, canvasW, canvasH); // one clear, then zero work while idle
      canvasDirty = false;
    }
  }

  /**
   * Svelte action: drag a placed block to reschedule (x -> start_time) and/or
   * move it between lanes (y -> track_id). Transform-only during the gesture;
   * on end the FINAL resolved position converts back to time + lane, both
   * persist in one update, then rendering returns to the time+lane model.
   */
  function blockGestures(node: HTMLElement, block: ScheduledBlock) {
    let offsetX = 0;
    let offsetY = 0;
    // Rebound by update() below: after loadStore() replaces store.blocks,
    // the keyed each reuses this DOM node with a NEW block object — without
    // rebinding, gestures would mutate a stale object the UI no longer renders.
    let current = block;
    // Right-click = delete this one block, immediately (Undo toast follows).
    // preventDefault suppresses any context menu — timeline blocks get NO
    // menu, by design (the pool chips are the ones with a menu). contextmenu
    // is a native event outside interact's tap/drag arbitration, so it fires
    // reliably regardless of pointer jitter. interact only drags with the
    // left button, so a right press never starts a gesture.
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      void deleteBlockWithUndo(current);
    };
    node.addEventListener('contextmenu', onContextMenu);

    interact(node).draggable({
      ignoreFrom: '.resize-zone',
      listeners: {
        start() {
          offsetX = 0;
          offsetY = 0;
          draggingId = current.id;
        },
        move(event) {
          offsetX += event.dx;
          offsetY += event.dy;
          node.style.transform = `translate(${offsetX}px, ${offsetY}px)`;
        },
        end() {
          if (draggingId !== current.id) return; // aborted gesture — nothing to place
          // x -> time: inverse of the on-screen position, measured against
          // the track so it's correct in both follow and free mode.
          const trackRect = track.getBoundingClientRect();
          const blockRect = node.getBoundingClientRect();
          const exact = anchor + (blockRect.left - trackRect.left) / pxPerMs();
          const newStart = snapTime(exact);

          // y -> TRACK: resolve the block's CENTER against the CURRENT variable
          // track bands (running-sum offsets), adjusting on-screen y to content
          // space by the vertical lane scroll. The sub-lane within the track is
          // irrelevant — assignment slots it after landing.
          const contentCenterY =
            blockRect.top + blockRect.height / 2 - trackRect.top + laneScrollY;
          let newTrackId = geom.yToTrack(contentCenterY) ?? current.track_id;

          // Eligibility gate: a block's track must stay inside its activity's
          // eligible set. An ineligible track bounces back to the original; the
          // time reschedule still applies. Overlapping in time within an
          // eligible track is ALLOWED (that's what sub-lanes are for).
          if (
            newTrackId !== current.track_id &&
            !isEligible(current.activity_id, newTrackId)
          ) {
            newTrackId = current.track_id;
          }

          // Land in the exact sub-lane it will occupy: run the assignment for
          // the target track with `current` at its new position. yOffset of the
          // target track is stable (only tracks below it shift), so this top is
          // final — no flash; blocks below reflow reactively (with transition).
          const targetBlocks = store.blocks
            .filter((b) => b.track_id === newTrackId && b.id !== current.id)
            .map((b) => ({
              id: b.id, start_time: b.start_time, duration_seconds: b.duration_seconds,
            }));
          targetBlocks.push({
            id: current.id, start_time: newStart, duration_seconds: current.duration_seconds,
          });
          const sub =
            assignSubLanes(targetBlocks, Date.now()).laneOf.get(current.id) ?? 0;
          // Exact landing rect (main OR half-height child) via the geometry
          // helper; the target track's offset is stable, so no flash.
          const rect = geom.bandRect(newTrackId, sub);

          node.style.left = `${xOf(newStart)}px`;
          node.style.top = `${rect.top}px`;
          node.style.height = `${rect.height}px`;
          node.style.transform = '';
          offsetX = 0;
          offsetY = 0;
          draggingId = null;

          rescheduleBlock(current, newStart, newTrackId).catch((e) =>
            console.error('Failed to reschedule block:', e),
          );
        },
      },
    });

    interact(node).resizable({
      edges: { left: false, right: '.resize-zone', top: false, bottom: false },
      modifiers: [
        // Function form keeps the min pixel width tracking the live time zoom;
        // interact's types only advertise a Rect-returning function, so cast.
        interact.modifiers.restrictSize({
          min: (() => ({ width: minWidthPx(), height: 0 })) as unknown as {
            width: number;
            height: number;
          },
        }),
      ],
      listeners: {
        start() {
          resizingId = current.id;
          liveDurationS = current.duration_seconds;
        },
        move(event) {
          const widthPx = event.rect.width;
          node.style.width = `${widthPx}px`;
          liveDurationS = widthPx / pxPerMs() / 1000;
        },
        end(event) {
          if (resizingId !== current.id) return; // aborted gesture — nothing to apply
          const exactMs = event.rect.width / pxPerMs();
          const snappedS = Math.max(
            MIN_DURATION_S,
            Math.round(snapTime(exactMs) / 1000),
          );
          node.style.width = `${snappedS * 1000 * pxPerMs()}px`;
          resizingId = null;

          resizeBlock(current, snappedS).catch((e) =>
            console.error('Failed to resize block:', e),
          );
        },
      },
    });

    return {
      update: (newBlock: ScheduledBlock) => {
        current = newBlock;
      },
      destroy: () => {
        node.removeEventListener('contextmenu', onContextMenu);
        interact(node).unset();
      },
    };
  }

  function formatDuration(seconds: number): string {
    const minutes = Math.round(seconds / 60);
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    if (h === 0) return `${m} min`;
    return m === 0 ? `${h} h` : `${h} h ${m} min`;
  }

  /** Wall-clock HH:MM of an epoch-ms time (for a block's finish time). */
  function formatClockHM(t: number): string {
    const d = new Date(t);
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function blockEnd(block: ScheduledBlock): number {
    return block.start_time + block.duration_seconds * 1000;
  }
</script>

<div class="timeline-wrap" bind:this={wrapEl}>
  <div class="topbar">
    <div class="corner">
      <TrackManager />
    </div>
    <header class="header">
      <div class="now-marker">
        <span class="marker-date">{headerDate}</span>
        <span class="marker-time">{headerClock}</span>
      </div>
      <div class="clock" class:detached={mode === 'free'} bind:this={clockEl}></div>
    </header>
  </div>

  <div class="body">
    <!-- Wheel over the gutter zooms all track heights (anchored to cursor);
         DRAG over the gutter pans the shared vertical scroll (labels follow the
         pointer). Wheel over the lane bodies keeps its time-pan / scroll roles. -->
    <div
      class="gutter"
      class:panning
      role="group"
      aria-label="Track labels — drag to scroll, wheel to zoom"
      bind:this={gutterEl}
      onwheel={handleGutterWheel}
      onpointerdown={handleGutterPointerDown}
      onpointermove={movePan}
      onpointerup={endPan}
      onpointercancel={endPan}
    >
      <div class="gutter-spacer"></div>
      <!-- Labels scroll vertically in sync with the lane bodies. Each label
           grows to its track's full (variable) height and centers its name. -->
      <div class="gutter-labels" style:transform="translateY({-laneScrollY}px)">
        {#each store.tracks as t (t.id)}
          {@const subCount = geom.subLaneCount(t.id)}
          <div
            class="lane-label"
            class:drop-no={dragUI.activityId !== null && !isEligible(dragUI.activityId, t.id)}
            style:height="{geom.trackHeight(t.id)}px"
          >
            <span class="lane-swatch" style:background={t.color}></span>
            <span class="lane-name">{t.name}</span>
            <!-- faint separators cue an expanded track's anonymous sub-lanes -->
            {#each { length: subCount - 1 } as _, si (si)}
              <span class="sublane-sep" style:top="{geom.subLaneOffsetY(si + 1)}px"></span>
            {/each}
          </div>
        {/each}
      </div>
    </div>

    <div
      class="timeline"
      class:panning
      role="group"
      aria-label="Timeline — drag empty space to pan vertically"
      bind:this={timelineEl}
      bind:clientWidth={paneWidth}
      bind:clientHeight={paneHeight}
      onwheel={handleWheel}
      onpointerdown={handleLanePointerDown}
      onpointermove={movePan}
      onpointerup={endPan}
      onpointercancel={endPan}
    >
      <!-- Hour-label strip = the THIRD wheel surface: time-axis zoom. Its own
           onwheel stops propagation so the lane-body pan handler on .timeline
           doesn't also fire. -->
      <div
        class="ruler"
        aria-hidden="true"
        onwheel={(e) => {
          e.stopPropagation();
          handleRulerWheel(e);
        }}
      ></div>

      <!-- Lane-row backgrounds: one band per track at its variable height,
           scrolling vertically with the blocks. data-track-id lets the pool
           drop hit-test the track directly from rendered geometry. -->
      <div class="lane-rows" style:transform="translateY({-laneScrollY}px)">
        {#each store.tracks as t, i (t.id)}
          {@const subCount = geom.subLaneCount(t.id)}
          <div
            class="lane-row"
            data-track-id={t.id}
            class:alt={i % 2 === 1}
            class:drop-ok={dragUI.activityId !== null && isEligible(dragUI.activityId, t.id)}
            class:drop-no={dragUI.activityId !== null && !isEligible(dragUI.activityId, t.id)}
            style:top="{geom.trackOffsetY(t.id)}px"
            style:height="{geom.trackHeight(t.id)}px"
          >
            {#each { length: subCount - 1 } as _, si (si)}
              <span class="sublane-sep" style:top="{geom.subLaneOffsetY(si + 1)}px"></span>
            {/each}
          </div>
        {/each}
      </div>

      <div class="track" bind:this={track}>
        {#each ticks as tick (tick.time)}
          {#if tick.minor}
            <div class="tick-minor" style:left="{tick.x}px"></div>
          {:else}
            <div class="tick" style:left="{tick.x}px">
              <span class="tick-label">{tick.label}</span>
            </div>
          {/if}
        {/each}

        <!-- Blocks scroll VERTICALLY with the lanes (translateY), while the
             track only translates horizontally (time). Ticks + now-line stay
             full-pane-height outside this layer. -->
        <div class="blocks-layer" class:zooming style:transform="translateY({-laneScrollY}px)">
        {#each store.blocks as block (block.id)}
          {@const activity = activityById.get(block.activity_id)}
          {@const end = blockEnd(block)}
          {@const done = block.status !== 'scheduled'}
          {@const active =
            block.status === 'scheduled' &&
            block.start_time <= currentTime &&
            currentTime < end}
          {@const fullyConsumed = done || end <= currentTime}
          {@const rect = geom.blockRect(block)}
          <div
            class="block"
            data-block-id={block.id}
            class:dragging={draggingId === block.id}
            class:resizing={resizingId === block.id}
            class:completed={done}
            class:active-now={active}
            class:child={rect.sub > 0}
            style:left="{xOf(block.start_time)}px"
            style:top="{rect.top}px"
            style:width="{block.duration_seconds * 1000 * pxPerMs()}px"
            style:height="{rect.height}px"
            style:background={trackById.get(block.track_id)?.color ?? '#888888'}
            title="Drag to move · drag right edge to resize · right-click to delete"
            use:blockGestures={block}
          >
            <span class="block-label">{activity?.name ?? 'Unknown'}</span>
            {#if resizingId === block.id}
              <span class="duration-badge">{formatDuration(liveDurationS)}</span>
            {:else}
              <span class="block-duration">{formatDuration(block.duration_seconds)}</span>
            {/if}
            <span class="resize-zone"></span>

            <!-- The "already lived" veil. Fully consumed/past: static full
                 cover (the ONE grayed treatment). Under the needle: width is
                 driven per-frame from the rAF loop via the action. Future:
                 nothing. Cosmetic only — block data is never touched. -->
            {#if fullyConsumed}
              <div class="consumed"></div>
            {:else if active}
              <div class="consumed live" use:consumedOverlay={block}></div>
            {/if}
          </div>

          <!-- Finish time under the block (main lanes only — a half-height
               child lane has no room for it below). Scrolls with the blocks. -->
          {#if rect.sub === 0}
          <div
            class="block-finish"
            class:completed={done}
            style:left="{xOf(block.start_time)}px"
            style:top="{rect.top + rect.height + 1}px"
          >
            ends {formatClockHM(blockEnd(block))}
          </div>
          {/if}
        {/each}
        </div>

        <!-- Child of the track, positioned by absolute time each frame.
             Full pane height, NOT vertically scrolled. -->
        <div class="now-line" bind:this={nowLine}></div>
      </div>

      <!-- Dissolve-front embers. One canvas in pane space (sibling of .track),
           above the blocks; drawn imperatively from the rAF loop. -->
      <canvas class="particles" bind:this={particleCanvas} aria-hidden="true"></canvas>

      {#if mode === 'free'}
        <button class="now-button" onclick={returnToNow}>Now</button>
      {/if}
    </div>
  </div>

  {#if blockUndo}
    <div class="undo-toast">
      <span>Deleted <strong>{activityById.get(blockUndo.activity_id)?.name ?? 'block'}</strong> block</span>
      <button class="undo-btn" onclick={undoBlockDelete}>Undo</button>
    </div>
  {/if}

  {#if catchUpCount > 0}
    <div class="catchup-toast">
      Logged {catchUpCount} completed {catchUpCount === 1 ? 'activity' : 'activities'} while
      you were away
    </div>
  {/if}
</div>

<style>
  .timeline-wrap {
    /* "Now" instrument identity — ONE source of truth for the needle AND the
       header marker field. Glow/gradient derive from --now-core/--now-halo via
       color-mix, so retuning a single token restyles both together. The sheen
       @keyframes (now-sheen) is defined once below and reused by both, driven
       per-element by --sheen-from/--sheen-to for its axis. */
    --now-core: #ff5c61; /* bright core */
    --now-halo: #e5484d; /* glow */
    --now-sheen-color: rgba(255, 255, 255, 0.9);
    --now-sheen-dur: 3.6s;
    --now-glow:
      0 0 3px 1px color-mix(in srgb, var(--now-core) 88%, transparent),
      0 0 10px 2px color-mix(in srgb, var(--now-halo) 55%, transparent),
      0 0 26px 6px color-mix(in srgb, var(--now-halo) 28%, transparent);

    position: relative;
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
  }

  .undo-toast {
    position: absolute;
    bottom: 12px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 80;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.4rem 0.9rem;
    font-size: 0.8rem;
    color: #e6e6e6;
    background: #2c2c2c;
    border: 1px solid #454545;
    border-radius: 999px;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.45);
    white-space: nowrap;
  }

  .undo-toast strong {
    font-weight: 600;
    color: #f5f5f5;
  }

  .undo-btn {
    padding: 0.15rem 0.7rem;
    font-size: 0.78rem;
    font-weight: 600;
    color: #e6e6e6;
    background: #3a3a3a;
    border: 1px solid #555555;
    border-radius: 999px;
    cursor: pointer;
    transition: background 120ms ease;
  }

  .undo-btn:hover {
    background: #474747;
  }

  /* Quiet startup summary — no action, distinct from the interactive toasts. */
  .catchup-toast {
    position: absolute;
    bottom: 12px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 80;
    max-width: 90%;
    padding: 0.4rem 0.9rem;
    font-size: 0.78rem;
    color: #cfcfcf;
    background: #262626;
    border: 1px solid #3d3d3d;
    border-radius: 999px;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.45);
    pointer-events: none;
    text-align: center;
  }

  .topbar {
    display: flex;
    flex: none;
    border-bottom: 1px solid #3a3a3a;
  }

  .corner {
    flex: none;
    width: 130px;
    display: flex;
    align-items: center;
    padding: 0.35rem 0.5rem;
    border-right: 1px solid #2e2e2e;
  }

  /* Right header cell aligns exactly above the scroll area, so the clock
     chip's x (needle x within the scroll area) needs no extra offset. */
  .header {
    position: relative;
    flex: 1;
    min-width: 0;
  }

  /* Glued to the header strip — never scrolls with the track. The moving
     clock chip is rendered after it, so the chip paints on top if they meet. */
  /* The glued "now marker": date (follows the marker anchor) + live clock.
     Shares the needle's tokens so it reads as the same instrument — but at
     ~half glow intensity to stay readable. */
  .now-marker {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    white-space: nowrap;
    pointer-events: none;
    isolation: isolate; /* contain the screen-blended sheen to this field */
  }

  .marker-date,
  .marker-time {
    letter-spacing: 0.05em;
  }

  .marker-date {
    font-size: 0.72rem;
    font-weight: 600;
    /* readable, faintly warmed toward the accent */
    color: color-mix(in srgb, var(--now-core) 32%, #cfcfcf);
  }

  /* The marker's star: crisp core-colored outline + layered halo glow — the
     text equivalent of the needle's core+halo. tabular-nums fixes every glyph
     cell's width so the ticking seconds never reflow or shift the date. All
     paint (stroke/shadow) — no layout on the per-second text swap. Stronger
     than the date, still short of the needle (16px max spread vs the needle's
     26px). */
  .marker-time {
    font-size: 0.8rem;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.06em;
    /* bright warm fill so the digits read clearly inside the outline */
    color: color-mix(in srgb, var(--now-core), white 22%);
    -webkit-text-stroke: 0.6px var(--now-core); /* crisp core edge, on top */
    /* halo beneath: tight bright layer + wider soft aura */
    text-shadow:
      0 0 3px color-mix(in srgb, var(--now-halo) 70%, transparent),
      0 0 8px color-mix(in srgb, var(--now-halo) 42%, transparent),
      0 0 16px color-mix(in srgb, var(--now-halo) 22%, transparent);
  }

  /* SAME sheen keyframes as the needle, swept horizontally across the field;
     subtler (lower opacity) and screen-blended so it reads as a shine. */
  .now-marker::after {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(
      105deg,
      transparent,
      var(--now-sheen-color) 50%,
      transparent
    );
    background-repeat: no-repeat;
    background-size: 45% 100%;
    --sheen-from: -90% 0%;
    --sheen-to: 190% 0%;
    opacity: 0.45;
    mix-blend-mode: screen;
    pointer-events: none;
    animation: now-sheen var(--now-sheen-dur) linear infinite;
  }

  /* The timestamp pill = the glowing "head" of the needle. Same core+halo
     recipe as the needle, tuned a notch below it (max ~20px bloom vs 26px),
     so hierarchy reads needle > pill > date. Dark fill kept for legibility;
     the inner glow is a faint halo, not a red wash. isolation:isolate makes
     this a stacking context so the sheen ::before can sit above the fill but
     UNDER the text via z-index:-1. */
  .clock {
    position: absolute;
    top: 50%;
    left: 0;
    padding: 0.15rem 0.65rem;
    font-size: 0.8rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.04em;
    color: #f5f5f5;
    background: linear-gradient(180deg, #33272a 0%, #2a2022 100%);
    border: 1px solid var(--now-core);
    border-radius: 999px;
    box-shadow:
      0 0 4px 1px color-mix(in srgb, var(--now-core) 60%, transparent),
      0 0 11px 2px color-mix(in srgb, var(--now-halo) 45%, transparent),
      0 0 20px 5px color-mix(in srgb, var(--now-halo) 22%, transparent),
      inset 0 0 6px color-mix(in srgb, var(--now-halo) 20%, transparent);
    pointer-events: none;
    white-space: nowrap;
    isolation: isolate;
  }

  /* Sheen on the pill surface — SAME now-sheen keyframes/duration as the
     needle & field. inset 1px + inherited radius keeps it inside the rim;
     z-index:-1 + screen blend brightens the dark fill under the digits. */
  .clock::before {
    content: '';
    position: absolute;
    inset: 1px;
    z-index: -1;
    border-radius: inherit;
    background: linear-gradient(
      105deg,
      transparent,
      var(--now-sheen-color) 50%,
      transparent
    );
    background-repeat: no-repeat;
    background-size: 45% 100%;
    --sheen-from: -90% 0%;
    --sheen-to: 190% 0%;
    opacity: 0.4;
    mix-blend-mode: screen;
    pointer-events: none;
    animation: now-sheen var(--now-sheen-dur) linear infinite;
  }

  /* Part C — the join: a glowing notch under the pill's bottom-center that the
     needle rises into (seamless in follow mode). */
  .clock::after {
    content: '';
    position: absolute;
    top: 100%;
    left: 50%;
    transform: translateX(-50%);
    border: 5px solid transparent;
    border-top-color: var(--now-core);
    filter: drop-shadow(0 1px 3px color-mix(in srgb, var(--now-halo) 65%, transparent));
    transition: opacity 200ms ease;
  }

  /* In free mode the needle scrolls off from under the pill — fade the join
     accent so it doesn't point at empty timeline. */
  .clock.detached::after {
    opacity: 0.2;
  }

  .body {
    display: flex;
    flex: 1;
    min-height: 0;
  }

  .gutter {
    flex: none;
    width: 130px;
    border-right: 1px solid #2e2e2e;
    overflow: hidden;
    cursor: grab;
    /* Drag-to-pan owns the pointer: no native touch-scroll or text selection. */
    touch-action: none;
    user-select: none;
  }
  .gutter.panning {
    cursor: grabbing;
  }

  .gutter-spacer {
    height: 28px; /* matches RULER_HEIGHT */
    border-bottom: 1px solid #2e2e2e;
  }

  /* Scrolls vertically in lockstep with .lane-rows / .blocks-layer. */
  .gutter-labels {
    will-change: transform;
  }

  .lane-label {
    position: relative; /* anchors the sub-lane separators */
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0 0.75rem;
    border-bottom: 1px solid #2a2a2a;
  }

  /* Faint anonymous-sub-lane divider (no label of its own). */
  .sublane-sep {
    position: absolute;
    left: 0;
    right: 0;
    height: 0;
    border-top: 1px dashed rgba(255, 255, 255, 0.07);
    pointer-events: none;
  }

  .lane-swatch {
    width: 0.7rem;
    height: 0.7rem;
    border-radius: 3px;
    flex-shrink: 0;
  }

  .lane-name {
    font-size: 0.8rem;
    font-weight: 600;
    color: #b9b9b9;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .timeline {
    position: relative;
    flex: 1;
    min-width: 0;
    overflow: hidden;
  }
  /* Active vertical pan over empty lane space — blocks keep their own cursors. */
  .timeline.panning {
    cursor: grabbing;
  }

  .ruler {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 28px; /* RULER_HEIGHT */
    background: rgba(255, 255, 255, 0.025);
    border-bottom: 1px solid #2e2e2e;
    /* Captures its own wheel (time-axis zoom); the rest of the pane pans. */
    pointer-events: auto;
    cursor: ns-resize;
    z-index: 2;
  }

  /* Vertical-scroll layer for the lane backgrounds. */
  .lane-rows {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    will-change: transform;
  }

  .lane-row {
    position: absolute;
    left: 0;
    right: 0;
    border-bottom: 1px solid #2a2a2a;
    pointer-events: none;
    transition: background 120ms ease;
  }

  .lane-row.alt {
    background: rgba(255, 255, 255, 0.015);
  }

  /* Chip-drag lane hints: eligible lanes glow faintly, the rest dim.
     Declared after .alt so they win the equal-specificity cascade. */
  .lane-row.drop-ok {
    background: rgba(255, 255, 255, 0.05);
  }

  .lane-row.drop-no {
    background: rgba(0, 0, 0, 0.45);
  }

  .lane-label {
    transition: opacity 120ms ease;
  }

  .lane-label.drop-no {
    opacity: 0.35;
  }

  .track {
    position: absolute;
    inset: 0;
    will-change: transform;
  }

  /* Blocks scroll vertically within the (horizontally-translated) track. */
  .blocks-layer {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    will-change: transform;
  }

  /* Zoom applies scale immediately; the reflow transition would smear across
     the wheel burst, so suspend it while zooming. */
  .blocks-layer.zooming .block {
    transition: none;
  }

  /* Ember overlay: above the blocks (.track is a will-change stacking context,
     so this sits above the whole track), below the now-button, non-interactive. */
  .particles {
    position: absolute;
    top: 0;
    left: 0;
    /* Explicit CSS size: a <canvas> is a replaced element, so inset:0 alone
       would leave its CSS box at the intrinsic (backing-store) width and
       mismatch the drawing coords. width/height:100% pins the CSS box to the
       pane while the width/height attributes hold the dpr backing store. */
    width: 100%;
    height: 100%;
    z-index: 5;
    pointer-events: none;
  }

  .tick {
    position: absolute;
    top: 28px;
    bottom: 0;
    width: 1px;
    background: linear-gradient(180deg, #383838 0%, #262626 30%, #222222 100%);
  }

  .tick-label {
    position: absolute;
    top: -28px;
    left: 0;
    transform: translateX(-50%);
    height: 28px;
    line-height: 28px;
    font-size: 0.68rem;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.06em;
    color: #7d7d7d;
    white-space: nowrap;
    z-index: 3;
  }

  .tick-minor {
    position: absolute;
    top: 20px;
    height: 8px;
    width: 1px;
    background: #3d3d3d;
  }

  .block {
    position: absolute;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: flex-start;
    gap: 2px;
    padding: 0 0.5rem;
    border-radius: 6px;
    overflow: hidden;
    cursor: grab;
    touch-action: none;
    transition:
      filter 120ms ease,
      box-shadow 120ms ease,
      opacity 120ms ease,
      top 120ms ease; /* smooth reflow when a track expands/collapses */
  }

  /* Half-height child sub-lane: one truncated line (name only), no wrap. */
  .block.child {
    flex-direction: row;
    align-items: center;
    gap: 0.4rem;
    padding: 0 0.4rem;
  }

  .block.child .block-duration {
    display: none;
  }

  .block:hover {
    filter: brightness(1.12);
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.45);
  }

  /* No top-transition mid-gesture: the dragged block moves by transform and
     lands at its exact computed top — the transition must not fight it. */
  .block.dragging,
  .block.resizing {
    filter: brightness(1.12);
    box-shadow: 0 8px 20px rgba(0, 0, 0, 0.55);
    opacity: 0.92;
    z-index: 10;
    transition:
      filter 120ms ease,
      box-shadow 120ms ease,
      opacity 120ms ease;
  }

  .block.dragging {
    cursor: grabbing;
  }

  .block.resizing {
    cursor: col-resize;
  }

  /* The "already lived" veil — THE single grayed treatment (dissolving,
     freshly completed, and old past blocks all use it, so they're identical).
     Width = consumedPx + 8px soft edge; the fade OVERHANGS the front and, at
     100%, slides out past the block's overflow:hidden right edge — so a
     finishing dissolve becomes the static past look with no style swap or
     pop. Keep the 8px in sync with DISSOLVE_EDGE_PX. backdrop-filter grays
     whatever sits beneath (background AND label). pointer-events:none keeps
     drag/resize hit-testing untouched. */
  .consumed {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: calc(100% + 8px); /* the static fully-consumed cover */
    pointer-events: none;
    background: rgba(22, 22, 22, 0.5);
    backdrop-filter: grayscale(0.8) brightness(0.8);
    -webkit-mask-image: linear-gradient(90deg, #000 calc(100% - 8px), transparent);
    mask-image: linear-gradient(90deg, #000 calc(100% - 8px), transparent);
  }

  .consumed.live {
    width: 0; /* the next rAF frame takes over with the real consumed width */
  }

  .block.active-now {
    outline: 2px solid #e5484d;
    outline-offset: 1px;
  }

  .block-label {
    max-width: 100%;
    font-size: 0.75rem;
    font-weight: 600;
    color: rgba(0, 0, 0, 0.78);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Total scheduled time, inside the block under the name. */
  .block-duration {
    max-width: 100%;
    font-size: 0.68rem;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
    color: rgba(0, 0, 0, 0.6);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Finish time, in the track just below the block (dark background). */
  .block-finish {
    position: absolute;
    font-size: 0.62rem;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.02em;
    color: #8f8f8f;
    white-space: nowrap;
    pointer-events: none;
    z-index: 1;
  }

  .block-finish.completed {
    opacity: 0.5;
  }

  .duration-badge {
    position: absolute;
    top: 4px;
    right: 12px;
    padding: 1px 6px;
    font-size: 0.65rem;
    font-variant-numeric: tabular-nums;
    color: #ffffff;
    background: rgba(0, 0, 0, 0.55);
    border-radius: 4px;
    pointer-events: none;
    white-space: nowrap;
  }

  .resize-zone {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    width: 12px;
    cursor: col-resize;
  }

  .resize-zone::after {
    content: '';
    position: absolute;
    top: 50%;
    right: 4px;
    width: 3px;
    height: 40%;
    transform: translateY(-50%);
    border-radius: 2px;
    background: rgba(0, 0, 0, 0.4);
    opacity: 0;
    transition: opacity 120ms ease;
  }

  .block:hover .resize-zone::after,
  .block.resizing .resize-zone::after {
    opacity: 1;
  }

  /* The needle: bright core + layered glow, with a slow sheen sweeping down
     its length. Composited only (the sheen animates transform); the loop is
     ~3.6s so it reads as a shimmer, not a strobe. Sits ABOVE blocks (z:6 vs
     their auto/10-when-dragging) so it visually does the consuming. */
  .now-line {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 2px;
    margin-left: -1px;
    /* core/halo from the shared tokens (visually identical to the old literals) */
    background: linear-gradient(
      180deg,
      color-mix(in srgb, var(--now-core), white 55%) 0%,
      var(--now-core) 30%,
      var(--now-halo) 70%,
      color-mix(in srgb, var(--now-halo), transparent 35%) 100%
    );
    box-shadow: var(--now-glow);
    pointer-events: none;
    z-index: 6;
  }

  /* Part C: a glowing "plug" at the needle's top, flush with the header edge
     (the timeline clips above it). A child of the needle, so it travels with
     it in free mode while the header field stays glued. */
  .now-line::before {
    content: '';
    position: absolute;
    top: 0;
    left: 50%;
    width: 7px;
    height: 9px;
    margin-left: -3.5px;
    border-radius: 0 0 4px 4px;
    background: color-mix(in srgb, var(--now-core), white 30%);
    box-shadow:
      0 0 5px 1px color-mix(in srgb, var(--now-core) 90%, transparent),
      0 0 12px 3px color-mix(in srgb, var(--now-halo) 50%, transparent);
  }

  /* Sheen: SAME now-sheen keyframes as the header field, swept vertically down
     the needle via --sheen-from/--sheen-to. background-position (not transform)
     keeps it confined to the 2px line with no clip needed. */
  .now-line::after {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(
      180deg,
      transparent,
      var(--now-sheen-color) 50%,
      transparent
    );
    background-repeat: no-repeat;
    background-size: 100% 45%;
    --sheen-from: 0% -85%;
    --sheen-to: 0% 185%;
    animation: now-sheen var(--now-sheen-dur) linear infinite;
  }

  /* Reused by both the needle (vertical) and the header field (horizontal);
     each supplies its own axis via --sheen-from/--sheen-to. */
  @keyframes now-sheen {
    from {
      background-position: var(--sheen-from);
    }
    to {
      background-position: var(--sheen-to);
    }
  }

  .now-button {
    position: absolute;
    top: 38px;
    right: 10px;
    z-index: 30;
    padding: 0.3rem 0.9rem;
    font-size: 0.8rem;
    font-weight: 600;
    color: #e5484d;
    background: #2a2a2a;
    border: 1px solid #e5484d;
    border-radius: 999px;
    cursor: pointer;
    transition: background 120ms ease;
  }

  .now-button:hover {
    background: #3a2426;
  }
</style>
