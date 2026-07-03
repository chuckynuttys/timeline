<script lang="ts">
  import { onMount } from 'svelte';
  import Timeline from './lib/Timeline.svelte';
  import ActivityPool from './lib/ActivityPool.svelte';
  import ActivityManager from './lib/ActivityManager.svelte';
  import Stats from './lib/Stats.svelte';
  import { loadStore, startupCatchUp } from './lib/store.svelte';

  /** No pane may be dragged below this many pixels on the split axis. */
  const MIN_PANE_PX = 110;
  const SPLITTER_PX = 6;
  /** v2 shape { v, lh, rh } — replaces (ignores) the old shared-grid v1 key. */
  const STORAGE_KEY = 'timeline.layout-splits.v2';

  type SplitKey = 'v' | 'lh' | 'rh';

  let timelineBody = $state<HTMLDivElement>();

  const sane = (x: unknown): number | null =>
    typeof x === 'number' && Number.isFinite(x)
      ? Math.min(0.95, Math.max(0.05, x))
      : null;

  function loadSplits(): { v: number; lh: number; rh: number } {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const p = JSON.parse(raw);
        const v = sane(p.v);
        const lh = sane(p.lh);
        const rh = sane(p.rh);
        if (v !== null && lh !== null && rh !== null) return { v, lh, rh };
      }
    } catch {
      // corrupted / unavailable storage — fall through to defaults
    }
    return { v: 0.5, lh: 0.5, rh: 0.5 };
  }

  const initial = loadSplits();
  /** SHARED: the left column's fraction of the total width. */
  let vSplit = $state(initial.v);
  /** LEFT column only: the timeline's fraction of that column's height. */
  let leftHSplit = $state(initial.lh);
  /** RIGHT column only: the pool's fraction of that column's height. */
  let rightHSplit = $state(initial.rh);
  /** Which splitter is mid-drag, so its highlight persists off-hover. */
  let dragging = $state<SplitKey | null>(null);

  function persistSplits() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ v: vSplit, lh: leftHSplit, rh: rightHSplit }),
      );
    } catch {
      // storage unavailable — layout just won't survive restart
    }
  }

  function setSplit(key: SplitKey, frac: number) {
    if (key === 'v') vSplit = frac;
    else if (key === 'lh') leftHSplit = frac;
    else rightHSplit = frac;
  }

  /** Pixel-floor clamp: neither side of a split may go below MIN_PANE_PX. */
  function clampFrac(pos: number, total: number): number {
    if (total <= MIN_PANE_PX * 2) return 0.5;
    const min = MIN_PANE_PX / total;
    return Math.min(1 - min, Math.max(min, pos / total));
  }

  /**
   * Splitter drag. The measuring container is always node.parentElement — the
   * app row for the vertical splitter, the splitter's OWN column for a
   * horizontal one — which is what keeps the two columns' height splits
   * independent. Pointer capture routes every move to the splitter itself, so
   * interact.js gestures inside the panels never see the drag.
   */
  function splitterDrag(node: HTMLElement, opts: { axis: 'x' | 'y'; key: SplitKey }) {
    const onPointerDown = (e: PointerEvent) => {
      e.preventDefault();
      node.setPointerCapture(e.pointerId);
      const rect = node.parentElement!.getBoundingClientRect();
      dragging = opts.key;
      document.body.style.cursor = opts.axis === 'x' ? 'col-resize' : 'row-resize';

      const onMove = (ev: PointerEvent) => {
        const pos = opts.axis === 'x' ? ev.clientX - rect.left : ev.clientY - rect.top;
        const total = opts.axis === 'x' ? rect.width : rect.height;
        setSplit(opts.key, clampFrac(pos, total));
      };
      const onUp = (ev: PointerEvent) => {
        node.releasePointerCapture(ev.pointerId);
        node.removeEventListener('pointermove', onMove);
        node.removeEventListener('pointerup', onUp);
        dragging = null;
        document.body.style.cursor = '';
        persistSplits();
      };
      node.addEventListener('pointermove', onMove);
      node.addEventListener('pointerup', onUp);
    };

    node.addEventListener('pointerdown', onPointerDown);
    return { destroy: () => node.removeEventListener('pointerdown', onPointerDown) };
  }

  onMount(async () => {
    try {
      // First db call applies pending migrations and seeds example activities.
      await loadStore();
      // Reconcile blocks that ended while the app was closed (logs their time
      // silently), THEN mark the store reconciled so Timeline's live tick may
      // start completing blocks in real time.
      await startupCatchUp();
    } catch (e) {
      console.error('Database init failed:', e);
    }
  });
</script>

<!-- Columns-first shell: [left col][shared vertical splitter][right col].
     Each column stacks [top panel][its OWN horizontal splitter][bottom panel],
     so the two columns' height splits are independent — staggered horizontal
     dividers are correct. All sizes render from the three fractions: the top
     panes get explicit calc() heights, the bottoms take the remainder via
     flex:1, keeping the tiling gapless with no pixel drift. -->
<main class="app">
  <div class="col col-left" style:width="calc((100% - {SPLITTER_PX}px) * {vSplit})">
    <!-- The timeline renders its own header so the clock chip can track the
         needle's x-position — no extra panel header here. -->
    <section
      class="panel pane-top cell-tl"
      style:height="calc((100% - {SPLITTER_PX}px) * {leftHSplit})"
    >
      <div class="panel-body" bind:this={timelineBody}>
        <Timeline />
      </div>
    </section>

    <div
      class="splitter splitter-h"
      class:active={dragging === 'lh'}
      use:splitterDrag={{ axis: 'y', key: 'lh' }}
    ></div>

    <section class="panel pane-bottom cell-bl">
      <header class="panel-header">Avatar</header>
      <div class="panel-body placeholder">Avatar goes here</div>
    </section>
  </div>

  <div
    class="splitter splitter-v"
    class:active={dragging === 'v'}
    use:splitterDrag={{ axis: 'x', key: 'v' }}
  ></div>

  <div class="col col-right">
    <section
      class="panel pane-top cell-tr"
      style:height="calc((100% - {SPLITTER_PX}px) * {rightHSplit})"
    >
      <header class="panel-header pool-header">
        <span>Activity pool</span>
        <ActivityManager />
      </header>
      <div class="panel-body">
        <ActivityPool getTimelinePane={() => timelineBody} />
      </div>
    </section>

    <div
      class="splitter splitter-h"
      class:active={dragging === 'rh'}
      use:splitterDrag={{ axis: 'y', key: 'rh' }}
    ></div>

    <section class="panel pane-bottom cell-br">
      <header class="panel-header">Stats</header>
      <div class="panel-body">
        <Stats />
      </div>
    </section>
  </div>
</main>

<style>
  .app {
    display: flex;
    width: 100vw;
    height: 100vh;
  }

  .col {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }

  .col-left {
    flex: none;
  }

  .col-right {
    flex: 1 1 0;
  }

  .panel {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }

  .pane-top {
    flex: none;
  }

  .pane-bottom {
    flex: 1 1 0;
  }

  .panel-header {
    flex: none;
    padding: 0.6rem 1rem;
    font-size: 0.85rem;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: #9a9a9a;
    border-bottom: 1px solid #3a3a3a;
  }

  .pool-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.35rem 0.6rem 0.35rem 1rem;
  }

  .panel-body {
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }

  .placeholder {
    display: grid;
    place-items: center;
    color: #6f6f6f;
    font-size: 0.9rem;
  }

  .splitter {
    flex: none;
    background: #2c2c2c;
    touch-action: none; /* raw pointer events, no scroll gestures */
    z-index: 40;
    transition: background 120ms ease;
  }

  .splitter:hover,
  .splitter.active {
    background: #4a4a4a;
  }

  .splitter-v {
    width: 6px;
    cursor: col-resize;
  }

  /* Lives inside its own column, so it spans only that column's width. */
  .splitter-h {
    height: 6px;
    cursor: row-resize;
  }
</style>
